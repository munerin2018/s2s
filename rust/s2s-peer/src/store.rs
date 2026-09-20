//! The replica: signed append-only logs plus content-addressed blobs.
//!
//! Byte-for-byte the same on-disk format the JavaScript peers use, so a data
//! directory can be handed between the two implementations.
//!
//! Validation here deliberately mirrors `packages/core/src/event.js` rather
//! than doing whatever Rust makes easy. If one implementation accepts an event
//! the other refuses, that author's log stops replicating across the boundary
//! from that sequence number on - a permanent split that no amount of
//! reconnecting repairs.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use crate::codec::{
    author_id, b58, blob_id, canonical, decode_id, event_id, is_author_id, is_blob_id,
    is_event_id, unb58, verify_signature,
};

/// Five minutes, matching `LIMITS.futureSkewMs` on the JavaScript side.
const FUTURE_SKEW_MS: i64 = 5 * 60 * 1000;

/// Mirrors `LIMITS` in `packages/core/src/event.js`.
mod limits {
    pub const TEXT: usize = 2000;
    pub const NAME: usize = 64;
    pub const BIO: usize = 400;
    pub const TITLE: usize = 120;
    pub const BOARD: usize = 48;
    pub const TAG: usize = 48;
    pub const TAGS: usize = 12;
    pub const MEDIA: usize = 8;
    pub const ALT: usize = 300;
    pub const MIME: usize = 80;
}

/// Content members defined for each kind. Anything else is refused: an event
/// that one implementation stores and the other rejects splits the network.
fn content_fields(kind: &str) -> Option<&'static [&'static str]> {
    Some(match kind {
        "profile" => &["name", "bio", "avatar"],
        "post" => &["text", "media", "tags", "board"],
        "reply" => &["root", "parent", "text", "media"],
        "like" => &["target", "value"],
        "repost" | "delete" => &["target"],
        "follow" | "unfollow" | "block" | "unblock" => &["target"],
        "thread" => &["board", "title", "text", "media"],
        _ => return None,
    })
}

const MEDIA_FIELDS: &[&str] = &["blob", "mime", "w", "h", "alt"];

/// Bounds on what a hostile peer can make us hold in memory.
const MAX_PENDING_TOTAL: usize = 20_000;
const MAX_PENDING_PER_AUTHOR: usize = 2_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub author: String,
    pub seq: u64,
    pub prev: Option<String>,
    pub ts: i64,
    pub kind: String,
    pub content: Value,
    pub sig: String,
    pub id: String,
}

impl Event {
    /// The subset that gets signed. `sig` and `id` are derived from it.
    fn body(&self) -> Value {
        let mut m = Map::new();
        m.insert("author".into(), Value::String(self.author.clone()));
        m.insert("seq".into(), Value::from(self.seq));
        m.insert(
            "prev".into(),
            match &self.prev {
                Some(p) => Value::String(p.clone()),
                None => Value::Null,
            },
        );
        m.insert("ts".into(), Value::from(self.ts));
        m.insert("kind".into(), Value::String(self.kind.clone()));
        m.insert("content".into(), self.content.clone());
        Value::Object(m)
    }

    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(canonical(&self.body())?.into_bytes())
    }

    fn id_bytes(&self) -> Result<Vec<u8>> {
        let mut body = self.body();
        body.as_object_mut()
            .expect("body is an object")
            .insert("sig".into(), Value::String(self.sig.clone()));
        Ok(canonical(&body)?.into_bytes())
    }

    pub fn compute_id(&self) -> Result<String> {
        Ok(event_id(&self.id_bytes()?))
    }

    /// Full check: shape, content, signature, and that the id names the content.
    pub fn verify(&self, now_ms: i64) -> Result<()> {
        self.validate_shape(now_ms)?;
        verify_signature(&self.author, &self.signing_bytes()?, &self.sig)?;
        if self.compute_id()? != self.id {
            bail!("id does not match content");
        }
        Ok(())
    }

    pub fn validate_shape(&self, now_ms: i64) -> Result<()> {
        if !is_author_id(&self.author) {
            bail!("bad author");
        }
        if self.seq < 1 {
            bail!("bad seq");
        }
        match (&self.prev, self.seq) {
            (None, 1) => {}
            (Some(p), s) if s > 1 && is_event_id(p) => {}
            _ => bail!("prev does not match seq"),
        }
        if self.ts < 0 {
            bail!("bad ts");
        }
        if self.ts > now_ms + FUTURE_SKEW_MS {
            bail!("timestamp too far in the future");
        }

        let Some(allowed) = content_fields(&self.kind) else {
            bail!("unknown kind {}", self.kind);
        };
        let Some(content) = self.content.as_object() else {
            bail!("content must be an object");
        };
        for key in content.keys() {
            if !allowed.contains(&key.as_str()) {
                bail!("content has an unknown member: {key}");
            }
        }
        validate_content(&self.kind, content)
    }
}

