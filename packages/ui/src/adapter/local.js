/**
 * In-page adapter: the browser tab *is* the peer.
 *
 * The whole replica lives in IndexedDB and the libp2p node runs in the page.
 * Nothing is uploaded when you post; the only network traffic is peer to peer.
 */
import { S2S } from '../../../core/src/s2s.js'
import { IdbBackend, loadOrCreateSecretIdb } from '../../../core/src/store-idb.js'
import { createBrowserPeer } from '../../../net/src/platform-browser.js'
import { loadBrowserNetworkKey } from '../../../net/src/browser-key.js'
import { nativeDialAddresses } from '../../../net/src/native-addresses.js'
import { publicPeerRoutes, relayRoutesForRestart } from '../../../net/src/peer-routes.js'
import { Capacitor } from '@capacitor/core'

const LOG_LIMIT = 300

/** Every key this app keeps in localStorage starts with `s2s.`. */
export function clearLocalSettings () {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('s2s.')) localStorage.removeItem(k)
  } catch {
    // nothing stored, nothing to clear
  }
}

export async function createLocalAdapter ({ bootstrapPeers = [], onLog } = {}) {
  const backend = await new IdbBackend().init()
  const learnedRoutes = new Set((await backend.getMeta('peerRoutes')) ?? [])
  const savedRelays = (await backend.getMeta('relayRoutes')) ?? []
  let relayRoutes = publicPeerRoutes(savedRelays, savedRelays).filter((a) => !a.includes('/p2p-circuit')).slice(0, 2)
  const identity = await loadOrCreateSecretIdb(backend)

  const s2s = new S2S({ identity, backend })
  await s2s.load()

  const logs = []
  const log = (msg) => {
    const line = { ts: Date.now(), msg }
    logs.push(line)
    if (logs.length > LOG_LIMIT) logs.shift()
    onLog?.(line)
  }

  const privateKey = await loadBrowserNetworkKey(backend)
  let net = createBrowserPeer({ s2s, bootstrapPeers, relayRoutes, privateKey, log })

  let netReady = false
  let starting = null
  let stopped = false
  const ensureNetwork = () => {
    if (stopped || netReady) return Promise.resolve()
    if (starting) return starting
    starting = net.start().then(() => { netReady = true; notify() }).catch(async (err) => {
      log(`network could not start: ${err.message}; will retry`)
      await net.stop().catch(() => {})
      net = createBrowserPeer({ s2s, bootstrapPeers, relayRoutes, privateKey, log })
      wireNetwork()
    }).finally(() => { starting = null })
    return starting
  }

  const listeners = new Set()
  const notify = () => listeners.forEach((fn) => fn())
  s2s.addEventListener('change', notify)
  const wireNetwork = () => {
    net.addEventListener('peers', notify)
    net.addEventListener('sync', notify)
  }
  wireNetwork()
  s2s.store.addEventListener('blob', notify)
  const netStarting = ensureNetwork()
  const retryTimer = setInterval(() => ensureNetwork(), 5000)

  const urlCache = new Map()

  return {
    kind: 'local',
    me: s2s.me,
    ready: netStarting,

    onChange (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    async snapshot (q) {
      return buildSnapshot(s2s, q)
    },

    async act (action, payload = {}) {
      if (['connect', 'sync', 'checkPeers'].includes(action)) {
        await ensureNetwork()
        if (!netReady) throw new Error('通信の起動に失敗しました。自動再試行しています。')
      }
      if (action === 'connect' && Capacitor.isNativePlatform()) {
        payload = { ...payload, addr: nativeDialAddresses(payload.addr) }
      }
      return runAction(s2s, net, action, payload)
    },

    async status () {
      if (netReady) {
        const currentRelays = relayRoutesForRestart(net.libp2p.getMultiaddrs().map(String))
        if (currentRelays.length && JSON.stringify(currentRelays) !== JSON.stringify(relayRoutes)) {
          relayRoutes = currentRelays
          await backend.setMeta('relayRoutes', relayRoutes)
        }
        const announced = await net.peerAddresses().catch(() => [])
        const routes = publicPeerRoutes(announced, announced)
        const next = [...new Set([...routes, ...learnedRoutes])].slice(0, 200)
        if (JSON.stringify(next) !== JSON.stringify([...learnedRoutes])) {
          learnedRoutes.clear()
          for (const addr of next) learnedRoutes.add(addr)
          await backend.setMeta('peerRoutes', next)
        }
      }
      return {
        online: netReady,
        peerId: netReady ? net.libp2p.peerId.toString() : null,
        addresses: netReady ? net.libp2p.getMultiaddrs().map((m) => m.toString()) : [],
        peers: netReady ? net.onlinePeers().map((p) => p.toString()) : [],
        onlineUsers: netReady ? net.onlineUsers() : [],
        transportPeers: netReady ? net.libp2p.getPeers().map((p) => p.toString()) : [],
        peerAddresses: [...learnedRoutes],
        stats: net.stats,
        logs: logs.slice(-120)
      }
    },

    /** Turn a stored blob into something an <img> can display. */
    async mediaUrl (blob) {
      if (urlCache.has(blob)) return urlCache.get(blob)
      const bytes = await s2s.getMedia(blob)
      if (!bytes) return null
      const url = URL.createObjectURL(new Blob([bytes]))
      urlCache.set(blob, url)
      return url
    },

    async addMedia (file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const dims = await imageSize(file).catch(() => ({}))
      return s2s.addMedia(bytes, { mime: file.type || 'application/octet-stream', ...dims })
    },

    // Async on both adapters so the UI never has to know which it is talking to.
    exportKey: async () => s2s.exportKey(),

    /**
     * Erase the account from this device: the key, the log, the media and
     * every setting. There is no server copy to ask anyone to delete.
     */
    async wipe () {
      stopped = true
      clearInterval(retryTimer)
      await starting
      await net.stop().catch(() => {})
      backend.db?.close()
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('s2s')
        req.onsuccess = req.onerror = req.onblocked = () => resolve()
      })
      clearLocalSettings()
    },
    async stop () {
      stopped = true
      clearInterval(retryTimer)
      await starting
      await net.stop()
    }
  }
}

