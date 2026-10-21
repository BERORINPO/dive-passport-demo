# アーキテクチャ（dive-passport-demo）

表 1 は `test/arch.check.mjs` が読んで検査する。パスを変えたら、この表だけ直せばよい。

## 1. 役割対応表
| 役割 | パス |
|---|---|
| shared | js/pass-schema.js js/roster-schema.js js/data-match.js js/data-samples.js |
| core | js/roster-core.js js/roster-guest.js js/roster-day.js js/roster-share.js js/match.js js/health-redact.js js/photo-mask.js |
| adapter | js/ai-reader.js js/core.js js/pass-codec.js js/qr.js js/photo-prep.js |
| entry | index.html pass.html js/app.js js/data.js js/data-pass.js js/intake.js js/passport.js js/shop.js js/chat.js js/pass-view.js js/viewer.js js/rules.js js/turtle3d.js js/booking.js js/intake-photo.js js/guest-ask.js js/day-roster.js js/share-roster.js |

- entry の画面の部品は、今は js/ の直下に並ぶ（rename しない）。data.js と data-pass.js は時計を使う見本データなので entry
- 外へ通信してよいのは js/ai-reader.js だけ。HTML と CSS から外を読むのは、3. の表「外から読む先」に書いた先だけ（`test/arch.check.mjs` の 8 番が検査する）
- 字体（BIZ UD ゴシック）は index.html だけが、repo の fonts/ から自前で配る（css/fonts.css）。外の字体は読まない
  - 日本語の字体は約 50 字ずつのファイルに分けて配られ（unicode-range）、端末は画面に出た字・打った字を含むファイルだけを取りに行く。どのファイルを取ったかで、配っている所に字の一部が分かる
  - Google Fonts から読むと、それが IP・端末の種類・時刻・サイトの origin と一緒に Google に伝わる（字体ファイルの要求には Origin ヘッダが付き、referrer を止めても消えない）。自前で配れば Google には伝わらない。分け方は Google と同じ（取得と作り方は fonts/README.md）
  - pass.html は字体を読まない（端末の字体で描く）。自前で配っても、取りに行く束が中身で変わると、配っている所（今は GitHub Pages、後で Worker）のアクセスの記録から、健康の答えや名前の字の一部が分かる。pass.html が出す要求は、中身に関係なく毎回同じにする（置き場所が決まっても変えない）。CSP を meta で付けている

## 2. 外部境界表
| adapter | 相手 | Fake | fixture | credential | 書き込み |
|---|---|---|---|---|---|
| js/ai-reader.js | 同じ場所の Worker `/api/read` → Claude API（Haiku） | `readSample`（同じファイル）+ js/data-samples.js | AI の読み取り試験 2026-10-21 の Haiku の答え（tools/make-samples.mjs が作る） | Cloudflare Access の cookie + 合言葉（`x-redux-code`、sessionStorage）。API キーは Worker の secret だけ（この Worker 専用の 1 本） | なし |
| js/core.js | localStorage | 無し（ブラウザの中だけ） | — | なし | このブラウザだけ |

## 3. Origin・監視
- 画面のファイルと `/api` は同じ Worker から配る（同じ origin）。CORS と cross-site の Cookie は使わない
- 入口は 2 重: Cloudflare Access（Worker 全体）と合言葉。Worker は `ctx.access` が無い呼び出しを 403 で断る
- 監視: Worker は回数と費用だけを KV に数える（中身は残さない）。上限を超えたら 429、画面は見本の読み取りに切り替える

### 外から読む先（test/arch.check.mjs の 8 番はこの表だけを読む）
`…` で囲んだ先を前方一致で許す。表に書いて使っていない先も FAIL にする。ここに無いファイルからは外を読まない。
| ファイル | 外から読んでよい先 | integrity なしでよい先 | 字体 |
|---|---|---|---|
| index.html | `https://cdn.jsdelivr.net/npm/three@0.160.0/` `https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/` | なし | 読む |
| pass.html | なし | なし | 読まない |
| css/app.css | なし | なし | — |
| css/fonts.css | なし | なし | — |

