-- 予約の受け口 API（POST /api/v1/bookings。決定ログ 2026-10-28 intake-api）。お店の Worker だけが読み書きする（redux-ask は D1 を持たない）。
-- api_keys: お店が作る API キー。1 つのお店に何本でも作れる（連携先ごとに 1 本）。置くのは鍵の SHA-256 だけで、鍵そのものは置かない
-- （作った 1 回だけスタッフの画面に出る）。label は連携先の名前（予約の「予約サイト」の欄にも出る）。created_at は今の鍵を作った時刻
-- （作り直すと hash と created_at が替わり、id・label・1 日の件数は引き継ぐ）。revoked_at が空でない鍵は使えない（行は残す）。
-- 1 日の件数は daily_counts（scope = 'api'、shop = 鍵の id）で数える。
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS api_keys_shop ON api_keys (shop);

-- api_idempotency: 同じ Idempotency-Key（なければ external_id）の 2 回目に、1 回目の結果を返すための記録。鍵（key_id）ごとに別。
-- idem は送られた文字の SHA-256。booking_id が空の行は「受け付け中」（落ちても 2 分で引き継げる）。7 日を過ぎた行は Cron が消す。
CREATE TABLE IF NOT EXISTS api_idempotency (
  key_id TEXT NOT NULL,
  idem TEXT NOT NULL,
  booking_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (key_id, idem)
);
CREATE INDEX IF NOT EXISTS api_idempotency_created ON api_idempotency (created_at);
