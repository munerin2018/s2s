/**
 * The network layer.
 *
 * This module owns a libp2p node and glues it to a local `S2S` replica. It is
 * deliberately transport-agnostic: the caller passes in the transports that
 * make sense for where it is running, because that is the one thing that
 * genuinely differs between a desktop peer (TCP, mDNS on the LAN) and a browser
 * tab (WebRTC and WebSockets, reached through a relay).
 *
 * Everything above this line - the event model, the log, the views - is
 * identical on every platform.
 */
import { createLibp2p } from 'libp2p'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { multiaddr } from '@multiformats/multiaddr'

import { EVENT_TOPIC, boardTopic } from './protocol.js'
import { handleSync, syncWith } from './sync.js'
import { handleBlobs, BlobFetcher } from './blobs.js'

export class S2SNetwork extends EventTarget {
  /**
   * @param {object} opts
   * @param {import('../../core/src/s2s.js').S2S} opts.s2s
   * @param {any[]} opts.transports
   * @param {any[]} [opts.peerDiscovery]
   * @param {string[]} [opts.listen]
   * @param {object} [opts.services] extra libp2p services (relay server, dht)
   * @param {(msg: string) => void} [opts.log]
   */
  constructor (opts) {
    super()
    this.s2s = opts.s2s
    this.opts = opts
    this.log = opts.log ?? (() => {})
    this.libp2p = null
    this.blobFetcher = null
    this.syncing = new Set()
    this.stats = { received: 0, published: 0, rejected: 0 }
  }

