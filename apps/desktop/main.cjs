/**
 * S2S desktop peer.
 *
 * The window is only a view. The peer itself - the log, the key, the libp2p
 * node - lives here in the main process, because this is the only place in the
 * stack that can do the two things a browser cannot:
 *
 *   - listen on a port, so other devices can dial *in*
 *   - speak mDNS, so peers on the same Wi-Fi find each other with zero setup
 *
 * It also runs a circuit relay, which is how a phone or a browser tab behind
 * NAT reaches other peers. That is the whole "who pays for servers" answer:
 * this process, on hardware you already own, switched off whenever you like.
 *
 * This file is CommonJS on purpose. Electron resolves `require('electron')` to
 * its built-in API; an ESM `import` of the same specifier finds the npm helper
 * package instead, which only knows where the binary lives.
 */
const { app, BrowserWindow, ipcMain, protocol, net: electronNet, shell, Menu, clipboard } = require('electron')
const { pathToFileURL } = require('node:url')
const { join, normalize } = require('node:path')
const { readFile } = require('node:fs/promises')

const UI_DIST = join(__dirname, '..', '..', 'packages', 'ui', 'dist')
const LOG_LIMIT = 400
const logs = []

let win = null
let s2s = null
let peer = null
let ui = null // the ESM modules, loaded once Electron is up
let peerReady = null // resolves when the log is loaded and libp2p is up

function log (msg) {
  const line = { ts: Date.now(), msg }
  logs.push(line)
  if (logs.length > LOG_LIMIT) logs.shift()
  console.log(`[s2s] ${msg}`)
  win?.webContents.send('s2s:log', line)
}

/** Serve the built UI over a real origin so ES modules and IndexedDB work. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

async function loadModules () {
  const url = (rel) => pathToFileURL(join(__dirname, '..', '..', rel)).href
  const [core, storeNode, net, keys, adapter] = await Promise.all([
    import(url('packages/core/src/s2s.js')),
    import(url('packages/core/src/store-node.js')),
    import(url('packages/net/src/platform-node.js')),
    import(url('packages/net/src/node-keys.js')),
    import(url('packages/ui/src/adapter/local.js'))
  ])
  return { S2S: core.S2S, ...storeNode, ...net, ...keys, ...adapter }
}

async function createPeer () {
  ui = await loadModules()

  const dir = join(app.getPath('userData'), 'data')
  const backend = await new ui.FileBackend(dir).init()
  const identity = await ui.loadOrCreateSecret(dir)

  s2s = new ui.S2S({ identity, backend })
  await s2s.load()
  log(`identity ${identity.id}`)
  log(`data directory ${dir}`)

  peer = ui.createNodePeer({
    s2s,
    // Persisted so that an address someone pasted into their phone keeps
    // working after this app restarts.
    privateKey: await ui.loadOrCreateNetworkKey(dir),
    datastore: await ui.openNetworkDatastore(dir),
    // Fixed ports rather than 0. A stable key and certificate are only half
    // of a stable address - the port is in there too, and "paste this into
    // your phone once" stops being true if it moves on every launch. Two
    // desktop peers on one machine would collide, which is rare enough to be
    // worth the trade and is what the env vars are for.
    tcpPort: Number(process.env.S2S_TCP_PORT ?? 4001),
    wsPort: Number(process.env.S2S_WS_PORT ?? 4002),
    webrtcPort: Number(process.env.S2S_WEBRTC_PORT ?? 4003),
    relay: true,
    lan: true,
    dht: process.env.S2S_DHT === '1',
    bootstrapPeers: (process.env.S2S_BOOTSTRAP ?? '').split(',').filter(Boolean),
    log
  })

  await peer.start()

  const notify = () => win?.webContents.send('s2s:change')
  s2s.addEventListener('change', notify)
  peer.addEventListener('peers', notify)
  peer.addEventListener('sync', notify)
  s2s.store.addEventListener('blob', notify)
}

function createWindow () {
  win = new BrowserWindow({
    width: 480,
    height: 900,
    minWidth: 360,
    minHeight: 560,
    backgroundColor: '#0b0d12',
    title: 'S2S',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.loadURL('app://s2s/index.html')

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Renderer problems are otherwise invisible in a packaged app; surface them
  // in the same log the settings screen shows.
  win.webContents.on('console-message', (event) => {
    const level = event.level ?? ''
    if (level === 'error' || level === 'warning') log(`ui: ${event.message}`)
  })
  win.webContents.on('render-process-gone', (_e, details) => log(`ui crashed: ${details.reason}`))

  if (process.env.S2S_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  if (process.env.S2S_SMOKE === '1') runSmokeTest()
}

/**
 * Headless self-check used by `npm run smoke`.
 *
 * Drives the real UI through a real peer: writes a post, reads it back out of
 * the rendered DOM, and reports. It exists so a change to the protocol cannot
 * quietly break the app while every unit test still passes.
 */
