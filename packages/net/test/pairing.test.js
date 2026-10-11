import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bestPairingAddress } from '../../ui/src/pairing.js'

test('public pairing address outranks LAN and private overlay addresses', () => {
  const suffix = '/udp/4003/webrtc-direct/certhash/hash/p2p/peer'
  const publicAddr = '/ip4/8.8.8.8' + suffix
  assert.equal(bestPairingAddress([
    '/ip4/192.168.0.22' + suffix,
    '/ip4/100.73.12.113' + suffix,
    publicAddr
  ]), publicAddr)
})
