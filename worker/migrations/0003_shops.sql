-- お店の一覧（何店でも扱える作り。plan/server.md「お店ごと」）。1 お店 1 行。名簿（rosters.shop）と鍵（ask_links.shop）の shop はこの id。
-- members: Access でログインするスタッフのメール（JSON の配列、小文字）。sites: 予約フォームを置くサイトの origin（JSON の配列）。
-- inbox: 予約メールを転送してもらう受け口のアドレス（ドメインを置いたあと）。senders: そのお店の予約メールを転送してくる送り主（JSON の配列）。
-- この表が空のあいだは、今までどおり 1 店（default）で動く
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]',
  sites TEXT NOT NULL DEFAULT '[]',
  inbox TEXT NOT NULL DEFAULT '',
  senders TEXT NOT NULL DEFAULT '[]'
);
