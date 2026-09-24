import { useEffect, useState } from 'react'
import { TERMS_URL, PRIVACY_URL, DELETION_URL } from './policy.js'
import {
  applyFilter, cachedList, clearHiddenLocally, hiddenLocally, isFollowingList, refreshList, setFollowingList
} from './moderation.js'

/** What is hidden on this device, and whose list the user follows. */
export function SafetySettings ({ adapter }) {
  const [follow, setFollow] = useState(isFollowingList)
  const [list, setList] = useState(cachedList)
  const [hidden, setHidden] = useState(hiddenLocally)
  const [busy, setBusy] = useState(false)

  async function toggle (on) {
    setFollowingList(on)
    setFollow(on)
    setBusy(true)
    if (on) setList(await refreshList({ force: true }))
    await applyFilter(adapter).catch(() => {})
    setBusy(false)
  }

  async function reset () {
    if (!confirm('この端末で非表示にした投稿と人を、すべて元に戻しますか？\n（ブロックは解除されません）')) return
    clearHiddenLocally()
    setHidden(hiddenLocally())
    await applyFilter(adapter).catch(() => {})
  }

  const localCount = hidden.authors.length + hidden.events.length

  return (
    <div className="card">
      <h3>安全</h3>

      <label className="row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={follow}
          disabled={busy}
          onChange={(e) => toggle(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          管理者の非表示リストを使う（推奨）
          <span className="small muted" style={{ display: 'block' }}>
            通報で違反が確認された投稿や人を、この端末でも非表示にします。
            リストは公開されている静的ファイルで、あなたの情報はどこにも送られません。
            {list?.updated && <> 最終更新 {list.updated}。</>}
          </span>
        </span>
      </label>

      <div className="small muted">
        この端末で非表示にしたもの：{localCount} 件
        {localCount > 0 && (
          <> · <button className="btn tiny ghost" onClick={reset}>元に戻す</button></>
        )}
      </div>

      <div className="small muted">
        <a href={TERMS_URL} target="_blank" rel="noreferrer">利用規約</a> ·{' '}
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">プライバシーポリシー</a>
      </div>
    </div>
  )
}

/**
 * Delete the account.
 *
 * "Account" here means the key on this device - there is no server-side
 * record anywhere to delete. So this does the two things that are actually
 * possible: ask every peer to drop your posts (a delete for each one, sent
 * while you are still online to send it), and then erase the key and the log
 * from this device.
 */
export function DeleteAccount ({ adapter }) {
  const [step, setStep] = useState('idle') // idle | confirm | working | done
  const [tombstones, setTombstones] = useState(true)
  const [progress, setProgress] = useState('')

  useEffect(() => {
    if (step !== 'done') return
    const t = setTimeout(() => location.reload(), 1500)
    return () => clearTimeout(t)
  }, [step])

  async function run () {
    setStep('working')
    try {
      if (tombstones) {
        setProgress('自分の投稿に削除を送信しています…')
        const r = await adapter.act('deleteAllMine')
        setProgress(`${r?.deleted ?? 0} 件の削除を送信しました。届くのを待っています…`)
        // Give gossip and the sync that follows it a moment to carry the
        // deletes to whoever is connected right now.
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
      setProgress('この端末のデータを消去しています…')
      await adapter.wipe()
      setStep('done')
    } catch (err) {
      setProgress(`失敗しました: ${err.message}`)
      setStep('confirm')
    }
  }

  return (
    <div className="card">
      <h3>アカウントの削除</h3>

      {step === 'idle' && (
        <>
          <div className="small muted">
            この端末から鍵・投稿・画像・設定をすべて消去します。
            <a href={DELETION_URL} target="_blank" rel="noreferrer">詳しく</a>
          </div>
          <button className="btn danger" onClick={() => setStep('confirm')}>アカウントを削除する…</button>
        </>
      )}

      {step === 'confirm' && (
        <>
          <div className="banner small">
            <b>元に戻せません。</b>鍵のバックアップを取っていない場合、この人格は二度と使えなくなります。
          </div>
          <label className="row" style={{ gap: 10, cursor: 'pointer', alignItems: 'flex-start' }}>
            <input type="checkbox" checked={tombstones} onChange={(e) => setTombstones(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              消去の前に、自分の投稿すべてに削除を送信する（推奨）
              <span className="small muted" style={{ display: 'block' }}>
                いまつながっている相手と、その先に伝わります。オフラインの端末に残った複製までは消せません。
              </span>
            </span>
          </label>
          {progress && <div className="small">{progress}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn grow" onClick={() => { setStep('idle'); setProgress('') }}>やめる</button>
            <button className="btn danger grow" onClick={run}>削除する</button>
          </div>
        </>
      )}

      {step === 'working' && <div className="small">{progress}</div>}
      {step === 'done' && <div className="small">削除しました。再起動します…</div>}
    </div>
  )
}
