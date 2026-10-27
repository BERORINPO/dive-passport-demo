/* 読めなかった予約メールを Cloudflare D1 に読み書きする（adapter）。表は worker/migrations/0005_mail_unread.sql、決まりは plan/auto.md。
   残すのは届いた時刻と理由の短い言葉だけ。見本は worker/fakes.mjs の fakeD1 */

/* 30 日を過ぎた行を消してから、1 行足す（batch で 1 つの transaction）。同じ id の行が既にあれば足さない（「ほかにもあった」は 1 日 1 行の決まった id） */
export async function addUnread(db, shop, { id, at, why, before }) {
  await db.batch([
    db.prepare('DELETE FROM mail_unread WHERE shop = ?1 AND at < ?2').bind(shop, before),
    db.prepare('INSERT INTO mail_unread (shop, id, at, why) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(shop, id) DO NOTHING').bind(shop, id, at, why)
  ]);
}

/* 新しい順に limit 行。返すのは [{ id, at, why }] */
export async function listUnread(db, shop, before, limit) {
  const got = await db.prepare('SELECT id, at, why FROM mail_unread WHERE shop = ?1 AND at >= ?2 ORDER BY at DESC LIMIT ?3').bind(shop, before, limit).all();
  return (got && got.results ? got.results : []).map(r => ({ id: String(r.id), at: String(r.at), why: String(r.why) }));
}

/* お店が「済んだ」を押した行を消す。消せたら true */
export async function dropUnread(db, shop, id) {
  const r = await db.prepare('DELETE FROM mail_unread WHERE shop = ?1 AND id = ?2').bind(shop, id).run();
  return Number(r && r.meta ? r.meta.changes : 0) === 1;
}
