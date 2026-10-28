# Worker を置く手順（P6）

本物の AI で読む版を Cloudflare Worker に置く。画面と `/api` は同じ Worker から配り、入口は Cloudflare Access（チームのメールだけ。合言葉は 2026-10-22 に外した）。お客さんのリンクと予約フォームを受ける Worker（redux-ask）だけは Access が無い（7 節）。
中身は架空の見本だけ。本物のお客さんの情報は入れない（spec/meibo.md の「本物のお客さんの情報を入れる前に」）。

- Yosuke の作業: 約 25 分（下の ★）。鍵の値は Yosuke だけが打ち、こちらは見ない
- お金・権限・公開に触れる所（★）は、その場で止まって確かめる

## 0. 前もって
- Node 18 以上（この PC は 24）
- wrangler は入れていない。使うときは `npx wrangler@4.151.0 …` と版を固定する（2026-10-14 公開。公開から 1 週間以上たった版を選んだ。置く日が 11 月にずれたら選び直す）。入れる前に、こちらから聞く
- 使える端末: iPhone は iOS 16.4 以上、Android は Chrome の新しい版（/api は Sec-Fetch-Site ヘッダを求める。古い Safari は送らないので 403 になる）

## 1. ★ Anthropic でこの Worker 専用の鍵を作る（約 5 分・お金）
1. Claude Console → Workspaces → 新しいワークスペース `dive-passport-demo`
2. そのワークスペースの Limits で、月の上限を付ける（例 $10）。上限は鍵ごとではなくワークスペースごと
3. そのワークスペースの中で API キーを 1 本作る（名前 `dive-passport-worker`）。値は次の 4 で貼るまでどこにも残さない

## 2. ★ Cloudflare にログインする（約 2 分・権限）
```bash
npx wrangler@4.151.0 login --scopes account:read user:read workers:write workers_kv:write workers_scripts:write workers_routes:write workers_tail:read
```
ブラウザで Cloudflare の許可の画面が出る（wrangler にこのアカウントの Workers を触る権限を渡す）。範囲は要る物だけに絞る（`--scopes` を付けないと、D1・Pages・AI・メール送信・証明書なども丸ごと求める）。許可の画面に出るのは、この 7 つと「Background Access」（ログインを続ける）の 8 つ。終わったら `npx wrangler@4.151.0 whoami` で確かめる（足りない範囲の警告が出るが、この作業には要らない物）

## 3. 回数を数える KV を作り、置く（約 3 分・公開）
```bash
npx wrangler@4.151.0 kv namespace create BUDGET
```
出た `id` を wrangler.jsonc の BUDGET の `id` に入れる（こちらで直して push する。今の本番の値は入れてある）。そのあと:
```bash
node tools/build-site.mjs && npx wrangler@4.151.0 deploy
```
- `https://dive-passport-demo.<アカウントの名前>.workers.dev` に置かれる。Access を付けるまでの数分は画面が誰でも開ける（中身は GitHub Pages の公開版と同じ見本）。`/api` は鍵も Access も無いので 503 / 403 で断る
- `preview_urls` は切ってあるので、版ごとの別の URL はできない

## 4. ★ Access を付ける（約 10 分・権限とお金の画面。2026-10-22 に実際にやった順）
1. Cloudflare の画面 → Workers & Pages → `dive-passport-demo` → Access のタブ。Zero Trust が無ければ「Set up Zero Trust」
   - プランは Zero Trust Free（$0・50 人まで）。**ここで登録済みのカードと、2 つの同意（利用規約・無料の枠を超えた分の請求）を求められる**。お金の境界なので Yosuke が自分で押す（2026-10-22 に Yosuke が有効にした）
   - チーム名は自動で付く（今は `broken-meadow-9e20`。チームのドメインは `broken-meadow-9e20.cloudflareaccess.com`）
2. Zero Trust → Access controls → Policies → Add a policy で、許す人のポリシーを先に作る
   - Include → Emails に、許すメールアドレスを 1 つずつ（「@gmail.com」のようなドメインでは通さない。Worker の画面の選び方にある「Email domain」は使わない）
   - Policy name `dive-passport-demo team`、Action Allow、Policy session duration 24 hours
   - 今は Yosuke 1 人だけ。チームの 5 人は通しの確認の前に、このポリシーと ALLOWED_EMAILS の両方に足す