/// Length in UTF-16 code units, which is what `String#length` counts in
/// JavaScript. Counting bytes or code points here would let an event through
/// on one implementation and not the other.
fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn check_str(content: &Map<String, Value>, key: &str, max: usize, required: bool) -> Result<String> {
    match content.get(key) {
        None if required => bail!("missing {key}"),
        None => Ok(String::new()),
        Some(Value::String(s)) if utf16_len(s) <= max => Ok(s.clone()),
        Some(Value::String(_)) => bail!("{key} is too long"),
        Some(_) => bail!("{key} must be a string"),
    }
}

fn check_id(content: &Map<String, Value>, key: &str, is: fn(&str) -> bool) -> Result<()> {
    match content.get(key).and_then(Value::as_str) {
        Some(v) if is(v) => Ok(()),
        _ => bail!("bad {key}"),
    }
}

/// @returns whether there is at least one attachment
fn check_media(content: &Map<String, Value>) -> Result<bool> {
    let Some(value) = content.get("media") else {
        return Ok(false);
    };
    let Some(list) = value.as_array() else {
        bail!("media must be a list");
    };
    if list.len() > limits::MEDIA {
        bail!("too many attachments");
    }
    for item in list {
        let Some(m) = item.as_object() else {
            bail!("bad media entry");
        };
        for key in m.keys() {
            if !MEDIA_FIELDS.contains(&key.as_str()) {
                bail!("media entry has an unknown member: {key}");
            }
        }
        check_id(m, "blob", is_blob_id)?;
        check_str(m, "mime", limits::MIME, false)?;
        check_str(m, "alt", limits::ALT, false)?;
        for key in ["w", "h"] {
            match m.get(key) {
                None => {}
                Some(v) if v.as_u64().is_some() => {}
                Some(_) => bail!("bad media {key}"),
            }
        }
    }
    Ok(!list.is_empty())
}

fn validate_content(kind: &str, c: &Map<String, Value>) -> Result<()> {
    match kind {
        "profile" => {
            check_str(c, "name", limits::NAME, false)?;
            check_str(c, "bio", limits::BIO, false)?;
            if c.contains_key("avatar") {
                check_id(c, "avatar", is_blob_id)?;
            }
            Ok(())
        }
        "post" => {
            let body = check_str(c, "text", limits::TEXT, false)?;
            let has_media = check_media(c)?;
            if body.trim().is_empty() && !has_media {
                bail!("post must have text or media");
            }
            check_str(c, "board", limits::BOARD, false)?;
            if let Some(tags) = c.get("tags") {
                let Some(list) = tags.as_array() else {
                    bail!("tags must be a list");
                };
                if list.len() > limits::TAGS {
                    bail!("too many tags");
                }
                for t in list {
                    match t.as_str() {
                        Some(s) if utf16_len(s) <= limits::TAG => {}
                        _ => bail!("bad tag"),
                    }
                }
            }
            Ok(())
        }
        "reply" => {
            check_id(c, "root", is_event_id)?;
            check_id(c, "parent", is_event_id)?;
            let body = check_str(c, "text", limits::TEXT, false)?;
            let has_media = check_media(c)?;
            if body.trim().is_empty() && !has_media {
                bail!("reply must have text or media");
            }
            Ok(())
        }
        "like" => {
            check_id(c, "target", is_event_id)?;
            match c.get("value").and_then(Value::as_i64) {
                Some(1) | Some(-1) => Ok(()),
                _ => bail!("bad like value"),
            }
        }
        "repost" | "delete" => check_id(c, "target", is_event_id),
        "follow" | "unfollow" | "block" | "unblock" => check_id(c, "target", is_author_id),
        "thread" => {
            let board = check_str(c, "board", limits::BOARD, true)?;
            let title = check_str(c, "title", limits::TITLE, true)?;
            if board.trim().is_empty() || title.trim().is_empty() {
                bail!("a thread needs a board and a title");
            }
            check_str(c, "text", limits::TEXT, false)?;
            check_media(c)?;
            Ok(())
        }
        other => bail!("unknown kind {other}"),
    }
}

