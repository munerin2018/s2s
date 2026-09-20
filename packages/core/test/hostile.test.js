/**
 * What a malicious peer can try.
 *
 * Every case here was a real hole found in review. They are kept as tests
 * because none of them is caught by testing the happy path: each one needs a
 * peer that is deliberately not following the protocol.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonical, blobId } from '../src/codec.js'
import { createIdentity } from '../src/identity.js'
import { createEvent, verifyEvent, sanitize } from '../src/event.js'
import { S2SStore, MemoryBackend } from '../src/store.js'
import { FileBackend } from '../src/store-node.js'
import { S2S } from '../src/s2s.js'

const mk = () => new S2S({ identity: createIdentity() })

test('a blob id cannot escape the blob directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 's2s-hostile-'))
  const backend = await new FileBackend(dir).init()

  // Pretend the account key is sitting where it really does sit.
  await writeFile(join(dir, 'identity.json'), '{"secretKey":"TOP SECRET"}')

  for (const attack of [
    '&../identity.json',
    '&..\\identity.json',
    '&/etc/passwd',
    '&C:\\Windows\\win.ini',
    '&../../../../../../etc/hosts',
    '&',
    '&' + 'A'.repeat(500),
    '&not base58 !!!'
  ]) {
    assert.equal(await backend.getBlob(attack), null, `${attack} must not resolve to a file`)
  }

  // And the real thing still works.
  const bytes = new Uint8Array([1, 2, 3])
  const id = blobId(bytes)
  await backend.putBlob(id, bytes)
  assert.deepEqual([...(await backend.getBlob(id))], [1, 2, 3])
})

test('a blob id that is not a blob id is refused on the way in too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 's2s-hostile-'))
  const backend = await new FileBackend(dir).init()
  await assert.rejects(() => backend.putBlob('&../escaped', new Uint8Array([1])))
})

test('canonical encoding refuses anything two implementations could disagree on', () => {
  // A float and an integer of the same value stringify differently in other
  // languages, so the format simply does not carry floats.
  assert.throws(() => canonical(1.5))
  assert.throws(() => canonical(-0.0 - 0.5))
  assert.throws(() => canonical(Number.MAX_SAFE_INTEGER + 2))
  assert.throws(() => canonical(NaN))
  assert.throws(() => canonical(Infinity))
  assert.equal(canonical(1), '1')
  assert.equal(canonical(-7), '-7')
})

test('object keys sort by code point, the order a byte-wise implementation gets', () => {
  // U+1F680 is above U+FFFD by code point, but below it by UTF-16 code unit,
  // which is what a plain `.sort()` would use.
  assert.equal(canonical({ '\u{1F680}': 1, '\uFFFD': 2 }), '{"\uFFFD":2,"\u{1F680}":1}')
})

test('an event carrying extra top level fields is not stored or relayed', async () => {
  const id = createIdentity()
  const e = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'hi' })
  const bloated = { ...e, padding: 'x'.repeat(100_000) }

  // It still verifies - the signature and id only cover the real fields.
  assert.equal(verifyEvent(bloated), null)

  const store = new S2SStore(new MemoryBackend())
  assert.equal((await store.put(bloated)).stored, true)

  const kept = store.get(e.id)
  assert.equal(kept.padding, undefined, 'the padding must not be kept')
  assert.deepEqual(Object.keys(kept).sort(), Object.keys(sanitize(e)).sort())
})

test('unknown members inside content are refused', () => {
  const id = createIdentity()
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'post', { text: 'hi', extra: 1 }))
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'follow', { target: id.id, extra: 1 }))
})

test('a delete from a stranger cannot tombstone an event we have not seen yet', async () => {
  const alice = mk()
  const mallory = mk()

  const post = await alice.post({ text: 'censor me' })

  const bob = mk()
  // Mallory's delete arrives first, naming an event bob has never seen.
  const censor = await mallory.remove(post.id)
  for (const e of mallory.store.logRange(mallory.me, 1, 99)) await bob.store.put(e)
  assert.equal(censor.content.target, post.id)

  // Then the real post arrives.
  for (const e of alice.store.logRange(alice.me, 1, 99)) await bob.store.put(e)

  assert.equal(bob.store.isDeleted(post.id), false, 'a stranger must not be able to hide it')
  assert.equal(bob.views.global().length, 1)

  // The author's own delete still works, in either order.
  const own = await alice.remove(post.id)
  await bob.store.put(own)
  assert.equal(bob.store.isDeleted(post.id), true)
})

test('a delete that arrives before its own author\'s post is applied once it lands', async () => {
  const alice = mk()
  const post = await alice.post({ text: 'gone' })
  await alice.remove(post.id)

  const bob = mk()
  const log = alice.store.logRange(alice.me, 1, 99)
  // Deliver the tombstone first; the chain buffers it until the post arrives.
  for (const e of [...log].reverse()) await bob.store.put(e)
  assert.equal(bob.store.isDeleted(post.id), true)
})

test('concurrent puts cannot slip two events into the same position', async () => {
  const id = createIdentity()
  const store = new S2SStore(new MemoryBackend())

  const e1 = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'one' })
  await store.put(e1)

  // Two different events both claiming seq 2, offered at the same moment.
  const a = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'a' })
  const b = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'b' }, a.ts + 1)

  const [ra, rb] = await Promise.all([store.put(a), store.put(b)])
  const stored = [ra, rb].filter((r) => r.stored)

  assert.equal(stored.length, 1, 'exactly one of the two may be stored')
  assert.equal(store.heads.get(id.id).seq, 2)
  assert.equal(store.logs.get(id.id).length, 2)
})

test('the pending buffer is bounded across authors, not just per author', async () => {
  const store = new S2SStore(new MemoryBackend())

  // A cheap attack: a fresh key per event, each one an orphan that can never
  // be applied, so nothing ever drains.
  for (let i = 0; i < 400; i++) {
    const id = createIdentity()
    const e1 = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'x' })
    const e2 = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'y' })
    await store.put(e2)
  }

  let held = 0
  for (const byAuthor of store.pending.values()) held += byAuthor.size
  assert.ok(held <= store.maxPending, `held ${held}, limit ${store.maxPending}`)
})

test('timestamps must be integers within range', () => {
  const id = createIdentity()
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'post', { text: 'x' }, -1))
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'post', { text: 'x' }, 1.5))
})

test('a forged event with a swapped author is refused', async () => {
  const alice = createIdentity()
  const mallory = createIdentity()
  const store = new S2SStore(new MemoryBackend())

  const forged = createEvent(mallory, { seq: 1, prev: null }, 'post', { text: 'alice said this' })
  const res = await store.put({ ...forged, author: alice.id })
  assert.equal(res.ok, false)
})
