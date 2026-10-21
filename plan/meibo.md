# 予約と名簿の試作 計画（2026-10-21、周 1。Cloudflare Worker + Access）

置き場所: `C:\dev\dive-passport-demo` の新しいブランチ（main から切る。3D のリドの PR #4 とは別）。merge の前に手元で見せる。

## 目的
11/9 の中間発表で、スマホ 1 台で次を通して見せる。
予約が入る → 名簿が埋まる（AI が読む・お客さんが足りない所だけ入れる）→ 条例の名簿を印刷 → 乗り合い便で他のお店のお客さんと合わせる → 札で帰船を確かめる

## 作る画面（全部で 14）
| まとまり | 画面 | モック |
|---|---|---|
| 予約 | 予約の一覧 / 予約サイトのメールを取り込む / 電話などの予約を足す | 新 A・新 B（今日足した）。電話の予約は新 B の手入力版 |
| 名簿 | ① 取り込み（申込書・C カードを撮る）/ ② 読み取りを確かめる / ⑤ 今日の名簿 / ⑥ 条例の名簿（印刷・PDF・CSV）/ ⑦ 保存と記録 | 名簿のキャンバス |
| お客さん | ③ 足りない所だけ / ④ 当日の体調 / パスポートから入れる | 名簿のキャンバス、パスポートは今の試作にある |
| 乗り合い | 便を作る / 他のお店のお客さんを入れる / 合同名簿 / 札ボード / ポイントを離れる前 | 乗り合いのキャンバス |

## 構成
```
[スマホのブラウザ]                                                [手元の PC]
 entry   index.html・app.js（画面の切り替えと部品のつなぎだけ）
   │
 画面    予約 / 取り込み / 確かめる / 名簿 / 乗り合い / お客さん / パスポート（今ある）
   │ 使う
 core    名簿のそろい具合（13 項目・スノーケル 11 項目）・足りない項目・CSV・印刷の中身・
         記録（追記だけ）・1 年の保存・合同名簿の合わせ方・札の数え方      ← 外のもの（保存・通信・画面）を知らない
   │ 使う
 shared  予約・人・便・記録の形と検査（pass-schema.js と同じ書き方）
 adapter 保存（localStorage）/ 健康欄の塗りつぶし（canvas）/
         AI の読み取り: 本物 ⇄ 見本（見本は試験の答えを返す。公開版と発表の予備）
   │ 本物のときだけ（同じ場所の /api。別のドメインにしないので CORS と Cookie の穴が出ない）
   └─ fetch ─▶ [Cloudflare Worker] ─▶ Claude API（Haiku）
               画面のファイルも同じ Worker から配る（Static Assets、無料）
               入口: Cloudflare Access（Worker 全体、チームのメールだけ）+ 合言葉 + 1 日の回数の上限
               鍵: この Worker 専用の API キー（Worker の secret。コードと画面には置かない）
               お金: 今月の上限を KV で数える。超えたら「見本の読み取り」に切り替わる
               記録: 回数と費用だけ。メールや画像の中身は残さない
```

### 読み取りの流れ
- 予約メール: 本文を貼る → server が AI に渡す → 予約（サイト・日時・ツアー・人数・代表者）と、名前が分かる人を返す → 足りない項目をお客さんに聞くリンク
- 申込書: 撮る → **健康の欄を画面の中で塗りつぶしてから** server へ → 人の項目 → 自信なしの所だけ確かめる
- C カード: 撮る → 名前・認定・取得日・本数（あれば）
- 健康の答え（既往症・当日の体調）は、お客さんが自分で選ぶ。AI に渡す中身から、健康の項目を外す決まりをコードとテストの両方で守る

## AI を呼ぶ場所: Cloudflare Worker（2026-10-21 Yosuke 指定で手元のサーバー案から変更）
- 良い所: スマホの通信だけで、どこからでも動く。PC と同じ Wi-Fi が要らない。チームも各自のスマホで試せる
- お金: Workers の無料プラン（1 日 10 万回まで）で収まる。AI の費用は 1 件約 $0.0006（Haiku）
- 入口の守り方（2026-10-21 Yosuke 指定で最初から 2 重）: ① Cloudflare Access を Worker 全体に付け、チームのメールアドレスだけ通す（メールで本人確認、50 人まで無料）② その上で合言葉 ③ 1 日の回数の上限。Worker は Access を通っていない呼び出し（ctx.access が無い）を 403 で断る。Access は Zero Trust の初回設定が要り、そこで支払い方法を求められるかは公式で確かめられなかった。求められたら Yosuke が決める（お金の境界）
- 鍵は分ける: この Worker 専用の API キーを Yosuke が発行し、使える額の上限（例: 月 $10）も Anthropic の画面で付ける。登録（`wrangler secret put`）も Yosuke が打つ。こちらは鍵の値を見ない
- 会場の通信が不安なときのために、画面に「見本の読み取り」へ切り替えるボタンを付ける
- 公開の範囲: 中身は見本データだけ。今の GitHub Pages と同じく検索に出さない（noindex）