function runSmokeTest () {
  win.webContents.once('did-finish-load', async () => {
    const check = async (label, js) => {
      try {
        const got = await win.webContents.executeJavaScript(js)
        console.log(`SMOKE ${got ? 'ok  ' : 'FAIL'} ${label}${got && got !== true ? ` -> ${got}` : ''}`)
        return !!got
      } catch (err) {
        console.log(`SMOKE FAIL ${label} -> ${err.message}`)
        return false
      }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    await sleep(2500)

    let ok = true
    ok &= await check('bridge is exposed', 'typeof window.s2sBridge === "object"')
    ok &= await check('app rendered', 'document.querySelectorAll(".nav button").length === 6')
    ok &= await check('identity resolved', 'window.s2sBridge.me().then(m => m.startsWith("@"))')
    ok &= await check('composer present', '!!document.querySelector(".composer textarea")')

    await win.webContents.executeJavaScript(
      'window.s2sBridge.act("post", { text: "smoke test post" })'
    )
    await sleep(1500)
    ok &= await check(
      'post appears in the timeline',
      'document.body.innerText.includes("smoke test post")'
    )
    ok &= await check(
      'board thread can be created',
      'window.s2sBridge.act("thread", { board: "smoke", title: "t", text: "x" }).then(r => r.kind === "thread")'
    )
    ok &= await check('peer is listening', 'window.s2sBridge.status().then(s => s.addresses.length > 0)')

    // The pairing QR is the only way onto iOS without typing a multiaddr by
    // hand, so it is worth failing the build over.
    await win.webContents.executeJavaScript("document.querySelectorAll('.nav button')[5].click()")
    await sleep(2500)
    ok &= await check(
      'pairing QR renders on the settings screen',
      '!!document.querySelector("img[alt=\'ペアリング用QRコード\']")'
    )
    ok &= await check(
      'the address offered for pairing is one a browser can use',
      'document.body.innerText.includes("/webrtc-direct/")'
    )

    if (process.env.S2S_SHOT) {
      const image = await win.webContents.capturePage()
      await require('node:fs/promises').writeFile(process.env.S2S_SHOT, image.toPNG())
      console.log(`SMOKE shot ${process.env.S2S_SHOT}`)
    }

    console.log(ok ? 'SMOKE PASS' : 'SMOKE FAILED')
    app.exit(ok ? 0 : 1)
  })
}

/* ---- IPC: the same API surface the in-page adapter exposes ------------- */

function wireIpc () {
  // The window opens immediately so the user sees something; every call that
  // touches the replica waits for it to finish loading instead of failing.
  const ready = () => peerReady

  ipcMain.handle('s2s:me', async () => { await ready(); return s2s.me })
  ipcMain.handle('s2s:snapshot', async (_e, q) => { await ready(); return ui.buildSnapshot(s2s, q) })
  ipcMain.handle('s2s:act', async (_e, action, payload) => { await ready(); return ui.runAction(s2s, peer, action, payload) })

  ipcMain.handle('s2s:status', () => {
    if (!peer?.libp2p) return { online: false, peers: [], addresses: [], logs: logs.slice(-120), stats: {} }
    return {
      online: true,
      peerId: peer.libp2p.peerId.toString(),
      addresses: peer.libp2p.getMultiaddrs().map((m) => m.toString()),
      peers: peer.libp2p.getPeers().map((p) => p.toString()),
      stats: peer.stats,
      logs: logs.slice(-120)
    }
  })

  ipcMain.handle('s2s:media', async (_e, blob) => {
    await ready()
    const bytes = await s2s.getMedia(blob)
    return bytes ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : null
  })

  ipcMain.handle('s2s:addMedia', async (_e, { bytes, mime, w, h }) => {
    await ready()
    return s2s.addMedia(new Uint8Array(bytes), { mime, w, h })
  })

  ipcMain.handle('s2s:exportKey', async () => { await ready(); return s2s.exportKey() })
  ipcMain.handle('s2s:copy', (_e, text) => clipboard.writeText(String(text)))
}

/* ---- boot -------------------------------------------------------------- */

app.whenReady().then(async () => {
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    // Everything is served from the built UI directory; nothing above it.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '')
    const target = join(UI_DIST, rel || 'index.html')
    if (!target.startsWith(UI_DIST)) return new Response('forbidden', { status: 403 })

    try {
      return await electronNet.fetch(pathToFileURL(target).href)
    } catch {
      // Single page app fallback.
      return new Response(await readFile(join(UI_DIST, 'index.html')), {
        headers: { 'content-type': 'text/html' }
      })
    }
  })

  Menu.setApplicationMenu(null)

  peerReady = createPeer()
    .then(() => { win?.webContents.send('s2s:change') })
    .catch((err) => {
      console.error('could not start the peer:', err)
      log(`peer failed to start: ${err.message}`)
      throw err
    })

  wireIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', async () => {
  await peer?.stop().catch(() => {})
  if (process.platform !== 'darwin') app.quit()
})