/// What happened when an event was offered to the store.
#[derive(Debug, PartialEq)]
pub enum Put {
    Stored,
    Duplicate,
    /// Arrived ahead of its predecessor; held until the gap closes.
    Buffered,
    Rejected(String),
}

pub struct Store {
    log_path: PathBuf,
    blob_dir: PathBuf,

    pub events: HashMap<String, Event>,
    /// author -> log indexed by `seq - 1`, so position and sequence never drift
    logs: HashMap<String, Vec<Event>>,
    pub heads: BTreeMap<String, u64>,
    pending: HashMap<String, BTreeMap<u64, Event>>,
    pending_count: usize,
    /// tombstones naming an event we have not received yet
    tombstone_pending: HashMap<String, HashSet<String>>,
    pub deleted: HashSet<String>,
}

impl Store {
    pub fn open(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref();
        let blob_dir = dir.join("blobs");
        fs::create_dir_all(&blob_dir).context("could not create the data directory")?;

        let mut store = Store {
            log_path: dir.join("events.jsonl"),
            blob_dir,
            events: HashMap::new(),
            logs: HashMap::new(),
            heads: BTreeMap::new(),
            pending: HashMap::new(),
            pending_count: 0,
            tombstone_pending: HashMap::new(),
            deleted: HashSet::new(),
        };
        store.load()?;
        Ok(store)
    }

    /// Replay the log from disk.
    ///
    /// Every line goes through the same chain checks a network event does. The
    /// file can be a line short after a crash, or hold a duplicate; applying
    /// such a file blindly would leave the in-memory log out of step with the
    /// sequence numbers, and every later lookup then reads the wrong event.
    fn load(&mut self) -> Result<()> {
        if !self.log_path.exists() {
            return Ok(());
        }
        let file = File::open(&self.log_path)?;
        let mut loaded: Vec<Event> = Vec::new();

        for (i, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Event>(&line) {
                Ok(e) => loaded.push(e),
                Err(err) => tracing::warn!("skipping corrupt line {} in events.jsonl: {err}", i + 1),
            }
        }

        // Apply in (author, seq) order so chains connect regardless of write order.
        loaded.sort_by(|a, b| a.author.cmp(&b.author).then(a.seq.cmp(&b.seq)));

        let total = loaded.len();
        let mut applied = 0;
        for e in loaded {
            if self.put_verified(e, false) == Put::Stored {
                applied += 1;
            }
        }
        self.drain_all_pending();

        if applied != total {
            tracing::warn!(
                "{} of {total} stored events did not fit the chain and were skipped",
                total - applied
            );
        }
        Ok(())
    }

    /// Validate an event from the network and, if it fits, append it.
    pub fn put(&mut self, event: Event, now_ms: i64) -> Put {
        if self.events.contains_key(&event.id) {
            return Put::Duplicate;
        }
        if let Err(err) = event.verify(now_ms) {
            return Put::Rejected(format!("{err:#}"));
        }
        self.put_verified(event, true)
    }

    fn put_verified(&mut self, event: Event, persist: bool) -> Put {
        let head = self.heads.get(&event.author).copied();
        let expected = head.map_or(1, |h| h + 1);

        if event.seq > expected {
            return if self.hold(event) {
                Put::Buffered
            } else {
                Put::Rejected("pending buffer is full".into())
            };
        }
        if event.seq < expected {
            return match self.at(&event.author, event.seq) {
                Some(prev) if prev.id != event.id => Put::Rejected(format!(
                    "fork detected: author signed two events at seq {}",
                    event.seq
                )),
                _ => Put::Duplicate,
            };
        }
        if let Some(head_seq) = head {
            match self.at(&event.author, head_seq) {
                Some(h) if event.prev.as_deref() == Some(h.id.as_str()) => {}
                _ => return Put::Rejected("prev does not match our head for this author".into()),
            }
        }

        if persist {
            if let Err(err) = self.append_to_disk(&event) {
                return Put::Rejected(format!("could not write to the log: {err}"));
            }
        }
        let author = event.author.clone();
        self.apply(event);
        self.drain_pending_for(&author);
        Put::Stored
    }

    /// The event at `seq` in an author's log. Indexed by sequence number, not
    /// by arrival position - the two only coincide while nothing was skipped.
    fn at(&self, author: &str, seq: u64) -> Option<&Event> {
        let index = usize::try_from(seq).ok()?.checked_sub(1)?;
        self.logs.get(author)?.get(index)
    }

