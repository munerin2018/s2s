import { useEffect, useState } from 'react'
import { AdSlot, Avatar, Composer, Empty, MediaGrid, PostCard, Sheet, ago, shortId, useBlobUrl } from './parts.jsx'
import { AD_EVERY } from './ads.js'
import { PairingCode } from './pairing-code.jsx'
import { SafetySettings, DeleteAccount } from './safety-settings.jsx'

/* ---- Twitter mode ------------------------------------------------------ */

export function Feed ({ snap, adapter, me, scope, setScope, nav, act, onReply, onReport }) {
  return (
    <>
      <div className="tabs">
        <button aria-current={scope === 'home'} onClick={() => setScope('home')}>フォロー中</button>
        <button aria-current={scope === 'global'} onClick={() => setScope('global')}>すべて</button>
      </div>

      <Composer adapter={adapter} />

      {(snap.items ?? []).length === 0 ? (
        scope === 'home' ? (
          <Empty icon="🌱" title="まだ誰もフォローしていません">
            「みんな」タブから誰かを見つけてフォローすると、ここに流れます。
          </Empty>
        ) : (
          <Empty icon="📡" title="まだ何も受信していません">
            設定タブでピアに接続するか、同じWi-Fi上でPC版を起動してください。<br />
            自分で投稿すれば、繋がった相手に自動で届きます。
          </Empty>
        )
      ) : (
        (snap.items ?? []).map((item, i) => (
          <div key={item.cardId} className="feed-row">
            {i > 0 && i % AD_EVERY === 0 && <AdSlot slotIndex={i} />}
            <PostCard
              item={item}
              adapter={adapter}
              me={me}
              onAct={act}
              onReply={onReply}
              onReport={onReport}
              onOpen={(p) => nav({ view: 'thread', id: p.id })}
              onAuthor={(a) => nav({ view: 'author', author: a })}
            />
          </div>
        ))
      )}
    </>
  )
}

/* ---- Instagram mode ---------------------------------------------------- */

export function Gallery ({ snap, adapter, me, nav, act, onReply, onReport }) {
  const [open, setOpen] = useState(null)
  const items = snap.items ?? []

  return (
    <>
      {items.length === 0 ? (
        <Empty icon="🖼" title="画像つきの投稿がありません">
          投稿に画像を添付すると、ここにグリッドで並びます。<br />
          画像の実体はハッシュで参照され、持っているピアから直接届きます。
        </Empty>
      ) : (
        <div className="grid">
          {items.map((item) => (
            <Tile key={item.cardId} item={item} adapter={adapter} onClick={() => setOpen(item)} />
          ))}
        </div>
      )}

      {open && (
        <Sheet title={open.author.name} onClose={() => setOpen(null)}>
          <PostCard
            item={open}
            adapter={adapter}
            me={me}
            onAct={act}
            onReply={onReply}
            onReport={(t) => { setOpen(null); onReport(t) }}
            onOpen={(p) => { setOpen(null); nav({ view: 'thread', id: p.id }) }}
            onAuthor={(a) => { setOpen(null); nav({ view: 'author', author: a }) }}
          />
        </Sheet>
      )}
    </>
  )
}

function Tile ({ item, adapter, onClick }) {
  const url = useBlobUrl(adapter, item.media[0]?.blob)
  return (
    <button onClick={onClick}>
      {url
        ? <img src={url} alt={item.media[0]?.alt ?? ''} loading="lazy" />
        : <div className="media-pending" style={{ height: '100%' }}>未受信</div>}
    </button>
  )
}

/* ---- 2ch mode ---------------------------------------------------------- */

export function Boards ({ snap, adapter, nav }) {
  const [creating, setCreating] = useState(false)

  return (
    <>
      <div className="pad row">
        <span className="grow small muted">板は誰でも作れます。板名が同じなら同じ板です。</span>
        <button className="btn tiny primary" onClick={() => setCreating(true)}>＋ スレを立てる</button>
      </div>

      {creating && (
        <Sheet title="スレッドを立てる" onClose={() => setCreating(false)}>
          <Composer adapter={adapter} mode="thread" placeholder="本文（>>1 になります）" onDone={() => setCreating(false)} />
        </Sheet>
      )}

      {(snap.boards ?? []).length === 0 ? (
        <Empty icon="🧵" title="まだ板がありません">
          最初のスレッドを立てると板ができます。
        </Empty>
      ) : (
        (snap.boards ?? []).map((b) => (
          <button key={b.board} className="board-row" onClick={() => nav({ view: 'board', board: b.board })}>
            <div className="name">/{b.board}/</div>
            <div className="small muted">
              {b.threads} スレッド · {b.posts} レス · 最終 {ago(b.lastActivity)}
            </div>
          </button>
        ))
      )}
    </>
  )
}

