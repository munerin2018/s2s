/** Default desktop endpoints share an identity; TCP remains usable when a VPN blocks UDP. */
export function nativeDialAddresses (addr) {
  if (Array.isArray(addr)) return [...new Set(addr.flatMap(nativeDialAddresses))]
  if (!/^\/ip[46]\//.test(addr) || addr.includes('/p2p-circuit')) return [addr]
  const alternative = addr.replace(/\/udp\/4003\/webrtc-direct\/certhash\/[^/]+(?=\/p2p\/[^/]+$)/, '/tcp/4002/ws')
  return alternative === addr ? [addr] : [alternative, addr]
}
