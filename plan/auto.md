# 書類の自動化（2026-10-27、周 1）

> 計画の時の記録。今の形は spec/architecture.md、置き方は docs/deploy.md。食い違うときはそちらが正しい。古くなった行は「済み」を付けるか書き直してある。

11/9 の中間発表の柱「書類が勝手に名簿になる」。流れの図は docs/flow/doc-automation.png、モックは v11。
予約が届いてから当日の朝に条例の名簿がそろうまで、お店の人が触るのは「確かめる」と「受付で聞く」だけにする。

## 決めたこと

- **中身は全部 core（js/roster-auto.js）。** 画面（端末だけの試作・GitHub Pages）でも Worker（D1 の名簿）でも同じ関数で動かす。core は時計を使わないので、今の時刻は日本の時刻の文字「YYYY-MM-DDTHH:MM」で受け取る
- **予約に連絡先を持つ。** booking.leadEmail（お願いを送る先）と booking.lang（送る言葉 ja/en/ko/zh）。無い予約もある
- **自動の予定（state.jobs）と送る連絡（state.outbox）を名簿に持つ。** 予約を入れたら予定を作る: お願い（すぐ）・2 日前の 9:00 にもう一度・前日の 20:00 にお店へ知らせる・当日の 6:00 に名簿を作って体調の質問を送る
- **時刻が来た予定を動かす（runDue）。** 足りない項目がもう無ければ飛ばす。送り先が無ければ「送れなかった」と残し、お店に見せる。本文に健康の答えは入れない
- **送るのは Worker だけ。** 画面は送る連絡を「送る準備ができた」まで作る。Worker は時刻で動く仕組み（Cron Triggers、15 分ごと）で runDue をかけ、メールの送信の設定（Cloudflare Email Service の binding）があれば送る。無ければ「メールの設定が無いので送っていない」と残す（済み: 2026-10-28 に reduxdive.com と Workers Paid を置き、yoyaku@reduxdive.com から送っている）
- **届いた予約メールは、Worker の email の入口で受ける。** 読んで、便に入れ、予定を作る。済み: inbox@reduxdive.com に届いたメールを Email Routing がお店の Worker の email() へ渡して動いている（2026-10-28）。画面のデモでは「見本のメールが届いた」で同じ流れを通す
- **デモ（試作の画面）では時刻を進められる。** 「時刻を進める」で、次の予定の時刻まで進めて runDue をかける

## 予約を受ける口（POST /api/bookings。自社のサイトの予約フォームから）

AquaGate（仲村さんのサイト）の予約フォームから届く予約を受ける。サイトは別の origin なので、Access の外に出す道になる。
**置く前に、ザクのレビューと Yosuke の確認が要る**（plan/server.md の 4 と同じ扱い）。済み: 今は Access の無い別の Worker redux-ask が受ける（お店の Worker の /api/bookings は使わない）。

送る物（JSON、1 件 4 KB まで）:

```json
{ "tour": "dive", "date": "2026-11-03", "people": 2, "name": "見本 花子", "email": "hanako@mail.example",
  "lang": "ja", "swim": "shallow", "exp": "first", "dives": "", "worries": ["ears"], "phone": "090-0000-0000", "note": "" }
```

- 項目は js/intake.js の送る物にそろえる（tour・date・people・name・lang・swim・exp・dives・worries）に、email と、任意の phone（30 字まで）・note（ご要望・ご質問、400 字まで。予約の note と同じ上限）を足す。健康の質問はサイトでは聞かない
- Turnstile の答えは本文に入れず、ヘッダー `cf-turnstile-response` で送る
- 返す物: 202 `{ ok: true }`（予約は名簿の便に入り、お願いの予定が作られる）／ 400 形が合わない ／ 429 回数の上限
- 守り: 許す origin は env の SITE_ORIGINS に書いた物だけ（CORS）。Turnstile（ロボットよけ）を付ける。1 つの IP からの回数に上限。受けた予約は「自社のサイトの予約フォーム」として入り、お店が見られる
- 作るのはこの repo の feature/auto-docs（Worker の handler.mjs を書類の自動化でも触るため、同じブランチで作る）。サイト側はこの形で送るだけ