3. Worker の Access のタブに戻り「Protect this Worker behind Access」→ Scope は **All traffic**（Previews only ではない）→ 2 のポリシーを選んで Apply Access
4. 同じ画面の「Application values」に出る AUD tag を控える。チームのドメインは JWKS の URL の `https://` と `/cdn-cgi/…` の間
5. 確かめ: Worker の URL をどこを開いても、Access のログイン画面へ 302 で飛ぶ

## 5. ★ 鍵と設定を入れる（約 5 分）
```bash
npx wrangler@4.151.0 secret put ANTHROPIC_API_KEY
npx wrangler@4.151.0 secret put ALLOWED_EMAILS
npx wrangler@4.151.0 secret put ACCESS_TEAM_DOMAIN
npx wrangler@4.151.0 secret put ACCESS_AUD
```
- ALLOWED_EMAILS: 4 の 6 人をカンマで区切って（Access の許可と同じにする。Worker も自分で確かめる）
- 1 人だけ止めたいとき（スマホを無くした・チームを抜けた）: その人を Access の Policy と ALLOWED_EMAILS の両方から消す。合言葉は無い（2026-10-22 に外した）ので、ほかの人は何もしなくてよい
- ACCESS_TEAM_DOMAIN: `<team>.cloudflareaccess.com`（https:// は付けなくてよい）
- 公開の repo なので、どれも wrangler.jsonc には書かない

## 6. 開けるか確かめる（約 3 分）
- スマホで Worker の URL を開く → Access のメールのコードで入る → 予約と名簿に「AI の読み取り」の行が出る（`/api/healthz` が通った印）
- 許していないメールアドレスで開くと、Access の画面で止まる
- パスポートの QR を、別のスマホ（Access に入っていない物）で読んで開けるか。QR は GitHub Pages の公開版の pass.html を指すので、公開版が古いと開けない

## 置いたあとの確かめ（harness.yaml の contract）
- 2026-10-22: 置いた Worker で、本物の AI が見本のメール 1（予約サイトの通知・2 人）を読み、予約サイト・番号・日時・人数・代表者・名前が全部合った。KV の数は day 1・month 659（約 $0.00066）。残りは下の 1〜5
- 2026-10-22 の確かめ（置いた Worker・本物の AI）:
  - 見本 16 件すべてに答えが返った（1 件 4〜10 秒）。試験の答えと 130 項目を比べて 122 項目が同じ。違った 8 項目のうち、自信ありの誤りは 0。良くなった・どちらも正しいのが 5（f2 の住所「見本巳」→「見本区」に直った、e3 の「今年の 6 月」を今日の日付から 2026-06 に、件名から読んだツアー名など）、空欄のままが 3（e3 の人数、e4 の大輔さんの電話（予約の代表者の電話には入った）、e4 のツアー）
  - 申込書 f3（スマホで斜めに撮った見本）で、AI が「健康の情報が見えた」と答えた。決まった位置の黒い四角から、健康の欄の見出しと 1 問目がはみ出ていた。画面はこの読み取りを使わず、塗り直しに戻す（守りは働いた）。spec/meibo.md の「本物の前に」23。→ 見本の書式の四角の上を 1150 から 930 に広げ（01761bd。6 枚で上の欄を隠さないことを目で確かめた）、置き直して f3 を読み直すと「見えなかった」になり、項目も全部正しかった
  - 上限: 1 日の上限を今日の回数にすると、画面は「今日か今月の上限に達しました」と出して見本に戻った。月の上限を $0.01 にすると 429（which: month）。どちらも AI は呼ばず、断った分は数えない。確かめのあと 200 回・$5 に戻した
  - 費用: 16 件で $0.0095（KV の month = 9,455）。1 件 約 $0.0006
