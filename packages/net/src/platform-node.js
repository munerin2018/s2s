/**
 * Desktop / headless peer configuration.
 *
 * A peer running on a real machine can do things a browser tab cannot: listen
 * on a port, find neighbours on the LAN with mDNS, and act as a circuit relay
 * so that browser peers behind NAT can reach each other through it.
 *
 * That relay role is the answer to "who pays for the infrastructure": your own
 * PC is the infrastructure. Turn it off and the network keeps working through
 * whoever else is online.
 *
 * Three listen addresses, for three kinds of caller:
 *
 *   tcp            other desktop peers
 *   ws             browsers served over plain http, and the Android app
 *   webrtc-direct  browsers served over https - see below
 *
 * The third exists because of a rule no amount of configuration gets around: a
 * page loaded over https may not open a `ws://` connection. Once the web build
 * is hosted anywhere real, and on iOS where a home-screen app is a Safari page
 * over https, the WebSocket address is simply unreachable. WebRTC Direct is
 * not subject to that rule, and it carries a hash of its own self-signed
 * certificate in the multiaddr, so it needs no certificate authority and no
 * domain name.
 */
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import { webRTCDirect } from '@libp2p/webrtc'
import { mdns } from '@libp2p/mdns'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { kadDHT } from '@libp2p/kad-dht'
import { keychain } from '@libp2p/keychain'
import { S2SNetwork } from './network.js'

/**
 * @param {object} opts
 * @param {import('../../core/src/s2s.js').S2S} opts.s2s
 * @param {number} [opts.tcpPort]   0 picks a free port
 * @param {number} [opts.wsPort]    WebSocket port that browser peers dial
 * @param {number} [opts.webrtcPort] UDP port for WebRTC Direct
 * @param {boolean} [opts.relay]    act as a circuit relay for NATed peers
 * @param {boolean} [opts.dht]      join the DHT (heavier; off by default)
 * @param {boolean} [opts.lan]      mDNS discovery on the local network
 * @param {string[]} [opts.bootstrapPeers]
 * @param {object} [opts.privateKey] persisted libp2p key, so the peer id is stable
 * @param {object} [opts.datastore]  persisted store, so cert hashes are stable
 * @param {(m: string) => void} [opts.log]
 */
export function createNodePeer (opts) {
  const {
    tcpPort = 0,
    wsPort = 0,
    webrtcPort = 0,
    relay = true,
    dht = false,
    lan = true,
    bootstrapPeers = [],
    privateKey,
    datastore,
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
  if (datastore) {
    // The keychain is what lets the WebRTC Direct certificate - and therefore
    // the certhash inside the listen address - survive a restart. Without a
    // datastore to put it in, every start invents a new certificate and any
    // address someone saved stops working.
    services.keychain = keychain()
  }

  return new S2SNetwork({
    s2s: opts.s2s,
    transports: [tcp(), webSockets(), webRTCDirect()],
    peerDiscovery,
    listen: [
      `/ip4/0.0.0.0/tcp/${tcpPort}`,
      `/ip4/0.0.0.0/tcp/${wsPort}/ws`,
      `/ip4/0.0.0.0/udp/${webrtcPort}/webrtc-direct`
    ],
    services,
    privateKey,
    datastore,
    log
  })
}
