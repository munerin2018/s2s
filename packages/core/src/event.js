/**
 * The S2S event model.
 *
 * Every action a user takes - posting, replying, liking, following, opening a
 * board thread - is one immutable event appended to that user's own log. A log
 * is a hash chain: event N names event N-1, and the whole thing is signed. A
 * peer can therefore hand you someone else's posts and you can check they are
 * genuine and complete without trusting the peer at all.
 */
import { canonical, utf8, eventId, isAuthorId, isEventId, isBlobId, b58, unb58 } from './codec.js'
import { sign, verify } from './identity.js'

export const KINDS = /** @type {const} */ ([
  'profile', // who I am
  'post',    // Twitter-style / Instagram-style top level post
  'reply',   // reply to a post, also used for 2ch thread posts
  'like',    // vote on an event
  'repost',  // boost someone else's post into my followers' timelines
  'follow',
  'unfollow',
  'block',
  'unblock',
  'thread',  // 2ch-style: open a new thread on a board
  'delete'   // tombstone for one of my own events
])

const KIND_SET = new Set(KINDS)

export const LIMITS = {
  text: 2000,
  name: 64,
  bio: 400,
  title: 120,
  media: 8,
  tags: 12,
  tag: 48,
  board: 48,
  futureSkewMs: 5 * 60 * 1000
}

/**
 * @typedef {object} S2SEvent
 * @property {string}  author  author id (`@...`)
 * @property {number}  seq     1-based position in the author's log
 * @property {string|null} prev id of event `seq-1`, null when seq === 1
 * @property {number}  ts      author-claimed unix ms (advisory only)
 * @property {string}  kind
 * @property {object}  content
 * @property {string}  sig     base58 ed25519 signature over canonical(body)
 * @property {string}  id      base58 sha256 of canonical(signed event)
 */

/** The only members an event may have. Anything else is not part of S2S. */
export const EVENT_FIELDS = ['author', 'seq', 'prev', 'ts', 'kind', 'content', 'sig', 'id']

/** The part that gets signed. `sig` and `id` are derived, never signed over. */
function body (e) {
  return { author: e.author, seq: e.seq, prev: e.prev, ts: e.ts, kind: e.kind, content: e.content }
}

/**
 * Reduce an event to exactly the members the protocol defines.
 *
 * The signature and the id cover only those members, so a peer can staple
 * anything it likes onto an otherwise valid event and we would still verify
 * it, store it and pass it on - a free amplifier. Rebuilding the object means
 * whatever we relay is exactly what we verified, and nothing more.
 *
 * `content` is copied through untouched: it is *inside* the signed body, so
 * removing anything from it would change the bytes the signature covers.
 * Unknown members there are refused outright instead, in `validateShape`.
 */
export function sanitize (e) {
  return {
    author: e.author,
    seq: e.seq,
    prev: e.prev,
    ts: e.ts,
    kind: e.kind,
    content: e.content,
    sig: e.sig,
    id: e.id
  }
}

/** Content members defined for each kind. Unknown members are refused. */
export const CONTENT_FIELDS = {
  profile: ['name', 'bio', 'avatar'],
  post: ['text', 'media', 'tags', 'board'],
  reply: ['root', 'parent', 'text', 'media'],
  like: ['target', 'value'],
  repost: ['target'],
  follow: ['target'],
  unfollow: ['target'],
  block: ['target'],
  unblock: ['target'],
  thread: ['board', 'title', 'text', 'media'],
  delete: ['target']
}

const MEDIA_FIELDS = ['blob', 'mime', 'w', 'h', 'alt']

/** @returns {string|null} the offending key, or null */
function unknownKey (obj, allowed) {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) continue
    if (!allowed.includes(key)) return key
  }
  return null
}

/** Bytes a signature is made over. */
export const signingBytes = (e) => utf8(canonical(body(e)))

/** Bytes the event id is derived from: the body *plus* its signature. */
export const idBytes = (e) => utf8(canonical({ ...body(e), sig: e.sig }))

/**
 * Build and sign the next event in an author's log.
 * @param {import('./identity.js').Identity} identity
 * @param {{ seq: number, prev: string|null }} head
 * @param {string} kind
 * @param {object} content
 * @param {number} [ts]
 * @returns {S2SEvent}
 */
export function createEvent (identity, head, kind, content, ts = Date.now()) {
  const draft = {
    author: identity.id,
    seq: head.seq,
    prev: head.prev,
    ts,
    kind,
    content
  }
  const err = validateShape(draft)
  if (err) throw new Error(`invalid event: ${err}`)
  const signed = { ...draft, sig: b58(sign(identity, signingBytes(draft))) }
  return { ...signed, id: eventId(idBytes(signed)) }
}

/**
 * Structural validation. Runs before signing (so we never sign junk) and again
 * on receive (so a peer cannot feed us junk that merely happens to be signed).
 * @returns {string|null} an error message, or null when the event is well formed
 */