    fn head_id(&self, author: &str) -> Option<String> {
        let head = self.heads.get(author).copied()?;
        self.at(author, head).map(|e| e.id.clone())
    }

    fn append_to_disk(&self, event: &Event) -> Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log_path)?;
        writeln!(file, "{}", serde_json::to_string(event)?)?;
        Ok(())
    }

    fn apply(&mut self, event: Event) {
        let log = self.logs.entry(event.author.clone()).or_default();
        // `put_verified` only reaches here for the exact next event in the
        // chain, so the push always lands at `seq - 1`.
        debug_assert_eq!(log.len() as u64 + 1, event.seq);
        log.push(event.clone());
        self.heads.insert(event.author.clone(), event.seq);

        if event.kind == "delete" {
            if let Some(target) = event.content.get("target").and_then(Value::as_str) {
                match self.events.get(target) {
                    // Only the author of an event may tombstone it.
                    Some(t) if t.author == event.author => {
                        self.deleted.insert(target.to_string());
                    }
                    Some(_) => {}
                    // The target is not here yet, so the author cannot be
                    // checked. Trusting it now would let anyone censor
                    // anything by naming it before it arrives.
                    None => {
                        self.tombstone_pending
                            .entry(target.to_string())
                            .or_default()
                            .insert(event.author.clone());
                    }
                }
            }
        }

        if let Some(waiting) = self.tombstone_pending.remove(&event.id) {
            if waiting.contains(&event.author) {
                self.deleted.insert(event.id.clone());
            }
        }

        self.events.insert(event.id.clone(), event);
    }

    /// Buffer an event that arrived ahead of its predecessor.
    ///
    /// Bounded per author and overall. A per-author cap alone is not enough:
    /// keys are free to make, so a peer can mint a fresh author for every
    /// orphan it sends and never reach it.
    fn hold(&mut self, event: Event) -> bool {
        if let Some(slot) = self.pending.get(&event.author) {
            if slot.contains_key(&event.seq) {
                return true;
            }
            if slot.len() >= MAX_PENDING_PER_AUTHOR {
                return false;
            }
        }
        if self.pending_count >= MAX_PENDING_TOTAL && !self.evict_pending() {
            return false;
        }
        self.pending
            .entry(event.author.clone())
            .or_default()
            .insert(event.seq, event);
        self.pending_count += 1;
        true
    }

    /// Drop one author's buffer to make room.
    fn evict_pending(&mut self) -> bool {
        let Some(victim) = self.pending.keys().next().cloned() else {
            return false;
        };
        if let Some(slot) = self.pending.remove(&victim) {
            self.pending_count = self.pending_count.saturating_sub(slot.len());
        }
        true
    }

    fn drain_pending_for(&mut self, author: &str) {
        loop {
            let want = self.heads.get(author).map_or(1, |h| h + 1);
            let Some(slot) = self.pending.get_mut(author) else {
                return;
            };
            let Some(next) = slot.remove(&want) else {
                return;
            };
            self.pending_count = self.pending_count.saturating_sub(1);
            if slot.is_empty() {
                self.pending.remove(author);
            }
            if next.prev != self.head_id(author) {
                return; // a fork; drop the branch
            }
            if self.append_to_disk(&next).is_err() {
                return;
            }
            self.apply(next);
        }
    }

    fn drain_all_pending(&mut self) {
        let authors: Vec<String> = self.pending.keys().cloned().collect();
        for a in authors {
            self.drain_pending_for(&a);
        }
    }

    /// Whether we hold anything at all from this author.
    pub fn knows(&self, author: &str) -> bool {
        self.heads.contains_key(author)
    }

    /// What we advertise to a peer: how far we have got in every log we hold.
    pub fn have_vector(&self) -> BTreeMap<String, u64> {
        self.heads.clone()
    }

    pub fn log_range(&self, author: &str, from: u64, to: u64) -> Vec<Event> {
        let Some(log) = self.logs.get(author) else {
            return Vec::new();
        };
        let start = (from.max(1) - 1) as usize;
        let end = (to as usize).min(log.len());
        if start >= end {
            return Vec::new();
        }
        log[start..end].to_vec()
    }

    // ---- blobs ---------------------------------------------------------

    /// Map a blob id to a file inside the blob directory, and nowhere else.
    ///
    /// The id comes off the wire, so it is a claim rather than a name. It is
    /// decoded to its 32 bytes and re-encoded, which means the filename can
    /// only ever be one of the valid hashes. Joining the raw string would let
    /// `&../identity.json` walk to the account key, and `PathBuf::join` with
    /// an absolute path would replace the directory outright.
    fn blob_path(&self, id: &str) -> Option<PathBuf> {
        let bytes = decode_id(id, '&').ok()?;
        Some(self.blob_dir.join(b58(&bytes)))
    }

    pub fn get_blob(&self, id: &str) -> Option<Vec<u8>> {
        fs::read(self.blob_path(id)?).ok()
    }

    pub fn put_blob(&self, bytes: &[u8]) -> Result<String> {
        let id = blob_id(bytes);
        let path = self
            .blob_path(&id)
            .context("a computed blob id should always decode")?;
        if !path.exists() {
            // A unique temp name: two peers can deliver the same blob at once,
            // and a shared scratch file would have them overwrite each other.
            let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, &path)?;
        }
        Ok(id)
    }

    // ---- writing our own log -------------------------------------------

    /// Sign and append a new event to our own log.
    pub fn append_local(
        &mut self,
        signing_key: &ed25519_dalek::SigningKey,
        kind: &str,
        content: Value,
        now_ms: i64,
    ) -> Result<Event> {
        use ed25519_dalek::Signer;

        let me = author_id(signing_key.verifying_key().as_bytes());
        let seq = self.heads.get(&me).map_or(1, |h| h + 1);
        let prev = self.head_id(&me);

        let mut event = Event {
            author: me,
            seq,
            prev,
            ts: now_ms,
            kind: kind.to_string(),
            content,
            sig: String::new(),
            id: String::new(),
        };
        // Check our own work before signing it, so we never put an event on
        // the wire that the other implementation would refuse.
        event.validate_shape(now_ms)?;
        event.sig = b58(&signing_key.sign(&event.signing_bytes()?).to_bytes());
        event.id = event.compute_id()?;

        match self.put_verified(event.clone(), true) {
            Put::Stored => Ok(event),
            other => bail!("could not append our own event: {other:?}"),
        }
    }
}

