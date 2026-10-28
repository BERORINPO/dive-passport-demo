-- 済んだ便（plan/server.md の「済んだ便を分けて置く」）。済んで 7 日を過ぎた便を、名簿の本体（rosters）から便ごとに 1 行へ移す。
-- part は便の id か 'log:YYYY-MM-DD'（お店全体の記録の 1 日分）。day は便の日。keep_until を過ぎた行は消す（作成の日から 1 年）。
-- body は便・予約・人・予定・送った連絡・その便の記録の JSON（worker/past-core.mjs の splitPast が作る）
CREATE TABLE IF NOT EXISTS roster_past (
  shop TEXT NOT NULL,
  part TEXT NOT NULL,
  day TEXT NOT NULL,
  keep_until TEXT NOT NULL,
  body TEXT NOT NULL,
  moved_at TEXT NOT NULL,
  PRIMARY KEY (shop, part)
);
CREATE INDEX IF NOT EXISTS roster_past_day ON roster_past (shop, day);