乗り合いの「他のお店」は、1 台の中で見本の店（C ダイブ）に切り替えて見せる。2 台のあいだで本当にやりとりするのは後回し。

## 作る順番
| 段 | 中身 | こちらの作業 | できたかの確かめ |
|---|---|---|---|
| P0 契約 | spec/architecture.md・予約/人/便/記録の形・見本の AI・テスト | 半日 | 形の往復テスト（保存して読み戻して同じ） |
| P1 予約 | 予約の一覧・メールの取り込み・電話の予約 | 1 日 | 見本メール 4 通で予約と人が入る |
| P2 読み取り | 申込書（健康欄を塗る）・C カード・確かめる画面 | 1 日 | 送る画像に健康欄が残っていない（テスト）。塗る関数が返す物だけを送れる形にし、写真は全種類を canvas で描き直して送る（位置情報なども消える）。塗る前に紙の向きを直す |
| P3 お客さん | 足りない所だけ・当日の体調・パスポートから | 半日 | 13 項目がそろうと「そろった」になる |
| P4 名簿 | 今日の名簿・条例の名簿（印刷・PDF）・CSV・保存と記録・カレンダーに書き出す（.ics、便ごとに予定 1 件。時刻・ツアー・人数だけで、名前・電話・健康は入れない。約半日） | 1.5 日 | 印刷に 13 項目全部、直したら記録に残る。.ics を Google カレンダー・iPhone に読み込める |
| P5 乗り合い | 便・他店のお客さん・合同名簿・札ボード・離れる前 | 1 日 | 2 店分が 1 枚の名簿になり、札の数が合う |
| P6 本物の AI | Cloudflare Worker（/api・合言葉・上限・/healthz）・発表の台本・通しの確認 | 半日 | 置いたあとの Worker で、見本 16 件の読み取りと上限の止まり方を確かめる。通しを 2 回（本物と見本） |

P6 で Yosuke がやること（約 25 分）: ① Anthropic でこの Worker 専用の API キーを発行し、上限を付ける ② `wrangler login` ③ `wrangler secret put` で鍵と合言葉を入れる ④ Cloudflare の画面で Zero Trust を有効にし、Worker の Access タブで「この Worker を守る」→ 通すメールアドレス（チーム 6 人）を入れる ⑤ 置く（`wrangler deploy`）の最終確認。wrangler を入れる（npm）ときは、こちらから先に聞く

合計 約 5.5 日（こちらの作業）。P0 で形を決めたあと、P1〜P5 は別々の作業場（worktree）で並べて作れるので、1〜2 日縮む見込み。11/9 まで 19 日。

Yosuke の確認は 3 回: ①今（この計画とモック）②P2 のあとに触る（約 15 分）③P6 のあとの通し（約 30 分）

## Worker で守ること（P6。ザクのレビュー 2026-10-21）
- **Access を通ったかは、JWT を自分で確かめる**: `Cf-Access-Jwt-Assertion` を `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` の鍵で、署名・iss・aud・exp・許可したメールかまで見る（crypto.subtle で書ける）。`ctx.access` だけに頼らない。`preview_urls = false`。確かめられなければ断る
- **画面側の検査を Worker でもう一度かける**: roster-schema.js を読み、validateRequest と healthRedact.redact をかける。プロンプト・model・max_tokens は Worker が決める。答えにも fromModel と validateReading をかける。画像はファイルの先頭の印で JPEG / PNG かを見る
- **Anthropic への request は新しく組み立てる**: ヘッダは `x-api-key`・`anthropic-version`・`content-type` だけ（Cookie・JWT・合言葉を送らない）
- **お金の上限はワークスペースで**: この Worker 専用のワークスペースを作って月の上限を付け、鍵はその中で作る（上限は鍵ごとではなくワークスペースごと）
- **KV の数は目安**: 数えるのは呼び出す前。KV が失敗したら断る。合言葉の失敗は書かない。正確にしたければ Durable Object
- **ログに中身を出さない**: 残すのは状態・doc・量・時間だけ。Anthropic のエラー本文は画面に返さない
- **画面のスクリプトと字体を自前で配る**: cdnjs・jsDelivr・Google Fonts の物を Static Assets に置き、CSP を付ける（ザクのレビュー 2026-10-21）
  - index.html: `default-src 'none'; script-src 'self' 'sha256-<importmap の中身の hash>'; style-src 'self'; font-src 'self'; img-src 'self' blob: data:; connect-src 'self' blob:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`
  - pass.html: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`（字体は読まない。GitHub Pages の間も meta で同じ物を付けている）
  - /fonts/ の要求は、path をログに残さない（どの束を取ったかで画面の字が分かる）。長い cache（`immutable`）を付ける
  - importmap は HTML の中のスクリプトなので hash で許す（`<script type="importmap">` と `</script>` の間の文字そのまま。CSP を付けて開くと、Chrome のコンソールに要る `sha256-...` が出る）。blob: は写真と 3D の模様、media-src は亀の声のため
  - CDN を残す間は、サイト名だけで許さずパスまで書き（`https://cdn.jsdelivr.net/npm/three@0.160.0/`）、integrity と組み合わせる。付けたら、コンソールに違反が出ないか、亀・QR・写真・声が動くかを確かめる
