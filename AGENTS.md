# Agent rules

- After committing a change to this repo, push it to `origin` (GitHub) before
  ending the task. This repo is public/open source, so the canonical copy is
  what's on GitHub, not the local working tree.

- `package.json` の `version` を上げたとき（＝リリース対象の修正が完了したとき）は、
  そのバージョンで GitHub Release も作成・更新すること。手順:
  1. `npm run build:web`、`npm run mobile:build`、
     `cargo build --release --manifest-path rust/s2s-peer/Cargo.toml` で
     Web版・Android APK・Windows用ピアexeを最新のコードから再ビルドする
  2. `git tag vX.Y.Z && git push origin vX.Y.Z`
  3. `gh release create vX.Y.Z <APK> <web zip> <peer exe> --title "S2S vX.Y.Z" --notes-file <変更点をまとめたファイル>`
     （既存タグなら `gh release create` の代わりに `gh release upload --clobber` で差し替え）
  リリースノートは前バージョンからの変更点を日本語で簡潔にまとめること。

- Google ドライブ上のコピー（`G:\マイドライブ\Claude_Code\S2S`）は、テスト用に
  ソースを同期しているだけの作業コピー。リポジトリを更新したら、このドライブの
  コピーも忘れずに最新化すること（`node_modules` やビルド成果物、秘密鍵ファイルは
  同期対象から除外し、削除ではなく追加・更新のみで揃える）。

- Android デバッグ版をビルドしたら、生成された
  `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk` を
  `G:\マイドライブ\Claude_Code\app-debug.apk` にコピーし、既存ファイルを更新すること。
  この APK の配布用コピーは、上記のソース同期でビルド成果物を除外するルールの例外とする。
