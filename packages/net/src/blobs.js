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
  }).catch((err) => log(`could not register blob handler: ${err.message}`))
}

/**
 * Ask one peer for one blob.
 * @returns {Promise<Uint8Array|null>}
 */
export async function fetchBlobFrom (libp2p, peerId, id) {
  if (!isBlobId(id)) throw new Error(`not a blob id: ${id}`)
  const signal = AbortSignal.timeout(TIMEOUTS.blob)
  const stream = await libp2p.dialProtocol(peerId, BLOB_PROTOCOL, { signal })
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
 * try each connected peer in turn until someone has it.
 */
export class BlobFetcher {
  constructor (libp2p, s2s, opts = {}) {
    this.libp2p = libp2p
    this.s2s = s2s
    this.log = opts.log ?? (() => {})
    this.wanted = new Set()
    this.inFlight = new Set()
    this.failed = new Map() // id -> attempts
    this.maxAttempts = opts.maxAttempts ?? 6
    // A post can name media that exists nowhere. Without a ceiling, one peer
    // can grow this set for free and have us dial every peer for every entry.
    this.maxWanted = opts.maxWanted ?? 2_000
  }

  /** Scan an event for media we do not have yet. */
  async consider (event) {
    const refs = []
    const c = event?.content ?? {}
    if (Array.isArray(c.media)) refs.push(...c.media.map((m) => m.blob))
    if (c.avatar) refs.push(c.avatar)

    for (const id of refs) {
      if (!isBlobId(id) || this.wanted.has(id)) continue
      if (this.wanted.size >= this.maxWanted) break
      if ((this.failed.get(id) ?? 0) >= this.maxAttempts) continue
      if (await this.s2s.store.getBlob(id)) continue
      this.wanted.add(id)
    }
    this.drain()
  }

  drain () {
    if (this.wanted.size === 0) return
    const peers = this.libp2p.getPeers()
    if (peers.length === 0) return

    for (const id of [...this.wanted]) {
      if (this.inFlight.has(id)) continue
      this.inFlight.add(id)
      this.#tryFetch(id, peers).finally(() => this.inFlight.delete(id))
    }
  }

  async #tryFetch (id, peers) {
    for (const peer of peers) {
      try {
        const bytes = await fetchBlobFrom(this.libp2p, peer, id)
        if (bytes) {
          await this.s2s.store.putBlob(id, bytes)
          this.wanted.delete(id)
          this.failed.delete(id)
          this.log(`fetched media ${id.slice(0, 10)} (${bytes.length} bytes)`)
          return
        }
      } catch {
        // try the next peer
      }
    }
    const attempts = (this.failed.get(id) ?? 0) + 1
    this.failed.set(id, attempts)
    if (attempts >= this.maxAttempts) {
      this.wanted.delete(id)
      this.log(`giving up on media ${id.slice(0, 10)} - no connected peer holds it`)
    }
  }
}
