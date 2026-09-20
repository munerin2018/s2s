/**
 * Desktop / headless peer configuration.
 *
 * A peer running on a real machine can do things a browser tab cannot: listen
 * on a TCP port, find neighbours on the LAN with mDNS, and act as a circuit
 * relay so that browser peers behind NAT can reach each other through it.
 *
 * That relay role is the answer to "who pays for the infrastructure": your own
 * PC is the infrastructure. Turn it off and the network keeps working through
 * whoever else is online.
 */
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { mdns } from '@libp2p/mdns'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { S2SNetwork } from './network.js'

/**
 * @param {object} opts
 * @param {import('../../core/src/s2s.js').S2S} opts.s2s
 * @param {number} [opts.tcpPort]   0 picks a free port
 * @param {number} [opts.wsPort]    WebSocket port that browser peers dial
 * @param {boolean} [opts.relay]    act as a circuit relay for NATed peers
 * @param {boolean} [opts.dht]      join the DHT (heavier; off by default)
 * @param {boolean} [opts.lan]      mDNS discovery on the local network
 * @param {string[]} [opts.bootstrapPeers]
 * @param {(m: string) => void} [opts.log]
 */
export function createNodePeer (opts) {
  const {
    tcpPort = 0,
    wsPort = 0,
    relay = true,
    dht = false,
    lan = true,
    bootstrapPeers = [],
    log
  } = opts

  const peerDiscovery = []
  if (lan) peerDiscovery.push(mdns({ interval: 10_000 }))
  if (bootstrapPeers.length > 0) peerDiscovery.push(bootstrap({ list: bootstrapPeers }))

  const services = {}
  if (relay) {
    services.relay = circuitRelayServer({
      reservations: { maxReservations: 64, applyDefaultLimit: false }
    })
  }
  if (dht) {
    services.dht = kadDHT({ clientMode: false })
  }

  return new S2SNetwork({
    s2s: opts.s2s,
    transports: [tcp(), webSockets()],
    peerDiscovery,
    listen: [
      `/ip4/0.0.0.0/tcp/${tcpPort}`,
      `/ip4/0.0.0.0/tcp/${wsPort}/ws`
    ],
    services,
    log
  })
}
