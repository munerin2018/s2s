#!/usr/bin/env node
/**
 * A peer pre-filled with sample content, for store screenshots and demos.
 *
 * Several made-up people post text, pictures and a board thread; everything
 * is signed by their own keys exactly as real use would produce, then handed
 * to one listening peer that serves it. Nothing here is real personal data.
 *
 *   node scripts/demo-peer.js --dir ./.demo-peer
 *
 * Uses fixed ports 5401 (tcp), 5402 (ws) and 5403 (webrtc-direct) so the
 * address stays the same between runs.
 */
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { existsSync } from 'node:fs'
import sharp from 'sharp'

import { S2S } from '../packages/core/src/s2s.js'
import { createIdentity } from '../packages/core/src/identity.js'
import { FileBackend, loadOrCreateSecret } from '../packages/core/src/store-node.js'
import { createNodePeer } from '../packages/net/src/platform-node.js'
import { loadOrCreateNetworkKey, openNetworkDatastore } from '../packages/net/src/node-keys.js'

const { values } = parseArgs({
  options: { dir: { type: 'string', default: join(process.cwd(), '.demo-peer') } }
})

/** A simple illustration, so the media grid has something to show. */
async function picture (hue, kind) {
  const w = 1080
  const h = 1080
  const shapes = {
    sunset: `<circle cx="540" cy="620" r="170" fill="hsl(${hue + 20},90%,62%)"/>
             <rect y="700" width="${w}" height="${h - 700}" fill="hsl(${hue + 200},40%,22%)"/>
             <path d="M0 700 L260 520 L470 700 Z" fill="hsl(${hue + 210},35%,30%)"/>
             <path d="M380 700 L720 470 L1080 700 Z" fill="hsl(${hue + 220},30%,26%)"/>`,
    bike: `<circle cx="330" cy="660" r="170" stroke="#e7eaf2" stroke-width="22" fill="none"/>
           <circle cx="750" cy="660" r="170" stroke="#e7eaf2" stroke-width="22" fill="none"/>
           <path d="M330 660 L480 430 L700 430 L750 660 M480 430 L560 660 L330 660 M700 430 L680 360 L760 360"
                 stroke="#e7eaf2" stroke-width="20" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`,
    cafe: `<rect x="330" y="420" width="360" height="330" rx="40" fill="#f3e9dc"/>
           <path d="M690 500 q110 0 110 90 t-110 90" stroke="#f3e9dc" stroke-width="34" fill="none"/>
           <ellipse cx="510" cy="440" rx="180" ry="36" fill="#6b3e26"/>
           <path d="M430 330 q30 -50 0 -100 M510 330 q30 -50 0 -100 M590 330 q30 -50 0 -100"
                 stroke="#e7eaf2" stroke-width="12" fill="none" opacity=".6" stroke-linecap="round"/>`,
    sea: `<rect y="560" width="${w}" height="${h - 560}" fill="hsl(${hue + 190},60%,38%)"/>
          <path d="M0 620 q135 -40 270 0 t270 0 t270 0 t270 0" stroke="#e7eaf2" stroke-width="10" fill="none" opacity=".5"/>
          <circle cx="820" cy="300" r="90" fill="hsl(${hue + 45},95%,70%)"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${hue + 40},65%,32%)"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>${shapes[kind]}</svg>`
  return new Uint8Array(await sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer())
}

async function person (name, bio) {
  const s = new S2S({ identity: createIdentity() })
  await s.setProfile({ name, bio })
  return s
}

async function seed (hub) {
  const yuki = await person('ゆき', '週末は写真と散歩。')
  const takumi = await person('たくみ', 'ロードバイクで峠を走ってます 🚲')
  const mina = await person('みな', 'コーヒーと本が好き')
  const sora = await person('そら', 'P2P とか分散系の話が好きです')

  const pic = async (who, hue, kind, text) => {
    const ref = await who.addMedia(await picture(hue, kind), { mime: 'image/jpeg', w: 1080, h: 1080 })
    return who.post({ text, media: [ref] })
  }

  await sora.post({ text: 'サーバーのない SNS、思ったより普通に使える。投稿が自分の端末に残るのが安心感ある。' })
  await pic(yuki, 15, 'sunset', '帰り道の夕焼け。今日は空がきれいだった')
  await pic(takumi, 200, 'bike', '朝練おわり！峠まで往復 60km')
  await mina.post({ text: '新しい喫茶店を見つけた。窓際の席が最高 ☕' })
  await pic(mina, 25, 'cafe', 'ここのブレンド、すごく好み')
  await pic(yuki, 185, 'sea', '海まで足をのばしてみた')
  const q = await takumi.post({ text: 'おすすめのサイクリングロードあったら教えてほしい' })
  await sora.reply({ root: q.id, parent: q.id, text: 'しまなみ海道は一度は走ってほしい' })
  await yuki.reply({ root: q.id, parent: q.id, text: '川沿いの道が走りやすかったよ' })
  await pic(takumi, 120, 'bike', '新しいホイールに替えた')

  const t = await sora.thread({ board: 'p2p', title: 'P2P SNS を使ってみた感想スレ', text: '気づいたこと、困ったことなど何でも' })
  await takumi.reply({ root: t.id, parent: t.id, text: 'QR コードでスマホとつながるのが楽だった' })
  await mina.reply({ root: t.id, parent: t.id, text: 'オフラインの人の投稿は見えないのが最初ちょっと不思議だった' })
  await yuki.reply({ root: t.id, parent: t.id, text: '広告が一切ないのがいい' })
  await sora.reply({ root: t.id, parent: t.id, text: '常時起動のピアを 1 台置くとかなり快適になるよ' })
  await takumi.thread({ board: 'bike', title: '週末ライド募集スレ', text: '土曜の朝、川沿いコース走りませんか' })
  await mina.thread({ board: 'books', title: '最近読んでよかった本', text: 'ジャンル問わず' })

  for (const [a, b] of [[yuki, takumi], [takumi, yuki], [mina, yuki], [sora, takumi], [yuki, sora]]) await a.follow(b.me)
  for (const e of [...yuki.store.posts]) await takumi.like(e)

  // Hand every log and every blob to the listening peer, exactly as sync would.
  for (const who of [yuki, takumi, mina, sora]) {
    for (const e of who.store.logRange(who.me, 1, 999)) await hub.store.put(e)
    for (const [id, bytes] of who.store.blobs) await hub.store.putBlob(id, bytes)
  }
}

const fresh = !existsSync(join(values.dir, 'events.jsonl'))
const backend = await new FileBackend(values.dir).init()
const hub = new S2S({ identity: await loadOrCreateSecret(values.dir), backend })
await hub.load()
if (fresh) {
  await hub.setProfile({ name: 'S2S デモ' })
  await seed(hub)
  console.log(`seeded ${hub.store.events.size} events`)
}

const net = createNodePeer({
  s2s: hub,
  privateKey: await loadOrCreateNetworkKey(values.dir),
  datastore: await openNetworkDatastore(values.dir),
  tcpPort: 5401,
  wsPort: 5402,
  webrtcPort: 5403,
  lan: false,
  log: () => {}
})
await net.start()

console.log('\nAddresses:')
for (const a of net.libp2p.getMultiaddrs()) console.log(`  ${a}`)

process.on('SIGINT', async () => { await net.stop(); process.exit(0) })
