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

test('public secure circuit pairing works without UDP and outranks WebRTC upgrade', () => {
  const relay = '/dns4/relay.example/tcp/443/tls/ws/p2p/relay'
  const circuit = `${relay}/p2p-circuit/p2p/phone`
  assert.equal(bestPairingAddress([
    '/ip4/8.8.8.8/udp/4003/webrtc-direct/certhash/hash/p2p/relay/p2p-circuit/webrtc/p2p/phone',
    `${relay}/p2p-circuit/webrtc/p2p/phone`,
    circuit
  ]), circuit)
  assert.equal(bestPairingAddress(['/dns4/relay.example/tcp/443/wss/p2p/relay']),
    '/dns4/relay.example/tcp/443/wss/p2p/relay')
})