async function imageSize (file) {
  if (!file.type.startsWith('image/')) return {}
  const bitmap = await createImageBitmap(file)
  const out = { w: bitmap.width, h: bitmap.height }
  bitmap.close()
  return out
}

/**
 * One call returns everything a screen needs. Keeping this in one place means
 * the Electron adapter can serve exactly the same shape over IPC.
 */
export function buildSnapshot (s2s, q = {}) {
  const v = s2s.views
  const base = {
    me: s2s.me,
    profile: s2s.store.profile(s2s.me),
    counts: {
      events: s2s.store.events.size,
      authors: s2s.store.knownAuthors().length,
      following: s2s.store.following(s2s.me).size,
      posts: s2s.store.posts.length
    }
  }

  switch (q.view) {
    case 'home':      return { ...base, items: v.home() }
    case 'global':    return { ...base, items: v.global() }
    case 'media':     return { ...base, items: v.media(q.scope ?? 'global') }
    case 'boards':    return { ...base, boards: v.boards() }
    case 'board':     return { ...base, board: q.board, threads: v.board(q.board) }
    case 'thread':    return { ...base, thread: v.thread(q.id) }
    case 'author':    return { ...base, items: v.byAuthor(q.author), who: s2s.store.profile(q.author), isFollowing: s2s.store.following(s2s.me).has(q.author), isBlocked: s2s.store.blocked(s2s.me).has(q.author) }
    case 'people':    return { ...base, people: v.people() }
    case 'search':    return { ...base, items: v.search(q.query ?? '') }
    case 'notifications': return { ...base, notifications: v.notifications() }
    default:          return base
  }
}

/** The single place where a UI action turns into an appended event. */
export async function runAction (s2s, net, action, p = {}) {
  switch (action) {
    case 'post':      return pick(await s2s.post(p))
    case 'reply':     return pick(await s2s.reply(p))
    case 'thread':    return pick(await s2s.thread(p))
    case 'like':      return pick(await s2s.like(p.target, p.value ?? 1))
    case 'repost':    return pick(await s2s.repost(p.target))
    case 'follow':    return pick(await s2s.follow(p.target))
    case 'unfollow':  return pick(await s2s.unfollow(p.target))
    case 'block':     return pick(await s2s.block(p.target))
    case 'unblock':   return pick(await s2s.unblock(p.target))
    case 'delete':    return pick(await s2s.remove(p.target))
    case 'profile':   return pick(await s2s.setProfile(p))
    case 'connect':   return { addr: await net.connect(p.addr) }
    case 'sync':      await net.syncAll(); return { ok: true }
    case 'checkPeers': return { peers: await net.checkPeers() }
    case 'subscribeBoard': net.subscribeBoard(p.board); return { ok: true }
    case 'setFilter': s2s.setFilter(p); return { ok: true }
    case 'deleteAllMine': {
      // Best effort by nature: this reaches the peers that are online now and
      // those that sync later from someone who received it. It cannot recall
      // copies on devices that never reconnect - the privacy policy says so.
      const mine = (s2s.store.logs.get(s2s.me) ?? []).filter((e) =>
        e && ['post', 'reply', 'thread', 'repost'].includes(e.kind) && !s2s.store.isDeleted(e.id))
      for (const e of mine) await s2s.remove(e.id)
      await s2s.setProfile({ name: '', bio: '' })
      await net.syncAll().catch(() => {})
      return { deleted: mine.length }
    }
    default: throw new Error(`unknown action: ${action}`)
  }
}

const pick = (e) => ({ id: e.id, seq: e.seq, kind: e.kind })
