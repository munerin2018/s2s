import { kadDHT, removePrivateAddressesMapper, MessageType } from '@libp2p/kad-dht'
import { peerRoutingSymbol } from '@libp2p/interface'
import { multiaddr } from '@multiformats/multiaddr'
import { peerIdFromString } from '@libp2p/peer-id'
import { publicPeerRoutes } from './peer-routes.js'

// libp2p 2's relay random walk immediately repeats an empty/cached routing query.
// Yield to the event loop so bootstrap dials, timeouts and Android resume can
// actually run while the routing table is still empty.
export function paceRoutingQueries (routing, delay = 500) {
  const closest = routing.getClosestPeers.bind(routing)
  routing.getClosestPeers = async function * (key, options = {}) {
    try {
      for await (const peer of closest(key, options)) {
        yield peer
      }
    } finally {
      if (!options.signal?.aborted) {
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }
  return routing
}

export function publicDHT () {
  return (components) => {
    const dht = kadDHT({
      clientMode: true,
      peerInfoMapper: removePrivateAddressesMapper
    })(components)
    paceRoutingQueries(dht[peerRoutingSymbol])
    return dht
  }
}

// Independent entry points into the public Amino DHT. They help discover
// peers; S2S events are exchanged only with peers speaking the S2S protocol.
export const PUBLIC_BOOTSTRAP = [
  '/dns4/sing-1.bootstrap.ipni.io/tcp/4443/wss/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
  '/dns4/lith-1.bootstrap.ipni.io/tcp/4443/wss/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb'
]

export function completePeerRoutes (addresses, target) {
  const routes = addresses.flatMap((a) => {
    try {
      const addr = multiaddr(String(a))
      if (/\/(p2p-circuit|webrtc)$/.test(addr.toString()) || !addr.getPeerId()) {
        return [addr.encapsulate(`/p2p/${target}`).toString()]
      }
      return addr.getPeerId() === target ? [addr.toString()] : []
    } catch { return [] }
  })
  return publicPeerRoutes(routes, routes)
}

/** Ask shared entry peers for the latest authenticated peer record, bypassing our stale cache. */
export async function lookupPeerRoutes (node, target, signal) {
  const id = peerIdFromString(target)
  // These peers already see both clients' identify pushes when their relay
  // addresses change. Query them before a random DHT walk: browser clients
  // cannot dial most of the DHT's TCP-only intermediate nodes.
  // kad-dht 14 exposes its protocol network on the service; keep this adapter
  // here rather than spreading this version-specific integration through UI.
  const queries = PUBLIC_BOOTSTRAP.map(async (entry) => {
    const seed = peerIdFromString(multiaddr(entry).getPeerId())
    if (!node.getConnections(seed).length) await node.dial(multiaddr(entry), { signal })
    for await (const event of node.services.dht.network.sendRequest(seed, {
      type: MessageType.FIND_NODE,
      key: id.toMultihash().bytes
    }, { signal })) {
      if (event.name !== 'PEER_RESPONSE') continue
      const peer = event.closer.find((p) => p.id.equals(id))
      if (peer) {
        const routes = completePeerRoutes(peer.multiaddrs, target)
        if (routes.length) return routes
      }
    }
    throw new Error('entry peer has no current route')
  })
  return Promise.any(queries).catch(() => [])
}
