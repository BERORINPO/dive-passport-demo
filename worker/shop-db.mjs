/* お店の一覧を D1 から読む（adapter）。表は worker/migrations/0003_shops.sql。足すのは今は D1 のコンソールか wrangler で（画面は後で）。
   一覧が使えないときは、開いた側（全員が 1 店の名簿を共有する）に倒さず、例外にする（2026-10-28 shops-fail-closed）:
   - 行の形が 1 つでも合わない・2 店が同じ受け口／メール／サイトを持つ（shops-malformed・shops-dup-inbox・shops-dup-member・shops-dup-site）。
     形の合わない行を捨てて一覧が空になると、全員が 1 店の名簿を共有してしまう（ザクのレビュー 2026-10-27）
   - 行が 0 件・表が無い（shops-empty・shops-no-table）。ただし env の SINGLE_SHOP でお店の id を明示したときだけは、その 1 店で動く（行があれば行が先）
   - D1 そのものが読めない（そのままの例外。呼ぶ側は shopsWhy で 'db' と見分ける）
   例外の message は短い理由の名前だけ（行の中身は入れない。ログにはこの名前を出す）。見本は fakeD1 */
import { shopsFromRows, shopsProblem, singleShop } from './shop-core.mjs';

const fail = (why) => new Error(`shops-${why}`);

/* 呼んだ側のログに出す理由。一覧の問題なら shops-… の名前、それ以外（D1 の不調など）は other */
export const shopsWhy = (e, other) => (e && /^shops-[a-z-]{1,20}$/.test(String(e.message)) ? e.message : other);

export async function listShops(db, env = {}) {
  let rows;
  let noTable = false;
  try {
    const r = await db.prepare('SELECT id, name, members, sites, inbox, senders, reply_to FROM shops').all();
    rows = (r && r.results) || [];
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
    rows = [];
    noTable = true;
  }
  const shops = shopsFromRows(rows);
  if (shops.length !== rows.length) throw fail('malformed');
  const problem = shopsProblem(shops);
  if (problem) throw fail(`dup-${problem}`);
  if (shops.length) return shops;
  const one = singleShop(env.SINGLE_SHOP, { siteOrigins: env.SITE_ORIGINS, mailSenders: env.MAIL_SENDERS });
  if (!one) throw fail(noTable ? 'no-table' : 'empty');
  return [one];
}

/* 名簿があるお店（Cron が回る先） */
export async function rosterShops(db) {
  const r = await db.prepare('SELECT shop FROM rosters').all();
  return ((r && r.results) || []).map(x => String(x.shop));
}
