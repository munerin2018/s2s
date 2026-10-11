import { multiaddr } from '@multiformats/multiaddr'

/** TCP relay streams work even when a mobile VPN prevents WebRTC UDP. */
export function preferredDialRoutes (addresses) {
  const routes = [...new Set(addresses.flatMap((address) => {
    const addr = String(address)
    return addr.includes('/p2p-circuit/webrtc/') && /\/wss?\//.test(addr)
      ? [addr.replace('/p2p-circuit/webrtc/', '/p2p-circuit/'), addr] : [addr]
  }))]
  return routes.sort((a, b) => Number(!/\/wss?\//.test(a) || a.includes('/webrtc/')) - Number(!/\/wss?\//.test(b) || b.includes('/webrtc/')))
}

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

/** Reserve slots for each saved peer instead of one relay's many addresses. */
export function mergePeerRoutes (fresh, saved, limit = 20) {
  const groups = groupPeerRoutes([...fresh, ...saved])
  const result = []
  for (let index = 0; result.length < limit; index++) {
    let added = false
    for (const { routes } of groups) {
      if (routes[index] && result.length < limit) {
        result.push(routes[index])
        added = true
      }
    }
    if (!added) break
  }
  return result
}

/** Re-reserve the same public relay after reopening, keeping paired routes usable. */
export function relayRoutesForRestart (addresses) {
  return [...new Set(publicPeerRoutes(addresses, addresses).flatMap((a) => {
    const circuit = a.indexOf('/p2p-circuit')
    return circuit < 0 ? [] : [a.slice(0, circuit)]
  }))].slice(0, 2)
}
