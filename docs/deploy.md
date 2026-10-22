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
npx wrangler@4.151.0 login
```
ブラウザで Cloudflare の許可の画面が出る（wrangler にこのアカウントの Workers を触る権限を渡す）。

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

## 4. ★ Access を付ける（約 10 分・権限）
1. Cloudflare の画面 → Workers & Pages → `dive-passport-demo` → Settings → Domains & Routes → `workers.dev` の「Cloudflare Access を有効にする」
   - Zero Trust の初回の設定で支払い方法を求められたら、そこで止める（お金の境界。Yosuke が決める）
2. 「Access を管理」から、Access のアプリの Policy を直す
   - Include: Emails に、チーム 6 人のメールアドレスを 1 つずつ（「@gmail.com」のようなドメインでは通さない）
   - Session duration: 24 時間
   - 例外の道（Bypass）は作らない（パスポートの pass.html は GitHub Pages の公開版を使う）
3. アプリの画面に出る 2 つを控える: チームのドメイン（`<team>.cloudflareaccess.com`）と Application Audience (AUD) Tag

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
1. 本物にして、見本 16 件（予約メール 4・C カード 6・申込書 6）を読む。答えを、見本の読み取り（js/data-samples.js、試験の Haiku の答え）と見比べる。予約の項目（日時・人数・代表者）は試験していないので、ここで初めて確かめる
2. 上限の止まり方: `npx wrangler@4.151.0 deploy --var DAILY_LIMIT:3` で一時的に 3 回にし、4 回目が「今日か今月の上限に達しました」になり、見本の読み取りに戻るのを見る。月の上限も `--var MONTHLY_USD:0.01` で同じように見る。終わったら `node tools/build-site.mjs && npx wrangler@4.151.0 deploy` で戻す
3. 費用の数え方: 16 件を読んだあと、Claude Console のワークスペースの使用額と、画面の「今月あと」の減り方（KV の month）を 1 回見比べる。大きくずれていたら worker/read-core.mjs の単価を直す
4. 2 台で同時に読まない（KV は同じキーへの書き込みが 1 秒に 1 回まで。重なると「届きませんでした」になる。目安の数なので、もう一度押せば読める）
5. 通しを 2 回（本物と見本）

## 手元で確かめる（置く前）
```bash
node tools/build-site.mjs && node tools/serve-dist.mjs
```
`http://127.0.0.1:8106` で、置く物と同じファイル・同じヘッダ（CSP）を配る。`/api` は Worker のコードを通り、Access と Claude API だけ見本に差し替える。