- チームの 5 人を足す前に、Zero Trust → Integrations → Identity providers に One-time PIN（メールに届くコードでログイン）を足す。今のログイン方法は「Cloudflare のアカウント」だけで、Cloudflare のアカウントを持たない人は入れない
1. 本物にして、見本 16 件（予約メール 4・C カード 6・申込書 6）を読む。答えを、見本の読み取り（js/data-samples.js、試験の Haiku の答え）と見比べる。予約の項目（日時・人数・代表者）は試験していないので、ここで初めて確かめる
2. 上限の止まり方: `npx wrangler@4.151.0 deploy --var DAILY_LIMIT:3` で一時的に 3 回にし、4 回目が「今日か今月の上限に達しました」になり、見本の読み取りに戻るのを見る。月の上限も `--var MONTHLY_USD:0.01` で同じように見る。終わったら `node tools/build-site.mjs && npx wrangler@4.151.0 deploy` で戻す
3. 費用の数え方: 16 件を読んだあと、Claude Console のワークスペースの使用額と、画面の「今月あと」の減り方（KV の month）を 1 回見比べる。大きくずれていたら worker/read-core.mjs の単価を直す
4. 2 台で同時に読まない（KV は同じキーへの書き込みが 1 秒に 1 回まで。重なると「届きませんでした」になる。目安の数なので、もう一度押せば読める）
5. 通しを 2 回（本物と見本）

## 7. 名簿のサーバーと、お客さんのリンクの Worker（2026-10-27 から）
お店の名簿を D1 に置き（端末どうしでそろう）、書類の自動化の Cron を動かし、お客さんのリンクを Access の無い別の Worker（`redux-ask`）で開けるようにする。
お店の Worker の Access の設定は触らない（お客さんの Worker にはお店の画面も名簿の道も無い。plan/meibo.md「お客さんのリンク」）。

1. ★ D1 を作れるように入り直す（約 2 分・権限）: 2 の login に `d1:write` を足して打つ
   ```bash
   npx wrangler@4.151.0 login --scopes account:read user:read workers:write workers_kv:write workers_scripts:write workers_routes:write workers_tail:read d1:write
   ```
2. D1 を作る（1 つだけ。全部のお店がこの 1 つを使う）。出た `database_id` を wrangler.jsonc の d1_databases に入れて push する（今の本番の値は入れてある）。redux-ask（wrangler.ask.jsonc）は D1 を持たない（2026-10-28 から。お店の Worker を Service Binding で呼ぶ）
   ```bash
   npx wrangler@4.151.0 d1 create redux-rosters
   ```
3. 表を作る（worker/migrations/ の 0001〜0009。0008（予約の受け口 API の鍵と、同じ予約の 2 回目の記録）も足すだけなので先に流せる。0009（お客さんのリンクを作った人の欄 minted_by）も欄を足すだけなので先に流す。**0009 を流す前にお店の Worker を置くと、お客さんのリンクが開けなくなる**。**流す前にお店の Worker を置くと、Cron が表の不足（0008）で止まる**ので、必ず先に流す。表は、それを使う Worker を置く前に作る。0004（済んだ便）が無いと便が済んで 7 日を過ぎた日の書き込みが 503 になり、0005（読めなかった予約メール）が無いと、読めなかったことを残せない（ログには残る）。0006（1 日の件数）が無いと、サイトの予約が 503 になる（件数を D1 で数えるため）。0006 は足すだけなので、前の版の Worker が動いたままでも先に流せる。0007（店頭の QR の鍵と、店頭で入れた人）も足すだけで先に流せる。無いと、Cron が表の不足で止まる）
   ```bash
   npx wrangler@4.151.0 d1 migrations apply redux-rosters --remote
   ```
