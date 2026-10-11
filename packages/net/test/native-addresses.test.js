import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeDialAddresses } from '../src/native-addresses.js'

test('native VPN fallback keeps the host and authenticated peer identity', () => {
  const addr = '/ip4/192.168.0.22/udp/4003/webrtc-direct/certhash/hash/p2p/peer'
  assert.deepEqual(nativeDialAddresses(addr), ['/ip4/192.168.0.22/tcp/4002/ws/p2p/peer', addr])
  assert.deepEqual(nativeDialAddresses([addr, addr]), nativeDialAddresses(addr))
})

test('custom ports and relay routes are never guessed', () => {
  for (const addr of [
    '/ip4/192.168.0.22/udp/4303/webrtc-direct/certhash/hash/p2p/peer',
    '/ip4/192.168.0.22/tcp/4002/ws/p2p/peer',
    '/ip4/192.168.0.22/udp/4003/webrtc-direct/certhash/hash/p2p/relay/p2p-circuit/p2p/peer'
  ]) assert.deepEqual(nativeDialAddresses(addr), [addr])
})
