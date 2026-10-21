# アーキテクチャ（dive-passport-demo）

表 1 は `test/arch.check.mjs` が読んで検査する。パスを変えたら、この表だけ直せばよい。

## 1. 役割対応表
| 役割 | パス |
|---|---|
| shared | js/pass-schema.js js/roster-schema.js js/data-match.js js/data-samples.js |
| core | js/roster-core.js js/match.js js/health-redact.js js/photo-mask.js |
| adapter | js/ai-reader.js js/core.js js/pass-codec.js js/qr.js js/photo-prep.js |
| entry | index.html pass.html js/app.js js/data.js js/data-pass.js js/intake.js js/passport.js js/shop.js js/chat.js js/pass-view.js js/viewer.js js/rules.js js/turtle3d.js js/booking.js js/intake-photo.js |

- entry の画面の部品は、今は js/ の直下に並ぶ（rename しない）。data.js と data-pass.js は時計を使う見本データなので entry
- 外へ通信してよいのは js/ai-reader.js だけ。HTML から外を読むのは表 3 の「外から読む物」だけ（`test/arch.check.mjs` が読み込み先と integrity を検査する）
- 字体（BIZ UD ゴシック）は index.html だけが Google Fonts から読む。URL の # 以降は送らない。ただし Google には IP・端末の種類・時刻・サイトの origin（字体ファイルの要求に Origin ヘッダが付く。referrer を止めても付く）と、画面に出た字・打った字を含む約 50 字ごとの束の番号が伝わる。pass.html は健康の「はい」の項目だけを出すので、束の組み合わせで答えが分かる。だから pass.html は端末の字体だけで描く

## 2. 外部境界表
| adapter | 相手 | Fake | fixture | credential | 書き込み |
|---|---|---|---|---|---|
| js/ai-reader.js | 同じ場所の Worker `/api/read` → Claude API（Haiku） | `readSample`（同じファイル）+ js/data-samples.js | AI の読み取り試験 2026-10-21 の Haiku の答え（tools/make-samples.mjs が作る） | Cloudflare Access の cookie + 合言葉（`x-redux-code`、sessionStorage）。API キーは Worker の secret だけ（この Worker 専用の 1 本） | なし |
| js/core.js | localStorage | 無し（ブラウザの中だけ） | — | なし | このブラウザだけ |

## 3. Origin・監視
- 画面のファイルと `/api` は同じ Worker から配る（同じ origin）。CORS と cross-site の Cookie は使わない
- 入口は 2 重: Cloudflare Access（Worker 全体）と合言葉。Worker は `ctx.access` が無い呼び出しを 403 で断る
- 監視: Worker は回数と費用だけを KV に数える（中身は残さない）。上限を超えたら 429、画面は見本の読み取りに切り替える
- 外から読む物（index.html だけ。pass.html は外を読まない）:
  - three.js 0.160.0（cdn.jsdelivr.net、importmap）と qrcode-generator 1.4.4（cdnjs.cloudflare.com、script）。画面と同じ権限で動くコードで、qrcode-generator は健康の答えを含むパスポートの URL を受け取る。両方に integrity（中身が書き換えられていないかをブラウザが確かめる指定）を付けた。importmap の integrity が効くのは Chrome/Edge 127・Safari/iOS 18・Firefox 138 から（古い iPhone では確かめないまま読む）
  - 字体（fonts.googleapis.com / fonts.gstatic.com）。上の表 1 の注のとおり、画面の字の一部が伝わる。字体の CSS の `<link>` は描画を止めるので、遅い電波だと画面が白いまま待つことがある

## 4. 決定ログ
| 日付+topic | 決定 | 理由と却下案 | lint 昇格 |
|---|---|---|---|
| 2026-10-21 ai-place | AI は Cloudflare Worker から呼ぶ | Yosuke 指定。手元のサーバー案は会場の Wi-Fi 頼みになる | なし |
| 2026-10-21 access | Access と合言葉の 2 重 | Yosuke 指定。合言葉だけだと、漏れたら誰でも使える | なし |
| 2026-10-21 health | 健康の情報は AI に送らない。申込書は健康の欄を塗ってから | 要配慮個人情報 | test/roster.test.mjs（送る物と答えの形） |
| 2026-10-21 health-mail | 予約メールは健康に触れていそうな行を外して送り、AI が健康を見たら記録に印を残す | ジンのレビュー（予約サイトの質問欄に健康が書かれうる）。本文を送らない案は、予約を読めなくなるので却下 | test/roster.test.mjs・test/ai-reader.test.mjs |
| 2026-10-21 who-src | 記録の「した人」と項目の「出どころ」を分けて持つ | ジンのレビュー（パスポートや他店から入った項目を正しく残す） | test/roster.test.mjs |
| 2026-10-21 no-innerhtml | entry と adapter で innerHTML などを禁止。固定の SVG だけ arch-allow | ザクのレビュー（AI の答えにメール経由で仕込まれた文字が入りうる） | test/arch.check.mjs |
| 2026-10-21 purge | 記録は足すだけ。ただし保存期間を過ぎた便は記録ごと消し、件数だけ残す | ザクのレビュー（1 年保存と「足すだけ」がぶつかる） | test/roster.test.mjs |
| 2026-10-21 redact-core | 健康の行の外し方を js/health-redact.js（core）に分け、画面と Worker の両方が使う。1 字の言葉は予約の項目の行では見ない。文ごとに外し、質問の答えは結び・署名・電話の手前まで | ジンの再レビュー（予約に要る行まで消える）とザク（取りこぼし）の両方を満たすため。行ごとに全部外す案は、1 段落のメールが丸ごと消えるので却下 | test/roster.test.mjs |
| 2026-10-21 arch-grep | 依存の向きは grep で検査し、dependency-cruiser は使わない | script タグで読む素の JS で、npm を入れていない | test/arch.check.mjs |
| 2026-10-21 core-clock | core は時計と乱数を使わない（at と newId を受け取る） | テストで毎回同じ結果にするため | test/arch.check.mjs |
| 2026-10-21 fonts | 字体は試作の間だけ index.html が Google Fonts から読む。pass.html は外の字体を読まない。本物のお客さんの情報を入れる前に、外から読むのをやめる（spec/meibo.md の 11） | ザクのレビュー（字体の束の取り寄せで、画面に出た字・打った字が Google に推測される）。repo に置く案は字体の取得に Yosuke の了承が要る | test/arch.check.mjs（読み込み先） |
| 2026-10-21 outside-reads | HTML から外を読むのは表 3 に書いた所だけ。外のスクリプトには integrity を付ける | ザクのレビュー（CDN の中身が差し替えられると、画面と同じ権限で localStorage の健康の答えを読める。2024 年の polyfill.io の件）。cdnjs が spec から漏れていたのを検査で捕まえるため | test/arch.check.mjs |