4. 置く（**お店の Worker を先、redux-ask を後**。redux-ask は Service Binding `SHOP` でお店の Worker の `ShopRpc` を呼ぶ。Cloudflare の文書: 相手の Worker が無いと置けず、先に相手を置く（「Deployment」の節）。ShopRpc を export する前のお店の Worker に当てると、/api/ask と /api/bookings が 500 になる）
   ```bash
   node tools/build-site.mjs
   npx wrangler@4.151.0 secret put ASK_ORIGIN
   npx wrangler@4.151.0 secret put SITE_ORIGINS
   npx wrangler@4.151.0 deploy
   npx wrangler@4.151.0 deploy -c wrangler.ask.jsonc
   ```
   - ASK_ORIGIN は今は `https://ask.reduxdive.com`（最後の / は付けない。9 節）。ドメインを持たないときは `https://redux-ask.<アカウントの名前>.workers.dev`（初めて置く日で住所がまだ無ければ、redux-ask を置いたあとにもう一度入れる）
   - SITE_ORIGINS: これまで redux-ask に入れていた値と同じ（予約フォームを置くサイトの住所）を、**お店の Worker に入れる**。サイトからの予約の振り分けと Turnstile のホスト名の確かめは、お店の一覧（D1 の shops）を引くお店の Worker が行うため。shops にそのサイトの行があれば要らない。入れ忘れて redux-ask を置くと、サイトの予約が 403（origin）になる
   - 置いたあと、redux-ask の古い secret `SITE_ORIGINS` は使われない（消してよい）。`SINGLE_SHOP` は wrangler.jsonc の vars だけでよい（wrangler.ask.jsonc からは外した）
   - 予約の受け口 API（/api/v1/bookings）で redux-ask に増えるのは、Rate Limiting の binding `INTAKE_LIMIT`（wrangler.ask.jsonc に書いてあり、置くと作られる。secret・課金は増えない）だけ。お店の Worker 側は、1 日の上限を変えたいときだけ vars の `INTAKE_DAILY_MAX`（1〜1000。既定 100）
   - 戻すとき（ロールバック）は逆の順: redux-ask を前の版（D1 を直に読む版。この変更の前の wrangler.ask.jsonc）に戻してから、お店の Worker を戻す。前の redux-ask は D1 の binding が要る
   - 2 回目から（置き直し）も、お店の Worker → redux-ask の順。お店の Worker だけを先に置いても、口（今は 7 つ）は足すだけなので前の redux-ask は動く（口を足すときは必ず、お店の Worker の版で足してから redux-ask を置く）
5. 確かめ（ログインしていない端末か curl で）
   - お店の Worker: `/` は Access のログインへ、`/api/roster` も止まる
   - お客さんの Worker: `/ask` は開ける。`/api/roster`・`/api/ask-link` は 404。`/api/ask` に間違った鍵を送ると 404。Cloudflare の画面で redux-ask の Bindings に D1 が無く、Service binding の `SHOP`（→ dive-passport-demo / ShopRpc）があること。サイトの予約フォームから 1 件送れること（202）
   - 2 台の端末で同じ名簿がそろう。「お客さんに聞くリンク」で作ったリンクを、ログインしていないスマホで開いて入れると、お店の画面に出る
   - 店頭の QR（決定ログ 2026-10-28 walkin-qr）: 予約の画面の「店頭の QR・店頭で入れた人」→「店頭の QR を作る」で貼り紙が出る。「A5 で印刷」の PDF が A5 の縦 1 枚で、QR の下に鍵つきの文字が出ていない。ログインしていないスマホで QR を読むと、今日・明日の便（日付・時刻・ツアーの名前だけ）が出て、ほかのお客さんの名前・人数は出ない。入れると「店頭で入れた人」に出て、名簿にはまだ入っていない。「その予約にまとめる」「便を選んで入れる」で名簿に入り、「入れない」で消える。作り直すと、前の QR が「使えません」になる。`wrangler tail` に名前・住所・鍵が出ていない
   - 予約の受け口 API（決定ログ 2026-10-28 intake-api、説明書は docs/api.md）: 予約の画面の「別のシステムから予約を受ける（API キー）」で鍵を作り（鍵は作った 1 回だけ出る）、次の curl で 1 件送る。`201` と `booking_id` が返り、予約の画面に「（連携先の名前）（自社の予約フォーム）」として出る。同じ `Idempotency-Key` でもう一度打つと `200` と `"replayed":true` で、予約は増えない。`Authorization` なし・違う鍵・止めた鍵は `401`。`-H "Origin: https://example.com"` を付けると、鍵が正しくても `403`。`wrangler tail` に鍵・名前・メールアドレスが出ていない。試した予約は予約の画面の「取り消す」で消す
     ```bash
     curl -i https://ask.reduxdive.com/api/v1/bookings -H "Authorization: Bearer rdx_ここに鍵" -H "Content-Type: application/json" -H "Idempotency-Key: deploy-check-1" \
       -d '{"date":"2026-11-20","tour":"体験ダイビング","people":1,"lead_name":"確認 太郎"}'
     ```
   - 予約のリンクの画面（「QR を見せる」から開く）: 「QR を見せる」で大きな QR が出て、お客さんのスマホで読める。「SMS で送る」が iPhone と Android の両方で、宛先と本文が入った SMS の作成画面を開く（電話番号が無い予約には出ない）。「LINE で送る」が LINE の共有先の選択画面を開く。送るのはスタッフが押す
