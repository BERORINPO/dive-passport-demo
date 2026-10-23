# アーキテクチャ（dive-passport-demo）

表 1 は `test/arch.check.mjs` が読んで検査する。パスを変えたら、この表だけ直せばよい。

## 1. 役割対応表
| 役割 | パス |
|---|---|
| shared | js/pass-schema.js js/roster-schema.js js/data-match.js js/data-samples.js js/data-sipe.js js/data-big-sample.js |
| core | js/roster-core.js js/roster-guest.js js/roster-day.js js/roster-share.js js/match.js js/health-redact.js js/photo-mask.js worker/read-core.mjs |
| adapter | js/ai-reader.js js/core.js js/pass-codec.js js/qr.js js/photo-prep.js worker/access.mjs worker/budget.mjs worker/anthropic.mjs worker/fakes.mjs |
| entry | index.html pass.html js/app.js js/data.js js/data-pass.js js/intake.js js/passport.js js/shop.js js/chat.js js/pass-view.js js/viewer.js js/rules.js js/turtle3d.js js/booking.js js/intake-photo.js js/guest-ask.js js/day-roster.js js/share-roster.js worker/index.mjs worker/handler.mjs |

- entry の画面の部品は、今は js/ の直下に並ぶ（rename しない）。data.js と data-pass.js は時計を使う見本データなので entry
- Worker（worker/）は画面と同じ 4 役割で分ける。core の worker/read-core.mjs は js/roster-schema.js と js/health-redact.js を読んで、画面と同じ検査をもう一度かける。worker/fakes.mjs は Worker の adapter の見本（テストだけが読み、置く物には入らない）
- 外へ通信してよいのは、画面では js/ai-reader.js だけ、Worker では worker/access.mjs（Access の鍵）と worker/anthropic.mjs（Claude API）だけ（本物の fetch は worker/index.mjs が渡す。9 番が検査する）。HTML と CSS から外を読むのは、3. の表「外から読む先」に書いた先だけ（`test/arch.check.mjs` の 8 番が検査する）
- 字体（BIZ UD ゴシック）は index.html だけが、repo の fonts/ から自前で配る（css/fonts.css）。外の字体は読まない
  - 日本語の字体は約 50 字ずつのファイルに分けて配られ（unicode-range）、端末は画面に出た字・打った字を含むファイルだけを取りに行く。どのファイルを取ったかで、配っている所に字の一部が分かる
  - Google Fonts から読むと、それが IP・端末の種類・時刻・サイトの origin と一緒に Google に伝わる（字体ファイルの要求には Origin ヘッダが付き、referrer を止めても消えない）。自前で配れば Google には伝わらない。分け方は Google と同じ（取得と作り方は fonts/README.md）
  - pass.html は字体を読まない（端末の字体で描く）。自前で配っても、取りに行く束が中身で変わると、配っている所（今は GitHub Pages、後で Worker）のアクセスの記録から、健康の答えや名前の字の一部が分かる。pass.html が出す要求は、中身に関係なく毎回同じにする（置き場所が決まっても変えない）。CSP を meta で付けている

## 2. 外部境界表
| adapter | 相手 | Fake | fixture | credential | 書き込み |
|---|---|---|---|---|---|
| js/ai-reader.js | 同じ場所の Worker `/api/read` → Claude API（Haiku） | `readSample`（同じファイル）+ js/data-samples.js | AI の読み取り試験 2026-10-21 の Haiku の答え（tools/make-samples.mjs が作る） | Cloudflare Access の cookie（合言葉は 2026-10-22 に外した）。API キーは Worker の secret だけ（この Worker 専用の 1 本） | なし |
| js/core.js | localStorage | 無し（ブラウザの中だけ） | — | なし | このブラウザだけ |
| worker/anthropic.mjs | Claude API（claude-haiku-5-5、/v1/messages） | `fakeAnthropic`（worker/fakes.mjs） | AI の読み取り試験 2026-10-21 の答え（予約の項目は試験していない。置いたあとに確かめる） | `ANTHROPIC_API_KEY`（この Worker 専用の 1 本、並行 1 本。Anthropic のこの Worker 専用ワークスペースで発行し、そこで月の上限） | なし |
| worker/access.mjs | Cloudflare Access の公開鍵（`https://<team>/cdn-cgi/access/certs`） | `fakeAccess`（鍵を作って JWT を署名する） | — | なし（`ACCESS_TEAM_DOMAIN`・`ACCESS_AUD`・`ALLOWED_EMAILS` は secret） | なし |
| worker/budget.mjs | Workers KV（`BUDGET`） | `fakeKv` | — | Worker の binding | 1 日の回数と今月の費用（目安）だけ |

