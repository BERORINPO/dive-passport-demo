-- お客さんのリンク（plan/meibo.md「お客さんのリンク」）。鍵そのものは置かず、SHA-256 だけを置く。
-- person_id が空なら予約 1 件のリンク（健康以外を入れる）、入っていればその人だけのリンク（健康の答え）。
-- 同じ予約・同じ人のリンクを作り直したら、前の行を消す（古い鍵を止める）。day と uses は 1 日に受けた回数
CREATE TABLE IF NOT EXISTS ask_links (
  hash TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  person_id TEXT NOT NULL DEFAULT '',
  expires_on TEXT NOT NULL,
  created_at TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ask_links_target ON ask_links (shop, booking_id, person_id);
