# 書類の自動化（2026-10-27、周 1）

11/9 の中間発表の柱「書類が勝手に名簿になる」。流れの図は docs/flow/doc-automation.png、モックは v11。
予約が届いてから当日の朝に条例の名簿がそろうまで、お店の人が触るのは「確かめる」と「受付で聞く」だけにする。

## 決めたこと

- **中身は全部 core（js/roster-auto.js）。** 画面（端末だけの試作・GitHub Pages）でも Worker（D1 の名簿）でも同じ関数で動かす。core は時計を使わないので、今の時刻は日本の時刻の文字「YYYY-MM-DDTHH:MM」で受け取る
- **予約に連絡先を持つ。** booking.leadEmail（お願いを送る先）と booking.lang（送る言葉 ja/en/ko/zh）。無い予約もある
- **自動の予定（state.jobs）と送る連絡（state.outbox）を名簿に持つ。** 予約を入れたら予定を作る: お願い（すぐ）・2 日前の 9:00 にもう一度・前日の 20:00 にお店へ知らせる・当日の 6:00 に名簿を作って体調の質問を送る
- **時刻が来た予定を動かす（runDue）。** 足りない項目がもう無ければ飛ばす。送り先が無ければ「送れなかった」と残し、お店に見せる。本文に健康の答えは入れない
- **送るのは Worker だけ。** 画面は送る連絡を「送る準備ができた」まで作る。Worker は時刻で動く仕組み（Cron Triggers、5 分ごと）で runDue をかけ、メールの送信の設定（Cloudflare Email Service の binding）があれば送る。無ければ「メールの設定が無いので送っていない」と残す（独自のドメインと有料の枠が要るので、今は送らない）
- **届いた予約メールは、Worker の email の入口で受ける。** 読んで、便に入れ、予定を作る。受けるには独自のドメインが要るので、今は動かない（画面のデモでは「見本のメールが届いた」で同じ流れを通す）
- **デモ（試作の画面）では時刻を進められる。** 「時刻を進める」で、次の予定の時刻まで進めて runDue をかける

## 予約を受ける口（POST /api/bookings。自社のサイトの予約フォームから）

AquaGate（仲村さんのサイト）の予約フォームから届く予約を受ける。サイトは別の origin なので、Access の外に出す道になる。
**置く前に、ザクのレビューと Yosuke の確認が要る**（plan/server.md の 4 と同じ扱い）。

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

## ファイル

| ファイル | 役割 | 中身 |
|---|---|---|
| js/roster-schema.js | shared | leadEmail・lang・jobs・outbox・trip.rosterAt の形 |
| js/roster-auto.js | core | autoAdd（読み取り・フォームから入れて予定を作る）・planJobs・runDue・markSent・文面 |
| js/booking.js ほか | entry | 自動で入れた印、1 件の流れ、送った連絡、当日の朝、デモの時刻 |
| worker/auto-core.mjs | core | Worker で runDue をかける順番、/api/bookings の検査 |
| worker/mail.mjs | adapter | Cloudflare Email Service で送る（見本 fakeMail） |
| worker/handler.mjs・index.mjs | entry | scheduled（Cron）・email（届いたメール）・POST /api/bookings |
