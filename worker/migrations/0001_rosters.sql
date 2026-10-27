-- お店の名簿（plan/server.md）。1 お店 1 行。state はサーバーが確かめて直した後の名簿の JSON
CREATE TABLE IF NOT EXISTS rosters (
  shop TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