- お店の一覧（D1 の shops）が空・表が無いとき、Worker は 503（shops-empty・shops-no-table をログに出す）。今の 1 店の動き（名簿の行 = default）で動かすには、wrangler.jsonc の vars に `SINGLE_SHOP: "default"` を入れる（入れてある。お店の一覧を引くのはお店の Worker だけなので、wrangler.ask.jsonc には要らない）。shops に行を足したら行が先になる（足す前に default の行も入れる: tools/shop.mjs keep-sample）。置く順は migration（0008 まで）を流す → お店の Worker → redux-ask
- Cron（`*/15 * * * *`）は 2026-10-28 に入れた（Workers Paid。9 節）。予定を動かして連絡を送るのは Cron だけ。**Cron が止まると、連絡も毎日の控えも何も動かない**（お店の画面は予定を動かさない）。止まったときは、Cloudflare の画面でお店の Worker に Cron が付いているかを見る
- 2026-10-27 に置いた: お店の Worker と redux-ask（https://redux-ask.cibimaro-yousuke.workers.dev）。D1 は画面で作り、表はコンソールで 0001・0002 と同じ文を流した（wrangler の login に D1 の権限が付かなかったため）
- サイトの予約フォーム（/api/bookings）は、Access の無い redux-ask が受ける（2026-10-27）。secret は、お店の Worker に SITE_ORIGINS（https://reduxdive.com。お店の一覧を引く側。移行が済むまでは古い workers.dev の住所も「,」で並べておく）、redux-ask に TURNSTILE_SECRET（Turnstile の widget。サイトキーはサイト側に。許す hostname に reduxdive.com が要る）。お店の Worker の /api/bookings は Access の中なので使わない
- メールの送り受けは 2026-10-28 に入れた（9 節）。設定が欠けると止まる作り（送らず unsent、受けずに断る）。入れる物の一覧は plan/auto.md の「置くときの設定」
- 中身は見本だけ。本物のお客さんの情報を入れる前に、spec/meibo.md の「本物のお客さんの情報を入れる前に」と、試用のお店ごとの Worker を決める

## 8. 毎日の控えと警報、控えから戻す（2026-10-28 から。Cron が動いてから効く）

- 控えの置き場所: Workers KV の `redux-roster-backup`（binding は BACKUP。wrangler.jsonc に入れてある）。Cron が 1 日 1 回、お店ごとに名簿の本体を `day:<お店>:<日付>` に置く（1 年）。済んだ便の行は `past:<お店>:<part>`、警報は `alert:<お店>:<日付>`
- 警報の宛先（運営）: `npx wrangler@4.151.0 secret put ALERT_TO`（メールの設定 MAIL_FROM・APP_URL と Email Service がそろうまでは、KV とログだけに残る）
- Cron（`"triggers": { "crons": ["*/15 * * * *"] }`）は wrangler.jsonc に入れてある。Workers Paid が要る（9 節）

控えから戻す（名簿が消えた・壊れたとき。約 15 分）:
1. どの日の控えに戻すかを決める（`alert:<お店>:<日付>` があれば、その中の数を見て、減る前の日）
   ```bash
   npx wrangler@4.151.0 kv key list --binding BACKUP --remote --prefix "day:default:"
   ```
2. 控えを取り出す
   ```bash
   npx wrangler@4.151.0 kv key get --binding BACKUP --remote "day:default:2026-10-28" > snap.json
   ```
3. 今の名簿を書き出して残す（戻すと消える予約を後で入れ直すため。版も、戻す 1 文の守りに使う）
   ```bash
   curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/f74f3e8d-7869-4899-9bdf-33c3737a5654/query" -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" --data '{"sql":"SELECT shop, version, state FROM rosters WHERE shop = ?1","params":["default"]}' > current.json
   ```
4. 戻す 1 文を作る。控えのお店と --shop が違えば止まる。戻すと消える予約と人の数が出るので確かめる
   ```bash
   node tools/restore.mjs snap.json --shop default --current current.json > restore-body.json
   ```
