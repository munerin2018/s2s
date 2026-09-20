/**
 * The local replica.
 *
 * Every peer keeps a full copy of the logs it cares about. Raw events go to a
 * pluggable backend (files on desktop, IndexedDB in the browser); every view
 * the UI needs - timelines, threads, like counts, follow graph - is a plain
 * in-memory index rebuilt from those events at startup. Indexes are derived
 * data and can always be thrown away and recomputed.
 */
import { verifyEvent, sanitize } from './event.js'
import { isBlobId } from './codec.js'

/** Backend contract: `{ loadEvents(), appendEvent(e), putBlob(id, bytes), getBlob(id), listBlobs() }` */

/** In-memory backend. Used for tests and as the fallback when nothing persists. */
export class MemoryBackend {
  constructor () {
    this.events = []
    this.blobs = new Map()
  }

  async loadEvents () { return this.events.slice() }
  async appendEvent (e) { this.events.push(e) }
  async putBlob (id, bytes) { this.blobs.set(id, bytes) }
  async getBlob (id) { return this.blobs.get(id) ?? null }
  async listBlobs () { return [...this.blobs.keys()] }
}

const setOf = (map, key) => {
  let s = map.get(key)
  if (!s) map.set(key, (s = new Set()))
  return s
}

const arrOf = (map, key) => {
  let a = map.get(key)
  if (!a) map.set(key, (a = []))
  return a
}

export class S2SStore extends EventTarget {
  /** @param {object} [backend] */
  constructor (backend = new MemoryBackend()) {
    super()
    this.backend = backend

    /** @type {Map<string, import('./event.js').S2SEvent>} */
    this.events = new Map()
    /** author -> events indexed by seq-1 @type {Map<string, any[]>} */
    this.logs = new Map()
    /** author -> { seq, id } @type {Map<string, {seq:number,id:string}>} */
    this.heads = new Map()

    /** events that arrived ahead of their predecessor: author -> seq -> event */
    this.pending = new Map()
    /** total buffered events across every author, not just per author */
    this.pendingCount = 0
    this.maxPending = 20_000
    this.maxPendingPerAuthor = 2_000

    /**
     * `put` is async, so two callers could otherwise interleave between
     * reading the head and appending. That is how two events end up at the
     * same seq with the fork check never firing. Everything goes through one
     * queue instead.
     */
    this.writeQueue = Promise.resolve()

    /** tombstones naming an event we have not received yet: target -> Set<author> */
    this.tombstonePending = new Map()

    // derived views
    this.posts = []                    // ids of post/thread/repost, newest last
    this.repliesByRoot = new Map()     // rootId -> [replyId]
    this.repliesByParent = new Map()   // parentId -> [replyId]
    this.likesByTarget = new Map()     // targetId -> Map<author, 1|-1>
    this.follows = new Map()           // author -> Set<author>
    this.followers = new Map()         // author -> Set<author>
    this.blocks = new Map()            // author -> Set<author>
    this.profiles = new Map()          // author -> { name, bio, avatar, updatedAt }
    this.boards = new Map()            // board -> [threadId]
    this.deleted = new Set()           // tombstoned event ids
    this.blobs = new Map()             // blobId -> Uint8Array (hot cache)
  }

  async load () {
    const stored = await this.backend.loadEvents()
    // Sort by (author, seq) so chains apply in order regardless of write order.
    stored.sort((a, b) => (a.author < b.author ? -1 : a.author > b.author ? 1 : a.seq - b.seq))
    for (const e of stored) this.#apply(e)
    await this.#drainPending()
    this.dispatchEvent(new Event('load'))
    return this
  }

  // ---- writing ----------------------------------------------------------

