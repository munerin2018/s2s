/**
 * Persisted network identity for a desktop or headless peer.
 *
 * This is deliberately *not* the account key. The account names a person and
 * lives in `identity.json`; this one names a network endpoint and lives in
 * `libp2p-key`. Deriving one from the other would mean that anyone you merely
 * connect to learns which person you are, so they stay separate - the same
 * split `docs/PROTOCOL.md` describes.
 *
 * Both this key and the WebRTC certificate in the datastore exist for one
 * practical reason: a multiaddr someone wrote down has to keep working. It
 * ends in `/p2p/<peer id>` and, for WebRTC Direct, also carries
 * `/certhash/<hash>`. Regenerate either at startup and every saved address
 * silently stops resolving.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

/**
 * Load the peer's libp2p key from `<dir>/libp2p-key`, creating one on first run.
 * @param {string} dir
 */
export async function loadOrCreateNetworkKey (dir) {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'libp2p-key')

  if (existsSync(path)) {
    try {
      return privateKeyFromProtobuf(new Uint8Array(await readFile(path)))
    } catch {
      // A truncated or hand-edited file should cost you a new peer id, not a
      // peer that refuses to start.
      console.warn('[s2s] libp2p-key could not be read; generating a new one')
    }
  }

  const key = await generateKeyPair('Ed25519')
  await writeFile(path, privateKeyToProtobuf(key))
  return key
}

/**
 * A datastore for the libp2p keychain, which is where the WebRTC Direct
 * certificate is kept between runs.
 * @param {string} dir
 */
export async function openNetworkDatastore (dir) {
  const { LevelDatastore } = await import('datastore-level')
  const store = new LevelDatastore(join(dir, 'libp2p'))
  await store.open()
  return store
}
