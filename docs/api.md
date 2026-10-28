# 予約を REDUX に送る API（予約の受け口）

お店のウェブサイト、WordPress（Contact Form 7）、Zapier / Make、ほかの予約システムが、**予約 1 件ずつを REDUX に送る**ための口です。
送られた予約は、スタッフの「予約」の画面に出て、名簿の下書きになります。メールアドレスがあれば、次の自動送信（15 分ごと）で、お客さんに「名簿の入力のお願い」が届きます。

- 予約サイト（じゃらん・アソビュー など）の予約は、この API ではなく、**予約メールの転送**で入ります（予約サイトに外から送る口が無いため）。この API は、お店が自分で持っているサイトやシステム向けです。
- English: see [English section](#english) below.

## 1. はじめかた（約 5 分）

1. REDUX の画面で「予約」を開き、「別のシステムから予約を受ける（API キー）」を押す
2. 「連携先の名前」（例: 公式サイト）を入れて「API キーを作る」を押す
3. 出てきた **鍵（`rdx_` で始まる 47 字）を写す**。**この鍵が出るのは、作った 1 回だけ**です（REDUX には鍵そのものを残していません。忘れたら「作り直す」で新しい鍵を作ります）
4. 鍵を、予約を送る側の設定（WordPress のサーバー、Zapier など）に貼る
5. 下の curl で 1 件送って、「予約」の画面に出るか確かめる

連携先ごとに鍵を 1 本ずつ作ってください（1 つのお店に 10 本まで）。1 本だけ止めたいときに、ほかの連携が止まりません。

**鍵は、ウェブページの中（ブラウザで見える所）には書かないでください。** 見えた人は、あなたのお店の名前で予約を入れられます。ブラウザから送った要求（`Origin` ヘッダーが付くもの）は、鍵が正しくても 403 で断ります。送るのは、必ずサーバー側（WordPress の PHP、Zapier など）からです。

## 2. 送り先

```
POST https://ask.reduxdive.com/api/v1/bookings
```

画面の鍵の作成直後にも、送り先が出ます。

| ヘッダー | 値 |
|---|---|
| `Authorization` | `Bearer <鍵>`（必須） |
| `Content-Type` | `application/json`（必須） |
| `Idempotency-Key` | 同じ予約を 2 回送ってしまっても 1 件にするための印（付けると安心。5 節） |

本文は JSON です。4 KB（約 4,000 バイト）まで。

## 3. 送る項目

| 項目 | 必須 | 中身 |
|---|---|---|
| `date` | 必須 | 潜る日。`2026-11-03` の形。今日（日本の日付）から約 1 年先まで |
| `start` | 任意 | 開始時刻。`08:30` の形（24 時間）。空でもよい。同じ日・同じ時刻・同じ種類の便があれば、そこにまとまる |
| `tour` | 必須 | ツアーの名前（文字、80 字まで）。「スノーケル」と読める名前は、スノーケルの便になる。それ以外はダイビング |
| `people` | 必須 | 人数（1〜30）。`"2"` のように文字で送ってもよい |
| `lead_name` | 必須 | 代表者の名前（60 字まで）。改行・URL・ドメインらしい字は受けない |
| `lead_email` | 任意 | 代表者のメール。あれば、お客さんに名簿の入力のお願いが届く |
| `lead_phone` | 任意 | 代表者の電話（数字と `+` `-` `(` `)` と空白、30 字まで） |
| `lang` | 任意 | お客さんへの連絡の言語。`ja` `en` `ko` `zh`（空なら `ja`） |
| `note` | 任意 | メモ（400 字まで）。名簿に残るだけで、AI には送りません。健康のことを書いた行は、入れる前に外します |
| `external_id` | 任意 | 送る側の予約番号（空白を含まない半角の英数字と記号、60 字まで）。予約に残る。`Idempotency-Key` が無いときは、これで 2 回目を見分ける |

- **健康に関する項目は受けません。** 上の表にない項目を付けると、400 になり、その項目の名前が返ります（黙って捨てて、あとで消えたことに気づかない、を防ぐため）
- 空の項目（`""` や `null`）は「無い」と見なします（WordPress や Zapier は、空の欄を空の文字で送るため）
- 名簿に入る名前・電話の検査は、お店のサイトの予約フォームと同じです

## 4. 返事

| 状態 | 本文 | 意味・することは |
|---|---|---|
| 201 | `{"ok":true,"booking_id":"…"}` | 予約が入った。`booking_id` は REDUX の予約の番号 |
| 200 | `{"ok":true,"booking_id":"…","replayed":true}` | 同じ予約をすでに受けていた（5 節）。1 回目の結果。新しい予約は入っていない |
| 400 | `{"error":"input","fields":["date","lead_name"]}` | 項目の誤り。`fields` が、直す項目の名前。`{"error":"json"}` は JSON が壊れている |
| 401 | `{"error":"auth"}` | 鍵が無い・違う・作り直して古い・止めてある（どれかは区別して返しません） |
| 403 | `{"error":"origin"}` | ブラウザから送っている。サーバー側から送ってください |
| 413 / 415 | `{"error":"size"}` / `{"error":"type"}` | 本文が 4 KB を超えた / `Content-Type` が JSON でない |
| 429 | `{"error":"limit"}` | 回数の上限（6 節）。しばらく待つか、翌日（日本の 0 時）に送る |
| 503 | `{"error":"busy"}` ほか | 一時的に受けられない。**同じ `Idempotency-Key` のまま、少し待って送り直してよい**（`busy` は、同じ予約をいま入れている最中） |

400・401・403 は、送り直しても同じなので、直してから送ってください。429・503 だけが、送り直しで通る可能性があります。

## 5. 同じ予約を 2 回送っても 1 件にする（Idempotency-Key）

通信が切れたときなど、送った予約が入ったかどうか分からないことがあります。そこで同じ予約には**同じ `Idempotency-Key`** を付けて送り直すと、2 回目は予約を増やさず、1 回目の結果（200）を返します。

- 値は、予約ごとに一意な文字（予約番号、フォームの送信 ID、UUID など。半角の記号と英数字、128 字まで）
- 付けなければ `external_id` で見分けます。どちらも無ければ、毎回新しい予約になります
- 覚えておく期間は **7 日**。鍵ごとに別に覚えます（別の連携の同じ番号とは混ざりません）
- 項目の誤り（400）や回数の上限（429）で断られた要求は覚えません。直して、同じ印のまま送り直せます

## 6. 回数と大きさの上限

| 上限 | 値 |
|---|---|
| 1 つの IP から | 1 分に 60 回 |
| 1 本の鍵で受ける予約 | 1 日（日本の日付）に 100 件 |
| 本文 | 4 KB |
| 1 つのお店の鍵 | 10 本まで（止めた鍵は数えません） |
| 名簿 | 名簿が大きくなりすぎたら（上限の約 7 割）、外からは受けない（503 `full`）。スタッフが古い便を片づける |

## 7. まず curl で試す

鍵を入れて、そのまま貼れます（日付は先の日にしてください）。

```bash
curl -i https://ask.reduxdive.com/api/v1/bookings \
  -H "Authorization: Bearer rdx_ここに鍵" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: curl-test-001" \
  -d '{
    "date": "2026-11-20",
    "start": "08:30",
    "tour": "体験ダイビング（ボート・2 本）",
    "people": 2,
    "lead_name": "見本 花子",
    "lead_email": "hanako@example.com",
    "lead_phone": "090-0000-0000",
    "lang": "ja",
    "note": "船酔いしやすいです",
    "external_id": "curl-test-001"
  }'
```

`201` と `{"ok":true,"booking_id":"…"}` が返れば成功です。もう一度同じコマンドを打つと `200` と `"replayed":true` になり、予約は増えません。試した予約は、スタッフが予約の画面から「取り消す」で消せます。

## 8. WordPress（Contact Form 7）

予約フォームの送信を、サーバーから REDUX に送ります。方法は 2 つあります。

### 方法 A: CF7 to Webhook（プラグイン）

プラグインの設定画面の名前は版によって違います。次の 4 つが設定できることを確かめてください。

1. 送り先（URL）: `https://ask.reduxdive.com/api/v1/bookings`
2. 送り方: POST、**JSON で送る**（「Send as JSON」のような選択）
3. 追加のヘッダー: `Authorization` = `Bearer <鍵>`
4. 項目の対応（フォームの欄の名前 → REDUX の項目）

項目の対応の例（左は、フォームで付けた欄の名前の例です。自分のフォームの名前に読みかえます）:

| フォームの欄 | → REDUX の項目 |
|---|---|
| `your-date`（日付） | `date` |
| `your-time`（時刻。任意） | `start` |
| `your-tour`（選択） | `tour` |
| `your-people`（人数） | `people` |
| `your-name` | `lead_name` |
| `your-email` | `lead_email` |
| `your-tel` | `lead_phone` |
| `your-message` | `note` |

対応にない欄（同意のチェック、送信日時など）を一緒に送る設定のままだと、400 `fields` にその欄の名前が出ます。送る欄を、上の対応だけに絞ってください。**ヘッダーを足せないプラグイン、欄を絞れないプラグインは、方法 B か Zapier を使ってください。**

### 方法 B: 数行の PHP（プラグインなし）

テーマの `functions.php`（または自作のプラグイン）に貼ります。鍵は `wp-config.php` に書き、テーマのファイルには書きません。

```php
// wp-config.php に（鍵はここだけ）
define('REDUX_API_KEY', 'rdx_ここに鍵');
```

```php
// functions.php に
add_action('wpcf7_mail_sent', function ($contact_form) {
    $submission = WPCF7_Submission::get_instance();
    if (!$submission) { return; }
    $d = $submission->get_posted_data();
    $v = function ($name) use ($d) {
        $x = isset($d[$name]) ? $d[$name] : '';
        return is_array($x) ? reset($x) : $x;   // 選択肢の欄は配列で来ることがある
    };
    $id = 'cf7-' . wp_generate_uuid4();         // この送信に 1 つ。送り直しても同じ印にする
    $response = wp_remote_post('https://ask.reduxdive.com/api/v1/bookings', array(
        'timeout' => 10,
        'headers' => array(
            'Authorization'   => 'Bearer ' . REDUX_API_KEY,
            'Content-Type'    => 'application/json',
            'Idempotency-Key' => $id,
        ),
        'body' => wp_json_encode(array(
            'date'        => $v('your-date'),
            'start'       => $v('your-time'),
            'tour'        => $v('your-tour'),
            'people'      => $v('your-people'),
            'lead_name'   => $v('your-name'),
            'lead_email'  => $v('your-email'),
            'lead_phone'  => $v('your-tel'),
            'note'        => $v('your-message'),
            'external_id' => $id,
        )),
    ));
    if (is_wp_error($response) || wp_remote_retrieve_response_code($response) >= 300) {
        error_log('REDUX booking not sent: ' . (is_wp_error($response) ? $response->get_error_message() : wp_remote_retrieve_body($response)));
    }
});
```

送れなかったときは、サイトのエラーログに REDUX の返事（`fields` など）が残ります。フォームのお客さんには何も出ません（予約の問い合わせメールは、今までどおり届きます）。

## 9. Zapier（Webhooks by Zapier → POST）

1. トリガーを選ぶ（例: Google フォーム、Typeform、ほかの予約ツールの「新しい予約」）
2. アクションに **Webhooks by Zapier** の **POST** を選ぶ
3. 次のように入れる:

| Zapier の欄 | 入れる値 |
|---|---|
| URL | `https://ask.reduxdive.com/api/v1/bookings` |
| Payload Type | `Json` |
| Data | 左に REDUX の項目名、右にトリガーの欄を選ぶ（下の表） |
| Headers | `Authorization` ＝ `Bearer <鍵>`、`Idempotency-Key` ＝ トリガーの「一意な ID」の欄（例: 回答の ID） |
| Wrap Request In Array / Unflatten | 使わない（空のまま） |

Data の対応:

| 左（キー） | 右（トリガーの欄） |
|---|---|
| `date` | 潜る日（`YYYY-MM-DD` の形にしておく。形を変える必要があれば Zapier の「Formatter → Date/Time」を挟む） |
| `tour` | ツアーの名前 |
| `people` | 人数 |
| `lead_name` | 代表者の名前 |
| `lead_email` | メール |
| `lead_phone` | 電話（任意） |
| `start` / `note` | 開始時刻 / メモ（任意） |

人数や空の欄が文字で送られても大丈夫です。テストを実行して `201` が返り、「予約」の画面に出れば完了です。Make（旧 Integromat）は、HTTP モジュールの「Make a request」で、同じ URL・ヘッダー・JSON の本文を設定します。

## 10. 鍵の管理

- **作り直す**: 同じ連携先のまま、新しい鍵に替えます。前の鍵は**その場で使えなくなる**ので、先に新しい鍵を連携先に貼る準備をしてから押してください
- **止める**: その鍵で送った予約は、もう届きません（元に戻せません。必要なら新しい鍵を作ります）
- 鍵が見えてしまった可能性があるとき（ログ・チャット・スクリーンショットに写ったなど）は、すぐに作り直すか止める
- 画面の「予約サイト」の欄には、連携先の名前が出ます。どの連携から入った予約か分かります

---

<a id="english"></a>

# English: Inbound booking API

A server-to-server endpoint for pushing bookings into REDUX from a shop's own website, WordPress (Contact Form 7), Zapier / Make, or another system. Marketplace sites (Jalan, Asoview, …) have no supplier API, so those bookings still arrive by forwarded email; this API is for systems the shop controls.

## Get a key

In the REDUX staff screen open "Bookings" → "API キー" → name the integration → create. The key (`rdx_…`, 47 characters) is shown **once**; only its SHA-256 is stored. Create one key per integration (up to 10 per shop). Rotate = new key, the old one stops immediately. Revoke = stop for good. **Never put a key in a web page**: requests carrying a browser `Origin` (or `Sec-Fetch-Site`) header are rejected with 403, and there is no CORS.

## Endpoint

```
POST https://ask.reduxdive.com/api/v1/bookings
Authorization: Bearer rdx_<key>
Content-Type: application/json
Idempotency-Key: <unique string, optional but recommended>
```

Body (JSON, max 4 KB). Unknown fields are rejected with 400 (health data is never accepted); `""` and `null` count as "not given"; `people` may be a number or a numeric string.

| Field | Required | Notes |
|---|---|---|
| `date` | yes | `YYYY-MM-DD`, today (Japan date) up to ~1 year ahead |
| `start` | no | `HH:MM` (24 h). Bookings with the same date, kind and start time share a trip |
| `tour` | yes | Free text, up to 80 chars. A name containing "snorkel" makes a snorkel trip, otherwise diving |
| `people` | yes | 1–30 |
| `lead_name` | yes | Up to 60 chars; no newlines, URLs or domain-like text (same rule as the site booking form) |
| `lead_email` | no | If present, the guest gets the roster request email on the next 15-minute run |
| `lead_phone` | no | Digits, `+ - ( )` and spaces, up to 30 chars |
| `lang` | no | `ja` `en` `ko` `zh` (default `ja`) |
| `note` | no | Up to 400 chars. Stored on the booking only, never sent to AI; lines that look like health information are removed |
| `external_id` | no | Your booking number (printable ASCII, no spaces, up to 60). Stored on the booking; used for de-duplication when `Idempotency-Key` is absent |

## Responses

| Status | Body | Meaning |
|---|---|---|
| 201 | `{"ok":true,"booking_id":"…"}` | Booking created |
| 200 | `{"ok":true,"booking_id":"…","replayed":true}` | Same `Idempotency-Key` (or `external_id`) seen within 7 days: the first result, no new booking |
| 400 | `{"error":"input","fields":[…]}` / `{"error":"json"}` | Fix the listed fields; do not retry unchanged |
| 401 | `{"error":"auth"}` | Missing, malformed, unknown, rotated-out or revoked key (not distinguished) |
| 403 | `{"error":"origin"}` | Sent from a browser |
| 413 / 415 | `size` / `type` | Body over 4 KB / not `application/json` |
| 429 | `{"error":"limit"}` | Rate or daily limit |
| 503 | `busy`, `db`, `shops`, `config`, `full` | Temporary. Retry later **with the same `Idempotency-Key`** |

## Idempotency

Send the same `Idempotency-Key` when you retry. Keys are remembered for 7 days, per API key. Requests rejected with 400 or 429 are not remembered, so you can fix them and resend under the same key.

## Limits

60 requests / minute / IP; 100 bookings / day / key (Japan date); 4 KB body; 10 keys / shop; external submissions are refused (503 `full`) when the shop's roster is about 70% of its size limit.

## Quick test

```bash
curl -i https://ask.reduxdive.com/api/v1/bookings \
  -H "Authorization: Bearer rdx_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: curl-test-001" \
  -d '{"date":"2026-11-20","start":"08:30","tour":"Boat diving (2 dives)","people":2,"lead_name":"Hanako Sample","lead_email":"hanako@example.com","lang":"en","external_id":"curl-test-001"}'
```

## WordPress and Zapier

- **Contact Form 7**: either a webhook plugin that can POST JSON with a custom `Authorization` header (map your form fields to the names above and send only those fields), or the short `wpcf7_mail_sent` PHP hook shown in section 8 above (keep the key in `wp-config.php`).
- **Zapier**: "Webhooks by Zapier" → POST, Payload Type `Json`, URL as above, Data = the field names above mapped from your trigger, Headers `Authorization: Bearer <key>` and `Idempotency-Key: <a unique ID from the trigger>`. Make: HTTP "Make a request" with the same URL, headers and JSON body.
