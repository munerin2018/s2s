/**
 * End to end: two real libp2p peers on localhost, no server between them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIdentity } from '../../core/src/identity.js'
import { S2S } from '../../core/src/s2s.js'
import { createNodePeer } from '../src/platform-node.js'
import { diff } from '../src/sync.js'
import { generateKeyPair } from '@libp2p/crypto/keys'

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Poll until `fn()` is truthy, or fail after `timeout`. */
async function until (fn, timeout = 20_000, label = 'condition') {
  const deadline = Date.now() + timeout
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await wait(200)
  }
}

async function peer (name, opts = {}) {
  const s2s = new S2S({ identity: createIdentity() })
  const net = createNodePeer({
    s2s,
    lan: false, // dial explicitly so the test does not depend on the LAN
    publicRouting: false, // integration tests stay on localhost
    relay: false,
    log: (m) => process.env.S2S_DEBUG && console.log(`[${name}] ${m}`),
    ...opts
  })
  await net.start()
  return { s2s, net, name }
}

test('online list identifies the connected account, not authors copied in its logs', async () => {
  const a = await peer('online-a')
  const b = await peer('online-b')
  try {
    const other = new S2S({ identity: createIdentity() })
    await b.s2s.store.put(await other.post({ text: 'replicated author is not an online session' }))
    await a.net.connect(b.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws')).toString())
    await until(() => a.net.onlineUsers().some((u) => u.id === b.s2s.me) && b.net.onlineUsers().some((u) => u.id === a.s2s.me))
    assert.equal(a.net.onlineUsers().some((u) => u.id === other.me), false)
    await a.net.libp2p.hangUp(b.net.libp2p.peerId)
    await until(() => a.net.onlineUsers().length === 0)
  } finally { await Promise.all([a.net.stop(), b.net.stop()]) }
})

test('immediate bootstrap and repeated reopening never miss account identification', async () => {
  const remote = await peer('restart-remote')
  const account = new S2S({ identity: createIdentity() })
  const privateKey = await generateKeyPair('Ed25519')
  const address = remote.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws')).toString()
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const net = createNodePeer({ s2s: account, privateKey, lan: false, publicRouting: false, relay: false, bootstrapPeers: [address] })
      try {
        await net.start()
        await until(() => net.onlineUsers().some((u) => u.id === remote.s2s.me), 3_000, 'account online immediately after bootstrap')
      } finally { await net.stop() }
    }
  } finally { await remote.net.stop() }
})

test('diff computes exactly the ranges the other side is missing', () => {
  const a = createIdentity().id
  assert.deepEqual(diff({ [a]: 5 }, { [a]: 2 }), [{ author: a, from: 3, to: 5 }])
  assert.deepEqual(diff({ [a]: 5 }, { [a]: 5 }), [])
  assert.deepEqual(diff({ [a]: 2 }, {}), [{ author: a, from: 1, to: 2 }])
  assert.deepEqual(diff({}, { [a]: 9 }), [])
})

test('a hostile have vector cannot steer the send loop', () => {
  const a = createIdentity().id

  // Every one of these was a way to make `writeEvents` spin: a negative
  // cursor turns one message into billions of loop iterations with no await
  // in them, which blocks the whole event loop.
  for (const evil of [-1e12, -1, 1.5, NaN, Infinity, '3', null, {}, Number.MAX_VALUE]) {
    assert.deepEqual(
      diff({ [a]: 3 }, { [a]: evil }),
      [{ author: a, from: 1, to: 3 }],
      `have vector value ${String(evil)} must be read as "they have nothing"`
    )
  }

  assert.deepEqual(diff({ [a]: 3 }, null), [{ author: a, from: 1, to: 3 }])
  assert.deepEqual(diff({ [a]: 3 }, 'nonsense'), [{ author: a, from: 1, to: 3 }])
  assert.deepEqual(diff({ [a]: 3 }, { 'not-an-author': 9 }), [{ author: a, from: 1, to: 3 }])

  // And a well formed one still works.
  assert.deepEqual(diff({ [a]: 3 }, { [a]: 1 }), [{ author: a, from: 2, to: 3 }])
})

test('two peers replicate posts over a real connection', async (t) => {
  const alice = await peer('alice')
  const bob = await peer('bob')
  t.after(async () => { await alice.net.stop(); await bob.net.stop() })

  await alice.s2s.setProfile({ name: 'Alice' })
  await alice.s2s.post({ text: 'first post on a network with no servers' })

  const addr = alice.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'))
  assert.ok(addr, 'alice should be listening on tcp')

  await bob.net.connect(addr.toString())

  // Sync on connect pulls alice's whole log, including the post made before
  // bob ever existed. This is the part plain gossip cannot do.
  await until(() => bob.s2s.views.global().length === 1, 20_000, 'bob to receive alice backlog')

  const [post] = bob.s2s.views.global()
  assert.equal(post.text, 'first post on a network with no servers')
  assert.equal(post.author.name, 'Alice')
  assert.equal(post.authorId, alice.s2s.me)
})

