/**
 * Choosing an address to hand to another device, and turning it into a QR code.
 *
 * Not every address this peer is listening on is usable by the device you are
 * pairing with, and the reasons are worth stating because they are not
 * obvious from looking at the list:
 *
 *   - A page served over https may not open a `ws://` connection. The browser
 *     refuses it outright, so every WebSocket address is dead to the hosted
 *     web build and to an iOS home-screen app, which is a Safari page over
 *     https. WebRTC Direct is not subject to that rule.
 *   - Loopback is useless to another device by definition, and WebRTC treats
 *     it oddly even on the same machine.
 *   - A machine usually has several interfaces. Virtual ones from VMs and
 *     container runtimes are routable from nothing, so a real LAN address
 *     beats them.
 */

/** Private ranges, in the order a phone on your Wi-Fi is likely to reach them. */
const LAN_PATTERNS = [
  /^\/ip4\/192\.168\./,
  /^\/ip4\/10\./,
  /^\/ip4\/172\.(1[6-9]|2[0-9]|3[01])\./
]

const isLoopback = (addr) => addr.startsWith('/ip4/127.') || addr.startsWith('/ip6/::1')
const isWebRTCDirect = (addr) => addr.includes('/webrtc-direct/')
const isWebSocket = (addr) => addr.includes('/ws/') || addr.endsWith('/ws')

/**
 * Virtual adapters that are almost never the one a phone can reach.
 * VirtualBox hands out 192.168.56.x, WSL uses 172.x, Tailscale 100.64/10.
 */
const LIKELY_VIRTUAL = [
  /^\/ip4\/192\.168\.56\./,
  /^\/ip4\/172\.2[0-9]\./,
  /^\/ip4\/100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./
]

function score (addr) {
  if (isLoopback(addr)) return -1

  let n = 0
  // The only transport a https page can use, so it outranks everything.
  if (isWebRTCDirect(addr)) n += 100
  else if (isWebSocket(addr)) n += 40
  else return -1 // tcp: other desktop peers only, not browsers

  if (LAN_PATTERNS.some((re) => re.test(addr))) n += 20
  if (LIKELY_VIRTUAL.some((re) => re.test(addr))) n -= 15
  return n
}

/**
 * The address most likely to work from another device's browser.
 * @param {string[]} addresses
 * @returns {string|null}
 */
export function bestPairingAddress (addresses = []) {
  const ranked = addresses
    .map((addr) => ({ addr, n: score(addr) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => b.n - a.n)
  return ranked[0]?.addr ?? null
}

/** Every address a browser could use, best first - for showing a list. */
export function browserReachableAddresses (addresses = []) {
  return addresses
    .map((addr) => ({ addr, n: score(addr) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.addr)
}

/**
 * A link that opens the web app already pointed at this peer.
 *
 * `#peer=` is read on boot by `App.jsx`, so scanning this with a phone camera
 * is the whole pairing flow - no multiaddr typed by hand.
 *
 * @param {string} addr
 * @param {string} [appUrl] where the web build is hosted
 */
export function pairingUrl (addr, appUrl) {
  const base = appUrl || DEFAULT_APP_URL
  return `${base}#peer=${encodeURIComponent(addr)}`
}

/**
 * Where the hosted web build lives.
 *
 * Only a default. It is a convenience for pairing a phone, not a dependency:
 * the page it points at is static files that talk to nobody, and anyone can
 * host their own copy and paste that instead.
 */
export const DEFAULT_APP_URL = 'https://munerin2018.github.io/s2s/app/'
