-- 読めなかった予約メール（plan/auto.md の「読めなかった予約メール」。ジンのレビュー 2026-10-27 HIGH 6）。
-- 送り主の確かめを通ったお店のメールを、名簿に入れられなかったときに 1 行。残すのは届いた時刻と理由の短い言葉だけ（件名・本文・送り主は残さない）。
-- お店が画面で「済んだ」を押すと消す。30 日を過ぎた行は、次に行を足すときに消す
CREATE TABLE IF NOT EXISTS mail_unread (
  shop TEXT NOT NULL,
  id TEXT NOT NULL,
  at TEXT NOT NULL,
  why TEXT NOT NULL,
  PRIMARY KEY (shop, id)
);
CREATE INDEX IF NOT EXISTS mail_unread_at ON mail_unread (shop, at);