/// Load the account key from `identity.json`, creating one on first run.
/// Same file the JavaScript peers write.
pub fn load_or_create_identity(dir: &Path) -> Result<ed25519_dalek::SigningKey> {
    #[derive(Serialize, Deserialize)]
    struct Stored {
        id: String,
        #[serde(rename = "secretKey")]
        secret_key: String,
    }

    fs::create_dir_all(dir)?;
    let path = dir.join("identity.json");

    if path.exists() {
        let stored: Stored = serde_json::from_str(&fs::read_to_string(&path)?)?;
        let raw = unb58(&stored.secret_key)?;
        if raw.len() != 32 {
            bail!("identity.json holds a malformed secret key");
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&raw);
        return Ok(ed25519_dalek::SigningKey::from_bytes(&bytes));
    }

    // Generate from OS randomness directly, rather than through a helper whose
    // signature has moved between ed25519-dalek releases.
    let mut seed = [0u8; 32];
    rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut seed);
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let stored = Stored {
        id: author_id(key.verifying_key().as_bytes()),
        secret_key: b58(&key.to_bytes()),
    };
    fs::write(&path, serde_json::to_string_pretty(&stored)? + "\n")?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn key() -> ed25519_dalek::SigningKey {
        let mut seed = [0u8; 32];
        rand_core::RngCore::fill_bytes(&mut rand_core::OsRng, &mut seed);
        ed25519_dalek::SigningKey::from_bytes(&seed)
    }

    fn store() -> (Store, tempdir::Dir) {
        let dir = tempdir::Dir::new();
        (Store::open(dir.path()).unwrap(), dir)
    }

    /// Minimal scratch directory helper, to avoid a dependency for two tests.
    mod tempdir {
        use std::path::{Path, PathBuf};
        pub struct Dir(PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!(
                    "s2s-test-{}-{:?}",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap()
                        .as_nanos()
                ));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
            pub fn path(&self) -> &Path {
                &self.0
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn a_blob_id_cannot_escape_the_blob_directory() {
        let (s, dir) = store();
        std::fs::write(dir.path().join("identity.json"), "TOP SECRET").unwrap();

        for evil in [
            "&../identity.json",
            "&..\\identity.json",
            "&/etc/passwd",
            "&C:\\Windows\\win.ini",
            "&日本",
            "&",
            "",
            "&!!!",
        ] {
            assert!(s.blob_path(evil).is_none(), "{evil} must not map to a path");
            assert!(s.get_blob(evil).is_none(), "{evil} must not read a file");
        }

        let id = s.put_blob(b"hello").unwrap();
        assert_eq!(s.get_blob(&id).unwrap(), b"hello");
    }

    #[test]
    fn content_the_javascript_side_refuses_is_refused_here_too() {
        let k = key();
        let (mut s, _dir) = store();
        let now = 1_700_000_000_000;

        // A non blob id where a blob id belongs. This used to be stored, then
        // panic later when the fetcher sliced it by byte offset.
        let bad = s.append_local(&k, "profile", json!({ "avatar": "日本" }), now);
        assert!(bad.is_err(), "an avatar must be a blob id");

        assert!(s.append_local(&k, "post", json!({ "text": "" }), now).is_err());
        assert!(s.append_local(&k, "nope", json!({}), now).is_err());
        assert!(
            s.append_local(&k, "post", json!({ "text": "hi", "extra": 1 }), now)
                .is_err(),
            "unknown content members must be refused"
        );
        assert!(
            s.append_local(&k, "post", json!({ "text": "x".repeat(5000) }), now)
                .is_err()
        );

        // And a valid one still works.
        assert!(s.append_local(&k, "post", json!({ "text": "hi" }), now).is_ok());
    }

    #[test]
    fn the_log_is_indexed_by_sequence_number() {
        let k = key();
        let (mut s, _dir) = store();
        let now = 1_700_000_000_000;

        let a = s.append_local(&k, "post", json!({ "text": "one" }), now).unwrap();
        let b = s.append_local(&k, "post", json!({ "text": "two" }), now).unwrap();

        assert_eq!(s.at(&a.author, 1).unwrap().id, a.id);
        assert_eq!(s.at(&a.author, 2).unwrap().id, b.id);
        assert_eq!(s.head_id(&a.author).unwrap(), b.id);
        assert_eq!(s.log_range(&a.author, 1, 2).len(), 2);
        assert_eq!(s.log_range(&a.author, 0, 99).len(), 2);
        assert!(s.at(&a.author, 0).is_none());
        assert!(s.at(&a.author, 99).is_none());
    }

    #[test]
    fn a_log_file_with_a_hole_in_it_does_not_desynchronise_the_index() {
        let k = key();
        let dir = tempdir::Dir::new();
        let now = 1_700_000_000_000;

        let (e1, e2, e3) = {
            let mut s = Store::open(dir.path()).unwrap();
            (
                s.append_local(&k, "post", json!({ "text": "one" }), now).unwrap(),
                s.append_local(&k, "post", json!({ "text": "two" }), now).unwrap(),
                s.append_local(&k, "post", json!({ "text": "three" }), now).unwrap(),
            )
        };

        // Rewrite the log with the middle event missing, as a torn write or an
        // older build could leave it.
        let path = dir.path().join("events.jsonl");
        let kept = format!(
            "{}\n{}\n",
            serde_json::to_string(&e1).unwrap(),
            serde_json::to_string(&e3).unwrap()
        );
        std::fs::write(&path, kept).unwrap();

        let s = Store::open(dir.path()).unwrap();
        assert_eq!(s.heads.get(&e1.author), Some(&1), "the chain stops at the hole");
        assert_eq!(s.at(&e1.author, 1).unwrap().id, e1.id);
        assert!(s.at(&e1.author, 2).is_none());
        assert!(!s.events.contains_key(&e2.id));
    }

    #[test]
    fn a_stranger_cannot_tombstone_an_event_that_has_not_arrived() {
        let alice = key();
        let mallory = key();
        let (mut s, _dir) = store();
        let now = 1_700_000_000_000;

        // Build alice's post in a separate store so it is not yet delivered.
        let post = {
            let (mut other, _d) = store();
            other.append_local(&alice, "post", json!({ "text": "censor me" }), now).unwrap()
        };

        let censor = {
            let (mut other, _d) = store();
            other.append_local(&mallory, "delete", json!({ "target": post.id }), now).unwrap()
        };

        assert_eq!(s.put(censor, now), Put::Stored);
        assert_eq!(s.put(post.clone(), now), Put::Stored);
        assert!(!s.deleted.contains(&post.id), "a stranger must not hide it");
    }
}
