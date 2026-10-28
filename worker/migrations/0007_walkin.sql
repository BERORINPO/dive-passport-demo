-- 店頭の QR（来店したお客さんが、その場で名簿の項目を入れる。決定ログ 2026-10-28 walkin-qr）。
-- walkin_keys: お店ごとに鍵は 1 つ（作り直したら前の鍵は開けない）。置くのは鍵の SHA-256 だけで、鍵そのものは置かない
-- （QR にして印刷するとき、スタッフの画面に 1 回だけ出る）。
-- walkin_pending: お客さんが入れた「店頭で入れた人」。名簿の本体には入れず、お店が「入れる」か「入れない」を押すまでここに置く
-- （名前・住所などの個人情報が入るので、押したら消す。expires_on を過ぎた行も Cron が消す。受けてから 2 日）。
-- body は検査と整形を通した JSON（名前・人数・生年月日・住所・緊急時の連絡先・メール）。trip_id は選んだ便（空ならスタッフに聞く）。
-- 1 日に受ける件数は daily_counts（scope = 'walkin'）で数える。
CREATE TABLE IF NOT EXISTS walkin_keys (
  shop TEXT PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS walkin_pending (
  shop TEXT NOT NULL,
  id TEXT NOT NULL,
  trip_id TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_on TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX IF NOT EXISTS walkin_pending_expires ON walkin_pending (expires_on);
