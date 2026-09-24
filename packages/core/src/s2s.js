/**
 * The application-level API.
 *
 * Everything the UI does goes through here: it owns the identity, appends to
 * the local log, and exposes the derived views. It knows nothing about the
 * network - `@s2s/net` attaches to it and replicates what it produces.
 */
import { createEvent } from './event.js'
import { S2SStore, MemoryBackend } from './store.js'
import { makeViews } from './timeline.js'
import { blobId } from './codec.js'
import { createIdentity, exportIdentity, importIdentity } from './identity.js'

export class S2S extends EventTarget {
  /**
   * @param {{ identity: import('./identity.js').Identity, backend?: object }} opts
   */
  constructor ({ identity, backend }) {
    super()
    this.identity = identity
    this.store = new S2SStore(backend ?? new MemoryBackend())
    this.filter = { authors: new Set(), events: new Set() }
    this.views = makeViews(this.store, identity.id, this.filter)
    this.store.addEventListener('change', () => this.dispatchEvent(new Event('change')))
    this.store.addEventListener('event', (ev) => {
      this.dispatchEvent(new CustomEvent('event', { detail: ev.detail }))
    })
  }

  get me () { return this.identity.id }

  async load () {
    await this.store.load()
    return this
  }

  // ---- writing to my own log -------------------------------------------

  /** @param {string} kind @param {object} content */
  async append (kind, content) {
    const head = this.store.nextHead(this.me)
    const event = createEvent(this.identity, head, kind, content)
    const res = await this.store.put(event, { trusted: true })
    if (!res.ok) throw new Error(`could not append: ${res.reason}`)
    this.dispatchEvent(new CustomEvent('local', { detail: event }))
    return event
  }

  post ({ text = '', media = [], tags = [], board }) {
    return this.append('post', clean({ text, media, tags, board }))
  }

  reply ({ root, parent, text = '', media = [] }) {
    return this.append('reply', clean({ root, parent: parent ?? root, text, media }))
  }

  thread ({ board, title, text = '', media = [] }) {
    return this.append('thread', clean({ board: board.trim(), title: title.trim(), text, media }))
  }

  async like (target, value = 1) {
    const current = this.store.myLike(target, this.me)
    // Clicking the same button again clears the vote.
    if (current === value) return this.append('like', { target, value: value === 1 ? -1 : 1 })
    return this.append('like', { target, value })
  }

  repost (target) { return this.append('repost', { target }) }

  follow (target) { return this.append('follow', { target }) }
  unfollow (target) { return this.append('unfollow', { target }) }
  block (target) { return this.append('block', { target }) }
  unblock (target) { return this.append('unblock', { target }) }

  /** Tombstone one of my own events. Peers that honour it stop showing it. */
  async remove (target) {
    const e = this.store.get(target)
    if (e && e.author !== this.me) throw new Error('you can only delete your own events')
    return this.append('delete', { target })
  }

  setProfile ({ name, bio, avatar }) {
    return this.append('profile', clean({ name, bio, avatar }))
  }

  // ---- media ------------------------------------------------------------

  /**
   * Store bytes locally and return the reference to embed in a post.
   * The bytes never leave the device until a peer asks for that exact hash.
   * @param {Uint8Array} bytes
   * @param {{ mime?: string, w?: number, h?: number, alt?: string }} meta
   */
  async addMedia (bytes, meta = {}) {
    const id = blobId(bytes)
    await this.store.putBlob(id, bytes)
    return clean({ blob: id, mime: meta.mime ?? 'application/octet-stream', w: meta.w, h: meta.h, alt: meta.alt })
  }

  getMedia (id) { return this.store.getBlob(id) }

  // ---- account ----------------------------------------------------------

  exportKey () { return exportIdentity(this.identity) }

  static newIdentity () { return createIdentity() }
  static importKey (text) { return importIdentity(text) }

  /**
   * Replace the device-local hide list. Mutated in place, so the views built
   * in the constructor see it without being rebuilt.
   * @param {{ authors?: string[], events?: string[] }} lists
   */
  setFilter ({ authors = [], events = [] } = {}) {
    this.filter.authors.clear()
    this.filter.events.clear()
    for (const a of authors) if (typeof a === 'string') this.filter.authors.add(a)
    for (const e of events) if (typeof e === 'string') this.filter.events.add(e)
    this.dispatchEvent(new Event('change'))
  }

  /** What we advertise to peers during sync. */
  haveVector () { return this.store.haveVector() }
}

/** Drop undefined/empty optional members so canonical encoding stays stable. */
function clean (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'string' && v === '' && k !== 'text' && k !== 'name') continue
    out[k] = v
  }
  return out
}