5. D1 の API に送る（名簿は 100 KB を超えるので、D1 のコンソールには貼れない。トークンは D1 の編集の権限だけの物を、その場で作って使う）
   ```bash
   curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/f74f3e8d-7869-4899-9bdf-33c3737a5654/query" -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" --data @restore-body.json
   ```
6. 答えの changes が 0 なら、3 のあとに予約が入って版が進んだ（予約フォーム・届いたメールは戻す間も書く）。3 からやり直す
7. 戻すと版が 1 つ進む。開いている画面は戻した名簿を受け取る。4 で出た「消える分」と「控えの時点に戻る分」（健康の答え・確かめた印など）は、current.json を見て入れ直す
8. 終わったら snap.json・current.json・restore-body.json を消す（お客さんの情報そのもの）
- 済んだ便（roster_past）が消えたときは、`past:<お店>:<part>` の body を、その行に入れ直す（今は手で。要るとなったら道具にする）
- 名簿の行が消えたまま 7 日たつと、比べる控えが無くなり警報は止まる。メールが送れるようになるまで（KV にだけ残るあいだ）は、`alert:` を週に 1 度見る
- お客さんから「消して」と頼まれたときは、名簿から消したうえで、控え（`day:` と `past:`）にも残っていることを伝え、要るなら控えも消す（控えは最長 1 年残る）

## 9. ドメイン reduxdive.com とメール（2026-10-28 に置いた）

いまの形:
| 物 | 中身 | どこで |
|---|---|---|
| ドメイン | reduxdive.com（Cloudflare Registrar、自動更新オン（2026-10-28 に入れた。2027-10-28 に 11.17 ドルを登録のカードに請求）、期限 2027-10-28） | Domains → Registrations |
| Workers | Paid（月 5 ドル）。Cron と Email Sending に要る | Workers plans |
| 受信 | Email Routing を有効にし（MX・SPF・DKIM は自動）、`inbox@reduxdive.com` → お店の Worker（dive-passport-demo）の rule | API `/zones/{zone}/email/routing/rules`（rule の名前 REDUX booking inbox） |
| 受ける送り主 | secret `MAIL_SENDERS`（「,」区切り。お店が予約メールを転送する元のアドレス。Gmail・Microsoft 365 の自動転送を受けるなら、転送を受ける予約サイトのドメインを `@booking.example` の形で足す。足さないと転送は断る）。お店の一覧（shops）が空の間は 1 店で、これを使う | `wrangler secret put MAIL_SENDERS` |
| 送り主の確かめの名前 | wrangler.jsonc の vars `MAIL_AUTHSERV_ID` = `mx.cloudflare.net`（2026-10-28、本番に届いた Gmail の 1 通の生の見出しで確かめた。一番上の Authentication-Results が Cloudflare の行）。**これが無いと全部のメールを断る**。Cloudflare はこの行に SPF の結果を 2 つ並べる（`spf=none smtp.helo=…` と `spf=pass smtp.mailfrom=…`）。見るのは mailfrom の方だけ（PR #48） | wrangler.jsonc |
| 送信 | Email Sending を reduxdive.com で有効（送り元 `yoyaku@reduxdive.com`、Return-Path は `cf-bounce.reduxdive.com`。DKIM・SPF・DMARC p=reject は自動） | API `/zones/{zone}/email/sending/subdomains`（wrangler の `email sending enable` は 4.151.0 で認証の誤りになった） |
| お客さんのリンク | `ask.reduxdive.com`（redux-ask の custom domain）。お店の Worker の secret `ASK_ORIGIN` もこの住所 | wrangler.ask.jsonc |
| 警報の宛先 | secret `ALERT_TO` | `wrangler secret put ALERT_TO` |
| お客さんの返信の行き先（Reply-To） | secret `REPLY_TO` | `wrangler secret put REPLY_TO`（無ければ Reply-To を付けない。返信は受け口の無い yoyaku@ に行く） |
| Cron | `*/15 * * * *`（書類の自動化と毎日の控え） | wrangler.jsonc |
| DMARC の報告 | Cloudflare の DMARC Management を有効（2026-10-28。`_dmarc` の TXT に Cloudflare の rua が足された。p=reject はそのまま） | Email → DMARC Management |
| 外の死活監視 | UptimeRobot（Yosuke のアカウント、無料）が `https://ask.reduxdive.com/api/health` を 5 分ごとに見る。Cron が 45 分動かないと 503 になり、Yosuke の Gmail に知らせが来る（Cloudflare と別の系統） | uptimerobot.com |

