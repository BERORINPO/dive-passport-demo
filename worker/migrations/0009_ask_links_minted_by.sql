-- お客さんのリンクを、だれが作ったか（決定ログ 2026-10-28 unconfirmed-marks）。'staff' はお店（Access の内）か Cron が作った物、'booking' は予約のリンクを
-- 持つお客さんが「この人のリンク」を作った物。AI が読んだ値を見せる・直せるのは 'staff' の鍵だけ（予約のリンクを持つ人が、同行者のリンクを作って値を見ないように）。
-- 'booking' の 1 人ずつのリンクは、健康の答えなど空の項目を入れるだけ。
-- 前からある行は 'staff'。ただし 1 人ずつのリンクは、これまでお客さんが予約のリンクから作る道しか無かったので 'booking' にする
ALTER TABLE ask_links ADD COLUMN minted_by TEXT NOT NULL DEFAULT 'staff';
UPDATE ask_links SET minted_by = 'booking' WHERE person_id <> '';
