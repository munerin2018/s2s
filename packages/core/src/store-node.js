/**
 * Filesystem backend, used by the desktop app and the headless peer.
 *
 * Events live in one append-only JSON Lines file, which matches how the log
 * actually behaves and makes the on-disk data trivially inspectable. Blobs are
 * separate files named after their content hash.
 */
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { b58, unb58, decodeId, isBlobId } from './codec.js'

export class FileBackend {
  /** @param {string} dir */
  constructor (dir) {
    this.dir = dir
    this.logPath = join(dir, 'events.jsonl')
    this.blobDir = join(dir, 'blobs')
    this.writeQueue = Promise.resolve()
  }

  async init () {
    await mkdir(this.dir, { recursive: true })
    await mkdir(this.blobDir, { recursive: true })
    if (!existsSync(this.logPath)) await writeFile(this.logPath, '')
    return this
  }

  async loadEvents () {
    if (!existsSync(this.logPath)) return []
    const out = []
    const rl = createInterface({ input: createReadStream(this.logPath, 'utf8'), crlfDelay: Infinity })
    let lineNo = 0
    for await (const line of rl) {
      lineNo++
      const t = line.trim()
      if (!t) continue
      try {
        out.push(JSON.parse(t))
      } catch {
        console.warn(`[store] skipping corrupt line ${lineNo} in events.jsonl`)
      }
    }
    return out
  }

  async appendEvent (e) {
    // Serialise writes so concurrent puts cannot interleave partial lines.
    this.writeQueue = this.writeQueue.then(() => appendFile(this.logPath, JSON.stringify(e) + '\n'))
    return this.writeQueue
  }

  /**
   * Map a blob id to a file inside the blob directory, and nowhere else.
   *
   * The id arrives from the network, so it is not a name - it is a claim. It
   * is decoded to its 32 bytes and re-encoded, which means the filename can
   * only ever be one of the 2^256 valid hashes. Interpolating the string
   * directly would let `&../identity.json` walk straight to the account key.
   * @returns {string|null} null when the id is not a blob id at all
   */
  #blobPath (id) {
    if (!isBlobId(id)) return null
    return join(this.blobDir, b58(decodeId(id).bytes))
  }

  async putBlob (id, bytes) {
    const path = this.#blobPath(id)
    if (!path) throw new Error(`refusing to store a blob under a bad id: ${id}`)
    if (existsSync(path)) return
    // A unique temp name: two peers can deliver the same blob at once, and a
    // shared scratch file would have them overwrite each other mid-write.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, path)
  }

  async getBlob (id) {
    const path = this.#blobPath(id)
    if (!path || !existsSync(path)) return null
    return new Uint8Array(await readFile(path))
  }

  async listBlobs () {
    try {
      const names = await readdir(this.blobDir)
      return names.filter((n) => !n.endsWith('.tmp')).map((n) => '&' + n)
    } catch {
      return []
    }
  }
}

/** Persist the account secret next to the log. */
export async function loadOrCreateSecret (dir) {
  const { createIdentity, fromSecretKey } = await import('./identity.js')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'identity.json')
  if (existsSync(path)) {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    return fromSecretKey(unb58(raw.secretKey))
  }
  const id = createIdentity()
  await writeFile(path, JSON.stringify({ id: id.id, secretKey: b58(id.secretKey) }, null, 2))
  return id
}
