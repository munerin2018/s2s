import { signObject, verify } from '../../core/src/identity.js'
import { canonical, utf8, b58, unb58, isAuthorId } from '../../core/src/codec.js'
import { jsonStream } from './protocol.js'
import { publicPeerRoutes } from './peer-routes.js'

export const PRESENCE_PROTOCOL = '/s2s/1.0.0/presence'
const MAX_PRESENCE_BYTES = 24 * 1024

export function presenceProof (identity, peerId, nonce, addresses = []) {
  const payload = { author: identity.id, peerId, nonce, addresses: publicPeerRoutes(addresses, addresses).slice(0, 16) }
  return { ...payload, signature: b58(signObject(identity, payload)) }
}

export function verifyPresence (proof, peerId, nonce) {
  try {
    if (!isAuthorId(proof?.author) || proof.peerId !== peerId || proof.nonce !== nonce ||
        !Array.isArray(proof.addresses) || proof.addresses.length > 16) return false
    const { signature, ...payload } = proof
    return verify(proof.author, utf8(canonical(payload)), unb58(signature))
  } catch { return false }
}

export async function handlePresence (node, identity) {
  await node.handle(PRESENCE_PROTOCOL, ({ stream }) => {
    ;(async () => {
      const signal = AbortSignal.timeout(8_000)
      const ch = jsonStream(stream, { maxDataLength: MAX_PRESENCE_BYTES })
      try {
        const { nonce } = await ch.read({ signal })
        if (typeof nonce !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(nonce)) throw new Error('invalid presence challenge')
        await ch.write(presenceProof(identity, node.peerId.toString(), nonce, node.getMultiaddrs().map(String)), { signal })
      } catch (err) { stream.abort(err) }
      finally { await stream.close().catch(() => {}) }
    })().catch(() => {})
  }, { runOnLimitedConnection: true })
}

export async function requestPresence (node, peerId) {
  const nonce = b58(crypto.getRandomValues(new Uint8Array(32)))
  const signal = AbortSignal.timeout(8_000)
  const stream = await node.dialProtocol(peerId, PRESENCE_PROTOCOL, { signal, runOnLimitedConnection: true })
  try {
    const ch = jsonStream(stream, { maxDataLength: MAX_PRESENCE_BYTES })
    await ch.write({ nonce }, { signal })
    const proof = await ch.read({ signal })
    if (!verifyPresence(proof, peerId.toString(), nonce)) throw new Error('invalid account presence signature')
    return proof
  } finally {
    // The signed reply is already complete. Waiting for a relay's FIN/close
    // acknowledgement must not delay displaying the reachable account.
    stream.close({ signal: AbortSignal.timeout(1_000) }).catch((err) => stream.abort(err))
  }
}
