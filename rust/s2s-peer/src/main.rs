//! S2S native peer.
//!
//! A full peer in the same network the desktop, web and phone apps join: it
//! verifies signatures, replicates logs, gossips new events and serves media.
//! It has no window and no UI, which makes it the thing you leave running.
//!
//! Why a native peer at all, when the Electron app already is one: this one
//! holds a few megabytes of memory instead of a few hundred, starts in
//! milliseconds, and will happily sit on a Raspberry Pi or a spare box keeping
//! your posts reachable while every other device you own is asleep.

mod codec;
mod store;
mod sync;
mod wire;

use anyhow::Result;
use clap::Parser;
use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, StreamProtocol, gossipsub, identify, mdns, noise, ping, swarm::NetworkBehaviour,
    swarm::SwarmEvent, tcp, yamux,
};
use libp2p_stream as stream;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, Semaphore};
use tokio::time::timeout;

/// Caps on what one peer can make this process do at once.
const MAX_CONCURRENT_STREAMS: usize = 32;
const SYNC_TIMEOUT: Duration = Duration::from_secs(60);
const BLOB_TIMEOUT: Duration = Duration::from_secs(60);
/// How many peers to ask for a blob before accepting it is not out there.
const MAX_BLOB_ATTEMPTS: u32 = 6;

use codec::is_blob_id;
use store::{Event, Put, Store, load_or_create_identity};
use sync::{BLOB_PROTOCOL, EVENT_TOPIC, SYNC_PROTOCOL, now_ms};

#[derive(Parser, Debug)]
#[command(name = "s2s-peer", about = "A native peer for the S2S peer-to-peer social network")]
struct Args {
    /// Where the log, blobs and account key live
    #[arg(long, default_value = ".s2s-peer")]
    dir: PathBuf,

    /// TCP listen port (0 picks a free one)
    #[arg(long, default_value_t = 0)]
    tcp: u16,

    /// WebSocket port that browser and phone peers dial
    #[arg(long, default_value_t = 0)]
    ws: u16,

    /// Dial this multiaddr on start; may be repeated
    #[arg(long)]
    connect: Vec<String>,

    /// Publish a post on start; may be repeated
    #[arg(long)]
    post: Vec<String>,

    /// Set the profile name on first run
    #[arg(long)]
    name: Option<String>,

    /// Do not announce on the local network
    #[arg(long)]
    no_lan: bool,
}

