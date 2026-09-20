# S2S

[![tests](https://github.com/__GH_OWNER__/s2s/actions/workflows/ci.yml/badge.svg)](https://github.com/__GH_OWNER__/s2s/actions/workflows/ci.yml)
[![license: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)

サーバーを持たない P2P 型 SNS。Twitter 型のタイムライン、Instagram 型のメディア一覧、
2ch 型の掲示板を、ひとつのイベントログの上に載せています。

**PC アプリ / スマホアプリ / Web 版**の3形態があり、UI のコードは1つです。

維持費はゼロです。アカウントサーバーも、DB も、CDN も、リレーの契約もありません。
投稿はあなたの端末の署名付きログに追記され、つながったピアへ直接複製されます。

📖 [紹介ページ](https://__GH_OWNER__.github.io/s2s/) ·
⬇️ [ダウンロード](https://github.com/__GH_OWNER__/s2s/releases/latest) ·
📐 [プロトコル仕様](docs/PROTOCOL.md)

<details>
<summary><b>In English</b></summary>

S2S is a fully peer-to-peer social network with no servers of any kind - no
account service, no database, no CDN, no relay contract. Your account *is* an
ed25519 keypair, and everything you do is one signed event appended to your own
hash-chained log. Peers replicate those logs directly.

One codebase provides three shapes of social network - a Twitter-style
timeline, an Instagram-style media grid and a 2ch-style board - because all
three are just different queries over the same log.

It ships as a desktop app (Electron, which is also the LAN entry point and
circuit relay), an Android app (Capacitor) and a fully static web build. There
is a second, independent peer implementation in Rust that speaks the same wire
protocol; the two are kept honest by a shared conformance vector file.

The protocol is specified in [docs/PROTOCOL.md](docs/PROTOCOL.md) (Japanese) in
enough detail to write a third implementation. Known limits are in
[docs/LIMITS.md](docs/LIMITS.md), and they are real: no spam resistance worth
the name, local-only search, and media that disappears once nobody keeps it.

</details>

---

## 5分で試す

### 1. PC アプリを起動する

```bash
git clone https://github.com/__GH_OWNER__/s2s.git
cd s2s
npm install
npm run desktop
```

ウィンドウが開いたら「設定」タブを見てください。**自分のアドレス**が並んでいます。
`/ip4/192.168.x.x/tcp/xxxxx/ws/p2p/12D3Koo...` という `ws` のついた行が、
スマホと Web 版から接続するためのアドレスです。

### 2. もう1つ PC ピアを起動して、同期を見る

別のターミナルで：

```powershell
node scripts/peer.js --dir .\.peer-b --name テスト用ピア --post "こんにちは"
```

**同じ Wi-Fi なら何も設定しなくても互いを見つけます**（mDNS）。
PC アプリのタイムラインに「こんにちは」が出てくれば成功です。

### 3. スマホアプリ

すでにビルド済みの APK があります：

[リリースページ](https://github.com/__GH_OWNER__/s2s/releases/latest) から
`S2S-android.apk` を落とすか、自分でビルドしてください。

```bash
npm run mobile:build   # JDK 21+ と Android SDK が必要
```

インストール後、**設定タブ**に PC アプリが表示している `ws` のアドレスを貼り付けて「接続」。
スマホはブラウザと同じ制約下で動くため LAN 自動発見ができません。ここだけ手動です。

> 接続先を毎回入力したくない場合、Web 版なら
> `index.html#peer=/ip4/.../ws/p2p/...` のようにURLに書けば自動で接続します。

### 4. Web 版

```powershell
npm run build:web
npm run preview:web
```

`packages/ui/dist/` は**完全な静的ファイル**です。好きな静的ホスティングに置けます。
置いた先のサーバーは投稿を一切見ません。鍵もログもブラウザの IndexedDB の中だけにあります。

> `file://` で直接開くことはできません（ES モジュールが読めないため）。
> 何らかの静的サーバー越しに開いてください。

---

## 何ができるか

| | |
|---|---|
| Twitter 型 | 投稿・返信・いいね・リポスト・フォロー・ブロック・通知 |
| Instagram 型 | 画像/動画つき投稿のグリッド表示 |
| 2ch 型 | 板・スレッド・レス番号（`>>1` から連番） |
| 共通 | プロフィール、検索（手元にあるものだけ）、削除（自分の投稿のみ） |

---

## 3つのアプリの関係

```
                    packages/core      イベントモデル・署名付きログ・各種ビュー
                          │
                    packages/net       libp2p・ゴシップ・同期・メディア転送
                          │
                    packages/ui        React。画面はここだけ
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
   apps/desktop      apps/mobile         Web 版
   Electron          Capacitor          静的ファイル
        │                 │                 │
  ピアは main        ページ内がピア     ページ内がピア
  プロセス           (WebRTC/WS)        (WebRTC/WS)
  (TCP/mDNS/リレー)
```

PC 版だけがポートを開けて **mDNS で LAN 内を自動発見**し、**サーキットリレー**にもなります。
ブラウザとスマホはそれができないので、PC 版（または誰かの PC 版）を入口に使います。

**「誰がサーバー代を払うのか」への答えがこれです。**
あなたの PC が入口であり、止めれば止まり、他の誰かがオンラインなら網は生き続けます。

---

## Rust ネイティブピア

`rust/s2s-peer/` に、同じプロトコルを話す Rust 実装があります。
JS 実装と**同じデータディレクトリ形式**（`events.jsonl` + `blobs/`）を使うので相互に読めます。

```powershell
cd rust\s2s-peer
cargo run --release -- --dir ..\..\.peer-rust --ws 4002 --name RustPeer
```

Electron 版が数百 MB のメモリを使うのに対し、こちらは数 MB です。
ラズパイや余っている常時起動マシンに置いて「自分の投稿が常に届く状態」を作るためのものです。

ビルドに必要なもののセットアップは [docs/RUST.md](docs/RUST.md) を見てください。

---

## テスト

```powershell
npm test                 # コア + ネットワーク（実際に libp2p ノードを2〜3個立てます）
npm run test:core        # 署名・ハッシュチェーン・タイムライン・悪意あるピア
npm run test:net         # 2ピア/3ピアの実レプリケーション
npm run smoke            # Electron を起動して UI ごと通しで検証
cd rust\s2s-peer; cargo test
```

テストは正常系だけではありません。`packages/core/test/hostile.test.js` と
Rust 側の `mod tests` は、**プロトコルに従わないピア**を想定しています
（パストラバーサル、先回りした削除、不正な同期ベクタ、並行書き込みなど）。
[docs/LIMITS.md](docs/LIMITS.md) の末尾に一覧があります。

正準エンコーディングは [docs/canonical-vectors.json](docs/canonical-vectors.json) という
共有ベクタで両実装が照合しています。ここがずれると署名が実装をまたいで検証できなくなり、
ネットワークが恒久的に分断されるので、独立したファイルを正とする形にしてあります。

---

## 正直に言っておくべきこと

完全 P2P には、中央サーバー型にはない制約がそのまま残ります。
[docs/LIMITS.md](docs/LIMITS.md) に、どれが設計上の割り切りで、どれが未実装かを分けて書いています。
要点だけ：

- **オフラインの相手の投稿は見えません。** 誰かが中継して持っていれば見えます。
- **検索はローカルだけです。** 手元に複製されていないものは検索できません。
- **画像は誰も持たなくなれば消えます。** 中身のハッシュで参照しているだけなので。
- **鍵を失うとアカウントは戻りません。** 再発行してくれる主体が存在しません。
- **スパム対策は弱いです。** 現状はブロックのみで、Sybil 攻撃への耐性はありません。

---

## ドキュメント

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — イベント形式、署名、同期プロトコルの仕様
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — なぜこの層構成なのか
- [docs/LIMITS.md](docs/LIMITS.md) — 制約と、対処するなら何をするか
- [docs/RUST.md](docs/RUST.md) — Rust ピアのビルド環境
- [SECURITY.md](SECURITY.md) — 脆弱性の報告先と、設計上そうなっているもの

---

## ライセンス

[AGPL-3.0](LICENSE)。

自由に使って、改変して、再配布できます。ただし**改変版を配ったり、ネットワーク越しに
使わせたりする場合は、そのソースも同じ条件で公開する必要があります**。

P2P プロトコルは、誰かが改良版を囲い込んで互換性を切った瞬間に価値を失います。
そうならないための選択です。

---

## 貢献

Issue と Pull Request を歓迎します。

プロトコルに触れる変更を出すときは、
[docs/PROTOCOL.md](docs/PROTOCOL.md) と
[docs/canonical-vectors.json](docs/canonical-vectors.json) も一緒に更新してください。
**JavaScript と Rust の両方が通ることが条件です。**
片方だけ変えると、その時点でネットワークが2つに割れます。

脆弱性は Issue ではなく [SECURITY.md](SECURITY.md) の手順でお願いします。
