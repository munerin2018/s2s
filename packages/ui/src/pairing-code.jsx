import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { bestPairingAddress, browserReachableAddresses, pairingUrl, DEFAULT_APP_URL } from './pairing.js'

/**
 * Pairing panel for the desktop app.
 *
 * Typing a 120-character multiaddr into a phone is the single worst moment in
 * using this thing, and on iOS there is no way around it with the keyboard -
 * there is no app to paste into until you have already paired. So the desktop
 * app draws the address as a QR code pointing at the hosted web build with
 * `#peer=` attached: the phone's own camera opens it, and the app comes up
 * already connected.
 *
 * The raw address is still shown underneath, because the QR depends on a
 * hosted copy of the web build and someone self-hosting will want the address
 * itself.
 */
export function PairingCode ({ addresses }) {
  const [dataUrl, setDataUrl] = useState(null)
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState(null)

  const best = bestPairingAddress(addresses)
  const reachable = browserReachableAddresses(addresses)
  const url = best ? pairingUrl(best, DEFAULT_APP_URL) : null

  useEffect(() => {
    if (!url) { setDataUrl(null); return }
    let alive = true
    QRCode.toDataURL(url, {
      errorCorrectionLevel: 'L', // the URL is long; the lowest level keeps the grid readable
      margin: 2,
      width: 300,
      color: { dark: '#0b0d12', light: '#ffffff' }
    })
      .then((d) => { if (alive) setDataUrl(d) })
      .catch(() => { if (alive) setDataUrl(null) })
    return () => { alive = false }
  }, [url])

  async function copy (text, label) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setCopied('コピーできませんでした')
    }
  }

  if (!best) {
    return (
      <div className="small muted">
        他の端末から繋げるアドレスがまだありません。ネットワークの起動を待っています。
      </div>
    )
  }

  return (
    <>
      <div className="small muted">
        スマホとつなぐ — <b style={{ color: 'var(--text)' }}>iPhone / Android のカメラでこれを読む</b>だけです。
        Web 版が開いて、そのまま繋がります。
      </div>

      {dataUrl && (
        <div style={{ display: 'grid', placeItems: 'center', margin: '4px 0 2px' }}>
          <img
            src={dataUrl}
            alt="ペアリング用QRコード"
            width={230}
            height={230}
            style={{ borderRadius: 12, display: 'block' }}
          />
        </div>
      )}

      <div className="row" style={{ gap: 8 }}>
        <button className="btn tiny grow" onClick={() => copy(url, 'link')}>
          {copied === 'link' ? 'コピーしました' : 'リンクをコピー'}
        </button>
        <button className="btn tiny grow" onClick={() => copy(best, 'addr')}>
          {copied === 'addr' ? 'コピーしました' : 'アドレスをコピー'}
        </button>
      </div>

      <div className="small muted">
        カメラが使えない場合は、上の「アドレスをコピー」を相手の端末の設定タブに貼り付けてください。
      </div>
      <code className="mono">{best}</code>

      {reachable.length > 1 && (
        <>
          <button className="btn tiny ghost" onClick={() => setShowAll((v) => !v)}>
            {showAll ? '他のアドレスを隠す' : `他のアドレスも見る (${reachable.length - 1})`}
          </button>
          {showAll && (
            <>
              <div className="small muted">
                上がうまくいかない場合に試してください。Wi-Fi が複数あるときや、
                仮想ネットワークのアダプタが先に選ばれてしまったときに使います。
              </div>
              {reachable.slice(1).map((a) => <code className="mono" key={a}>{a}</code>)}
            </>
          )}
        </>
      )}
    </>
  )
}