- 合言葉は header `x-redux-code` に UTF-8 の base64url で来る。両方を SHA-256 にしてから `crypto.subtle.timingSafeEqual` で比べ、空なら 401
- /api は `application/json` と `Sec-Fetch-Site: same-origin` を必須にし、CORS のヘッダは出さず、OPTIONS は断る
- カレンダーの購読用の URL（`/api/calendar/<長い合言葉>.ics`）。中身は .ics の書き出しと同じ（便の時刻・ツアー・人数だけ）。URL を知る人は誰でも見られるので、合言葉は長くし、作り直せるようにする。Google カレンダーは反映が数時間〜1 日遅れる
- 画面の「本物」は、同じ origin の `/api/healthz` が通ったときだけ選べる（GitHub Pages 版から github.io に本文を送らない）
- Access の許可はメールアドレスを 1 つずつ書く（「@gmail.com」で通さない）。ログインの有効時間は 24 時間
- **お客さんのリンク**（P3 の本物版。ザクのレビュー 2026-10-21）
  - お客さんの画面は pass.html と同じく別の HTML にする（お店の JS とデータの道を読まない。CSP は `connect-src 'self'`）
  - 鍵は `crypto.getRandomValues` で 32 バイトを作り base64url にする（`crypto.randomUUID()` は 122 bit で足りない）。KV / D1 には鍵の SHA-256 だけを置く。鍵が無い・切れた・違うは、どれも同じ 404
  - 鍵は URL の # の後ろに置き、`/api/ask` へは body で送る（path に入れると、Cloudflare の記録・ログ・Referer・履歴に残る）。応答には `Referrer-Policy: no-referrer`・`Cache-Control: no-store`・`X-Robots-Tag: noindex`
  - リンクは便の翌日まで（名簿を残す 1 年とは別）。作り直したら古い鍵を止める。全部そろったら何も見せない
  - 予約 1 件のリンクで受けるのは健康以外の項目だけ。既往症と当日の体調は、1 人ずつのリンクで本人に答えてもらう（子どもは保護者）
  - 聞く項目は Worker が自分の名簿から計算し、guestProblems と guestPatch も Worker でかける（お客さんから来た ask や patch は信じない）。当日の体調は、Worker の日付が便の日のときだけ受ける。デモの「当日として答える」は外し、`aiReader.mode()` でデモかを決める試作の判定も持ち込まない
  - /api/ask に Cloudflare の rate limit を付け、鍵 1 つあたり 1 日に受ける回数にも上限を付ける。`Sec-Fetch-Site: same-origin` と JSON は /api と同じく必須
  - Access を外す道（Bypass）は `/ask` と `/api/ask` だけにする（`/ask*` と書くと `/askadmin` なども外に出る）

## 後回しにするもの
予約サイトとの本当の連携（API）/ Google カレンダーと直接つなぐ（API・OAuth。権限付与なので株主判断。中間発表の後）/ お店ごとの申込書の書式の登録 / 2 台での乗り合いのやりとり / ログイン / 本当の保存先（お店のドライブ）

## まだ当てにならない所
- 本物の手書き（チームの誰かに申込書を手で書いてもらいたい。P2 で試す）
- お店が本当に名簿で困っているか（座間味ダイビング協会の返事、11/6 ごろ）
- 会場の通信（見本の読み取りで逃げられるようにする）
