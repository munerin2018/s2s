import { useState } from 'react'
import { Sheet } from './parts.jsx'
import { REPORT_REASONS, TERMS_URL, PRIVACY_URL, TERMS_VERSION, reportUrl } from './policy.js'
import { hideLocally, applyFilter } from './moderation.js'

const TERMS_KEY = 's2s.terms.accepted'

export function termsAccepted () {
  try {
    return Number(localStorage.getItem(TERMS_KEY)) >= TERMS_VERSION
  } catch {
    return false
  }
}

function acceptTerms () {
  try {
    localStorage.setItem(TERMS_KEY, String(TERMS_VERSION))
  } catch {
    // Without storage this is asked again next launch, which is the right
    // failure: better to ask twice than to skip it.
  }
}

/**
 * Shown once, before anything else, and again whenever the terms change.
 *
 * The short version is on the screen rather than behind a link, because the
 * point is that people read it: there is no operator here to clean up after
 * them, so the rules only mean something if the people posting know them.
 */
export function TermsGate ({ onAccept }) {
  const [checked, setChecked] = useState(false)

  return (
    <div className="app">
      <div className="scroll pad col" style={{ gap: 14, paddingTop: 'max(28px, env(safe-area-inset-top))' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>S2S へようこそ</h1>
        <div className="muted">
          使い始める前に、次のことに同意してください。
        </div>

        <div className="card">
          <h3>このアプリについて</h3>
          <div className="small">
            S2S には運営会社のサーバーがありません。あなたの投稿はあなたの端末に保存され、
            つながった相手の端末へ直接届きます。<b>投稿はすべて公開</b>で、一度届いたものは
            取り消せません。
          </div>
        </div>

        <div className="card">
          <h3>禁止事項</h3>
          <ul className="small" style={{ margin: 0, paddingLeft: '1.2em', lineHeight: 1.9 }}>
            <li>違法なコンテンツの投稿（児童の性的な画像は理由を問わず絶対に禁止）</li>
            <li>嫌がらせ・差別・脅迫・なりすまし</li>
            <li>同意のない性的なコンテンツや個人情報の投稿</li>
            <li>スパムや、他人の端末に負荷をかける行為</li>
          </ul>
        </div>

        <div className="card">
          <h3>困ったときは</h3>
          <div className="small">
            投稿や人の横にある <b>⚑</b> から通報できます。その場で非表示になり、
            相手をブロックすることもできます。通報は管理者にも届き、
            違反が確認されたものは全員の画面から非表示になります。
          </div>
        </div>

        <div className="small muted">
          全文：<a href={TERMS_URL} target="_blank" rel="noreferrer">利用規約</a> ·{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer">プライバシーポリシー</a>
        </div>

        <label className="row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ width: 20, height: 20, marginTop: 2, flex: 'none' }}
          />
          <span>利用規約とプライバシーポリシーを読み、同意します。18 歳以上です。</span>
        </label>

        <button
          className="btn primary"
          disabled={!checked}
          onClick={() => { acceptTerms(); onAccept() }}
          style={{ padding: '12px 16px', fontSize: 15 }}
        >
          同意して始める
        </button>
      </div>
    </div>
  )
}

/**
 * Report a post or a person.
 *
 * The first two effects happen immediately and locally, because that is what
 * actually protects the person reporting: they stop seeing it now, not after
 * someone reviews it. Sending the report to the maintainer is a separate,
 * visible step, since it opens a public page in the browser.
 */
export function ReportSheet ({ target, adapter, onClose, onDone }) {
  const [reason, setReason] = useState('spam')
  const [hide, setHide] = useState(true)
  const [block, setBlock] = useState(true)
  const [sendReport, setSendReport] = useState(true)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)

  const isEvent = !!target.eventId

  async function submit () {
    setBusy(true)
    try {
      if (hide) {
        hideLocally({ eventId: target.eventId, authorId: isEvent ? undefined : target.authorId })
        await applyFilter(adapter)
      }
      if (block && target.authorId) {
        await adapter.act('block', { target: target.authorId })
      }
      if (sendReport) {
        window.open(reportUrl({ eventId: target.eventId, authorId: target.authorId, reason }), '_blank', 'noopener')
      }
      setDone(true)
      onDone?.()
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <Sheet title="通報しました" onClose={onClose}>
        <div className="small">
          {hide && <div>✓ この端末で非表示にしました</div>}
          {block && <div>✓ {target.name ?? 'この人'} をブロックしました</div>}
          {sendReport && <div>✓ 管理者への通報ページを開きました。送信まで完了してください</div>}
        </div>
        <div className="small muted">
          ブロックは設定からいつでも解除できます。
        </div>
        <button className="btn primary" onClick={onClose}>閉じる</button>
      </Sheet>
    )
  }

  return (
    <Sheet title={isEvent ? 'この投稿を通報' : `${target.name ?? 'この人'} を通報`} onClose={onClose}>
      <div className="col" style={{ gap: 6 }}>
        {REPORT_REASONS.map((r) => (
          <label key={r.key} className="row" style={{ gap: 10, cursor: 'pointer' }}>
            <input type="radio" name="reason" checked={reason === r.key} onChange={() => setReason(r.key)} />
            <span>{r.label}</span>
          </label>
        ))}
      </div>

      {reason === 'illegal' && (
        <div className="banner small">
          児童の性的虐待にあたる画像など、重大な違法コンテンツは
          <a href="https://www.internethotline.jp/" target="_blank" rel="noreferrer">インターネット・ホットラインセンター</a>
          にも通報してください。内容をスクリーンショット等で保存・転送しないでください。
        </div>
      )}

      <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
        <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
          <span>{isEvent ? 'この投稿を非表示にする' : 'この人の投稿をすべて非表示にする'}</span>
        </label>
        {target.authorId && (
          <label className="row" style={{ gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={block} onChange={(e) => setBlock(e.target.checked)} />
            <span>{target.name ?? 'この人'} をブロックする</span>
          </label>
        )}
        <label className="row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={sendReport} onChange={(e) => setSendReport(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            管理者に通報する
            <span className="small muted" style={{ display: 'block' }}>
              ブラウザで通報フォームが開きます。送られるのは投稿の ID だけで、内容は含まれません。
            </span>
          </span>
        </label>
      </div>

      <button className="btn primary" onClick={submit} disabled={busy || (!hide && !block && !sendReport)}>
        {busy ? '処理中…' : '通報する'}
      </button>
    </Sheet>
  )
}