export function BoardThreads ({ snap, adapter, nav }) {
  const [creating, setCreating] = useState(false)

  return (
    <>
      <div className="pad row">
        <span className="grow small muted">/{snap.board}/</span>
        <button className="btn tiny primary" onClick={() => setCreating(true)}>＋ スレを立てる</button>
      </div>

      {creating && (
        <Sheet title={`/${snap.board}/ にスレを立てる`} onClose={() => setCreating(false)}>
          <Composer adapter={adapter} mode="thread" board={snap.board} placeholder="本文（>>1 になります）" onDone={() => setCreating(false)} />
        </Sheet>
      )}

      {(snap.threads ?? []).length === 0 ? (
        <Empty icon="🧵" title="この板にはまだスレがありません" />
      ) : (
        (snap.threads ?? []).map((t, i) => (
          <button key={t.id} className="thread-row" onClick={() => nav({ view: 'thread', id: t.id })}>
            <div className="title">{i + 1}: {t.title} ({t.count})</div>
            <div className="small muted">{t.author.name} · 最終 {ago(t.lastTs)}</div>
          </button>
        ))
      )}
    </>
  )
}

export function ThreadView ({ snap, adapter, me, act, nav, onReport }) {
  const t = snap.thread
  if (!t?.root) {
    return (
      <Empty icon="🔍" title="この投稿はまだ手元にありません">
        参照先を持っているピアに接続すると表示されます。
      </Empty>
    )
  }

  return (
    <>
      <div className="res">
        <div className="head">
          <span className="no">1</span>
          <button onClick={() => nav({ view: 'author', author: t.root.authorId })}>{t.root.author.name}</button>
          <span>{ago(t.root.ts)}</span>
          {t.root.board && <span>/{t.root.board}/</span>}
        </div>
        {t.root.title && <div style={{ fontWeight: 650, marginTop: 4 }}>{t.root.title}</div>}
        {t.root.text && <div className="body">{t.root.text}</div>}
        <MediaGrid media={t.root.media} adapter={adapter} />
        <div className="actions">
          <button
            className={t.root.myLike === 1 ? 'on' : ''}
            onClick={() => act('like', { target: t.root.id, value: 1 })}
          >
            {t.root.myLike === 1 ? '♥' : '♡'} {t.root.likes.up || ''}
          </button>
          {t.root.authorId !== me && (
            <button
              title="通報"
              aria-label="通報"
              onClick={() => onReport({ eventId: t.root.id, authorId: t.root.authorId, name: t.root.author.name })}
            >
              ⚑
            </button>
          )}
        </div>
      </div>

      {t.posts.map((p) => (
        <div className="res" key={p.id}>
          <div className="head">
            <span className="no">{p.no}</span>
            <button onClick={() => nav({ view: 'author', author: p.authorId })}>{p.author.name}</button>
            <span>{ago(p.ts)}</span>
            <span className="wrap" style={{ opacity: .5 }}>{shortId(p.authorId)}</span>
          </div>
          <div className="body">{p.text}</div>
          <MediaGrid media={p.media} adapter={adapter} />
          <div className="actions">
            <button className={p.myLike === 1 ? 'on' : ''} onClick={() => act('like', { target: p.id, value: 1 })}>
              {p.myLike === 1 ? '♥' : '♡'} {p.likes.up || ''}
            </button>
            {p.authorId === me && (
              <button onClick={() => confirm('削除しますか？') && act('delete', { target: p.id })}>🗑</button>
            )}
            {p.authorId !== me && (
              <button
                title="通報"
                aria-label="通報"
                onClick={() => onReport({ eventId: p.id, authorId: p.authorId, name: p.author.name })}
              >
                ⚑
              </button>
            )}
          </div>
        </div>
      ))}

      <Composer
        adapter={adapter}
        mode="reply"
        replyTo={{ root: t.root.id, parent: t.root.id }}
        placeholder="レスを書く"
      />
    </>
  )
}

