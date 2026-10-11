import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { publicPeerRoutes } from './peer-routes.js'
import { SYNC_PROTOCOL } from './protocol.js'

export function hasPublicWebSocketRelay (addresses) {
  return publicPeerRoutes(addresses, addresses).some((a) => /\/wss?\//.test(a) && !a.includes('/p2p-circuit'))
}

export function hasLiveReservation (reservation, now = Date.now()) {
  const expiry = Number(reservation?.expire) * 1_000
  return Number.isFinite(expiry) && expiry > now
}

/** Reserve routes that a phone can reach via TCP even with a VPN blocking UDP. */
export function s2sRelayTransport (publicWebSocketOnly = false) {
  return (components) => {
    const transport = circuitRelayTransport()(components)
    if (!publicWebSocketOnly) return transport
    // circuit-relay-v2 3 exposes its reservation store on the transport.
    // Validate candidates before reserving; a Node client can otherwise pick
    // a TCP-only relay that none of its browser/phone partners can dial.
    const reserve = transport.reservationStore.addRelay.bind(transport.reservationStore)
    transport.reservationStore.addRelay = async (peerId, type) => {
      const peer = await components.peerStore.get(peerId)
      const addresses = peer.addresses.map(({ multiaddr }) =>
        multiaddr.getPeerId() ? String(multiaddr) : String(multiaddr.encapsulate(`/p2p/${peerId}`)))
      const usable = hasPublicWebSocketRelay(addresses)
      if (!usable) {
        if (!peer.protocols.includes(SYNC_PROTOCOL)) await components.connectionManager.closeConnections(peerId).catch(() => {})
        throw new Error('relay has no public WebSocket route')
      }
      const result = await reserve(peerId, type)
      if (!hasLiveReservation(result.details.reservation)) {
        // Some public peers return an OK response without an expiry. The SDK
        // then schedules a NaN timeout and repeatedly reopens that dead route.
        clearTimeout(result.details.timeout)
        await components.connectionManager.closeConnections(peerId).catch(() => {})
        throw new Error('relay returned an expired or invalid reservation')
      }
      return result
    }
    return transport
  }
}