  /**
   * Validate and store one event.
   * @param {import('./event.js').S2SEvent} e
   * @param {{ trusted?: boolean }} [opts] trusted skips signature check (our own freshly signed events)
   * @returns {Promise<{ ok: boolean, reason?: string, stored?: boolean }>}
   */
  async put (e, opts = {}) {
    // One writer at a time. The check-then-append below is not atomic on its
    // own, and a peer feeding us two events at the same seq is exactly the
    // case the fork check exists to catch.
    const run = this.writeQueue.then(() => this.#put(e, opts), () => this.#put(e, opts))
    this.writeQueue = run.then(() => {}, () => {})
    return run
  }

  async #put (e, opts = {}) {
    if (!e || typeof e !== 'object') return { ok: false, reason: 'not an event' }
    if (this.events.has(e.id)) return { ok: true, stored: false, reason: 'duplicate' }

    if (!opts.trusted) {
      const err = verifyEvent(e)
      if (err) return { ok: false, reason: err }
    }

    // Keep only what the signature covers; drop anything stapled on.
    e = sanitize(e)

    const head = this.heads.get(e.author)
    const expected = head ? head.seq + 1 : 1

    if (e.seq > expected) {
      // Arrived early. Hold it until the gap is filled.
      const held = this.#hold(e)
      return {
        ok: true,
        stored: false,
        reason: held ? 'buffered: waiting for seq ' + expected : 'dropped: buffer full'
      }
    }
    if (e.seq < expected) {
      // We already have this position. Either a duplicate or a fork attempt.
      const existing = this.logs.get(e.author)?.[e.seq - 1]
      if (existing && existing.id !== e.id) {
        return { ok: false, reason: 'fork detected: author signed two events at seq ' + e.seq }
      }
      return { ok: true, stored: false, reason: 'duplicate' }
    }
    if (head && e.prev !== head.id) {
      return { ok: false, reason: 'prev does not match our head for this author' }
    }

    await this.backend.appendEvent(e)
    this.#apply(e)

    const drained = await this.#drainPendingFor(e.author)
    this.dispatchEvent(new CustomEvent('event', { detail: e }))
    this.dispatchEvent(new Event('change'))
    return { ok: true, stored: true, drained }
  }

  /** Where the next event in our own log goes. */
  nextHead (author) {
    const head = this.heads.get(author)
    return head ? { seq: head.seq + 1, prev: head.id } : { seq: 1, prev: null }
  }

  // ---- indexing ---------------------------------------------------------

  #apply (e) {
    this.events.set(e.id, e)
    arrOf(this.logs, e.author)[e.seq - 1] = e
    this.heads.set(e.author, { seq: e.seq, id: e.id })

    // A tombstone may have been waiting for this event to turn up so that its
    // author could be checked.
    const waiting = this.tombstonePending.get(e.id)
    if (waiting) {
      if (waiting.has(e.author)) this.deleted.add(e.id)
      this.tombstonePending.delete(e.id)
    }

