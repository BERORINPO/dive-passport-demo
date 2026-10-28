-- 1 日の回数の正確な数（worker/limit-db.mjs）。scope は 'site'（サイトの予約）・'mail'（届いた予約メール）・'unread'（読めなかったメールの記録）。
-- shop はお店の id。'*' は全店あわせた数の行。day は日本の日付（YYYY-MM-DD）。Cron が前の日までの行を消す。
-- 数え方は「上限未満のときだけ n に 1 足す」1 文なので、同じ秒に続けて届いても数え漏れない（KV の数は目安で、同じキーへの書き込みは 1 秒に 1 回まで）。
CREATE TABLE IF NOT EXISTS daily_counts (
  scope TEXT NOT NULL,
  shop TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, shop, day)
);

-- 2 店が同じ受け口（予約メールの宛先）を持てないようにする（空の受け口は何店でもよい。コードは小文字にそろえて引くので、そろえた形で一意）。
-- members（JSON の配列の中のメール）と sites は SQL では一意にできないので、worker/shop-db.mjs の listShops が重なりを見て止める
CREATE UNIQUE INDEX IF NOT EXISTS shops_inbox_unique ON shops (lower(trim(inbox))) WHERE trim(inbox) <> '';
