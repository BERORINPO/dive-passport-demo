# Worker を置く手順（P6）

本物の AI で読む版を Cloudflare Worker に置く。画面と `/api` は同じ Worker から配り、入口は Cloudflare Access（チームのメールだけ。合言葉は 2026-10-22 に外した）。
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
出た `id` を wrangler.jsonc の `REPLACE_WITH_KV_ID` に入れる（こちらで直して push する）。そのあと:
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
2. D1 を作る（無料の枠）。出た `database_id` を wrangler.jsonc と wrangler.ask.jsonc の `REPLACE_WITH_D1_ID` に入れて push する
   ```bash
   npx wrangler@4.151.0 d1 create redux-rosters
   ```
3. 表を作る（worker/migrations/ の 0001〜0005。表は、それを使う Worker を置く前に作る。0004（済んだ便）が無いと便が済んで 7 日を過ぎた日の書き込みが 503 になり、0005（読めなかった予約メール）が無いと、読めなかったことを残せない（ログには残る））
   ```bash
   npx wrangler@4.151.0 d1 migrations apply redux-rosters --remote
   ```
4. 置く（お客さんの Worker を先に置いて URL を知り、お店の Worker に ASK_ORIGIN として入れてから、お店の Worker を置く）
   ```bash
   node tools/build-site.mjs
   npx wrangler@4.151.0 deploy -c wrangler.ask.jsonc
   npx wrangler@4.151.0 secret put ASK_ORIGIN
   npx wrangler@4.151.0 deploy
   ```
   - ASK_ORIGIN は `https://redux-ask.<アカウントの名前>.workers.dev`（最後の / は付けない）
5. 確かめ（ログインしていない端末か curl で）
   - お店の Worker: `/` は Access のログインへ、`/api/roster` も止まる
   - お客さんの Worker: `/ask` は開ける。`/api/roster`・`/api/ask-link` は 404。`/api/ask` に間違った鍵を送ると 404
   - 2 台の端末で同じ名簿がそろう。「お客さんに聞くリンク」で作ったリンクを、ログインしていないスマホで開いて入れると、お店の画面に出る
- Cron（15 分ごとの予定）はまだ入れていない。アカウントの無料の枠（5 本）をほかの Worker が使い切っているため。入れるまでは、お店の画面を開いている間に画面が予定を動かす
- 2026-10-27 に置いた: お店の Worker と redux-ask（https://redux-ask.cibimaro-yousuke.workers.dev）。D1 は画面で作り、表はコンソールで 0001・0002 と同じ文を流した（wrangler の login に D1 の権限が付かなかったため）
- サイトの予約フォーム（/api/bookings）は、Access の無い redux-ask が受ける（2026-10-27）。redux-ask の secret: SITE_ORIGINS（https://aquagate-demo.cibimaro-yousuke.workers.dev）と TURNSTILE_SECRET（Turnstile の widget「aquagate-demo booking form」。サイトキーはサイト側に）。お店の Worker の /api/bookings は Access の中なので使わない
- メールの送り受けは、まだ設定を入れない（無ければ止まる作り。入れる物は plan/auto.md の「置くときの設定」）
- 中身は見本だけ。本物のお客さんの情報を入れる前に、spec/meibo.md の「本物のお客さんの情報を入れる前に」と、試用のお店ごとの Worker を決める

## 8. 毎日の控えと警報、控えから戻す（2026-10-28 から。Cron が動いてから効く）

- 控えの置き場所: Workers KV の `redux-roster-backup`（binding は BACKUP。wrangler.jsonc に入れてある）。Cron が 1 日 1 回、お店ごとに名簿の本体を `day:<お店>:<日付>` に置く（1 年）。済んだ便の行は `past:<お店>:<part>`、警報は `alert:<お店>:<日付>`
- 警報の宛先（運営）: `npx wrangler@4.151.0 secret put ALERT_TO`（メールの設定 MAIL_FROM・APP_URL と Email Service がそろうまでは、KV とログだけに残る）
- Cron は Workers Paid にしてから `"triggers": { "crons": ["*/15 * * * *"] }` を入れる（draft PR #15）

控えから戻す（名簿が消えた・壊れたとき。約 10 分）:
1. どの日の控えに戻すかを決める（`alert:<お店>:<日付>` があれば、その前の日）
   ```bash
   npx wrangler@4.151.0 kv key list --binding BACKUP --remote --prefix "day:default:"
   ```
2. 控えを取り出す
   ```bash
   npx wrangler@4.151.0 kv key get --binding BACKUP --remote "day:default:2026-10-28" > snap.json
   ```
3. 戻す 1 文を作る（形の検査に通らない控えは止める。人の数が出るので確かめる）
   ```bash
   node tools/restore.mjs snap.json --shop default > restore-body.json
   ```
4. D1 の API に送る（名簿は 100 KB を超えるので、D1 のコンソールには貼れない。トークンは D1 の編集の権限だけの物を、その場で作って使う）
   ```bash
   curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/f74f3e8d-7869-4899-9bdf-33c3737a5654/query" -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" --data @restore-body.json
   ```
5. 戻すと版が 1 つ進む。開いている画面は戻した名簿を受け取る（送れていなかった直しは、当て直すか、端末の別の場所に残る）
- 済んだ便（roster_past）が消えたときは、`past:<お店>:<part>` の body を、その行に入れ直す（今は手で。要るとなったら道具にする）

## 置き直したら（2 回目から）
- 開いているタブを全部読み込み直す（スマホ・PC とも）。古い版の画面が残ったまま保存すると、古い形の名簿を書く
- be0b404 から後の版は、別のタブが新しい形で保存したのに気づくと、その画面からは書かなくなる（「この画面より新しい版の名簿が保存されました」と出る）。921da0e までの版にはこの守りが無いので、置き直した日は特に読み込み直しを先にする

## 手元で確かめる（置く前）
```bash
node tools/build-site.mjs && node tools/serve-dist.mjs
```
`http://127.0.0.1:8106` で、置く物と同じファイル・同じヘッダ（CSP）を配る。`/api` は Worker のコードを通り、Access と Claude API だけ見本に差し替える。
