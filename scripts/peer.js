#!/usr/bin/env node
/**
 * Headless S2S peer.
 *
 * Same protocol as the desktop app, no window. Two uses:
 *
 *   - leave one running so your posts stay reachable while your laptop sleeps
 *   - run it on a box with a public address and it becomes the relay that lets
 *     browser and phone peers behind NAT reach each other
 *
 * It stores a log like any other peer, which means it is not a server: it holds
 * what it has replicated and nothing else, and the network survives it going
 * away.
 *
 *   node scripts/peer.js --dir ./.s2s-peer --tcp 4001 --ws 4002
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { S2S } from '../packages/core/src/s2s.js'
import { FileBackend, loadOrCreateSecret } from '../packages/core/src/store-node.js'
import { createNodePeer } from '../packages/net/src/platform-node.js'

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: join(process.cwd(), '.s2s-peer') },
    tcp: { type: 'string', default: '0' },
    ws: { type: 'string', default: '0' },
    connect: { type: 'string', multiple: true, default: [] },
    lan: { type: 'boolean', default: true },
    'no-lan': { type: 'boolean', default: false },
    relay: { type: 'boolean', default: true },
    dht: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    name: { type: 'string' },
    post: { type: 'string', multiple: true, default: [] },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(`
S2S headless peer

  --dir <path>       where the log and blobs live   (default ./.s2s-peer)
  --tcp <port>       TCP listen port                (default 0 = any free port)
  --ws <port>        WebSocket port for browsers    (default 0)
  --connect <addr>   dial this multiaddr on start   (repeatable)
  --no-lan           do not announce on the local network
  --dht              join the Kademlia DHT
  --name <name>      set the profile name on first run
  --post <text>      publish a post on start        (repeatable)
  --quiet            only print addresses and errors
`)
  process.exit(0)
}

const log = (m) => { if (!values.quiet) console.log(`[s2s] ${m}`) }

const backend = await new FileBackend(values.dir).init()
const identity = await loadOrCreateSecret(values.dir)
const s2s = new S2S({ identity, backend })
await s2s.load()

console.log(`identity  ${identity.id}`)
console.log(`data dir  ${values.dir}`)

if (values.name && !s2s.store.profiles.has(s2s.me)) {
  await s2s.setProfile({ name: values.name })
}

const peer = createNodePeer({
  s2s,
  tcpPort: Number(values.tcp),
  wsPort: Number(values.ws),
  lan: values.lan && !values['no-lan'],
  relay: values.relay,
  dht: values.dht,
  log
})

await peer.start()

console.log('\nAddresses other peers can dial:')
for (const a of peer.libp2p.getMultiaddrs()) console.log(`  ${a}`)
console.log('\n(paste a /ws/ address into the web or phone app)\n')

for (const addr of values.connect) {
  try {
    await peer.connect(addr)
    console.log(`connected to ${addr}`)
  } catch (err) {
    console.error(`could not connect to ${addr}: ${err.message}`)
  }
}

for (const text of values.post) {
  const e = await s2s.post({ text })
  console.log(`posted ${e.id}`)
}

// A quiet heartbeat so it is obvious the peer is alive and what it holds.
setInterval(() => {
  if (values.quiet) return
  const info = peer.peerInfo()
  console.log(
    `[s2s] peers ${info.peers.length} · events ${s2s.store.events.size} · authors ${s2s.store.knownAuthors().length}`
  )
}, 30_000)

const shutdown = async () => {
  console.log('\nstopping…')
  await peer.stop().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
