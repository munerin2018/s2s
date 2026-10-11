import { multiaddr } from '@multiformats/multiaddr'

/** Only persist browser-capable public routes belonging to a saved peer. */
export function publicPeerRoutes (addresses, saved) {
  const peerIds = new Set(saved.flatMap((a) => {
    try { return [multiaddr(a).getPeerId()] } catch { return [] }
  }))
  return [...new Set(addresses)].filter((a) => {
    try {
      const addr = multiaddr(a)
      if (!peerIds.has(addr.getPeerId())) return false
      if (!/\/(wss?|webrtc-direct)(\/|$)/.test(a)) return false
      const ip = /^\/ip4\/(\d+)\.(\d+)\.(\d+)\.(\d+)\//.exec(a)
      if (ip) {
        const [, x, y, z] = ip.map(Number)
        return !(x === 0 || x === 10 || x === 127 || x >= 224 ||
          (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
          (x === 192 && (y === 168 || (y === 0 && (z === 0 || z === 2)))) ||
          (x === 100 && y >= 64 && y <= 127) ||
          (x === 198 && (y === 18 || y === 19 || (y === 51 && z === 100))) ||
          (x === 203 && y === 0 && z === 113))
      }
      if (/^\/ip6\//.test(a)) return /^\/ip6\/[23][0-9a-f]{3}:/i.test(a)
      return /^\/dns[46]?\//.test(a)
    } catch { return false }
  }).slice(0, 20)
}

/** A single multi-address dial per peer keeps private paths from blocking public alternatives. */
export function groupPeerRoutes (addresses) {
  const groups = new Map()
  for (const addr of addresses) {
    try {
      const id = multiaddr(addr).getPeerId()
      if (!id) continue
      const routes = groups.get(id) ?? []
      if (!routes.includes(addr)) routes.push(addr)
      groups.set(id, routes)
    } catch {}
  }
  return [...groups].map(([peerId, routes]) => ({ peerId, routes }))
}