#[derive(NetworkBehaviour)]
struct Behaviour {
    gossipsub: gossipsub::Behaviour,
    mdns: libp2p::swarm::behaviour::toggle::Toggle<mdns::tokio::Behaviour>,
    identify: identify::Behaviour,
    ping: ping::Behaviour,
    stream: stream::Behaviour,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "s2s_peer=info,libp2p_swarm=warn".into()),
        )
        .with_target(false)
        .init();

    let args = Args::parse();

    let signing_key = load_or_create_identity(&args.dir)?;
    let me = codec::author_id(signing_key.verifying_key().as_bytes());
    let store = Arc::new(Mutex::new(Store::open(&args.dir)?));

    println!("identity  {me}");
    println!("data dir  {}", args.dir.display());

    if let Some(name) = &args.name {
        let known = store.lock().await.knows(&me);
        if !known {
            store
                .lock()
                .await
                .append_local(&signing_key, "profile", json!({ "name": name }), now_ms())?;
        }
    }

    // The libp2p identity is separate from the S2S account on purpose: one
    // names a network endpoint, the other names a person. Deriving the peer id
    // from the account key would leak your identity to every peer you touch.
    let mut swarm = libp2p::SwarmBuilder::with_new_identity()
        .with_tokio()
        .with_tcp(
            tcp::Config::default().nodelay(true),
            noise::Config::new,
            yamux::Config::default,
        )?
        .with_websocket(noise::Config::new, yamux::Config::default)
        .await?
        .with_behaviour(|key| {
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub::ConfigBuilder::default()
                    .heartbeat_interval(Duration::from_secs(1))
                    .validation_mode(gossipsub::ValidationMode::Strict)
                    .max_transmit_size(4 * 1024 * 1024)
                    .build()
                    .expect("valid gossipsub config"),
            )
            .expect("valid gossipsub behaviour");

            let mdns = if args.no_lan {
                None
            } else {
                Some(
                    mdns::tokio::Behaviour::new(mdns::Config::default(), key.public().to_peer_id())
                        .expect("mdns starts"),
                )
            };

            Behaviour {
                gossipsub,
                mdns: mdns.into(),
                identify: identify::Behaviour::new(identify::Config::new(
                    "/s2s/1.0.0".into(),
                    key.public(),
                )),
                ping: ping::Behaviour::default(),
                stream: stream::Behaviour::new(),
            }
        })?
        .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
        .build();

    let topic = gossipsub::IdentTopic::new(EVENT_TOPIC);
    swarm.behaviour_mut().gossipsub.subscribe(&topic)?;

    swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{}", args.tcp).parse()?)?;
    swarm.listen_on(format!("/ip4/0.0.0.0/tcp/{}/ws", args.ws).parse()?)?;

    // Inbound streams for our two request protocols.
    let mut control = swarm.behaviour().stream.new_control();
    let mut inbound_sync = control.accept(StreamProtocol::new(SYNC_PROTOCOL))?;
    let mut inbound_blob = control.accept(StreamProtocol::new(BLOB_PROTOCOL))?;

    // Both inbound handlers are bounded in two ways: a timeout, so one peer
    // cannot hold a task open forever, and a semaphore, so it cannot open
    // thousands of them at once. Without either, a single peer can consume
    // this process without ever sending anything invalid.
    let sync_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_STREAMS));
    let blob_slots = Arc::new(Semaphore::new(MAX_CONCURRENT_STREAMS));

    {
        let store = store.clone();
        let slots = sync_slots.clone();
        tokio::spawn(async move {
            while let Some((peer, mut s)) = inbound_sync.next().await {
                let store = store.clone();
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    tracing::debug!("too many sync streams open; dropping one from {peer}");
                    continue;
                };
                tokio::spawn(async move {
                    let _permit = permit;
                    match timeout(SYNC_TIMEOUT, sync::sync_inbound(&mut s, &store)).await {
                        Ok(Ok(o)) if o.received > 0 || o.sent > 0 => {
                            tracing::info!("served {peer}: received {}, sent {}", o.received, o.sent)
                        }
                        Ok(Ok(_)) => {}
                        Ok(Err(err)) => tracing::debug!("inbound sync with {peer} ended: {err}"),
                        Err(_) => tracing::debug!("inbound sync with {peer} timed out"),
                    }
                });
            }
        });
    }

    {
        let store = store.clone();
        let slots = blob_slots.clone();
        tokio::spawn(async move {
            while let Some((peer, mut s)) = inbound_blob.next().await {
                let store = store.clone();
                let Ok(permit) = slots.clone().try_acquire_owned() else {
                    tracing::debug!("too many blob streams open; dropping one from {peer}");
                    continue;
                };
                tokio::spawn(async move {
                    let _permit = permit;
                    match timeout(BLOB_TIMEOUT, sync::serve_blob(&mut s, &store)).await {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => tracing::debug!("blob request from {peer} failed: {err}"),
                        Err(_) => tracing::debug!("blob request from {peer} timed out"),
                    }
                });
            }
        });
    }

    for addr in &args.connect {
        match addr.parse::<Multiaddr>() {
            Ok(ma) => {
                if let Err(err) = swarm.dial(ma.clone()) {
                    eprintln!("could not dial {addr}: {err}");
                } else {
                    println!("dialing {ma}");
                }
            }
            Err(err) => eprintln!("not a multiaddr: {addr} ({err})"),
        }
    }

    for text in &args.post {
        let event = store.lock().await.append_local(
            &signing_key,
            "post",
            json!({ "text": text }),
            now_ms(),
        )?;
        println!("posted {}", event.id);
        publish(&mut swarm, &topic, &event);
    }

    // Media referenced by events we hold but whose bytes we have not fetched.
    let wanted: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let blob_failures: Arc<Mutex<HashMap<String, u32>>> = Arc::new(Mutex::new(HashMap::new()));
    {
        let events: Vec<Event> = store.lock().await.events.values().cloned().collect();
        let mut want = wanted.lock().await;
        let store = store.lock().await;
        for e in &events {
            for id in media_refs(e) {
                if store.get_blob(&id).is_none() {
                    want.insert(id);
                }
            }
        }
    }

    let syncing: Arc<Mutex<HashSet<PeerId>>> = Arc::new(Mutex::new(HashSet::new()));
    let mut resync = tokio::time::interval(Duration::from_secs(30));
    let mut blob_tick = tokio::time::interval(Duration::from_secs(10));
    let mut heartbeat = tokio::time::interval(Duration::from_secs(30));
    resync.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = resync.tick() => {
                let peers: Vec<PeerId> = swarm.connected_peers().copied().collect();
                for peer in peers {
                    spawn_sync(syncing.clone(), control.clone(), store.clone(), peer);
                }
            }
            _ = blob_tick.tick() => {
                let peers: Vec<PeerId> = swarm.connected_peers().copied().collect();
                if !peers.is_empty() {
                    fetch_wanted_blobs(
                        control.clone(),
                        store.clone(),
                        wanted.clone(),
                        blob_failures.clone(),
                        peers,
                    );
                }
            }
            _ = heartbeat.tick() => {
                let guard = store.lock().await;
                tracing::info!(
                    "peers {} · events {} · authors {}",
                    swarm.connected_peers().count(),
                    guard.events.len(),
                    guard.heads.len()
                );
            }
            event = swarm.select_next_some() => {
                match event {
                    SwarmEvent::NewListenAddr { address, .. } => {
                        let full = address.clone().with(libp2p::multiaddr::Protocol::P2p(*swarm.local_peer_id()));
                        println!("listening on {full}");
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Mdns(mdns::Event::Discovered(list))) => {
                        for (peer, addr) in list {
                            tracing::info!("found {peer} on the local network");
                            swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer);
                            let _ = swarm.dial(addr);
                        }
                    }
                    SwarmEvent::ConnectionEstablished { peer_id, .. } => {
                        tracing::info!("connected to {peer_id}");
                        swarm.behaviour_mut().gossipsub.add_explicit_peer(&peer_id);
                        spawn_sync(syncing.clone(), control.clone(), store.clone(), peer_id);
                    }
                    SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Message {
                        message, ..
                    })) => {
                        ingest_gossip(&store, &wanted, &message.data).await;
                    }
                    _ => {}
                }
            }
        }
    }
}

