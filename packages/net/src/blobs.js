/**
 * Media transfer.
 *
 * Images and video are never inlined into events. A post carries only the
 * blob's sha256, and the bytes are fetched from whichever connected peer
 * happens to hold them. Because the name *is* the hash, a lying peer is caught
 * for free: we hash what arrives and discard it if it does not match.
 *
 * The flip side is the honest one: a blob nobody keeps is a blob that
 * eventually cannot be fetched. There is no bucket paying to keep it alive.
 */
import { blobId, isBlobId } from '../../core/src/index.js'
import { BLOB_PROTOCOL, MAX_BLOB_BYTES, TIMEOUTS, jsonStream } from './protocol.js'

/** Serve blobs we hold to anyone who asks for one by hash. */
export function handleBlobs (libp2p, s2s, opts = {}) {
  const log = opts.log ?? (() => {})

  libp2p.handle(BLOB_PROTOCOL, ({ stream }) => {
    ;(async () => {
      const ch = jsonStream(stream, { maxDataLength: MAX_BLOB_BYTES })
      const signal = AbortSignal.timeout(TIMEOUTS.blob)
      try {
        const req = await ch.read({ signal })
        // `req.blob` is whatever the peer sent, so it is a claim rather than a
        // name. Anything that is not a blob id never reaches the store, let
        // alone the filesystem.
        const bytes = isBlobId(req?.blob) ? await s2s.store.getBlob(req.blob) : null
        if (!bytes) {
          await ch.write({ ok: false }, { signal })
          return
        }
        await ch.write({ ok: true, size: bytes.length }, { signal })
        await ch.writeBytes(bytes, { signal })
      } catch (err) {
        log(`blob serve failed: ${err.message}`)
      } finally {
        await stream.close().catch(() => {})
      }
    })()
  }, { runOnLimitedConnection: true }).catch((err) => log(`could not register blob handler: ${err.message}`))
}

/**
 * Ask one peer for one blob.
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchBlobFrom (libp2p, peerId, id, { timeoutMs = TIMEOUTS.blob } = {}) {
  if (!isBlobId(id)) throw new Error(`not a blob id: ${id}`)
  const signal = AbortSignal.timeout(timeoutMs)
  const stream = await libp2p.dialProtocol(peerId, BLOB_PROTOCOL, { signal, runOnLimitedConnection: true })
  const ch = jsonStream(stream, { maxDataLength: MAX_BLOB_BYTES })

  try {
    await ch.write({ blob: id }, { signal })
    const header = await ch.read({ signal })
    if (!header?.ok) return null
    if (header.size > MAX_BLOB_BYTES) throw new Error('blob too large')

    const bytes = await ch.readBytes({ signal })
    // The name is the hash. If they do not match, the peer is lying to us.
    if (blobId(bytes) !== id) throw new Error('blob content does not match its hash')
    return bytes
  } finally {
    await stream.close().catch(() => {})
  }
}

/**
 * Background fetcher: whenever an event references media we do not hold,
 * ask every connected peer for it until someone has it.
 *
 * Peers are asked in parallel with a short timeout, and a miss is retried on
 * a quick backoff rather than given up: in a chain like phone -> PC -> phone
 * the middle peer usually doesn't have the image yet at the moment we first
 * ask, and will a second or two later.
 */
export class BlobFetcher {
  constructor (libp2p, s2s, opts = {}) {
    this.libp2p = libp2p
    this.s2s = s2s
    this.log = opts.log ?? (() => {})
    this.wanted = new Map() // id -> { attempts, next }
    this.inFlight = new Set()
    this.timeoutMs = opts.timeoutMs ?? 45_000
    this.minDelay = opts.minDelay ?? 1_500
    this.maxDelay = opts.maxDelay ?? 30_000
    // A post can name media that exists nowhere. Without a ceiling, one peer
    // can grow this set for free and have us dial every peer for every entry.
    this.maxWanted = opts.maxWanted ?? 2_000
    this.timer = null
    this.stopped = false
    this.maxConcurrent = opts.maxConcurrent ?? 4
  }

  /** Scan an event for media we do not have yet. */
  async consider (event) {
    const refs = []
    const c = event?.content ?? {}
    if (Array.isArray(c.media)) refs.push(...c.media.map((m) => m?.blob))
    if (c.avatar) refs.push(c.avatar)

    for (const id of refs) {
      if (!isBlobId(id) || this.wanted.has(id)) continue
      if (this.wanted.size >= this.maxWanted) break
      if (await this.s2s.store.getBlob(id)) continue
      this.wanted.set(id, { attempts: 0, next: 0 })
    }
    this.drain()
  }

  /** Someone new is here and may hold what nobody else did: retry everything now. */
  async rescan (events) {
    for (const w of this.wanted.values()) { w.attempts = 0; w.next = 0 }
    for (const e of events) await this.consider(e)
    this.drain()
  }

  drain () {
    clearTimeout(this.timer)
    this.timer = null
    if (this.stopped || this.wanted.size === 0) return
    const peers = this.libp2p.getPeers()
    // Nobody to ask; a new connection calls rescan(), which lands back here.
    if (peers.length === 0) return

    const now = Date.now()
    let soonest = Infinity
    for (const [id, w] of this.wanted) {
      if (this.inFlight.has(id)) continue
      if (w.next > now) { soonest = Math.min(soonest, w.next); continue }
      if (this.inFlight.size >= this.maxConcurrent) break
      this.inFlight.add(id)
      this.#tryFetch(id, w, peers).finally(() => {
        this.inFlight.delete(id)
        this.#schedule()
      })
    }
    if (soonest !== Infinity) this.#schedule(soonest - now)
  }

  #schedule (delay) {
    if (this.stopped || this.wanted.size === 0 || this.timer) return
    if (delay === undefined) {
      const now = Date.now()
      let next = Infinity
      for (const [id, w] of this.wanted) if (!this.inFlight.has(id)) next = Math.min(next, w.next)
      if (next === Infinity) return
      delay = next - now
    }
    this.timer = setTimeout(() => { this.timer = null; this.drain() }, Math.max(200, delay))
  }

  async #tryFetch (id, w, peers) {
    const attempt = (peer) => fetchBlobFrom(this.libp2p, peer, id, { timeoutMs: this.timeoutMs })
      .then((bytes) => bytes ?? Promise.reject(new Error('not held')))
    try {
      const bytes = await Promise.any(peers.map(attempt))
      await this.s2s.store.putBlob(id, bytes)
      this.wanted.delete(id)
      this.log(`fetched media ${id.slice(0, 10)} (${bytes.length} bytes)`)
    } catch {
      w.attempts++
      w.next = Date.now() + Math.min(this.maxDelay, this.minDelay * 2 ** (w.attempts - 1))
    }
  }

  stop () { this.stopped = true; clearTimeout(this.timer); this.timer = null }
}
