import { test } from 'node:test'
import assert from 'node:assert/strict'
import { paceRoutingQueries } from '../src/public-dht.js'
import { relayRoutesForRestart } from '../src/peer-routes.js'

test('empty routing walks let reconnect and timeout timers run', async () => {
  const routing = paceRoutingQueries({ async * getClosestPeers () {} }, 1)
  let timerRan = false
  const timer = setTimeout(() => { timerRan = true }, 0)
  try {
    for (let i = 0; i < 5; i++) {
      for await (const _ of routing.getClosestPeers(new Uint8Array())) {}
    }
    assert.equal(timerRan, true)
  } finally { clearTimeout(timer) }
})

test('routing pacing preserves peer results and errors', async () => {
  const peer = { id: 'peer' }
  const routing = paceRoutingQueries({ async * getClosestPeers () { yield peer } }, 1)
  const result = []
  for await (const p of routing.getClosestPeers(new Uint8Array())) result.push(p)
  assert.deepEqual(result, [peer])
  const failure = paceRoutingQueries({ async * getClosestPeers () { throw new Error('offline') } }, 1)
  await assert.rejects(async () => {
    for await (const _ of failure.getClosestPeers(new Uint8Array())) {}
  }, /offline/)
})

test('relay restart stores the public relay, not the remote phone or a LAN relay', () => {
  const relay = '12D3KooWFZ4r4nZEwToNdx4htCmqe2Xxk5zPHXTz91k4iiLTehgT'
  const phone = '12D3KooWSZNaBh5zFaiLWy3Tug52rGyzdTLmhDWMYtukdC3k7pNU'
  const publicRelay = `/dns4/example.com/tcp/443/tls/ws/p2p/${relay}`
  assert.deepEqual(relayRoutesForRestart([
    `${publicRelay}/p2p-circuit/webrtc/p2p/${phone}`,
    `${publicRelay}/p2p-circuit/p2p/${phone}`,
    `/ip4/192.168.0.22/tcp/4002/ws/p2p/${relay}/p2p-circuit/p2p/${phone}`,
    `/ip4/8.8.8.8/tcp/4002/ws/p2p/${phone}`,
    'invalid'
  ]), [publicRelay])
})