/* ---- people & profile -------------------------------------------------- */

export function People ({ snap, adapter, act, nav }) {
  const people = snap.people ?? []
  return people.length === 0 ? (
    <Empty icon="👥" title="まだ誰も知りません">
      ピアに接続すると、その相手が持っている人たちが見えるようになります。
    </Empty>
  ) : (
    people.map((p) => (
      <div className="post" key={p.id}>
        <button onClick={() => nav({ view: 'author', author: p.id })}>
          <Avatar profile={p} adapter={adapter} />
        </button>
        <div className="grow">
          <div className="row">
            <span className="name grow">{p.name}{p.isSelf && <span className="muted small"> (自分)</span>}</span>
            {!p.isSelf && (
              <button
                className={`btn tiny${p.following ? '' : ' primary'}`}
                onClick={() => act(p.following ? 'unfollow' : 'follow', { target: p.id })}
              >
                {p.following ? 'フォロー中' : 'フォロー'}
              </button>
            )}
          </div>
          <div className="small muted wrap">{shortId(p.id)}</div>
          <div className="small muted">{p.posts} イベント · {p.followers} フォロワー</div>
        </div>
      </div>
    ))
  )
}

export function ProfileView ({ snap, adapter, me, act, nav, onReply, onReport }) {
  const who = snap.who
  if (!who) return <Empty icon="🔍" title="この人のことはまだ知りません" />
  const isSelf = who.id === me

  return (
    <>
      <div className="pad col">
        <div className="row">
          <Avatar profile={who} adapter={adapter} />
          <div className="grow">
            <div className="name" style={{ fontWeight: 650 }}>{who.name}</div>
            <div className="small muted wrap">{who.id}</div>
          </div>
          {!isSelf && (
            <div className="col" style={{ gap: 6 }}>
              <button
                className={`btn tiny${snap.isFollowing ? '' : ' primary'}`}
                onClick={() => act(snap.isFollowing ? 'unfollow' : 'follow', { target: who.id })}
              >
                {snap.isFollowing ? 'フォロー中' : 'フォロー'}
              </button>
              <button
                className={`btn tiny${snap.isBlocked ? '' : ' danger'}`}
                onClick={() => act(snap.isBlocked ? 'unblock' : 'block', { target: who.id })}
              >
                {snap.isBlocked ? 'ブロック解除' : 'ブロック'}
              </button>
              <button
                className="btn tiny ghost"
                onClick={() => onReport({ authorId: who.id, name: who.name })}
              >
                ⚑ 通報
              </button>
            </div>
          )}
        </div>
        {who.bio && <div className="wrap">{who.bio}</div>}
      </div>

      {(snap.items ?? []).map((item) => (
        <PostCard
          key={item.cardId}
          item={item}
          adapter={adapter}
          me={me}
          onAct={act}
          onReply={onReply}
          onReport={onReport}
          onOpen={(p) => nav({ view: 'thread', id: p.id })}
          onAuthor={(a) => nav({ view: 'author', author: a })}
        />
      ))}
    </>
  )
}

/* ---- notifications ----------------------------------------------------- */

export function Notifications ({ snap, nav }) {
  const list = snap.notifications ?? []
  const label = { reply: '返信しました', like: 'いいねしました', dislike: 'よくないを押しました', follow: 'フォローしました', repost: 'リポストしました' }

  return list.length === 0 ? (
    <Empty icon="🔔" title="通知はありません" />
  ) : (
    list.map((n) => (
      <button
        key={n.id}
        className="board-row"
        onClick={() => n.target && nav({ view: 'thread', id: n.target })}
      >
        <div><strong>{n.who.name}</strong> が{label[n.type] ?? n.type}</div>
        {n.text && <div className="small muted wrap">{n.text.slice(0, 120)}</div>}
        <div className="small muted">{ago(n.ts)}</div>
      </button>
    ))
  )
}

/* ---- settings ---------------------------------------------------------- */

