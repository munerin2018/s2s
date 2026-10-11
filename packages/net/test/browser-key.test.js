import { test } from 'node:test'
import assert from 'node:assert/strict'
import { peerIdFromPrivateKey } from '@libp2p/peer-id'
import { loadBrowserNetworkKey } from '../src/browser-key.js'

test('phone network identity survives reopening and stays separate from account key', async () => {
  const meta = new Map([['secretKey', 'account-secret-must-not-be-used']])
  const backend = { getMeta: async (k) => meta.get(k), setMeta: async (k, v) => meta.set(k, v) }
  const first = await loadBrowserNetworkKey(backend)
  const second = await loadBrowserNetworkKey(backend)
  assert.equal(peerIdFromPrivateKey(first).toString(), peerIdFromPrivateKey(second).toString())
  assert.equal(meta.get('secretKey'), 'account-secret-must-not-be-used')
  assert.ok(meta.get('networkKey') instanceof Uint8Array)
})
