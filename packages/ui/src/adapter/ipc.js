/**
 * Desktop adapter: the peer runs in the Electron main process.
 *
 * A browser tab cannot open a TCP port or speak mDNS, so on desktop the libp2p
 * node lives in the Node process and the window talks to it over IPC. That is
 * what lets two machines on the same Wi-Fi find each other with no
 * configuration at all - and it is what lets the desktop app act as the relay
 * that browser and phone peers connect through.
 *
 * The API it exposes is identical to the in-page adapter, so every screen in
 * this app is written once.
 */
export async function createIpcAdapter (bridge) {
  const urlCache = new Map()
  const listeners = new Set()
  const me = await bridge.me()

  bridge.onChange(() => listeners.forEach((fn) => fn()))

  return {
    kind: 'desktop',
    me,
    ready: Promise.resolve(),

    onChange (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    snapshot: (q) => bridge.snapshot(q),
    act: (action, payload) => bridge.act(action, payload),
    status: () => bridge.status(),

    async mediaUrl (blob) {
      if (urlCache.has(blob)) return urlCache.get(blob)
      const buf = await bridge.media(blob)
      if (!buf) return null
      const url = URL.createObjectURL(new Blob([buf]))
      urlCache.set(blob, url)
      return url
    },

    async addMedia (file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const dims = await imageSize(file).catch(() => ({}))
      return bridge.addMedia({ bytes, mime: file.type || 'application/octet-stream', ...dims })
    },

    exportKey: () => bridge.exportKey(),
    stop: async () => {}
  }
}

async function imageSize (file) {
  if (!file.type.startsWith('image/')) return {}
  const bitmap = await createImageBitmap(file)
  const out = { w: bitmap.width, h: bitmap.height }
  bitmap.close()
  return out
}