test('a post made while connected arrives by gossip', async (t) => {
  const alice = await peer('alice2')
  const bob = await peer('bob2')
  t.after(async () => { await alice.net.stop(); await bob.net.stop() })

  const addr = alice.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'))
  await bob.net.connect(addr.toString())
  await until(() => bob.net.libp2p.getPeers().length > 0, 10_000, 'connection')

  // Give gossipsub time to build its mesh before publishing.
  await until(
    () => alice.net.libp2p.services.pubsub.getSubscribers('s2s/v1/events').length > 0,
    15_000,
    'gossip mesh'
  )

  await alice.s2s.post({ text: 'live update' })
  await until(
    () => bob.s2s.views.global().some((p) => p.text === 'live update'),
    20_000,
    'gossip delivery'
  )
})

test('media transfers on demand and a tampered blob is rejected', async (t) => {
  const alice = await peer('alice3')
  const bob = await peer('bob3')
  t.after(async () => { await alice.net.stop(); await bob.net.stop() })

  const bytes = new Uint8Array(4096).map((_, i) => i % 251)
  const ref = await alice.s2s.addMedia(bytes, { mime: 'image/png', w: 64, h: 64 })
  await alice.s2s.post({ text: 'look at this', media: [ref] })

  const addr = alice.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'))
  await bob.net.connect(addr.toString())

  await until(() => bob.s2s.views.media().length === 1, 20_000, 'bob to see the post')
  const got = await until(() => bob.s2s.getMedia(ref.blob), 20_000, 'bob to fetch the blob')
  assert.deepEqual([...got], [...bytes], 'bytes arrive intact')

  // The blob id is the hash, so asking for a hash nobody holds simply fails.
  const missing = await bob.s2s.getMedia('&11111111111111111111111111111111')
  assert.equal(missing, null)
})

test('three peers converge, including through the middle one', async (t) => {
  const a = await peer('a')
  const b = await peer('b')
  const c = await peer('c')
  t.after(async () => { await a.net.stop(); await b.net.stop(); await c.net.stop() })

  const tcpAddr = (p) => p.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws')).toString()

  // a <-> b <-> c : a and c never dial each other directly.
  await b.net.connect(tcpAddr(a))
  await b.net.connect(tcpAddr(c))

  await a.s2s.post({ text: 'from a' })
  await c.s2s.post({ text: 'from c' })

  await until(() => a.s2s.views.global().length === 2, 30_000, 'a to learn about c')
  await until(() => c.s2s.views.global().length === 2, 30_000, 'c to learn about a')

  assert.deepEqual(
    a.s2s.views.global().map((p) => p.text).sort(),
    ['from a', 'from c']
  )
})


test('local posts sync promptly even when gossip does not deliver', async (t) => {
  const a = await peer('no-gossip-a')
  const b = await peer('no-gossip-b')
  t.after(async () => { await a.net.stop(); await b.net.stop() })
  const addr = a.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'))
  await b.net.connect(addr.toString())
  await wait(1200)
  a.net.libp2p.services.pubsub.publish = async () => ({ recipients: [] })
  await a.s2s.post({ text: 'sync without gossip' })
  await until(() => b.s2s.views.global().some((p) => p.text === 'sync without gossip'), 8000, 'immediate reconciliation')
})

test('missing media is retried when its connected holder receives it later', async (t) => {
  const a = await peer('late-media-a')
  const b = await peer('late-media-b')
  t.after(async () => { await a.net.stop(); await b.net.stop() })
  const bytes = new Uint8Array([1, 7, 9, 4])
  const ref = await a.s2s.addMedia(bytes, { mime: 'image/png' })
  a.s2s.store.blobs.delete(ref.blob)
  a.s2s.store.backend.blobs.delete(ref.blob)
  await a.s2s.post({ text: 'late media', media: [ref] })
  const addr = a.net.libp2p.getMultiaddrs().find((m) => m.toString().includes('/tcp/') && !m.toString().includes('/ws'))
  await b.net.connect(addr.toString())
  await until(() => b.s2s.views.global().length === 1, 8000, 'post before media')
  assert.equal(await b.s2s.getMedia(ref.blob), null)
  await a.s2s.store.putBlob(ref.blob, bytes)
  const got = await until(() => b.s2s.getMedia(ref.blob), 8000, 'retry without reconnect')
  assert.deepEqual(got, bytes)
})
