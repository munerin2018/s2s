import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publicPeerRoutes, groupPeerRoutes, mergePeerRoutes } from '../src/peer-routes.js'

const first = '12D3KooWFZ4r4nZEwToNdx4htCmqe2Xxk5zPHXTz91k4iiLTehgT'
const second = '12D3KooWSZNaBh5zFaiLWy3Tug52rGyzdTLmhDWMYtukdC3k7pNU'
const route = (host, peer = first) => `/ip4/${host}/tcp/4002/ws/p2p/${peer}`

test('many fresh relay routes do not evict a different saved peer', () => {
  const fresh = Array.from({ length: 25 }, (_, i) => route(`8.8.8.${i + 1}`))
  const saved = route('192.168.0.22', second)
  const merged = mergePeerRoutes(fresh, [saved])
  assert.equal(merged.length, 20)
  assert.deepEqual(merged.slice(0, 2), [fresh[0], saved])
})

test('only public routes of an explicitly saved peer are retained', () => {
  const saved = [route('192.168.0.22')]
  const external = route('8.8.8.8')
  assert.deepEqual(publicPeerRoutes([
    external, external, route('10.0.0.1'), route('192.168.0.22'),
    route('100.73.12.113'), route('127.0.0.1'), route('203.0.113.1'),
    route('8.8.4.4', second), 'invalid'
  ], saved), [external])
})

test('private and public alternatives are dialled together once per peer', () => {
  const privateAddr = route('192.168.0.22')
  const external = route('8.8.8.8')
  const other = route('8.8.4.4', second)
  assert.deepEqual(groupPeerRoutes([privateAddr, external, privateAddr, other, 'invalid']), [
    { peerId: first, routes: [privateAddr, external] },
    { peerId: second, routes: [other] }
  ])
})
