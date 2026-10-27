# 段階 1 の土台: お店の名簿をサーバーに置く（2026-10-27、周 1）

全部を作る計画（B。決定ログ build-all）の段階 1。今の試作は、入れた物がその端末の中（localStorage）だけに残る。
お店の複数の端末と、お客さん・一緒に乗るお店のリンクが、同じ名簿を見られるようにする。

## 決めたこと

- **名簿の正本はサーバー（Cloudflare D1）に置く。** 端末の localStorage は写し（電波が無いときにも開ける）
- **お店の名簿は 1 つの文書として持ち、版の番号で書き込みを守る。** 書く側は「この版を元に直した」（base）を付けて送り、サーバーの版が違えば断って最新を返す（409）。
  画面は、名簿を直す決まり（roster-core.js などの関数）を最新に当て直して送り直す。直す決まりは全部、名簿を受けて新しい名簿を返す関数なので、当て直せる
- **サーバーは画面を信じない。** 受け取った名簿は、画面と同じ js/roster-schema.js で形を確かめ、記録の中身を消し（scrubLog）、保存期間を過ぎた便を消し（purgeExpired）、他のお店のお客さんの健康の答えを外して（holdPartnerHealth）から置く。日付は Worker の時計（日本の日付）
- **入口は今と同じ Cloudflare Access だけ（お店のスタッフ）。** お客さんと一緒に乗るお店のリンク（/ask・/api/ask）は次の一切れで、plan/meibo.md の「お客さんのリンク」「乗り合いの本物の形」のとおりに作る
- **お店は今は 1 つ（shop = default）。** 複数のお店を受けるときに、Access のメールからお店を決める表を足す

## 口（/api/roster。Access 必須・同じ場所からの呼び出しだけ）

| method | 送る物 | 返す物 |
|---|---|---|
| GET | なし | 200 `{ version, state }`（まだ無ければ `version: 0, state: null`） |
| PUT | `{ base, state }`（JSON、1 MB まで） | 200 `{ version, state }`（サーバーが直した後の名簿）/ 409 `{ error: 'conflict', version, state }`（最新）/ 400 形が合わない / 413 大きすぎる |

- 置いてある名簿が形の検査に落ちたら、渡さずに 500（壊れた物を画面に広げない）
- ログは 1 要求 1 行。道・状態・版・大きさだけ（名簿の中身は出さない）

## 保存の形（D1）

```sql
CREATE TABLE rosters (
  shop TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,       -- 名簿の JSON（サーバーが確かめて直した後の物）
  updated_at TEXT NOT NULL
);
```

- base が 0 のときは INSERT（同じお店が既にあれば何もしない = 409）、それ以外は `WHERE version = base` の UPDATE。書けた行が 1 つでなければ 409
- D1 の 1 行は 2 MB まで。名簿は 1 MB で止める（1 年分の予約が入る見込み。超えたら、便ごとに分けて持つ形へ直す）

## ファイル（契約）

| ファイル | 役割 | 中身 |
|---|---|---|
| worker/sync-core.mjs | core | 送られてきた名簿の検査と直し（checkPut）、置いてある名簿の読み直し（readStored）、上限 |
| worker/roster-db.mjs | adapter | D1 の読み書き（getRoster・putRoster）。見本は worker/fakes.mjs の fakeD1 |
| worker/migrations/0001_rosters.sql | — | 上の表を作る |
| worker/handler.mjs | entry | /api/roster の道を足す。DB が無いときは /api/roster だけ 503（今の読み取りは止めない） |
| js/roster-sync.js | adapter | 画面からサーバーへ。GET・PUT と 409 のときの当て直し（次の一切れ） |
| js/core.js | adapter | rosterStore がサーバーの写しを持つ（次の一切れ） |

## 順番

1. サーバー側（この一切れ）: sync-core・roster-db・handler・テスト。D1 はまだ作らない
2. 画面側: roster-sync.js と rosterStore。電波が無いときは端末に貯め、つながったら送る。409 なら当て直す。当て直しても合わないときは、この端末の変更を退避して知らせる
3. D1 を作って Worker に置く（`wrangler d1 create`、無料の枠）。置いた Worker で 2 台の端末から同じ名簿を直して確かめる
4. お客さんのリンク（/ask・/api/ask）と、一緒に乗るお店のリンク。Access の外に出す道なので、置く前にザクのレビューと Yosuke の確認

## まだ決めていないこと

- **名簿が 1 MB を超えたときの分け方（便ごと・月ごと）。** 手元で測ると、見本の乗り合い便（30 人）で 54 KB だった。1 MB は約 550 人分で、1 年に数千人を案内する店には足りない。本物の店で使う前（段階 1 の終わりまで）に、便ごとに分けて持つ形へ直す
- バックアップ（D1 の Time Travel は 30 日。1 年保存の名簿には別の写しが要るか）
- 複数のお店のときの、メールとお店の対応表の置き場所