fn publish(
    swarm: &mut libp2p::Swarm<Behaviour>,
    topic: &gossipsub::IdentTopic,
    event: &store::Event,
) {
    let payload = json!({ "type": "event", "event": event });
    match serde_json::to_vec(&payload) {
        Ok(bytes) => {
            if let Err(err) = swarm.behaviour_mut().gossipsub.publish(topic.clone(), bytes) {
                // Nobody subscribed yet is normal on a fresh network; sync will
                // deliver the event as soon as a peer shows up.
                tracing::debug!("could not gossip the event yet: {err}");
            }
        }
        Err(err) => tracing::warn!("could not encode the event: {err}"),
    }
}

/// Blob ids an event points at: attachments and profile avatars.
fn media_refs(event: &Event) -> Vec<String> {
    let mut out = Vec::new();
    // Only real blob ids. `Store::verify` refuses anything else now, but this
    // is where the value used to be sliced by byte offset, so it checks here
    // as well rather than relying on a caller two layers away.
    let mut take = |v: Option<&str>| {
        if let Some(id) = v {
            if is_blob_id(id) {
                out.push(id.to_string());
            }
        }
    };
    if let Some(list) = event.content.get("media").and_then(|m| m.as_array()) {
        for item in list {
            take(item.get("blob").and_then(|b| b.as_str()));
        }
    }
    take(event.content.get("avatar").and_then(|a| a.as_str()));
    out
}

