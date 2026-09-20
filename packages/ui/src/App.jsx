import { useCallback, useEffect, useRef, useState } from 'react'
import { createAdapter, savedBootstrapPeers, saveBootstrapPeers } from './adapter/index.js'
import { Composer, Empty, Sheet } from './parts.jsx'
import {
  BoardThreads, Boards, Feed, Gallery, Notifications, People, ProfileView, Settings, ThreadView
} from './views.jsx'

const TABS = [
  { key: 'feed', ico: '🏠', label: 'タイムライン' },
  { key: 'gallery', ico: '🖼', label: 'メディア' },
  { key: 'boards', ico: '🧵', label: '掲示板' },
  { key: 'people', ico: '👥', label: 'みんな' },
  { key: 'alerts', ico: '🔔', label: '通知' },
  { key: 'settings', ico: '⚙️', label: '設定' }
]

const TITLES = {
  feed: 'タイムライン',
  gallery: 'メディア',
  boards: '掲示板',
  people: 'みんな',
  alerts: '通知',
  settings: '設定'
}

export default function App () {
  const [adapter, setAdapter] = useState(null)
  const [fatal, setFatal] = useState(null)
  const [tab, setTab] = useState('feed')
  const [scope, setScope] = useState('global')
  const [stack, setStack] = useState([])          // drill-down within a tab
  const [snap, setSnap] = useState(null)
  const [status, setStatus] = useState(null)
  const [replyTo, setReplyTo] = useState(null)
  const [bootstrap, setBootstrapState] = useState(savedBootstrapPeers)
  const scrollRef = useRef(null)

  /* ---- boot ---------------------------------------------------------- */

  useEffect(() => {
    let live = true
    createAdapter({ bootstrapPeers: savedBootstrapPeers() })
      .then((a) => {
        if (!live) return
        setAdapter(a)
        // Your peer, your console. There is no third party here to protect the
        // app from, and being able to script your own node is the point.
        if (typeof window !== 'undefined') window.s2s = a
      })
      .catch((e) => setFatal(e))
    return () => { live = false }
  }, [])

  /* Opening `...#peer=/ip4/.../ws/p2p/...` pairs this device with that peer. */
  useEffect(() => {
    if (!adapter) return
    const m = /(?:^|[#&])peer=([^&]+)/.exec(location.hash)
    if (!m) return
    const addr = decodeURIComponent(m[1])
    adapter.act('connect', { addr })
      .then(() => setBootstrapState((b) => {
        const next = [...new Set([addr, ...b])]
        saveBootstrapPeers(next)
        return next
      }))
      .catch(() => {})
    history.replaceState(null, '', location.pathname + location.search)
  }, [adapter])

  const query = useCallback(() => {
    const top = stack[stack.length - 1]
    if (top) return top
    switch (tab) {
      case 'feed': return { view: scope }
      case 'gallery': return { view: 'media', scope: 'global' }
      case 'boards': return { view: 'boards' }
      case 'people': return { view: 'people' }
      case 'alerts': return { view: 'notifications' }
      default: return { view: 'settings' }
    }
  }, [tab, scope, stack])

  const refresh = useCallback(() => {
    if (!adapter) return
    adapter.snapshot(query()).then(setSnap).catch((e) => console.error(e))
  }, [adapter, query])

  const refreshStatus = useCallback(() => {
    adapter?.status().then(setStatus).catch(() => {})
  }, [adapter])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (!adapter) return
    refreshStatus()
    const off = adapter.onChange(() => refresh())
    const t = setInterval(refreshStatus, 5000)
    return () => { off(); clearInterval(t) }
  }, [adapter, refresh, refreshStatus])

  /* ---- actions ------------------------------------------------------- */

  const act = useCallback(async (action, payload) => {
    const res = await adapter.act(action, payload)
    refresh()
    return res
  }, [adapter, refresh])

  const nav = useCallback((q) => {
    setStack((s) => [...s, q])
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  const back = useCallback(() => setStack((s) => s.slice(0, -1)), [])

  const goTab = useCallback((key) => {
    setTab(key)
    setStack([])
    scrollRef.current?.scrollTo({ top: 0 })
  }, [])

  const setBootstrap = useCallback((list) => {
    setBootstrapState(list)
    saveBootstrapPeers(list)
  }, [])

  /* ---- render -------------------------------------------------------- */

  if (fatal) {
    return (
      <div className="app">
        <div className="pad">
          <Empty icon="⚠️" title="起動できませんでした">
            {String(fatal.message ?? fatal)}
          </Empty>
        </div>
      </div>
    )
  }

  if (!adapter || !snap) {
    return (
      <div className="app">
        <div className="pad center muted" style={{ paddingTop: 80 }}>
          鍵を読み込み、ローカルのログを復元しています…
        </div>
      </div>
    )
  }

  const top = stack[stack.length - 1]
  const title = top
    ? (top.view === 'board' ? `/${top.board}/` : top.view === 'author' ? 'プロフィール' : 'スレッド')
    : TITLES[tab]

  return (
    <div className="app">
      <header className="topbar">
        {stack.length > 0 && <button className="btn tiny ghost" onClick={back}>← 戻る</button>}
        <h1>{title}</h1>
        <span className={`dot${status?.peers?.length ? ' on' : ''}`} title={`接続中のピア: ${status?.peers?.length ?? 0}`} />
        <span className="small muted">{status?.peers?.length ?? 0}</span>
      </header>

      <main className="scroll" ref={scrollRef}>
        <Screen
          snap={snap}
          top={top}
          tab={tab}
          adapter={adapter}
          me={adapter.me}
          scope={scope}
          setScope={setScope}
          nav={nav}
          act={act}
          status={status}
          refreshStatus={refreshStatus}
          bootstrap={bootstrap}
          setBootstrap={setBootstrap}
          onReply={(item) => setReplyTo(item)}
        />
      </main>

      <nav className="nav">
        {TABS.map((t) => (
          <button key={t.key} aria-current={tab === t.key && stack.length === 0} onClick={() => goTab(t.key)}>
            <span className="ico">{t.ico}</span>
            {t.label}
          </button>
        ))}
      </nav>

      {replyTo && (
        <Sheet title={`${replyTo.author.name} に返信`} onClose={() => setReplyTo(null)}>
          <div className="small muted wrap">{replyTo.text?.slice(0, 200)}</div>
          <Composer
            adapter={adapter}
            mode="reply"
            replyTo={{ root: replyTo.id, parent: replyTo.id }}
            placeholder="返信を書く"
            onDone={() => { setReplyTo(null); refresh() }}
          />
        </Sheet>
      )}
    </div>
  )
}

function Screen (props) {
  const { snap, top, tab } = props
  const view = top?.view ?? null

  if (view === 'thread') return <ThreadView {...props} />
  if (view === 'board') return <BoardThreads {...props} />
  if (view === 'author') return <ProfileView {...props} />

  switch (tab) {
    case 'feed': return <Feed {...props} />
    case 'gallery': return <Gallery {...props} />
    case 'boards': return <Boards {...props} />
    case 'people': return <People {...props} />
    case 'alerts': return <Notifications {...props} />
    case 'settings': return <Settings {...props} />
    default: return <Empty icon="?" title="不明な画面" />
  }
}