export function Settings ({ snap, adapter, status, act, refreshStatus, bootstrap, setBootstrap }) {
  const [name, setName] = useState(snap.profile?.name ?? '')
  const [bio, setBio] = useState(snap.profile?.bio ?? '')
  const [addr, setAddr] = useState('')
  const [msg, setMsg] = useState(null)
  const [secret, setSecret] = useState(null)

  useEffect(() => {
    const t = setInterval(refreshStatus, 3000)
    return () => clearInterval(t)
  }, [refreshStatus])

  async function connect () {
    setMsg(null)
    try {
      await act('connect', { addr: addr.trim() })
      const next = [...new Set([addr.trim(), ...bootstrap])]
      setBootstrap(next)
      setMsg({ ok: true, text: '接続しました。次回起動時にも自動で試します。' })
      setAddr('')
    } catch (e) {
      setMsg({ ok: false, text: `接続できません: ${e.message}` })
    }
  }

  return (
    <div className="pad col" style={{ gap: 14 }}>
      <div className="card">
        <h3>プロフィール</h3>
        <input className="field" placeholder="表示名" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
        <textarea className="field" rows={2} placeholder="自己紹介" value={bio} onChange={(e) => setBio(e.target.value)} maxLength={400} />
        <button className="btn primary" onClick={() => act('profile', { name, bio })}>保存</button>
        <div className="small muted">
          プロフィールも1つのイベントです。保存すると署名され、繋がっているピアに伝わります。
        </div>
      </div>

      <div className="card">
        <h3>ピアに接続</h3>
        <div className="small muted">
          PC版が表示しているアドレスを貼り付けてください。同じWi-Fi内のPC版どうしは自動で見つかります。
        </div>
        <input
          className="field mono"
          placeholder="/ip4/192.168.0.10/tcp/.../ws/p2p/12D3Koo..."
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
        />
        <button className="btn primary" onClick={connect} disabled={!addr.trim()}>接続</button>
        {msg && <div className={`small ${msg.ok ? '' : 'banner'}`}>{msg.text}</div>}

        {bootstrap.length > 0 && (
          <>
            <div className="small muted">起動時に試すピア</div>
            {bootstrap.map((b) => (
              <div className="row" key={b}>
                <code className="mono grow">{b}</code>
                <button className="btn tiny danger" onClick={() => setBootstrap(bootstrap.filter((x) => x !== b))}>削除</button>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="card">
        <h3>このピア</h3>
        <div className="small">
          状態: {status?.online ? <span style={{ color: 'var(--good)' }}>オンライン</span> : '起動中／オフライン'}
          {' · '}接続中のピア: {status?.peers?.length ?? 0}
        </div>
        {status?.peerId && <code className="mono">{status.peerId}</code>}

        {status?.addresses?.length > 0 && <PairingCode addresses={status.addresses} />}

        <button className="btn" onClick={() => act('sync')}>今すぐ同期</button>

        <div className="small muted">
          受信 {status?.stats?.received ?? 0} · 送信 {status?.stats?.published ?? 0} · 拒否 {status?.stats?.rejected ?? 0}
        </div>
      </div>

      <div className="card">
        <h3>アカウントの鍵</h3>
        <div className="small muted">
          このSNSにアカウント登録はありません。鍵そのものがアカウントです。
          <strong>鍵を失うとその人格は二度と取り戻せません。</strong>
        </div>
        {secret
          ? <code className="mono">{secret}</code>
          : (
            <button
              className="btn danger"
              onClick={() => adapter.exportKey().then(setSecret)}
            >
              秘密鍵を表示する
            </button>
          )}
        <div className="small muted">
          保存しているイベント {snap.counts?.events ?? 0} 件 / 知っている人 {snap.counts?.authors ?? 0} 人
        </div>
      </div>

      <SafetySettings adapter={adapter} />

      <DeleteAccount adapter={adapter} />

      <div className="card">
        <h3>ログ</h3>
        <div className="logs">
          {(status?.logs ?? []).slice().reverse().map((l, i) => (
            <div key={i}>{new Date(l.ts).toLocaleTimeString('ja-JP')} {l.msg}</div>
          ))}
          {(status?.logs ?? []).length === 0 && <div>（まだありません）</div>}
        </div>
      </div>
    </div>
  )
}
