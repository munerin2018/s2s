/**
 * Browser peer configuration - the "fully static web version", and the same
 * code the iOS home-screen app and the Android app run.
 *
 * A browser cannot listen on a port, so it reaches the network three ways:
 *
 *   WebRTC Direct  dial a desktop peer straight out, with no relay and no
 *                  certificate authority: the multiaddr carries a hash of the
 *                  peer's self-signed certificate, which is what makes the
 *                  connection allowed. This is the only one of the three that
 *                  works from a page served over https, so it is the one that
 *                  matters once the app is hosted anywhere real.
 *   WebSocket      dial a peer that can listen. Only usable when the page
 *                  itself was served over plain http - a https page may not
 *                  open a `ws://` connection, and a peer on someone's LAN has
 *                  no certificate for `wss://`.
 *   WebRTC         once two browsers can both see some relay, they negotiate a
 *                  direct connection through it and then talk peer to peer.
 *
 * The page itself is static files. It can be opened from a USB stick or from
 * any free static host - none of that changes the trust model, because the
 * host never sees an event: everything is signed and stored locally.
 */
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
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
      // Listed first because it is the one that works everywhere.
      webRTCDirect(),
      // `all` permits ws:// as well as wss://, which is what you need when the
      // page was served over http and the peer you are dialling is a desktop
      // app on your own LAN with no certificate. A https page will refuse
      // these regardless of this filter - that is the browser's rule, not ours.
      webSockets({ filter: filters.all }),
      webRTC()
    ],
    peerDiscovery,
    // libp2p's default gater refuses to dial private and loopback addresses
    // from a browser, which is a sensible default for a public DHT crawler
    // and exactly wrong here: the peer you are trying to reach is a desktop
    // app on your own Wi-Fi, so its address is always 192.168.x.x or similar.
    // Every dial is still authenticated by Noise against the peer id in the
    // multiaddr, so allowing these does not let us be pointed at a stranger.
    connectionGater: { denyDialMultiaddr: () => false },
    // A browser listens only for inbound WebRTC negotiated over a relay.
    listen: ['/p2p-circuit', '/webrtc'],
    log
  })
}
