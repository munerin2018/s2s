import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys'

/** Keep the phone's network identity stable across closing and reopening. */
export async function loadBrowserNetworkKey (backend) {
  const stored = await backend.getMeta('networkKey')
  if (stored) return privateKeyFromProtobuf(new Uint8Array(stored))
  const key = await generateKeyPair('Ed25519')
  await backend.setMeta('networkKey', privateKeyToProtobuf(key))
  return key
}
