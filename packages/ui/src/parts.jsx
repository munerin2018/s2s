import { useEffect, useRef, useState } from 'react'

/* ---- small helpers ---------------------------------------------------- */

export function initials (name = '') {
  const t = name.trim()
  if (!t) return '?'
  return [...t][0].toUpperCase()
}

export function ago (ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'たった今'
  if (s < 3600) return `${Math.floor(s / 60)}分前`
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}日前`
  return new Date(ts).toLocaleDateString('ja-JP')
}

export const shortId = (id = '') => id.slice(0, 9) + '…' + id.slice(-4)

export function Empty ({ icon, title, children }) {
  return (
    <div className="empty">
      <span className="big">{icon}</span>
      <strong>{title}</strong>
      {children && <div className="small" style={{ marginTop: 6 }}>{children}</div>}
    </div>
  )
}

export function Avatar ({ profile, adapter, size }) {
  const url = useBlobUrl(adapter, profile?.avatar)
  return (
    <div className={`avatar${size === 'sm' ? ' sm' : ''}`}>
      {url ? <img src={url} alt="" /> : initials(profile?.name)}
    </div>
  )
}

/* ---- media ------------------------------------------------------------ */

/** Resolve a content-addressed blob to a displayable URL, once it arrives. */
export function useBlobUrl (adapter, blob) {
  const [url, setUrl] = useState(null)

  useEffect(() => {
    if (!blob) { setUrl(null); return }
    let alive = true
    let resolved = false
    const load = () =>
      adapter.mediaUrl(blob).then((u) => {
        if (!alive || !u) return
        resolved = true
        setUrl(u)
      })
    load()
    // The bytes may still be in flight from another peer; retry as we learn
    // more. `resolved` is a ref-like local rather than the state value, which
    // would be stale inside this subscription.
    const off = adapter.onChange(() => { if (!resolved) load() })
    return () => { alive = false; off() }
  }, [blob, adapter])

  return url
}

export function MediaGrid ({ media, adapter, onOpen }) {
  if (!media?.length) return null
  const n = Math.min(media.length, 4)
  return (
    <div className={`media-grid n${n}`}>
      {media.map((m, i) => (
        <MediaItem key={m.blob + i} m={m} adapter={adapter} onOpen={onOpen} />
      ))}
    </div>
  )
}

function MediaItem ({ m, adapter, onOpen }) {
  const url = useBlobUrl(adapter, m.blob)

  if (!url) {
    return (
      <div className="media-pending">
        まだ受信していません
        <br />
        <span style={{ opacity: .6 }}>保持しているピアに接続すると表示されます</span>
      </div>
    )
  }
  if ((m.mime ?? '').startsWith('video/')) {
    return <video src={url} controls playsInline />
  }
  return (
    <img
      src={url}
      alt={m.alt ?? ''}
      loading="lazy"
      onClick={onOpen ? () => onOpen(url) : undefined}
      style={onOpen ? { cursor: 'zoom-in' } : undefined}
    />
  )
}

/* ---- post card -------------------------------------------------------- */

export function PostCard ({ item, adapter, me, onOpen, onReply, onAuthor, onAct }) {
  const mine = item.authorId === me

  return (
    <article className="post">
      <button onClick={() => onAuthor?.(item.authorId)} aria-label="プロフィール">
        <Avatar profile={item.author} adapter={adapter} />
      </button>

      <div className="grow">
        {item.repostedBy && (
          <div className="small muted">🔁 {item.repostedBy.name} がリポスト</div>
        )}

        <div className="row" style={{ gap: 6 }}>
          <span className="name">{item.author.name}</span>
          <span className="handle grow wrap">{shortId(item.authorId)}</span>
          <span className="handle">{ago(item.ts)}</span>
        </div>

        {item.board && (
          <div className="small muted">板 /{item.board}/ {item.title && `· ${item.title}`}</div>
        )}

        {item.text && <p className="text">{item.text}</p>}

        <MediaGrid media={item.media} adapter={adapter} />

        <div className="actions">
          <button onClick={() => onReply?.(item)} title="返信">💬 {item.replies || ''}</button>
          <button onClick={() => onAct('repost', { target: item.id })} title="リポスト">🔁</button>
          <button
            className={item.myLike === 1 ? 'on' : ''}
            onClick={() => onAct('like', { target: item.id, value: 1 })}
            title="いいね"
          >
            {item.myLike === 1 ? '♥' : '♡'} {item.likes.up || ''}
          </button>
          <button
            className={item.myLike === -1 ? 'on down' : ''}
            onClick={() => onAct('like', { target: item.id, value: -1 })}
            title="よくない"
          >
            👎 {item.likes.down || ''}
          </button>
          <button onClick={() => onOpen?.(item)} title="スレッドを開く">↗</button>
          {mine && (
            <button
              onClick={() => confirm('この投稿を削除しますか？\n（自分の端末と、この削除を受け取ったピアで非表示になります）') && onAct('delete', { target: item.id })}
              title="削除"
            >
              🗑
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

/* ---- composer --------------------------------------------------------- */

export function Composer ({ adapter, mode = 'post', placeholder, onDone, board, replyTo }) {
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const [boardName, setBoardName] = useState(board ?? '')
  const [media, setMedia] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const fileRef = useRef(null)

  const limit = 2000
  const over = text.length > limit
  const needsText = media.length === 0
  const canSend =
    !busy && !over &&
    (!needsText || text.trim().length > 0) &&
    (mode !== 'thread' || (title.trim() && boardName.trim()))

  async function pick (e) {
    const files = [...e.target.files].slice(0, 8 - media.length)
    e.target.value = ''
    setErr(null)
    try {
      const added = []
      for (const f of files) {
        if (f.size > 8 * 1024 * 1024) {
          setErr(`${f.name} は 8MB を超えています。P2Pでは各ピアが実体を持ち合うため大きすぎる添付は避けています。`)
          continue
        }
        const ref = await adapter.addMedia(f)
        added.push({ ...ref, _preview: URL.createObjectURL(f) })
      }
      setMedia((m) => [...m, ...added])
    } catch (e2) {
      setErr(e2.message)
    }
  }

  async function send () {
    setBusy(true)
    setErr(null)
    try {
      const attachments = media.map(({ _preview, ...m }) => m)
      if (mode === 'thread') {
        await adapter.act('thread', { board: boardName.trim(), title: title.trim(), text, media: attachments })
      } else if (mode === 'reply') {
        await adapter.act('reply', { root: replyTo.root, parent: replyTo.parent, text, media: attachments })
      } else {
        await adapter.act('post', { text, media: attachments, board: board || undefined })
      }
      setText(''); setTitle(''); setMedia([])
      onDone?.()
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="composer">
      {mode === 'thread' && (
        <>
          <input
            className="field"
            placeholder="板の名前（例: anime, bike, pc）"
            value={boardName}
            onChange={(e) => setBoardName(e.target.value)}
            maxLength={48}
          />
          <input
            className="field"
            placeholder="スレッドタイトル"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
          />
        </>
      )}

      <textarea
        className="field"
        rows={mode === 'post' ? 3 : 4}
        placeholder={placeholder ?? 'いまどうしてる？'}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      {media.length > 0 && (
        <div className="thumbs">
          {media.map((m, i) => (
            <div className="thumb" key={m.blob + i}>
              <img src={m._preview} alt="" />
              <button onClick={() => setMedia((x) => x.filter((_, j) => j !== i))}>×</button>
            </div>
          ))}
        </div>
      )}

      {err && <div className="banner small">{err}</div>}

      <div className="bar">
        <button className="btn tiny" onClick={() => fileRef.current.click()} disabled={media.length >= 8}>
          🖼 画像・動画
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={pick}
        />
        <span className={`counter${over ? ' over' : ''}`}>{text.length}/{limit}</span>
        <button className="btn primary" onClick={send} disabled={!canSend}>
          {busy ? '署名中…' : mode === 'reply' ? '返信' : mode === 'thread' ? 'スレを立てる' : '投稿'}
        </button>
      </div>
    </div>
  )
}

/* ---- sheet ------------------------------------------------------------ */

export function Sheet ({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sheet" onClick={onClose}>
      <div className="inner" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <strong className="grow">{title}</strong>
          <button className="btn tiny ghost" onClick={onClose}>閉じる</button>
        </div>
        {children}
      </div>
    </div>
  )
}