## 読めなかった予約メール（2026-10-27。ジンのレビュー HIGH 6）

届いた予約メールを名簿に入れられなかったとき（日付が無い・AI が読めない・上限・本文が読めない・名簿に書けない）、今までは Worker のログに残るだけで、お店は気づけなかった。
- 宛先・送り主・送り主のドメインの確かめを通ったメールだけ、D1 の `mail_unread`（worker/migrations/0005_mail_unread.sql）に 1 行残す。残すのは届いた時刻と理由の短い言葉だけ（件名・本文・送り主は残さない。件名にお客さんの名前が入る予約サイトがあるため）
- お店の画面: 書類の自動化の画面（画面 10。予約の一覧の上の「書類の自動化」の 1 行から開く）に「読めなかった予約メール」と、届いた時刻・理由を出す（2026-10-28 に予約の一覧から移した）。お店は自分の受信箱で、その時刻のメールを探して「メールを貼る」で入れ、「入れた・済んだ」を押す
- 口: `GET /api/mail-unread`（新しい順 50 件）・`POST /api/mail-unread { id }`（消す）。Access の内、お店はログインしたメールで決める
- 30 日を過ぎた行は、次に足すときに消す。1 お店で 1 日 60 行まで（大量に届いても表が育たない）
- 理由の言葉は worker/auto-core.mjs の unreadWhy、テストは test/unread.test.mjs

## ファイル

| ファイル | 役割 | 中身 |
|---|---|---|
| js/roster-schema.js | shared | leadEmail・lang・jobs・outbox・trip.rosterAt の形 |
| js/roster-auto.js | core | autoAdd（読み取り・フォームから入れて予定を作る）・planJobs・runDue・markSent・文面・board（お店全体の一覧）・resend / confirmSent（送り直す・届いていた） |
| js/booking.js ほか | entry | 自動で入れた印、1 件の流れ、送った連絡、当日の朝、デモの時刻 |
| js/auto-flow.js | entry | 画面の B（1 件の流れ）・画面 10（お店全体の書類の自動化）・一覧の 1 行・デモの「見本のメールが届く」「時刻を進める」 |
| worker/auto-core.mjs | core | /api/bookings の本文の検査と、名簿に入れる直し・届いたメール（MIME）から本文を取り出す・送り主の許可・送った結果を付ける |
| worker/mail.mjs | adapter | Cloudflare Email Service（binding `EMAIL`）で送る。設定がそろうまでは unsent（見本 fakeMail） |
| worker/site-guard.mjs | adapter | Turnstile の確かめ・1 つの IP の回数（見本 fakeTurnstile・fakeRateLimit） |
| worker/ask.mjs | entry | AI に読ませる 1 回（上限 → Claude API → 費用 → 答えの形）。/api/read と届いたメールが使う |
| worker/auto.mjs | entry | 名簿を読んで直して版つきで書く（ぶつかったら 5 回まで当て直す）・Cron・届いたメール・/api/bookings の中身 |
| worker/handler.mjs・index.mjs | entry | POST /api/bookings の守り（CORS → 設定 → 種類 → 回数 → 大きさ → Turnstile）、index は scheduled と email をつなぐ |

## 置くときの設定（済み。2026-10-28 に置いた。今の値は wrangler.jsonc・wrangler.ask.jsonc と docs/deploy.md の 9）

設定が無ければ止まる作りにしてある（/api/bookings は 503、Cron は `config:DB` をログに出して何もしない、メールは unsent）。
連絡を送るのは Cron だけ。サイトの予約と届いたメールは名簿に入れるだけで、お願いは次の Cron（最大 15 分後）で送る（ザクのレビュー 2026-10-27 M-1）。

