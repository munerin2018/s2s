import { test } from 'node:test'
import assert from 'node:assert/strict'

import { canonical, blobId, isEventId } from '../src/codec.js'
import { createIdentity, exportIdentity, importIdentity } from '../src/identity.js'
import { createEvent, verifyEvent } from '../src/event.js'
import { S2SStore, MemoryBackend } from '../src/store.js'
import { S2S } from '../src/s2s.js'

const mk = () => new S2S({ identity: createIdentity() })

test('canonical encoding is order independent', () => {
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
  assert.equal(canonical({ a: [3, 1] }), '{"a":[3,1]}')
  assert.notEqual(canonical({ a: [1, 3] }), canonical({ a: [3, 1] }))
  assert.equal(canonical({ a: 1, b: undefined }), '{"a":1}')
})

test('identity round trips through its backup string', () => {
  const id = createIdentity()
  const back = importIdentity(exportIdentity(id))
  assert.equal(back.id, id.id)
  assert.deepEqual([...back.secretKey], [...id.secretKey])
})

test('a signed event verifies, and any tampering breaks it', () => {
  const id = createIdentity()
  const e = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'hello p2p' })

  assert.equal(verifyEvent(e), null)
  assert.ok(isEventId(e.id))

  assert.notEqual(verifyEvent({ ...e, content: { text: 'tampered' } }), null)
  assert.notEqual(verifyEvent({ ...e, ts: e.ts + 1 }), null)
  assert.notEqual(verifyEvent({ ...e, author: createIdentity().id }), null)
})

test('the id is bound to the signature, so a signature cannot be swapped in', () => {
  const id = createIdentity()
  const a = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'a' })
  const b = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'b' }, a.ts)
  assert.notEqual(verifyEvent({ ...a, sig: b.sig }), null)
})

test('malformed content is rejected before it can be signed', () => {
  const id = createIdentity()
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'post', { text: '' }))
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'post', { text: 'x'.repeat(5000) }))
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'like', { target: 'not-an-id', value: 1 }))
  assert.throws(() => createEvent(id, { seq: 1, prev: null }, 'nope', {}))
  assert.throws(() => createEvent(id, { seq: 2, prev: null }, 'post', { text: 'x' }))
})

test('the log is a hash chain and a broken link is refused', async () => {
  const id = createIdentity()
  const store = new S2SStore(new MemoryBackend())

  const e1 = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'one' })
  const e2 = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'two' })
  const bogus = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'not two' }, e2.ts + 1)

  assert.equal((await store.put(e1)).stored, true)
  assert.equal((await store.put(e2)).stored, true)

  const forked = await store.put(bogus)
  assert.equal(forked.ok, false)
  assert.match(forked.reason, /fork|prev/)
})

test('events arriving out of order are buffered until the gap closes', async () => {
  const id = createIdentity()
  const store = new S2SStore(new MemoryBackend())

  const e1 = createEvent(id, { seq: 1, prev: null }, 'post', { text: 'one' })
  const e2 = createEvent(id, { seq: 2, prev: e1.id }, 'post', { text: 'two' })
  const e3 = createEvent(id, { seq: 3, prev: e2.id }, 'post', { text: 'three' })

  await store.put(e3)
  await store.put(e2)
  assert.equal(store.heads.get(id.id), undefined, 'nothing applies while seq 1 is missing')

  await store.put(e1)
  assert.equal(store.heads.get(id.id).seq, 3, 'the buffer drains once the chain connects')
  assert.equal(store.posts.length, 3)
})

test('replication between two independent replicas converges', async () => {
  const alice = mk()
  const bob = mk()

  await alice.post({ text: 'from alice' })
  await alice.post({ text: 'also from alice' })

  // Bob receives alice's log exactly as a peer would hand it over.
  for (const e of alice.store.logRange(alice.me, 1, 99)) {
    const r = await bob.store.put(e)
    assert.equal(r.ok, true, r.reason)
  }

  assert.equal(bob.views.global().length, 2)
  assert.equal(bob.views.global()[0].text, 'also from alice')
  assert.deepEqual(bob.haveVector(), alice.haveVector())
})

test('timeline modes: home follows, media filters, boards thread', async () => {
  const alice = mk()
  const bob = mk()

  await alice.setProfile({ name: 'Alice' })
  const p = await alice.post({ text: 'hello world' })
  const img = await alice.addMedia(new Uint8Array([1, 2, 3]), { mime: 'image/png', w: 10, h: 10 })
  await alice.post({ text: 'with a picture', media: [img] })

  for (const e of alice.store.logRange(alice.me, 1, 99)) await bob.store.put(e)

  assert.equal(bob.views.home().length, 0, 'home is empty until bob follows someone')
  await bob.follow(alice.me)
  assert.equal(bob.views.home().length, 2)
  assert.equal(bob.views.media().length, 1)
  assert.equal(bob.views.global()[0].author.name, 'Alice')

  await bob.reply({ root: p.id, parent: p.id, text: 'nice post' })
  assert.equal(bob.views.thread(p.id).posts.length, 1)
  assert.equal(bob.views.thread(p.id).posts[0].no, 2)
})

test('2ch style boards group threads and order them by activity', async () => {
  const a = mk()
  const t1 = await a.thread({ board: 'anime', title: 'thread one', text: '1get' })
  const t2 = await a.thread({ board: 'anime', title: 'thread two', text: 'hi' })
  await a.thread({ board: 'bike', title: 'road bikes', text: 'hi' })

  const boards = a.views.boards()
  assert.equal(boards.length, 2)
  assert.equal(boards.find((b) => b.board === 'anime').threads, 2)

  await a.reply({ root: t1.id, parent: t1.id, text: 'bump' })
  assert.equal(a.views.board('anime')[0].id, t1.id, 'the bumped thread rises to the top')
  assert.equal(a.views.board('anime')[0].count, 2)
  assert.equal(t2.content.board, 'anime')
})

test('likes toggle, blocks hide, deletes tombstone', async () => {
  const a = mk()
  const b = mk()
  const post = await a.post({ text: 'vote on me' })
  for (const e of a.store.logRange(a.me, 1, 99)) await b.store.put(e)

  await b.like(post.id, 1)
  assert.equal(b.store.likeScore(post.id).score, 1)
  await b.like(post.id, 1)
  assert.equal(b.store.likeScore(post.id).score, -1, 'pressing like twice clears then flips the vote')

  await b.block(a.me)
  assert.equal(b.views.global().length, 0)
  await b.unblock(a.me)
  assert.equal(b.views.global().length, 1)

  await a.remove(post.id)
  assert.equal(a.views.global().length, 0)
  await assert.rejects(() => b.remove(post.id), /your own/)
})

test('blobs are addressed by their content hash', async () => {
  const a = mk()
  const bytes = new Uint8Array([9, 8, 7, 6])
  const ref = await a.addMedia(bytes, { mime: 'image/jpeg' })
  assert.equal(ref.blob, blobId(bytes))
  assert.deepEqual([...(await a.getMedia(ref.blob))], [...bytes])
})

test('a peer cannot forge an event in someone else pretending to be them', async () => {
  const alice = createIdentity()
  const mallory = createIdentity()
  const store = new S2SStore(new MemoryBackend())

  const forged = createEvent(mallory, { seq: 1, prev: null }, 'post', { text: 'alice said this' })
  forged.author = alice.id // swap the claimed author

  const res = await store.put(forged)
  assert.equal(res.ok, false)
})