  async start () {
    const { transports, peerDiscovery = [], listen = [], services = {} } = this.opts

    this.libp2p = await createLibp2p({
      addresses: { listen },
      transports: [...transports, circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      connectionManager: {
        minConnections: 0,
        maxConnections: 64
      },
      services: {
        identify: identify(),
        ping: ping(),
        pubsub: gossipsub({
          // A brand new network has nobody subscribed yet; without this the
          // very first post of the very first peer throws instead of queueing.
          allowPublishToZeroTopicPeers: true,
          ignoreDuplicatePublishError: true,
          emitSelf: false
        }),
        ...services
      }
    })

    handleSync(this.libp2p, this.s2s, { log: this.log })
    handleBlobs(this.libp2p, this.s2s, { log: this.log })
    this.blobFetcher = new BlobFetcher(this.libp2p, this.s2s, { log: this.log })

    // Any newly stored event may reference media we do not hold yet, no matter
    // whether it arrived by gossip, by sync, or was written locally.
    this.s2s.addEventListener('event', (evt) => {
      this.blobFetcher.consider(evt.detail)
      if (evt.detail.author !== this.s2s.me) this.#scheduleGossipForward()
    })

    this.#wirePubsub()
    this.#wirePeers()
    this.#wireLocalEvents()

    this.log(`peer id ${this.libp2p.peerId.toString()}`)
    for (const addr of this.libp2p.getMultiaddrs()) this.log(`listening on ${addr.toString()}`)

    // Pull any media referenced by events we already hold but never fetched.
    for (const e of this.s2s.store.events.values()) this.blobFetcher.consider(e)

    return this
  }

  async stop () {
    clearInterval(this.resyncTimer)
    clearTimeout(this.forwardTimer)
    await this.libp2p?.stop()
  }

  // ---- pubsub -----------------------------------------------------------

  #wirePubsub () {
    const pubsub = this.libp2p.services.pubsub

    // The whole handler is guarded. It is an async listener, so anything that
    // throws inside becomes an unhandled rejection, and Node ends the process
    // on those by default. A four byte gossip message must not be able to
    // stop a peer.
    pubsub.addEventListener('message', (evt) => {
      this.#onGossip(evt).catch((err) => {
        this.stats.rejected++
        this.log(`gossip handling failed: ${err.message}`)
      })
    })

    pubsub.subscribe(EVENT_TOPIC)
    this.log(`subscribed to ${EVENT_TOPIC}`)
  }

  async #onGossip (evt) {
    if (!evt.detail?.topic?.startsWith('s2s/v1/')) return

    let payload
    try {
      payload = JSON.parse(new TextDecoder().decode(evt.detail.data))
    } catch {
      return
    }
    // `JSON.parse('null')` succeeds, so the type check has to follow the parse
    // rather than living in the catch.
    if (!payload || typeof payload !== 'object') return
    if (payload.type !== 'event' || !payload.event || typeof payload.event !== 'object') return

    const res = await this.s2s.store.put(payload.event)
    if (res.stored) {
      this.stats.received++
      this.dispatchEvent(new CustomEvent('event', { detail: payload.event }))
    } else if (!res.ok) {
      this.stats.rejected++
      this.log(`gossip rejected: ${res.reason}`)
    } else if (res.reason?.startsWith('buffered')) {
      // We are behind on this author. Pull their log properly.
      this.#backfill()
    }
  }

  /** Subscribe to a 2ch-style board so its traffic reaches us even unfollowed. */
  subscribeBoard (board) {
    this.libp2p.services.pubsub.subscribe(boardTopic(board))
  }

  unsubscribeBoard (board) {
    this.libp2p.services.pubsub.unsubscribe(boardTopic(board))
  }

  // ---- peers ------------------------------------------------------------

  #wirePeers () {
    this.libp2p.addEventListener('peer:discovery', (evt) => {
      const id = evt.detail.id
      this.libp2p.dial(id).catch(() => {})
    })

    this.libp2p.addEventListener('peer:connect', (evt) => {
      this.log(`connected to ${short(evt.detail.toString())}`)
      this.dispatchEvent(new Event('peers'))
      // Give identify a moment to settle before we ask for their logs.
      setTimeout(() => this.syncPeer(evt.detail), 800)
      this.blobFetcher.drain()
    })

    this.libp2p.addEventListener('peer:disconnect', () => {
      this.dispatchEvent(new Event('peers'))
    })

    // Periodic reconciliation catches anything gossip missed.
    this.resyncTimer = setInterval(() => this.syncAll(), 30_000)
  }

  /**
   * Store and forward.
   *
   * Gossip only reaches peers whose mesh is already built, which is never true
   * in the first seconds of a connection - exactly when a small network does
   * most of its talking. So whenever we learn something new from anyone, we
   * offer it onward to everyone else we are connected to. On a personal-scale
   * network this is cheap, and it is what makes a chain of peers converge even
   * though the ends never meet.
   */
  #scheduleGossipForward () {
    if (this.forwardTimer) return
    this.forwardTimer = setTimeout(() => {
      this.forwardTimer = null
      this.syncAll().catch(() => {})
    }, 1_500)
  }

  async syncPeer (peerId) {
    const key = peerId.toString()
    if (this.syncing.has(key)) return
    this.syncing.add(key)
    try {
      const res = await syncWith(this.libp2p, this.s2s, peerId, { log: this.log })
      if (res.received) {
        this.blobFetcher.drain()
        this.dispatchEvent(new Event('sync'))
      }
    } catch (err) {
      this.log(`sync with ${short(key)} failed: ${err.message}`)
    } finally {
      this.syncing.delete(key)
    }
  }

  async syncAll () {
    for (const peer of this.libp2p.getPeers()) await this.syncPeer(peer)
  }

  /**
   * We are behind on someone. Reconciling with everyone is the cheapest
   * correct answer, but it has to be throttled: a peer can push us into this
   * branch with one small message, and an unthrottled response turns that
   * into an amplifier aimed at every peer we are connected to.
   */
  #backfill () {
    this.#scheduleGossipForward()
  }

  // ---- publishing -------------------------------------------------------

  #wireLocalEvents () {
    this.s2s.addEventListener('local', (evt) => {
      this.publish(evt.detail).catch((err) => this.log(`publish failed: ${err.message}`))
    })
  }

  /** Shout a freshly created event to the network. */
  async publish (event) {
    const data = new TextEncoder().encode(JSON.stringify({ type: 'event', event }))
    const topics = [EVENT_TOPIC]
    if (event.kind === 'thread' && event.content.board) topics.push(boardTopic(event.content.board))

    for (const topic of topics) {
      try {
        await this.libp2p.services.pubsub.publish(topic, data)
        this.stats.published++
      } catch (err) {
        if (!/no peers|PublishError/i.test(err?.message ?? '')) throw err
        // Nobody is listening yet. Sync will deliver it when someone appears.
      }
    }
  }

  // ---- introspection ----------------------------------------------------

  async connect (addr) {
    const ma = multiaddr(addr)
    await this.libp2p.dial(ma, { signal: AbortSignal.timeout(20_000) })
    return ma.toString()
  }

  peerInfo () {
    return {
      peerId: this.libp2p.peerId.toString(),
      addresses: this.libp2p.getMultiaddrs().map((m) => m.toString()),
      peers: this.libp2p.getPeers().map((p) => p.toString()),
      topics: this.libp2p.services.pubsub.getTopics(),
      stats: { ...this.stats }
    }
  }
}

const short = (p) => (p.length > 12 ? p.slice(0, 6) + '…' + p.slice(-4) : p)