| 名前 | 種類 | 中身 | 無いとき |
|---|---|---|---|
| `DB` | D1 binding | 名簿の正本（plan/server.md）。表は `worker/migrations/0001_rosters.sql` と `0002_ask_links.sql`（お客さんのリンクの鍵の SHA-256） | Cron・メール・予約の口・お客さんのリンクは何もしない |
| `triggers.crons` | wrangler.jsonc | `"*/15 * * * *"`（15 分ごと。予定は 9:00・20:00・6:00 なので、遅れても 15 分） | 予定が動かない（動かすのは Cron だけ） |
| `EMAIL` | send_email binding | Email Service。お店のドメインを `wrangler email sending enable` で載せる（有料・ドメインが要る） | 送らず unsent（no-mail-config） |
| `MAIL_FROM` | var | 送り元（お店のドメインのアドレス） | 同上 |
| `APP_URL` | var | お店の画面の住所（workers.dev）。お客さんのリンクの頭は secret の `ASK_ORIGIN`（https://ask.reduxdive.com。Access の無い別の Worker redux-ask） | 同上 |
| `MAIL_SENDERS` | var | 届いたメールを読む送り主（封筒の From、「,」区切り）。お店が予約サイトのメールを転送する元。加えて Authentication-Results の SPF か DKIM がそのドメインで pass のときだけ受ける | 全部断る |
| Email Routing の rule | ダッシュボード | 受けるアドレス → この Worker | メールは届かない |
| `SITE_ORIGINS` | var | 予約フォームを置くサイトの origin（「,」区切り） | /api/bookings は 503 |
| `TURNSTILE_SECRET` | secret | Turnstile の秘密の鍵（サイト側にサイトキー）。サイト側の widget は `data-action="booking"`。答えの hostname が SITE_ORIGINS のどれかでないと通さない | 同上 |
| `BOOKING_LIMIT` | ratelimits binding | `{ "name": "BOOKING_LIMIT", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }` | 同上 |
| `BUDGET` | KV binding（今ある物） | AI を呼ぶ 1 日の回数と今月の費用の目安（お店ごと）。サイトの予約とメールの予約の 1 日の件数（各 30 件）は D1 の daily_counts（0006）で数える | AI の読み取りは 503 |
| `SINGLE_SHOP` | var | 1 店で動かすときのお店の id（`default`）。D1 の shops が空・表が無いときに、これを書いた場合だけ 1 店で動く | shops が空なら全部 503（shops-empty・shops-no-table） |
| `ASK_LIMIT` | ratelimits binding | お客さんのリンク（/api/ask）の 1 つの IP の回数。`{ "name": "ASK_LIMIT", "namespace_id": "1002", "simple": { "limit": 30, "period": 60 } }` | /api/ask は 503 |
| Access の Bypass | （使わない） | お客さんの道は Access の無い別の Worker redux-ask（wrangler.ask.jsonc）に分けたので、お店の Worker の Access は触らない | — |
| `SHOP_NAME` | var | 名簿がまだ無いときのお店の名前（送るメールの差出人名） | 空 |

外からの予約の守り（ザクのレビュー 2026-10-27 H-1・M-2・M-5）: サイトからは 1 件 10 人まで・1 日 30 件まで、メールからは 1 日 30 件まで（AI を呼ぶ前に数える）。
名簿が上限（1 MB）の 7 割を超えたら外からは入れず、お店自身の書き込みの分を残す。名前は改行・URL・ドメインらしい字を断る（お客さんへのメールの 1 行目に入るため）。

残る穴（置く前に決めた。1〜3 は済み）:
- 済み: 送ったあとに結果を書けなかった連絡は、もう一度は送らず、30 分後に「送れたか分からない」（failed / maybe-sent）にして画面 10 に出す（worker/auto-core.mjs の releaseStale）
- 済み: 読めなかった予約メールは D1 の mail_unread に残し、画面 10 に出す（「読めなかった予約メール」の節）
- 済み: 済んだ予定（jobs）と送った連絡（outbox）は、済んで 7 日を過ぎた便ごと D1 の roster_past へ移す（plan/server.md「済んだ便を分けて置く」）
- お店の確認を挟む（サイトの予約を別の表に置き、お店が確かめてから名簿へ）はザクの案。今は件数と 7 割の歯止めで代え、試用で困ったら入れる
