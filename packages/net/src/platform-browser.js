/**
 * Browser peer configuration - the "fully static web version".
 *
 * A browser cannot listen on a port, so it reaches the network two ways:
 *
 *   WebSocket   dial a peer that *can* listen (your own desktop app, or a
 *               friend's). This is a normal libp2p connection, not a server:
 *               the peer on the other end stores nothing on your behalf.
 *   WebRTC      once two browsers can both see some relay, they negotiate a
 *               direct connection through it and then talk peer to peer.
 *
 * The page itself is static files. It can be opened from disk, from a USB
 * stick, or from any free static host - none of that changes the trust model,
 * because the host never sees an event: everything is signed and stored locally.
 */
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { webRTC } from '@libp2p/webrtc'
import { bootstrap } from '@libp2p/bootstrap'
import { S2SNetwork } from './network.js'

/**
 * @param {object} opts
 * @param {import('../../core/src/s2s.js').S2S} opts.s2s
 * @param {string[]} [opts.bootstrapPeers] multiaddrs of peers that can listen
 * @param {(m: string) => void} [opts.log]
 */
export function createBrowserPeer (opts) {
  const { bootstrapPeers = [], log } = opts

  const peerDiscovery = []
  if (bootstrapPeers.length > 0) peerDiscovery.push(bootstrap({ list: bootstrapPeers }))

  return new S2SNetwork({
    s2s: opts.s2s,
    transports: [
      // `all` permits ws:// as well as wss://, which is what you need when the
      // peer you are dialling is a desktop app on your own LAN with no cert.
      webSockets({ filter: filters.all }),
      webRTC()
    ],
    peerDiscovery,
    // A browser listens only for inbound WebRTC negotiated over a relay.
    listen: ['/p2p-circuit', '/webrtc'],
    log
  })
}
