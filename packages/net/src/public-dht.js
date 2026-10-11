import { kadDHT, removePrivateAddressesMapper } from '@libp2p/kad-dht'
import { peerRoutingSymbol } from '@libp2p/interface'

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
