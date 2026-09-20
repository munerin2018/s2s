/**
 * A user *is* an ed25519 keypair. There is no account server, no sign-up and
 * nothing to revoke centrally: losing the secret key loses the identity.
 */
import { ed25519 } from '@noble/curves/ed25519'
import { authorId, b58, unb58, utf8, canonical } from './codec.js'

/**
 * @typedef {{ id: string, publicKey: Uint8Array, secretKey: Uint8Array }} Identity
 */

/** @returns {Identity} */
export function createIdentity () {
  const secretKey = ed25519.utils.randomPrivateKey()
  return fromSecretKey(secretKey)
}

/** @param {Uint8Array} secretKey @returns {Identity} */
export function fromSecretKey (secretKey) {
  if (secretKey.length !== 32) throw new Error('secret key must be 32 bytes')
  const publicKey = ed25519.getPublicKey(secretKey)
  return { id: authorId(publicKey), publicKey, secretKey }
}

/** Portable backup form. This string is the whole account — treat it as a password. */
export function exportIdentity (identity) {
  return 's2s-secret-' + b58(identity.secretKey)
}

/** @param {string} text */
export function importIdentity (text) {
  const t = String(text).trim()
  const raw = t.startsWith('s2s-secret-') ? t.slice('s2s-secret-'.length) : t
  return fromSecretKey(unb58(raw))
}

/** @param {Identity} identity @param {Uint8Array} bytes */
export function sign (identity, bytes) {
  return ed25519.sign(bytes, identity.secretKey)
}

/** @param {string} author @param {Uint8Array} bytes @param {Uint8Array} sig */
export function verify (author, bytes, sig) {
  try {
    const pub = unb58(author.slice(1))
    return ed25519.verify(sig, bytes, pub)
  } catch {
    return false
  }
}

/** Sign an arbitrary object with the canonical encoding. */
export function signObject (identity, obj) {
  return sign(identity, utf8(canonical(obj)))
}