- 名前の変更（2026-10-28、REDUX に統一）: サイトは https://reduxdive.com（Worker redux-site。team-pivot の prototype/leisure-site-motion）、お店の画面は https://app.reduxdive.com（この Worker の Custom Domain。wrangler.jsonc の routes と vars の APP_URL）、お客さんのリンクは ask.reduxdive.com のまま。`www.reduxdive.com` → `https://reduxdive.com` の 301 は、ダッシュボードの Redirect Rules で付ける（静的サイトの Worker の `_redirects` は host を指定できない）
- 古い aquagate-demo の Worker（workers.dev のサイト）は、reduxdive.com が開き、予約フォームが 1 件通るのを確かめてから消す。移行のあいだ workers_dev は true のまま（お店の画面の workers.dev も、app.reduxdive.com で入れるのを確かめてから false にする）
- app.reduxdive.com を使い始める前に、Cloudflare 側で次が要る（権限の設定を足すので、Yosuke が画面で行う）:
  1. Zero Trust → Access で、app.reduxdive.com にも 4 節と同じポリシー（許す人だけ）を付ける。別の application を作ると AUD tag が変わる。ACCESS_AUD は 1 つの値しか受けないので、同じ application の宛先に足して AUD を変えないか、作り直して `ACCESS_AUD` を入れ直す
  2. お店の Worker の secret `SITE_ORIGINS` に `https://reduxdive.com` を足す。redux-ask の Turnstile の widget の hostname に `reduxdive.com` を足す
  3. 置いたあと、お店の画面を app.reduxdive.com で開き直す（ホーム画面に足した古いアイコンは workers.dev のまま）
- メールのアドレスは公開の repo に書かない（送り主・警報の宛先は secret）

置き直し: `node tools/build-site.mjs` のあと、`npx wrangler@4.151.0 deploy`（お店の Worker）→ `npx wrangler@4.151.0 deploy -c wrangler.ask.jsonc`（redux-ask）の順（7 節の 4）

確かめ方（2026-10-28 に通した）: `ask.reduxdive.com/ask` が 200／MAIL_SENDERS のアドレスから `inbox@reduxdive.com` に予約メールを送る → 名簿に入り予定が 4 つできる → 次の Cron でお願いのメールが届く／Cron のあとに BACKUP の KV に `day:<お店>:<日付>` ができる。届いた記録は GraphQL の `emailRoutingAdaptive` で見られる

## 壊れた版を置いたとき（戻し方）
1. `npx wrangler@4.151.0 deployments list`（お店の Worker）と `npx wrangler@4.151.0 deployments list -c wrangler.ask.jsonc`（redux-ask）で、前の版の Version ID を見る
2. `npx wrangler@4.151.0 rollback <前の Version ID> --message "<理由>"` で戻す。redux-ask も壊したなら、`-c wrangler.ask.jsonc` を付けて同じようにする（Service Binding があるので、戻すときは redux-ask を先、お店の Worker を後）
3. 戻らない物: D1 の表（migration）・secret・KV・Email Routing の設定。これらを変えた版を戻すときは、手で元に戻す
4. 戻したら、main の直す PR を作り、通ってから置き直す。戻したことはこの節の下に 1 行足す
- 2026-10-28: 送り主の確かめ（#42）が本物の Gmail を断った → `rollback 51f5200e…` で戻し、#48 で直して置き直した（止まっていたのは約 20 分）

## 置き直したら（2 回目から）
- 開いているタブを全部読み込み直す（スマホ・PC とも）。古い版の画面が残ったまま保存すると、古い形の名簿を書く
- be0b404 から後の版は、別のタブが新しい形で保存したのに気づくと、その画面からは書かなくなる（「この画面より新しい版の名簿が保存されました」と出る）。921da0e までの版にはこの守りが無いので、置き直した日は特に読み込み直しを先にする

## 手元で確かめる（置く前）
```bash
node tools/build-site.mjs && node tools/serve-dist.mjs
```
`http://127.0.0.1:8106` で、置く物と同じファイル・同じヘッダ（CSP）を配る。`/api` は Worker のコードを通り、Access と Claude API だけ見本に差し替える。
