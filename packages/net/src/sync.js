/**
 * Log replication.
 *
 * Two peers each announce a "have vector" - one integer per author saying how
 * far down that author's log they have got - and then each sends the other the
 * events it is missing. Because every log is a strictly ordered chain, the
 * cursor is a single number and the diff is exact. No set reconciliation, no
 * Merkle tree, no bloom filter.
 *
 * This is the same idea as an AT Protocol repo cursor or an SSB feed sequence.
 *
 * The exchange is strictly turn-taking, which makes it impossible to deadlock:
 *
 *   dialer  -> have
 *   dialer  <- have
 *   dialer  -> events*, end      (responder is reading)
 *   dialer  <- events*, end      (responder is writing)
 */
import { isAuthorId } from '../../core/src/index.js'
import { SYNC_PROTOCOL, MAX_EVENTS_PER_MESSAGE, TIMEOUTS, jsonStream } from './protocol.js'

/** At most this many authors in one have vector. */
const MAX_VECTOR_ENTRIES = 50_000

/** Upper bound on how long one side may keep a single sync going. */
const MAX_MESSAGES_PER_SYNC = 10_000

/**
 * Sanitise a have vector that came off the wire.
 *
 * Every number in it is chosen by the peer. An entry like `-1e12` turns the
 * send loop into billions of iterations with no `await` in any of them, which
 * blocks the event loop outright: a whole peer stopped by one small message.
 * Anything that is not a plain non-negative integer is read as "they have
 * nothing", which is the safe interpretation.
 */
export function cleanVector (vector) {
  const out = {}
  if (!vector || typeof vector !== 'object' || Array.isArray(vector)) return out

  let seen = 0
  for (const [author, seq] of Object.entries(vector)) {
    if (++seen > MAX_VECTOR_ENTRIES) break
    if (!isAuthorId(author)) continue
    if (!Number.isSafeInteger(seq) || seq < 0) continue
    out[author] = seq
  }
  return out
}

/**
 * @param {Record<string, number>} mine
 * @param {Record<string, number>} theirs
 * @returns {Array<{ author: string, from: number, to: number }>} ranges we can send them
 */
export function diff (mine, theirs) {
  const clean = cleanVector(theirs)
  const out = []
  for (const [author, myHead] of Object.entries(mine)) {
    const theirHead = clean[author] ?? 0
    if (myHead > theirHead) out.push({ author, from: theirHead + 1, to: myHead })
  }
  return out
}

/** Attach the responder side. Runs for the lifetime of the node. */
export function handleSync (libp2p, s2s, opts = {}) {
  const log = opts.log ?? (() => {})

  libp2p.handle(SYNC_PROTOCOL, ({ stream, connection }) => {
    const peer = connection.remotePeer.toString()

    ;(async () => {
      const ch = jsonStream(stream)
      const signal = AbortSignal.timeout(TIMEOUTS.sync)
      try {
        const theirHave = await ch.read({ signal })
        if (theirHave?.type !== 'have') throw new Error('expected a have vector')

        await ch.write({ type: 'have', vector: s2s.haveVector() }, { signal })

        const received = await readEvents(ch, s2s, log, peer, signal)
        const sent = await writeEvents(ch, s2s, theirHave.vector, signal)

        if (received || sent) log(`served ${short(peer)}: received ${received}, sent ${sent}`)
      } catch (err) {
        if (!isNormalClose(err)) log(`inbound sync with ${short(peer)} ended: ${err.message}`)
      } finally {
        await stream.close().catch(() => {})
      }
    })()
  }).catch((err) => log(`could not register sync handler: ${err.message}`))
}

/**
 * Dial a peer and reconcile logs in both directions.
 * @returns {Promise<{ received: number, sent: number }>}
 */
export async function syncWith (libp2p, s2s, peerId, opts = {}) {
  const log = opts.log ?? (() => {})
  const peer = peerId.toString()
  const signal = AbortSignal.timeout(TIMEOUTS.sync)

  const stream = await libp2p.dialProtocol(peerId, SYNC_PROTOCOL, { signal })
  const ch = jsonStream(stream)

  try {
    await ch.write({ type: 'have', vector: s2s.haveVector() }, { signal })

    const theirHave = await ch.read({ signal })
    if (theirHave?.type !== 'have') throw new Error('expected a have vector')

    const sent = await writeEvents(ch, s2s, theirHave.vector, signal)
    const received = await readEvents(ch, s2s, log, peer, signal)

    if (received || sent) log(`synced with ${short(peer)}: received ${received}, sent ${sent}`)
    return { received, sent }
  } finally {
    await stream.close().catch(() => {})
  }
}

/** Send every event the other side is missing, then `end`. */
async function writeEvents (ch, s2s, theirVector, signal) {
  const ranges = diff(s2s.haveVector(), theirVector ?? {})
  let sent = 0

  for (const r of ranges) {
    for (let from = r.from; from <= r.to; from += MAX_EVENTS_PER_MESSAGE) {
      const to = Math.min(from + MAX_EVENTS_PER_MESSAGE - 1, r.to)
      const events = s2s.store.logRange(r.author, from, to)
      if (events.length === 0) continue
      await ch.write({ type: 'events', events }, { signal })
      sent += events.length
    }
  }
  await ch.write({ type: 'end' }, { signal })
  return sent
}

/** Read event batches until the other side says `end`. */
async function readEvents (ch, s2s, log, peer, signal) {
  let stored = 0
  let messages = 0
  for (;;) {
    const msg = await ch.read({ signal })
    if (!msg || msg.type === 'end') return stored
    // A peer that never sends `end` would otherwise hold this open until the
    // timeout, feeding us whatever it likes in the meantime.
    if (++messages > MAX_MESSAGES_PER_SYNC) {
      log(`${short(peer)} sent too many messages in one sync; stopping`)
      return stored
    }
    if (msg.type !== 'events' || !Array.isArray(msg.events)) continue

    for (const e of msg.events) {
      const res = await s2s.store.put(e)
      if (res.stored) stored++
      else if (!res.ok) log(`rejected an event from ${short(peer)}: ${res.reason}`)
    }
  }
}

const isNormalClose = (err) =>
  /closed|reset|aborted|EOF|ended/i.test(err?.message ?? '') || err?.name === 'AbortError'

const short = (p) => (p.length > 12 ? p.slice(0, 6) + '…' + p.slice(-4) : p)
