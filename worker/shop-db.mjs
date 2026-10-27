/* お店の一覧を D1 から読む（adapter）。表は worker/migrations/0003_shops.sql。足すのは今は D1 のコンソールか wrangler で（画面は後で）。
   表がまだ無い D1（0003 を流す前）は、空の一覧として扱う（1 店のまま動く）。それ以外の読めない時は例外にする。
   行があるのに 1 つでも形が合わなければ例外にする（形の合わない行を捨てて一覧が空になると、全員が 1 店の名簿を共有してしまう。ザクのレビュー 2026-10-27）。
   見本は fakeD1 */
import { shopsFromRows } from './shop-core.mjs';

export async function listShops(db) {
  let rows;
  try {
    const r = await db.prepare('SELECT id, name, members, sites, inbox, senders FROM shops').all();
    rows = (r && r.results) || [];
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return [];
    throw e;
  }
  const shops = shopsFromRows(rows);
  if (shops.length !== rows.length) throw new Error('shops: 形の合わない行がある');
  return shops;
}

/* 名簿があるお店（Cron が回る先） */
export async function rosterShops(db) {
  const r = await db.prepare('SELECT shop FROM rosters').all();
  return ((r && r.results) || []).map(x => String(x.shop));
}