- 字体の列が「読まない」のページは、@font-face のある CSS・字体の preload を読めない。守りの本体は meta の CSP なので、charset の次に置き、default-src・connect-src・img-src を 'none'、font-src と 'unsafe-…' は書かない（どれも検査する）
- css/*.css では @import を使わない（読む CSS は HTML の link に並べ、検査がたどれる形にする）
- fonts/ の字体は fonts/SHA256SUMS と中身を突き合わせる

- three.js（importmap）と qrcode-generator（script）は、画面と同じ権限で動くコード。qrcode-generator は健康の答えを含むパスポートの URL を受け取る。両方に integrity（中身が書き換えられていないかをブラウザが確かめる指定）を付けた
- importmap の integrity が効くのは Chrome/Edge 127・Safari/iOS 18・Firefox 138 から（古い iPhone では確かめないまま読む）
- js の import は importmap で URL に直し、1 つずつ integrity を求める。CDN のファイルの中の import（GLTFLoader.js → BufferGeometryUtils.js）は検査で追えないので、integrity に並べて、Network で漏れが無いか確かめる
- js では、ai-reader.js 以外の fetch、全部の js の動的な import・sendBeacon・XMLHttpRequest・WebSocket・EventSource・Worker、読み込むタグ（script・link・iframe など）を作ること、外の URL を文字で書くこと、window[…]・eval・Function を禁止する（同じ 8 番）。HTML の中に直に書いてよいスクリプトは importmap だけ（on… の属性・javascript: の URL・iframe・frame・object・embed も禁止）。js では setTimeout に文字列を渡すこと、constructor・Reflect・top[…] も禁止
- 検査で追えない形（window を変数に入れてから文字で名前を引く、など）は、P6 の CSP で止める。検査が見るのはルートの HTML と js/・css/ の直下だけなので、P6 で js/vendor/ などを作るときは、検査を下の階層まで広げる

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
| 2026-10-21 fonts | 字体は Google Fonts と同じ束に分けた woff2 を repo の fonts/ に置き、自前で配る。数字用の BIZ UDGothic は英数字の束だけ | ザクのレビュー（外から読むと、取った束から画面に出た字・打った字が Google に推測される）。Yosuke が取得を了承（2026-10-21）。端末の字体だけにする案は、design.md の BIZ UD と見た目が変わるので次点 | test/arch.check.mjs（読み込み先） |
| 2026-10-21 share-health | 乗り合いの他のお店のお客さんの健康の 2 欄は、そのお店が「渡す同意をもらった」に印を付けたときだけ受け取る。無ければ「そのお店が確かめた」とだけ持つ | 要配慮個人情報の第三者提供になるため。いつも受け取る案は同意の無い答えを持つので却下、いつも受け取らない案は船の上で既往症が分からないので次点 | test/share.test.mjs |
| 2026-10-21 own-roster | 条例の名簿（P4）は自分の店のお客さんだけ。船の全員は合同名簿（P5）で別に出す | 条例の名簿はお店ごとに作る。合同名簿に事業者 1 店の名前で他店の客を載せない | test/share.test.mjs |
| 2026-10-21 leave-one-tap | ポイントを離れる前は札ボードで数え、スマホは 1 回押すだけ | 店へのアンケート（2 人のスマホ記録は 8 店中 4 店が難しい、和船はしぶきで触れない）。札を選ぶボタンを並べる案は Yosuke の判断で外した | なし |
| 2026-10-21 outside-reads | HTML と CSS から外を読むのは、3. の表「外から読む先」にファイルごとに書いた先だけ。外のスクリプトと読み込む link には integrity を付ける。js の通信の道具と外の URL の文字は禁止 | ザクのレビュー（CDN の中身が差し替えられると、画面と同じ権限で localStorage の健康の答えを読める。2024 年の polyfill.io の件）。cdnjs が spec から漏れていたのを検査で捕まえるため。許可は表「外から読む先」だけから読み、ファイルごとに分ける（散文のサイト名を拾うと、書いただけで許可になる） | test/arch.check.mjs（test/outside.mjs） |