/// Ask connected peers, one at a time, for each blob we are missing.
///
/// Holding media is what makes an always-on peer worth running: a photo whose
/// only other copy is on a phone in someone's pocket is a photo that is usually
/// unreachable.
fn fetch_wanted_blobs(
    mut control: stream::Control,
    store: Arc<Mutex<Store>>,
    wanted: Arc<Mutex<HashSet<String>>>,
    failed: Arc<Mutex<HashMap<String, u32>>>,
    peers: Vec<PeerId>,
) {
    tokio::spawn(async move {
        let ids: Vec<String> = wanted.lock().await.iter().cloned().collect();
        for id in ids {
            let mut got = false;
            for peer in &peers {
                let protocol = StreamProtocol::new(BLOB_PROTOCOL);
                let Ok(Ok(mut s)) =
                    timeout(BLOB_TIMEOUT, control.open_stream(*peer, protocol)).await
                else {
                    continue;
                };
                match timeout(BLOB_TIMEOUT, sync::fetch_blob(&mut s, &id)).await {
                    Ok(Ok(Some(bytes))) => {
                        let len = bytes.len();
                        if store.lock().await.put_blob(&bytes).is_ok() {
                            wanted.lock().await.remove(&id);
                            failed.lock().await.remove(&id);
                            tracing::info!("fetched media {} ({len} bytes)", short_id(&id));
                            got = true;
                        }
                        break;
                    }
                    Ok(Ok(None)) => continue,
                    Ok(Err(err)) => tracing::debug!("blob {id} from {peer} failed: {err}"),
                    Err(_) => tracing::debug!("blob {id} from {peer} timed out"),
                }
            }

            if got {
                continue;
            }
            // A post can name media that exists nowhere. Retrying it against
            // every peer every ten seconds, forever, is free work for whoever
            // wrote the post and none for us.
            let mut f = failed.lock().await;
            let attempts = f.entry(id.clone()).or_insert(0);
            *attempts += 1;
            if *attempts >= MAX_BLOB_ATTEMPTS {
                wanted.lock().await.remove(&id);
                tracing::info!("giving up on media {} - no connected peer holds it", short_id(&id));
            }
        }
    });
}

/// First few characters of an id, without slicing inside a character.
fn short_id(id: &str) -> String {
    id.chars().take(10).collect()
}

async fn ingest_gossip(
    store: &Arc<Mutex<Store>>,
    wanted: &Arc<Mutex<HashSet<String>>>,
    data: &[u8],
) {
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(data) else {
        return;
    };
    if payload.get("type").and_then(|t| t.as_str()) != Some("event") {
        return;
    }
    let Some(raw) = payload.get("event") else { return };
    let Ok(event) = serde_json::from_value::<store::Event>(raw.clone()) else {
        return;
    };

    let refs = media_refs(&event);
    let mut guard = store.lock().await;
    match guard.put(event, now_ms()) {
        Put::Stored => {
            tracing::info!("received an event by gossip");
            let mut want = wanted.lock().await;
            for id in refs {
                if guard.get_blob(&id).is_none() {
                    want.insert(id);
                }
            }
        }
        Put::Rejected(reason) => tracing::warn!("gossip rejected: {reason}"),
        _ => {}
    }
}

/// Open a sync stream to one peer, unless one is already in flight.
fn spawn_sync(
    syncing: Arc<Mutex<HashSet<PeerId>>>,
    mut control: stream::Control,
    store: Arc<Mutex<Store>>,
    peer: PeerId,
) {
    tokio::spawn(async move {
        // Held for the whole exchange, not just the moment it starts. A
        // connection event and the thirty second tick otherwise each open
        // their own stream to the same peer.
        if !syncing.lock().await.insert(peer) {
            return;
        }

        let protocol = StreamProtocol::new(SYNC_PROTOCOL);
        let result = timeout(SYNC_TIMEOUT, async {
            let mut s = control.open_stream(peer, protocol).await?;
            sync::sync_outbound(&mut s, &store).await
        })
        .await;

        match result {
            Ok(Ok(o)) if o.received > 0 || o.sent > 0 => {
                tracing::info!("synced with {peer}: received {}, sent {}", o.received, o.sent)
            }
            Ok(Ok(_)) => {}
            Ok(Err(err)) => tracing::debug!("sync with {peer} failed: {err}"),
            Err(_) => tracing::debug!("sync with {peer} timed out"),
        }

        syncing.lock().await.remove(&peer);
    });
}
