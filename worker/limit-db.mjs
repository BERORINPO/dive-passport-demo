/* 1 日の回数の上限（adapter、D1）。サイトの予約・届いた予約メール・読めなかったメールの記録を、お店ごとに正確に数える。
   表は worker/migrations/0006_daily_counts.sql。数え方は ask-db.mjs の useLink と同じ「上限未満のときだけ 1 足す」1 文
   （INSERT … ON CONFLICT DO UPDATE SET n = n + 1 WHERE n < 上限）。1 文で原子的なので、同じ秒に続けて届いても数え漏れず、断りも出ない
   （KV は同じキーへ 1 秒に 1 回しか書けず、続けて届いた予約が「上限」として落ちた。2026-10-28 shops-fail-closed、正確さの点検 M3）。
   D1 が答えないときは例外にする（「上限に届いた」と見分けるため。呼ぶ側が断る）。見本は fakeD1 */

/* 全店あわせた数の行に使うお店の名前（SHOP_ID の形には合わないので、お店の id とはぶつからない） */
export const ALL_SHOPS = '*';

/* scope（'site' | 'mail' | 'unread'）・お店・日の 1 回分を取る。上限に届いていたら false（数えない） */
export async function takeDaily(db, { scope, shop, day, max }) {
  if (!(max >= 1)) return false;
  const r = await db.prepare('INSERT INTO daily_counts (scope, shop, day, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(scope, shop, day) DO UPDATE SET n = n + 1 WHERE n < ?4')
    .bind(scope, shop, day, max).run();
  return Boolean(r && r.meta && Number(r.meta.changes) === 1);
}

/* お店ごとの数と、全店あわせた数の両方に空きがあるときだけ通す。お店ごとを先に数える
   （上限に届いたお店が、ほかのお店の分の全店枠を使わない。全店枠で断られたときも、そのお店の 1 回分は数えたまま） */
export async function takeDailyAll(db, { scope, shop, day, max, maxAll }) {
  if (!(await takeDaily(db, { scope, shop, day, max }))) return false;
  return takeDaily(db, { scope, shop: ALL_SHOPS, day, max: maxAll });
}

/* 前の日までの行を消す（Cron） */
export async function dropOldCounts(db, today) {
  await db.prepare('DELETE FROM daily_counts WHERE day < ?1').bind(today).run();
}
