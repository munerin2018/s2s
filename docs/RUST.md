# Rust ピアのビルド

`rust/s2s-peer` は、JavaScript 実装と同じプロトコルを話す独立した実装です。
常時起動用であると同時に、プロトコル仕様が片方の実装に寄りかかっていないことの検証でもあります。

## 動かす

```bash
cd rust/s2s-peer
cargo run --release -- --dir ../../.peer-rust --ws 4002 --name RustPeer
```

Linux と macOS なら、Rust が入っていれば他に何も要りません。

## Windows での準備

`msvc` ツールチェーンは **Visual Studio Build Tools（数 GB・要管理者権限）**を必要とします。
それを避けたい場合、`gnu` ツールチェーンと MinGW-w64 の組み合わせなら
**管理者権限なし・ユーザープロファイル内だけ**で完結します。

1. Rust を `gnu` ツールチェーンで入れる

   ```
   rustup-init.exe -y --profile minimal --default-toolchain stable-x86_64-pc-windows-gnu
   ```

2. [winlibs](https://github.com/brechtsanders/winlibs_mingw/releases) の
   `winlibs-x86_64-...-ucrt-...zip` を `%USERPROFILE%\.s2s-toolchain\` に展開する

3. PATH に通してビルドする

   ```powershell
   $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:USERPROFILE\.s2s-toolchain\mingw64\bin;$env:PATH"
   cargo build --release
   ```

MinGW が要るのは 2 つの理由からです。
`ring`（暗号ライブラリ）が C とアセンブラを含むことと、`windows-sys` が `dlltool` を使うことです。

どちらもユーザープロファイル内に閉じているので、
`rustup self uninstall` とフォルダ削除で完全に元へ戻せます。

## 使い方

```
s2s-peer [OPTIONS]

  --dir <PATH>       ログ・メディア・鍵の置き場所      (既定 .s2s-peer)
  --tcp <PORT>       TCP 待ち受けポート               (既定 0 = 空きポート)
  --ws <PORT>        ブラウザ/スマホ用 WebSocket ポート (既定 0)
  --connect <ADDR>   起動時に接続する multiaddr        (複数可)
  --post <TEXT>      起動時に投稿する                 (複数可)
  --name <NAME>      初回のみプロフィール名を設定
  --no-lan           LAN への告知をしない
```

ログの詳しさは `RUST_LOG` で変えられます。

```powershell
$env:RUST_LOG = "s2s_peer=debug"
```

## JS 実装との相互運用

データディレクトリの形式は完全に同じです。片方が書いたディレクトリをもう片方が読めます。

```powershell
# JS ピアを立てて、Rust ピアから繋ぐ
node scripts\peer.js --dir .\.tmp\js --tcp 4501 --name JSピア --post "こんにちは"
cargo run -- --dir ..\..\.tmp\rs --tcp 4502 --connect /ip4/127.0.0.1/tcp/4501/p2p/12D3Koo...
```

両方が `received 2, sent 2` と出れば、
**署名・正準 JSON・varint フレーミング・同期手順のすべてが一致している**ということです。

> Git Bash から multiaddr を渡すときは `MSYS_NO_PATHCONV=1` を付けてください。
> 付けないと `/ip4/...` が Windows のパスに変換されて壊れます。
> PowerShell や cmd では不要です。

## テスト

```powershell
cargo test
```

正準 JSON の文字列エスケープと varint 符号化を検証します。
この2つは仕様として最も間違えやすく、間違えると「なぜか署名が通らない」という形でしか現れません。
