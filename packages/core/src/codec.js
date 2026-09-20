/**
 * S2S codec layer.
 *
 * Everything that gets signed or hashed passes through here, so that two
 * independent peers always produce byte-identical input for the same logical
 * object. Without that guarantee signatures are meaningless across machines.
 */
import { sha256 } from '@noble/hashes/sha2'
import { base58 } from '@scure/base'

const te = new TextEncoder()
const td = new TextDecoder()

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace,
 * `undefined` members dropped. Arrays keep their order (it is meaningful).
 * @param {any} value
 * @returns {string}
 */
export function canonical (value) {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number') {
    // Only safe integers. A float has no encoding that every language agrees
    // on - JavaScript writes 1.0 as `1`, Rust writes it as `1.0` - and two
    // peers that disagree about the bytes disagree about the signature. The
    // format therefore simply does not carry floats.
    if (!Number.isInteger(value)) throw new Error('canonical: numbers must be integers')
    if (!Number.isSafeInteger(value)) throw new Error('canonical: integer out of safe range')
    return String(value)
  }
  if (t === 'boolean' || t === 'string') return JSON.stringify(value)
  if (t === 'bigint') throw new Error('canonical: bigint unsupported')
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(byCodePoint)
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  throw new Error(`canonical: unsupported type ${t}`)
}

/**
 * Sort by code point rather than by UTF-16 code unit.
 *
 * `Array#sort` on strings compares code units, which places astral characters
 * below U+E000 because their surrogates are. Implementations that compare
 * UTF-8 bytes - Rust's `str` ordering, for one - sort by code point. Keys with
 * emoji in them are the case where the two disagree.
 */
function byCodePoint (a, b) {
  if (a === b) return 0
  const as = [...a]
  const bs = [...b]
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    const d = as[i].codePointAt(0) - bs[i].codePointAt(0)
    if (d !== 0) return d
  }
  return as.length - bs.length
}

/** @param {string} s */
export const utf8 = (s) => te.encode(s)
/** @param {Uint8Array} b */
export const fromUtf8 = (b) => td.decode(b)

/** @param {Uint8Array} b */
export const b58 = (b) => base58.encode(b)
/** @param {string} s */
export const unb58 = (s) => base58.decode(s)

/** @param {Uint8Array} b */
export const hash = (b) => sha256(b)

/**
 * Identifiers are prefixed so a bare string always tells you what it points at.
 *   @  author (32-byte ed25519 public key)
 *   %  event  (sha256 of the signed event)
 *   &  blob   (sha256 of the raw bytes)
 */
export const PREFIX = { AUTHOR: '@', EVENT: '%', BLOB: '&' }

export const authorId = (pub) => PREFIX.AUTHOR + b58(pub)
export const eventId = (bytes) => PREFIX.EVENT + b58(hash(bytes))
export const blobId = (bytes) => PREFIX.BLOB + b58(hash(bytes))

/** @param {string} id */
export function decodeId (id) {
  if (typeof id !== 'string' || id.length < 2) throw new Error('bad id')
  const kind = id[0]
  if (kind !== PREFIX.AUTHOR && kind !== PREFIX.EVENT && kind !== PREFIX.BLOB) {
    throw new Error(`bad id prefix: ${kind}`)
  }
  return { kind, bytes: unb58(id.slice(1)) }
}

export const isAuthorId = (v) => typeof v === 'string' && v[0] === PREFIX.AUTHOR && safe(v)
export const isEventId = (v) => typeof v === 'string' && v[0] === PREFIX.EVENT && safe(v)
export const isBlobId = (v) => typeof v === 'string' && v[0] === PREFIX.BLOB && safe(v)

function safe (v) {
  try { return decodeId(v).bytes.length === 32 } catch { return false }
}