## 3. Origin・監視
- 画面のファイルと `/api` は同じ Worker から配る（同じ origin）。CORS と cross-site の Cookie は使わない
- 入口は Cloudflare Access（Worker 全体）だけ。Worker は `Cf-Access-Jwt-Assertion` を自分で確かめ（署名・iss・aud・期限・許したメール）、通らない呼び出しを 403 で断る。`ctx.access` には頼らない。Access の鍵が取れないとき（Cloudflare 側の障害）は 503
- 画面の「本物」は、同じ場所の `/api/healthz` が通ったときだけ選べる（js/ai-reader.js の probe。GitHub Pages 版から本文を外に送らない）。確かめるのは置く物の index.html に `redux-worker` の meta があるときだけ（GitHub Pages では github.io の一番上が同じ場所になるため）。開くたびに見本から始める
- Worker の外への通信の先は、arch.check の 9 番がファイルごとに完全一致で見る。検査で追えない形（`io.fetch(env.X)`・文字を足して作った URL）は、テストの io.fetch が知らない先で例外を出すことで止める
- Worker が画面を信じる所: 申込書の写真を塗ったか（`masked: true` は画面の photo-prep.js の申告で、Worker は確かめられない）。spec/meibo.md の「本物の前に」21
- /api は `Sec-Fetch-Site: same-origin` と JSON を求め、CORS のヘッダは出さない。画面のファイルは Static Assets が `dist/_headers` の CSP を付けて配る（tools/build-site.mjs が作る）
- 監視: Worker は回数と費用だけを KV に数える（中身は残さない）。上限を超えたら 429、画面は見本の読み取りに切り替える。ログは 1 要求 1 行で、道・状態・doc・量・時間・理由の短い言葉だけ。Cloudflare の observability は切る
- 他のお店のスマホで開くパスポート（pass.html）は、GitHub Pages の公開版に置いたまま。Worker 版の画面の QR は公開版の pass.html を指す（Worker は Access の中なので、他のお店は開けない）

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
| 2026-10-23 ui-less-ai | 画面の形を直す: 白い面のカードを重ねない（罫線と余白だけ）・説明の小見出しを付けない・便の画面は時刻を大きく出す見出し・お客さんの画面はタブの無い 1 本の流れ・デモの説明は「デモの画面」を開いたときだけ。決まりは design.md の「形」と「部品」 | 点検（reports/UIのAIっぽさ点検.md）の重い 2 件と中の主な物。デザイナーへ頼む案は、11/9 までに自分で直せる所を直す方を取った | design.check（色の組）。形は目で見る |
| 2026-10-23 choice-shape | 1 つ選ぶ選択肢は、名前が短いときだけ横につなげる（`R.choiceClass`: 2 つなら 8 字・3 つなら 5 字まで）。長い物は罫線の行 | 320 幅でツアー名と英語が 2 行に折れた。画面ごとに決める案は、言葉を変えるたびに崩れる | なし（幅 4 つで確かめる） |
| 2026-10-23 trip-cancel | 便の中止は、船を出す店が 1 回押すと、便に中止（理由・時刻・確かめたお店）が付き、相乗りのお店の画面とお客さんのページに出る。相乗りのお店は「確かめた」を返す。取り消せる。記録に cancel・ack・reopen を残す | 天気で中止は乗り合いの店どうしの電話・LINE の手間が一番大きい所。試作では送らず画面に出す（本物の送り先は後）。お客さんの連絡先は各店が持つので、船の店からは相乗りのお客さんへ直接送らない | 形は roster-schema.js の検査（理由は 4 つ・確かめたお店は 10 まで） |
| 2026-10-23 partner-return | 船を出す店は、相乗りのお店ごとに、そのお店のお客さんだけの条例の名簿を作って返せる（潜水日時・場所はこの便の物、ガイドはそのお店の人、健康の 2 欄は「お店が記入」）。印刷と CSV。記録は paper: partner | 相乗りのお店も自分の名簿（作成者は各店）が要るが、日時・場所は船の店しか持たない。健康の 2 欄を船の店が埋める案は、no-health-to-boat と食い違う | share.test（そのお店の人だけ・健康は「お店が記入」・そろいの数に健康を入れない） |
| 2026-10-23 big-sample | 11/9 の見せ場用に、見本の乗り合い便（4 店・30 人・ガイド 4 人）を 1 回で作るボタンを予約の一覧に置く | 手で 30 人入れると発表の前に時間がかかり、入れ間違える。名前と連絡先はすべて見本 | なし |
| 2026-10-23 newer-first | 別のタブの保存を受けたら、この版の知らない形かを先に見て、そうなら書かなくする（保存できていない予約があっても） | 「食い違い」の知らせだけだと、次の保存で新しい版の名簿を古い形で上書きする（ザクの指摘） | booking-flow.test（storage の 3 本） |
| 2026-10-21 ai-place | AI は Cloudflare Worker から呼ぶ | Yosuke 指定。手元のサーバー案は会場の Wi-Fi 頼みになる | なし |
| 2026-10-21 access | Access と合言葉の 2 重 | Yosuke 指定。合言葉だけだと、漏れたら誰でも使える | なし |
| 2026-10-22 access-only | 合言葉を外し、入口は Access だけ（2026-10-21 access を置き換える） | Yosuke の判断。Worker が Access の JWT を自分で確かめるので、合言葉が足す守りは小さい（ザク同意）。共有の言葉は 1 人だけ止められず、漏れやすく、発表の場で打つ手間がある。1 人を止めるときは Access の Policy と ALLOWED_EMAILS から消す。2 つ目の鍵が要るなら、合言葉ではなく Access のログインを 2 段階にする | test/worker.test.mjs |
| 2026-10-21 health | 健康の情報は AI に送らない。申込書は健康の欄を塗ってから | 要配慮個人情報 | test/roster.test.mjs（送る物と答えの形） |
| 2026-10-21 health-mail | 予約メールは健康に触れていそうな行を外して送り、AI が健康を見たら記録に印を残す | ジンのレビュー（予約サイトの質問欄に健康が書かれうる）。本文を送らない案は、予約を読めなくなるので却下 | test/roster.test.mjs・test/ai-reader.test.mjs |
| 2026-10-21 who-src | 記録の「した人」と項目の「出どころ」を分けて持つ | ジンのレビュー（パスポートや他店から入った項目を正しく残す） | test/roster.test.mjs |
| 2026-10-21 no-innerhtml | entry と adapter で innerHTML などを禁止。固定の SVG だけ arch-allow | ザクのレビュー（AI の答えにメール経由で仕込まれた文字が入りうる） | test/arch.check.mjs |
| 2026-10-21 purge | 記録は足すだけ。ただし保存期間を過ぎた便は記録ごと消し、件数だけ残す | ザクのレビュー（1 年保存と「足すだけ」がぶつかる） | test/roster.test.mjs |
| 2026-10-21 redact-core | 健康の行の外し方を js/health-redact.js（core）に分け、画面と Worker の両方が使う。1 字の言葉は予約の項目の行では見ない。文ごとに外し、質問の答えは結び・署名・電話の手前まで | ジンの再レビュー（予約に要る行まで消える）とザク（取りこぼし）の両方を満たすため。行ごとに全部外す案は、1 段落のメールが丸ごと消えるので却下 | test/roster.test.mjs |
| 2026-10-21 arch-grep | 依存の向きは grep で検査し、dependency-cruiser は使わない | script タグで読む素の JS で、npm を入れていない | test/arch.check.mjs |
| 2026-10-21 core-clock | core は時計と乱数を使わない（at と newId を受け取る） | テストで毎回同じ結果にするため | test/arch.check.mjs |
| 2026-10-21 fonts | 字体は Google Fonts と同じ束に分けた woff2 を repo の fonts/ に置き、自前で配る。数字用の BIZ UDGothic は英数字の束だけ | ザクのレビュー（外から読むと、取った束から画面に出た字・打った字が Google に推測される）。Yosuke が取得を了承（2026-10-21）。端末の字体だけにする案は、design.md の BIZ UD と見た目が変わるので次点 | test/arch.check.mjs（読み込み先） |
| 2026-10-21 share-health | （2026-10-22 no-health-to-boat で置き換え）乗り合いの他のお店のお客さんの健康の 2 欄は、そのお店が「渡す同意をもらった」に印を付けたときだけ受け取る。無ければ「そのお店が確かめた」とだけ持つ | 要配慮個人情報の第三者提供になるため。いつも受け取る案は同意の無い答えを持つので却下、いつも受け取らない案は船の上で既往症が分からないので次点 | test/share.test.mjs |
| 2026-10-21 own-roster | 条例の名簿（P4）は自分の店のお客さんだけ。船の全員は合同名簿（P5）で別に出す | 条例の名簿はお店ごとに作る。合同名簿に事業者 1 店の名前で他店の客を載せない | test/share.test.mjs |
| 2026-10-21 health-log | 記録（log）に健康の答えの中身を残さない。答えた数・当日の答えの有無・誰が確かめたか・同意の版だけ | 同意を取り消して答えを消しても、記録に 1 年残っていた（ザク SEC-001・ジン）。中身を残す案は前と後が分かるが、消せない要配慮個人情報になるので却下。条例の「書き換えが分かる」は、いつ・誰が・どの項目かで満たす | roster-schema.js の logOk（人の記録の health の形）と test/share.test.mjs |
| 2026-10-21 held-today | 健康を渡さない他店のお客さんの当日の欄は、そのお店が便の日に「渡す」を押したらそろう | 便の前に「確かめた」と出すと、まだ誰も見ていない体調を確かめた扱いにする（ジン）。いつもそろった扱いにする案は却下 | test/share.test.mjs |
| 2026-10-22 joint-items | （健康の 2 欄は 2026-10-22 no-health-to-boat で外した）合同名簿は札・氏名・店・種類・ガイド・緊急時の連絡先・健康の 2 欄だけ。住所・生年月日などは各店の条例の名簿だけ | 船の上の安全に要る物だけを他のお店に見せる（ザク SEC-003、Yosuke の判断）。条例の 13 項目を全部載せる案は、住所・生年月日・家族の電話まで全店に渡すので却下 | test/share.test.mjs（行に 7 項目のほかを持たない） |
| 2026-10-22 no-health-to-boat | 健康の 2 欄（既往症・当日の健康状態）は、船にも他のお店にも渡さない。そのお客さんのお店だけが確かめ、ここには「確かめた」印（heldBy）だけを持つ。合同名簿は札・氏名・店・種類・ガイド・緊急時の連絡先の 5 項目（この店のお客さんの健康も載せない）。前の版で受け取った答えは、読み込むときに消す（holdPartnerHealth） | 店から船へ渡すのは本人の同意が要る第三者提供で、船の全員の一覧に健康を載せる理由が無い（報告「乗り合い便の名簿と横断の勝ち筋」の個人情報の節、Yosuke の判断 2026-10-22）。同意つきで渡す前の形は、同意の確かめ方が店の自己申告で弱い。船の上で既往症が分からない点は、そのお店のガイドが自分の客を見る形で補う | test/share.test.mjs（答えを入れない・5 項目・前の版の答えを消す） |
| 2026-10-22 sipe-spo2 | 県警の「ダイビング・スノーケリング前後の体調チェック表【暫定版】」に合わせ、お店が測った血中酸素を 1 本ごとに潜る前・後で入れる（person.health.spo2、3 本まで、50〜100 の整数）。高リスクは表の目安の 3 つだけ（1 本目の前が 95 以下・潜った後が 95 以下・次の前が直前の後より低い）。数値は健康の欄と同じ扱いで、この店だけが持つ（他のお店のお客さんには入れない、記録・CSV・印刷・合同名簿に出さない）。表の数値と言葉は js/data-sipe.js の 1 か所に置き、言葉は表のまま写す。お客さんには水に入った後の 3 つの症状を表の 5 言語で出す。50 歳以上は名前の横に年齢 | Yosuke の指示（2026-10-22、報告「県警の体調チェック表とパスポートの比較」）。表は質問票ではなく潜る前後の記録表で、パスポートの病歴の質問とは重ならない。表に無い判定（3 本目の前が 95 以下など）を足す案は、県警の表と違う結論を出すので却下。研究への同意の□と研究への提供は、県警・大学と話がつくまで作らない。「県警が認めた」とは書かない | test/day.test.mjs（目安の 3 つ・年齢・入れ方と断り方・形・一覧） |
| 2026-10-22 worker-fetch | Worker から Claude API へは SDK を使わず fetch で、ヘッダは x-api-key・anthropic-version・content-type の 3 つだけ | この repo は npm の部品を入れない作りで、送るヘッダを決めた 3 つにしたい（ザクのレビュー 2026-10-21）。SDK はヘッダを足すので却下 | test/worker.test.mjs（ヘッダが 3 つ） |
| 2026-10-22 worker-guard | Worker の守りの順番: 道と method → Sec-Fetch-Site → 設定 → Access の JWT → 種類・大きさ・形 → 上限（KV、呼ぶ前。判定は core の overLimit）→ AI → 答えの形。画面の検査（validateRequest・健康の行を外す・validateReading）を Worker でもう一度かける | 画面は書き換えられる前提（plan/meibo.md の「Worker で守ること」） | test/worker.test.mjs（順番と各段）・test/arch.check.mjs 9 番（Worker の通信の先） |
| 2026-10-22 mail-format | 予約メールのプロンプトは形式を 1 つの JSON にまとめ、例の値を null にする。答えは JSON の塊を前から取り出し（閉じたのに JSON でない塊は中に入らない）、参加者の塊に予約の項目が無いときだけ予約の塊を足す。参加者か予約の塊が 2 つあれば断る。健康が見えた印は、答えの文のどこかで true なら true（壊れた答えでも画面に返す） | ジンのレビュー（2 つに分けて返すと読めない・書き損じで中の 1 人分を拾う）とザク（書類に仕込んだ JSON の書き写しで値を差し替えられる）。写真のプロンプトは試験と同じ文のまま | test/worker.test.mjs |
| 2026-10-22 pass-place | pass.html は GitHub Pages に置いたまま。Worker 版の QR は公開版を指す | Access を Worker 全体にかけると他のお店が開けない。Access に例外の道（Bypass）を足す案は、pass.html が読む 9 ファイル分の設定が要り、外す道を増やすので次点 | なし |
| 2026-10-21 leave-one-tap | ポイントを離れる前は札ボードで数え、スマホは 1 回押すだけ | 店へのアンケート（2 人のスマホ記録は 8 店中 4 店が難しい、和船はしぶきで触れない）。札を選ぶボタンを並べる案は Yosuke の判断で外した | なし |
| 2026-10-21 outside-reads | HTML と CSS から外を読むのは、3. の表「外から読む先」にファイルごとに書いた先だけ。外のスクリプトと読み込む link には integrity を付ける。js の通信の道具と外の URL の文字は禁止 | ザクのレビュー（CDN の中身が差し替えられると、画面と同じ権限で localStorage の健康の答えを読める。2024 年の polyfill.io の件）。cdnjs が spec から漏れていたのを検査で捕まえるため。許可は表「外から読む先」だけから読み、ファイルごとに分ける（散文のサイト名を拾うと、書いただけで許可になる） | test/arch.check.mjs（test/outside.mjs） |
