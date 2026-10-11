import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIdentity } from '../../core/src/identity.js'
import { presenceProof, verifyPresence } from '../src/presence.js'
import { completePeerRoutes, lookupPeerRoutes } from '../src/public-dht.js'
import { peerIdFromString } from '@libp2p/peer-id'

const target = '12D3KooWSZNaBh5zFaiLWy3Tug52rGyzdTLmhDWMYtukdC3k7pNU'
const relay = '12D3KooWFZ4r4nZEwToNdx4htCmqe2Xxk5zPHXTz91k4iiLTehgT'
const base = `/dns4/relay.example/tcp/443/tls/ws/p2p/${relay}/p2p-circuit`

test('online account proof cannot be forged, replayed, or moved to another peer', () => {
  const identity = createIdentity()
  const proof = presenceProof(identity, target, 'challenge', [`${base}/p2p/${target}`])
  assert.equal(verifyPresence(proof, target, 'challenge'), true)
  assert.equal(verifyPresence(proof, target, 'new challenge'), false)
  assert.equal(verifyPresence(proof, relay, 'challenge'), false)
  assert.equal(verifyPresence({ ...proof, author: createIdentity().id }, target, 'challenge'), false)
  assert.equal(verifyPresence({ ...proof, addresses: [] }, target, 'challenge'), false)
})

test('DHT relay routes missing the destination id are completed for that paired peer', () => {
  assert.deepEqual(completePeerRoutes([base, `${base}/webrtc`, `${base}/p2p/${target}`,
    `/dns4/unrelated.example/tcp/443/wss/p2p/${relay}`, 'invalid'], target),
  [`${base}/p2p/${target}`, `${base}/webrtc/p2p/${target}`])
})

test('lookup asks shared entry peers for current routes instead of reusing stale local addresses', async () => {
  let requests = 0
  const node = {
    getConnections: () => [{}],
    services: { dht: { network: { async * sendRequest (_peer, request) {
      requests++
      assert.deepEqual(request.key, peerIdFromString(target).toMultihash().bytes)
      yield { name: 'PEER_RESPONSE', closer: [
        { id: peerIdFromString(relay), multiaddrs: [base] },
        { id: peerIdFromString(target), multiaddrs: [base] }
      ] }
    } } } }
  }
  assert.deepEqual(await lookupPeerRoutes(node, target, AbortSignal.timeout(1000)), [`${base}/p2p/${target}`])
  assert.equal(requests, 2)
})