    const c = e.content
    switch (e.kind) {
      case 'post':
      case 'repost':
        this.#insertPost(e.id)
        break
      case 'thread':
        this.#insertPost(e.id)
        arrOf(this.boards, c.board).push(e.id)
        break
      case 'reply':
        arrOf(this.repliesByRoot, c.root).push(e.id)
        arrOf(this.repliesByParent, c.parent).push(e.id)
        break
      case 'like': {
        let m = this.likesByTarget.get(c.target)
        if (!m) this.likesByTarget.set(c.target, (m = new Map()))
        m.set(e.author, c.value)
        break
      }
      case 'follow':
        setOf(this.follows, e.author).add(c.target)
        setOf(this.followers, c.target).add(e.author)
        break
      case 'unfollow':
        this.follows.get(e.author)?.delete(c.target)
        this.followers.get(c.target)?.delete(e.author)
        break
      case 'block':
        setOf(this.blocks, e.author).add(c.target)
        break
      case 'unblock':
        this.blocks.get(e.author)?.delete(c.target)
        break
      case 'profile':
        this.profiles.set(e.author, { ...c, updatedAt: e.ts })
        break
      case 'delete': {
        // Only the author of an event may tombstone it. When the target has
        // not arrived we cannot check that, and gossip delivers out of order
        // routinely - so the tombstone waits instead of being trusted.
        // Applying it early would let anyone censor anything by naming it
        // before it turns up.
        const target = this.events.get(c.target)
        if (target) {
          if (target.author === e.author) this.deleted.add(c.target)
        } else {
          setOf(this.tombstonePending, c.target).add(e.author)
        }
        break
      }
    }
  }

  /**
   * Keep `posts` ordered by timestamp with an insertion rather than a sort.
   *
   * A first sync delivers thousands of events one at a time; re-sorting the
   * whole array on each one is the difference between a moment and a minute.
   */
  #insertPost (id) {
    const ts = this.events.get(id)?.ts ?? 0
    let lo = 0
    let hi = this.posts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.events.get(this.posts[mid])?.ts ?? 0) <= ts) lo = mid + 1
      else hi = mid
    }
    this.posts.splice(lo, 0, id)
  }

  /**
   * Buffer an event that arrived ahead of its predecessor.
   *
   * Bounded twice over. A per-author cap is not enough on its own: keys are
   * free to make, so a peer can mint a fresh author for every orphan it sends
   * and never reach it.
   * @returns {boolean} whether it was kept
   */
  #hold (e) {
    let byAuthor = this.pending.get(e.author)
    if (!byAuthor) this.pending.set(e.author, (byAuthor = new Map()))
    if (byAuthor.has(e.seq)) return true
    if (byAuthor.size >= this.maxPendingPerAuthor) return false
    if (this.pendingCount >= this.maxPending && !this.#evictPending()) return false
    byAuthor.set(e.seq, e)
    this.pendingCount++
    return true
  }

  /** Drop the oldest author's buffer to make room. */
  #evictPending () {
    const victim = this.pending.keys().next()
    if (victim.done) return false
    this.pendingCount -= this.pending.get(victim.value).size
    this.pending.delete(victim.value)
    return true
  }

  #forget (author, seq) {
    const byAuthor = this.pending.get(author)
    if (!byAuthor?.delete(seq)) return
    this.pendingCount--
    if (byAuthor.size === 0) this.pending.delete(author)
  }

  async #drainPendingFor (author) {
    let count = 0
    for (;;) {
      const byAuthor = this.pending.get(author)
      if (!byAuthor) break
      const head = this.heads.get(author)
      const want = head ? head.seq + 1 : 1
      const next = byAuthor.get(want)
      if (!next) break
      this.#forget(author, want)
      if (head && next.prev !== head.id) break // fork; drop the branch
      await this.backend.appendEvent(next)
      this.#apply(next)
      // Drained events are as new to us as any other, so whatever watches for
      // new events - the media fetcher, store-and-forward - must hear about
      // them too.
      this.dispatchEvent(new CustomEvent('event', { detail: next }))
      count++
    }
    return count
  }

  async #drainPending () {
    for (const author of [...this.pending.keys()]) await this.#drainPendingFor(author)
  }

  // ---- reading ----------------------------------------------------------

  get (id) { return this.events.get(id) ?? null }

  /** Our "have" vector: what the sync protocol advertises to a peer. */
  haveVector () {
    /** @type {Record<string, number>} */
    const out = {}
    for (const [author, head] of this.heads) out[author] = head.seq
    return out
  }

  /** Events `from`..`to` of one author's log, inclusive, 1-based. */
  logRange (author, from, to) {
    const log = this.logs.get(author) ?? []
    return log.slice(Math.max(0, from - 1), to).filter(Boolean)
  }

  knownAuthors () { return [...this.heads.keys()] }

  profile (author) {
    const p = this.profiles.get(author)
    return {
      id: author,
      name: p?.name || author.slice(0, 9),
      bio: p?.bio || '',
      avatar: p?.avatar || null
    }
  }

  isDeleted (id) { return this.deleted.has(id) }

  likeScore (id) {
    const m = this.likesByTarget.get(id)
    if (!m) return { up: 0, down: 0, score: 0 }
    let up = 0
    let down = 0
    for (const v of m.values()) v === 1 ? up++ : down++
    return { up, down, score: up - down }
  }

  myLike (id, author) { return this.likesByTarget.get(id)?.get(author) ?? 0 }

  following (author) { return this.follows.get(author) ?? new Set() }
  blocked (author) { return this.blocks.get(author) ?? new Set() }

  replyCount (rootId) { return (this.repliesByRoot.get(rootId) ?? []).length }

  // ---- blobs ------------------------------------------------------------

  async putBlob (id, bytes) {
    if (!isBlobId(id)) throw new Error(`not a blob id: ${id}`)
    this.blobs.set(id, bytes)
    await this.backend.putBlob(id, bytes)
    this.dispatchEvent(new CustomEvent('blob', { detail: id }))
  }

  async getBlob (id) {
    // Called with whatever a peer asked for, so the shape is checked here
    // rather than trusting every backend to do it.
    if (!isBlobId(id)) return null
    const hot = this.blobs.get(id)
    if (hot) return hot
    const cold = await this.backend.getBlob(id)
    if (cold) this.blobs.set(id, cold)
    return cold
  }

  hasBlob (id) { return this.blobs.has(id) }
}
