//! The S2S replication and blob protocols, Rust side.
//!
//! Wire-identical to `packages/net/src/sync.js` and `blobs.js`. The exchange is
//! strictly turn-taking so neither side can deadlock waiting on the other:
//!
//!   dialer  -> have
//!   dialer  <- have
//!   dialer  -> events*, end      (responder is reading)
//!   dialer  <- events*, end      (responder is writing)

use anyhow::{Result, bail};
use futures::{AsyncRead, AsyncWrite};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::codec::blob_id;
use crate::store::{Event, Put, Store};
use crate::wire::{MAX_BLOB_BYTES, read_frame, read_json, write_frame, write_json};

pub const SYNC_PROTOCOL: &str = "/s2s/1.0.0/sync";
pub const BLOB_PROTOCOL: &str = "/s2s/1.0.0/blob";
pub const EVENT_TOPIC: &str = "s2s/v1/events";

const MAX_EVENTS_PER_MESSAGE: u64 = 200;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Message {
    Have {
        vector: BTreeMap<String, u64>,
    },
    Events {
        events: Vec<Event>,
    },
    End,
}

#[derive(Debug, Default)]
pub struct SyncOutcome {
    pub received: usize,
    pub sent: usize,
}

/// At most this many authors in one have vector.
const MAX_VECTOR_ENTRIES: usize = 50_000;

/// Ranges of our logs that `theirs` has not seen.
///
/// `theirs` is chosen entirely by the peer. Deserialising into `u64` already
/// rejects negatives, which is what made the JavaScript side spin, but the
/// entry count still has to be bounded and an unknown author id ignored.
fn diff(mine: &BTreeMap<String, u64>, theirs: &BTreeMap<String, u64>) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    for (author, my_head) in mine {
        let their_head = theirs.get(author).copied().unwrap_or(0);
        if *my_head > their_head {
            out.push((author.clone(), their_head + 1, *my_head));
        }
    }
    out
}

/// Drop entries a peer has no business sending before they reach `diff`.
fn clean_vector(mut vector: BTreeMap<String, u64>) -> BTreeMap<String, u64> {
    vector.retain(|author, _| crate::codec::is_author_id(author));
    while vector.len() > MAX_VECTOR_ENTRIES {
        let last = vector.keys().next_back().cloned();
        if let Some(k) = last {
            vector.remove(&k);
        } else {
            break;
        }
    }
    vector
}

/// We dialled them.
pub async fn sync_outbound<S>(stream: &mut S, store: &Arc<Mutex<Store>>) -> Result<SyncOutcome>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mine = store.lock().await.have_vector();
    write_json(stream, &Message::Have { vector: mine }).await?;

    let theirs = match read_json::<_, Message>(stream).await? {
        Message::Have { vector } => clean_vector(vector),
        other => bail!("expected a have vector, got {other:?}"),
    };

    let sent = write_missing(stream, store, &theirs).await?;
    let received = read_until_end(stream, store).await?;
    Ok(SyncOutcome { received, sent })
}

/// They dialled us.
pub async fn sync_inbound<S>(stream: &mut S, store: &Arc<Mutex<Store>>) -> Result<SyncOutcome>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let theirs = match read_json::<_, Message>(stream).await? {
        Message::Have { vector } => clean_vector(vector),
        other => bail!("expected a have vector, got {other:?}"),
    };

    let mine = store.lock().await.have_vector();
    write_json(stream, &Message::Have { vector: mine }).await?;

    let received = read_until_end(stream, store).await?;
    let sent = write_missing(stream, store, &theirs).await?;
    Ok(SyncOutcome { received, sent })
}