export function validateShape (e) {
  if (!e || typeof e !== 'object') return 'not an object'
  if (!isAuthorId(e.author)) return 'bad author'
  if (!Number.isInteger(e.seq) || e.seq < 1) return 'bad seq'
  if (e.seq === 1) {
    if (e.prev !== null) return 'first event must have prev=null'
  } else if (!isEventId(e.prev)) return 'bad prev'
  if (!Number.isInteger(e.ts) || e.ts < 0) return 'bad ts'
  if (!KIND_SET.has(e.kind)) return `unknown kind ${e.kind}`
  if (!e.content || typeof e.content !== 'object' || Array.isArray(e.content)) return 'bad content'

  // Refuse members the kind does not define. Without this, two peers can hold
  // the same event under the same id while disagreeing about its bytes.
  const stray = unknownKey(e.content, CONTENT_FIELDS[e.kind])
  if (stray) return `content has an unknown member: ${stray}`

  return validateContent(e.kind, e.content)
}

function str (v, max) { return typeof v === 'string' && v.length <= max }

function validateMedia (media) {
  if (media === undefined) return null
  if (!Array.isArray(media) || media.length > LIMITS.media) return 'bad media list'
  for (const m of media) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return 'bad media entry'
    const stray = unknownKey(m, MEDIA_FIELDS)
    if (stray) return `media entry has an unknown member: ${stray}`
    if (!isBlobId(m.blob)) return 'bad media blob id'
    if (!str(m.mime ?? '', 80)) return 'bad media mime'
    if (m.alt !== undefined && !str(m.alt, 300)) return 'bad media alt'
    for (const k of ['w', 'h']) {
      if (m[k] !== undefined && (!Number.isInteger(m[k]) || m[k] < 0)) return `bad media ${k}`
    }
  }
  return null
}

function validateTags (tags) {
  if (tags === undefined) return null
  if (!Array.isArray(tags) || tags.length > LIMITS.tags) return 'bad tags'
  for (const t of tags) if (!str(t, LIMITS.tag)) return 'bad tag'
  return null
}

function validateContent (kind, c) {
  switch (kind) {
    case 'profile':
      if (!str(c.name ?? '', LIMITS.name)) return 'bad name'
      if (c.bio !== undefined && !str(c.bio, LIMITS.bio)) return 'bad bio'
      if (c.avatar !== undefined && !isBlobId(c.avatar)) return 'bad avatar'
      return null
    case 'post': {
      if (!str(c.text ?? '', LIMITS.text)) return 'bad text'
      const hasText = (c.text ?? '').trim().length > 0
      const hasMedia = Array.isArray(c.media) && c.media.length > 0
      if (!hasText && !hasMedia) return 'post must have text or media'
      if (c.board !== undefined && !str(c.board, LIMITS.board)) return 'bad board'
      return validateMedia(c.media) ?? validateTags(c.tags)
    }
    case 'reply': {
      if (!isEventId(c.root)) return 'bad root'
      if (!isEventId(c.parent)) return 'bad parent'
      if (!str(c.text ?? '', LIMITS.text)) return 'bad text'
      const hasText = (c.text ?? '').trim().length > 0
      const hasMedia = Array.isArray(c.media) && c.media.length > 0
      if (!hasText && !hasMedia) return 'reply must have text or media'
      return validateMedia(c.media)
    }
    case 'like':
      if (!isEventId(c.target)) return 'bad target'
      if (c.value !== 1 && c.value !== -1) return 'bad like value'
      return null
    case 'repost':
      return isEventId(c.target) ? null : 'bad target'
    case 'follow':
    case 'unfollow':
    case 'block':
    case 'unblock':
      return isAuthorId(c.target) ? null : 'bad target'
    case 'thread':
      if (!str(c.board ?? '', LIMITS.board) || !(c.board ?? '').trim()) return 'bad board'
      if (!str(c.title ?? '', LIMITS.title) || !(c.title ?? '').trim()) return 'bad title'
      if (!str(c.text ?? '', LIMITS.text)) return 'bad text'
      return validateMedia(c.media)
    case 'delete':
      return isEventId(c.target) ? null : 'bad target'
    default:
      return `unknown kind ${kind}`
  }
}

/**
 * Full verification of an event received from the network.
 * Checks shape, signature, and that the id really is the hash of the content.
 * @param {S2SEvent} e
 * @param {{ now?: number }} [opts]
 * @returns {string|null} error message, or null when the event is valid
 */
export function verifyEvent (e, opts = {}) {
  const shape = validateShape(e)
  if (shape) return shape
  if (typeof e.sig !== 'string' || typeof e.id !== 'string') return 'missing sig/id'

  let sigBytes
  try { sigBytes = unb58(e.sig) } catch { return 'bad sig encoding' }
  if (sigBytes.length !== 64) return 'bad sig length'
  if (!verify(e.author, signingBytes(e), sigBytes)) return 'signature does not verify'

  if (eventId(idBytes(e)) !== e.id) return 'id does not match content'

  const now = opts.now ?? Date.now()
  if (e.ts > now + LIMITS.futureSkewMs) return 'timestamp too far in the future'
  return null
}

/** Recompute an event's id. Used when an event arrives without one. */
export function withId (e) {
  return { ...e, id: eventId(idBytes(e)) }
}
