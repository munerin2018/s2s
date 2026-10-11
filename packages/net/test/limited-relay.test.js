import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { S2SNetwork } from '../src/network.js'
import { S2S } from '../../core/src/s2s.js'
import { createIdentity } from '../../core/src/identity.js'
import { fetchBlobFrom } from '../src/blobs.js'

async function until (fn) {
  const deadline = Date.now() + 10_000
  while (!await fn()) {
    if (Date.now() > deadline) throw new Error('limited relay did not converge')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('limited public-style relay carries posts both ways, account presence and media', { timeout: 30_000 }, async () => {
  const relay = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
    services: { identify: identify(), ping: ping(), relay: circuitRelayServer({ reservations: {
      applyDefaultLimit: true, defaultDurationLimit: 120_000, defaultDataLimit: 131072n
    } }) }
  })
  const a = new S2S({ identity: createIdentity() })
  const b = new S2S({ identity: createIdentity() })
  const netA = new S2SNetwork({ s2s: a, transports: [tcp()], listen: ['/p2p-circuit'] })
  const netB = new S2SNetwork({ s2s: b, transports: [tcp()], listen: ['/p2p-circuit'] })
  try {
    await Promise.all([netA.start(), netB.start()])
    const relayAddr = relay.getMultiaddrs()[0]
    await Promise.all([netA.libp2p.dial(relayAddr), netB.libp2p.dial(relayAddr)])
    await until(() => netA.libp2p.getMultiaddrs().length && netB.libp2p.getMultiaddrs().length)
    await netA.connect(`${relayAddr}/p2p-circuit/p2p/${netB.libp2p.peerId}`)
    assert.ok(netA.libp2p.getConnections(netB.libp2p.peerId).some((c) => c.limits != null))
    const first = await a.post({ text: 'message from first phone' })
    const second = await b.post({ text: 'reply from second phone' })
    await until(() => b.store.get(first.id) && a.store.get(second.id))
    await until(() => netA.onlineUsers().some((u) => u.id === b.me) && netB.onlineUsers().some((u) => u.id === a.me))
    const bytes = new Uint8Array([1, 2, 3, 4])
    const media = await b.addMedia(bytes, { mime: 'image/png' })
    assert.deepEqual(await fetchBlobFrom(netA.libp2p, netB.libp2p.peerId, media.blob), bytes)
  } finally { await Promise.all([netA.stop(), netB.stop(), relay.stop()]) }
})

test('background discovery leaves room for an inbound mobile user', { timeout: 30_000 }, async () => {
  const config = { addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()], connectionEncrypters: [noise()], streamMuxers: [yamux()], services: { identify: identify(), ping: ping() } }
  const relay = await createLibp2p({ ...config, services: { ...config.services, relay: circuitRelayServer() } })
  const background = await Promise.all(Array.from({ length: 7 }, () => createLibp2p(config)))
  const a = new S2S({ identity: createIdentity() })
  const b = new S2S({ identity: createIdentity() })
  const netA = new S2SNetwork({ s2s: a, transports: [tcp()], listen: ['/p2p-circuit'], publicRouting: true })
  const netB = new S2SNetwork({ s2s: b, transports: [tcp()], listen: ['/p2p-circuit'] })
  try {
    await Promise.all([netA.start(), netB.start()])
    const relayAddr = relay.getMultiaddrs()[0]
    await Promise.all([netA.libp2p.dial(relayAddr), netB.libp2p.dial(relayAddr)])
    await until(() => netA.libp2p.getMultiaddrs().length && netB.libp2p.getMultiaddrs().length)
    for (const node of background) await netA.libp2p.dial(node.getMultiaddrs()[0]).catch(() => {})
    assert.ok(netA.libp2p.getConnections().length <= 6, 'discovery must not fill user connection slots')
    await netB.connect(`${relayAddr}/p2p-circuit/p2p/${netA.libp2p.peerId}`)
    await until(() => netA.onlineUsers().some((u) => u.id === b.me))
    assert.ok(netA.libp2p.getConnections().some((c) => c.remotePeer.equals(netB.libp2p.peerId)))
  } finally { await Promise.all([netA.stop(), netB.stop(), relay.stop(), ...background.map((n) => n.stop())]) }
})
