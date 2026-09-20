/**
 * Wire protocol constants and framing.
 *
 * Three protocols, deliberately small:
 *
 *   /s2s/1.0.0/sync   pull whatever the other side has that we do not
 *   /s2s/1.0.0/blob   fetch one media blob by its content hash
 *   gossip "s2s/v1/events"  shout about an event the instant it is made
 *
 * Gossip gets you liveness; sync gets you completeness. Gossip alone loses
 * anything published while you were offline, which for a P2P SNS is most of it.
 */
import { lpStream } from 'it-length-prefixed-stream'
import { fromString, toString } from 'uint8arrays'

export const SYNC_PROTOCOL = '/s2s/1.0.0/sync'
export const BLOB_PROTOCOL = '/s2s/1.0.0/blob'
export const EVENT_TOPIC = 's2s/v1/events'
export const boardTopic = (board) => `s2s/v1/board/${board}`

/** Cap a single sync response so one peer cannot flood us in one shot. */
export const MAX_EVENTS_PER_MESSAGE = 200
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
export const MAX_BLOB_BYTES = 16 * 1024 * 1024

/** Timeouts, kept in one place so they are easy to reason about. */
export const TIMEOUTS = {
  sync: 60_000,
  message: 20_000,
  blob: 60_000
}

const raw = (frame) => (frame?.subarray ? frame.subarray() : frame)

/**
 * Length-prefixed JSON messages over a libp2p stream.
 *
 * libp2p v3 streams are message streams rather than it-pipe duplexes, so this
 * wraps `lpStream` into the small request/response shape the S2S protocols use.
 * @param {any} stream
 * @param {{ maxDataLength?: number }} [opts]
 */
export function jsonStream (stream, opts = {}) {
  const max = opts.maxDataLength ?? MAX_MESSAGE_BYTES
  const lp = lpStream(stream, { maxDataLength: max, maxBufferSize: max * 2 })

  return {
    async write (obj, options) {
      await lp.write(fromString(JSON.stringify(obj)), options)
    },
    async read (options) {
      return JSON.parse(toString(raw(await lp.read(options))))
    },
    async writeBytes (data, options) {
      await lp.write(data, options)
    },
    async readBytes (options) {
      return new Uint8Array(raw(await lp.read(options)))
    }
  }
}
