/**
 * IndexedDB backend for the web build.
 *
 * This is what makes the "fully static site" claim honest: the page is served
 * as dead files, and every byte of the user's account lives in their own
 * browser. Nothing is uploaded anywhere on save.
 */
import { isBlobId } from './codec.js'

const DB_NAME = 's2s'
const DB_VERSION = 1

function open () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const tx = (db, store, mode, fn) =>
  new Promise((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => resolve(req?.result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })

/** Reject ids that are not blob ids before they reach a keyed store. */
function checkBlobId (id) {
  if (!isBlobId(id)) throw new Error(`not a blob id: ${id}`)
  return id
}

export class IdbBackend {
  async init () {
    this.db = await open()
    return this
  }

  async loadEvents () {
    return (await tx(this.db, 'events', 'readonly', (s) => s.getAll())) ?? []
  }

  async appendEvent (e) {
    await tx(this.db, 'events', 'readwrite', (s) => s.put(e))
  }

  async putBlob (id, bytes) {
    await tx(this.db, 'blobs', 'readwrite', (s) => s.put(bytes, checkBlobId(id)))
  }

  async getBlob (id) {
    if (!isBlobId(id)) return null
    const v = await tx(this.db, 'blobs', 'readonly', (s) => s.get(id))
    if (!v) return null
    return v instanceof Uint8Array ? v : new Uint8Array(v)
  }

  async listBlobs () {
    return (await tx(this.db, 'blobs', 'readonly', (s) => s.getAllKeys())) ?? []
  }

  async getMeta (key) {
    return tx(this.db, 'meta', 'readonly', (s) => s.get(key))
  }

  async setMeta (key, value) {
    await tx(this.db, 'meta', 'readwrite', (s) => s.put(value, key))
  }
}

/**
 * The account key in the browser. Stored in IndexedDB, never transmitted.
 * If the user clears site data this identity is gone - the UI warns about that
 * and offers the export string as a backup.
 */
export async function loadOrCreateSecretIdb (backend) {
  const { createIdentity, fromSecretKey } = await import('./identity.js')
  const { b58, unb58 } = await import('./codec.js')
  const existing = await backend.getMeta('secretKey')
  if (existing) return fromSecretKey(unb58(existing))
  const id = createIdentity()
  await backend.setMeta('secretKey', b58(id.secretKey))
  return id
}
