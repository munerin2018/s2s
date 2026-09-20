/**
 * End to end: two real libp2p peers on localhost, no server between them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createIdentity } from '../../core/src/identity.js'
import { S2S } from '../../core/src/s2s.js'
import { createNodePeer } from '../src/platform-node.js'
import { diff } from '../src/sync.js'

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
    relay: false,
    log: (m) => process.env.S2S_DEBUG && console.log(`[${name}] ${m}`),
    ...opts
  })
  await net.start()
  return { s2s, net, name }
}

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