async fn write_missing<S: AsyncWrite + Unpin>(
    stream: &mut S,
    store: &Arc<Mutex<Store>>,
    theirs: &BTreeMap<String, u64>,
) -> Result<usize> {
    let ranges = {
        let guard = store.lock().await;
        diff(&guard.have_vector(), theirs)
    };

    let mut sent = 0;
    for (author, from, to) in ranges {
        let mut cursor = from;
        while cursor <= to {
            let batch_end = (cursor + MAX_EVENTS_PER_MESSAGE - 1).min(to);
            let events = store.lock().await.log_range(&author, cursor, batch_end);
            if !events.is_empty() {
                sent += events.len();
                write_json(stream, &Message::Events { events }).await?;
            }
            cursor = batch_end + 1;
        }
    }
    write_json(stream, &Message::End).await?;
    Ok(sent)
}

/// Upper bound on how long one side may keep a single sync going.
const MAX_MESSAGES_PER_SYNC: usize = 10_000;

async fn read_until_end<S: AsyncRead + Unpin>(
    stream: &mut S,
    store: &Arc<Mutex<Store>>,
) -> Result<usize> {
    let mut stored = 0;
    let mut messages = 0;
    loop {
        // A peer that never sends `end` - or that sends `have` forever - would
        // otherwise keep this loop alive indefinitely.
        messages += 1;
        if messages > MAX_MESSAGES_PER_SYNC {
            bail!("peer sent too many messages in one sync");
        }
        match read_json::<_, Message>(stream).await? {
            Message::End => return Ok(stored),
            Message::Events { events } => {
                let now = now_ms();
                let mut guard = store.lock().await;
                for event in events {
                    match guard.put(event, now) {
                        Put::Stored => stored += 1,
                        Put::Rejected(reason) => tracing::warn!("rejected an event: {reason}"),
                        _ => {}
                    }
                }
            }
            Message::Have { .. } => continue,
        }
    }
}

/* ---- blobs ------------------------------------------------------------- */

#[derive(Serialize, Deserialize)]
struct BlobRequest {
    blob: String,
}

#[derive(Serialize, Deserialize)]
struct BlobHeader {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<usize>,
}

/// Serve one blob to a peer that asked for it by hash.
pub async fn serve_blob<S>(stream: &mut S, store: &Arc<Mutex<Store>>) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request: BlobRequest = read_json(stream).await?;
    // `request.blob` is whatever the peer sent. Anything that is not a blob id
    // never reaches the store, let alone the filesystem.
    let bytes = if crate::codec::is_blob_id(&request.blob) {
        store.lock().await.get_blob(&request.blob)
    } else {
        None
    };

    match bytes {
        None => write_json(stream, &BlobHeader { ok: false, size: None }).await,
        Some(bytes) => {
            write_json(
                stream,
                &BlobHeader {
                    ok: true,
                    size: Some(bytes.len()),
                },
            )
            .await?;
            write_frame(stream, &bytes).await
        }
    }
}

/// Ask a peer for one blob, and check that what comes back really hashes to it.
pub async fn fetch_blob<S>(stream: &mut S, id: &str) -> Result<Option<Vec<u8>>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if !crate::codec::is_blob_id(id) {
        bail!("not a blob id: {id}");
    }
    write_json(stream, &BlobRequest { blob: id.to_string() }).await?;

    let header: BlobHeader = read_json(stream).await?;
    if !header.ok {
        return Ok(None);
    }
    if header.size.unwrap_or(0) > MAX_BLOB_BYTES {
        bail!("peer offered a blob larger than the limit");
    }

    let bytes = read_frame(stream, MAX_BLOB_BYTES).await?;
    if blob_id(&bytes) != id {
        bail!("blob content does not match its hash");
    }
    Ok(Some(bytes))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_finds_exactly_the_missing_ranges() {
        let mine = BTreeMap::from([("@a".to_string(), 5u64)]);
        let theirs = BTreeMap::from([("@a".to_string(), 2u64)]);
        assert_eq!(diff(&mine, &theirs), vec![("@a".to_string(), 3, 5)]);
        assert!(diff(&mine, &mine).is_empty());
        assert_eq!(
            diff(&mine, &BTreeMap::new()),
            vec![("@a".to_string(), 1, 5)]
        );
        assert!(diff(&BTreeMap::new(), &theirs).is_empty());
    }
}
