/* お店の名簿を Cloudflare D1 に読み書きする（adapter）。表の形は worker/migrations/0001_rosters.sql と 0004_roster_past.sql、決まりは plan/server.md。
   書くときは版の番号で守る: base が 0 なら新しく作り（同じお店が既にあれば書かない）、それ以外は今の版が base のときだけ書き換える。
   済んだ便（past-core.mjs の splitPast が分けた物）は、名簿の本体と同じ batch（1 つの transaction）で書く。済んだ便の行は、版がまだ base の
   ときだけ足す（別の端末が先に書いて名簿の本体を書けなかったときに、済んだ便だけが書かれないように）。
   一度書いた行は上書きしない（DO NOTHING）。同じ便が後から届くのは、古い写しを持った端末からだけなので（past-core.mjs の splitPast）。
   見本は worker/fakes.mjs の fakeD1 */

/* 返すのは { version, text }。まだ無ければ { version: 0, text: null } */
export async function getRoster(db, shop) {
  const row = await db.prepare('SELECT version, state FROM rosters WHERE shop = ?1').bind(shop).first();
  return row ? { version: Number(row.version), text: String(row.state) } : { version: 0, text: null };
}

const WRITE_NEW = 'INSERT INTO rosters (shop, version, state, updated_at) VALUES (?1, 1, ?2, ?3) ON CONFLICT(shop) DO NOTHING';
const WRITE_NEXT = 'UPDATE rosters SET version = version + 1, state = ?2, updated_at = ?3 WHERE shop = ?1 AND version = ?4';
/* parts は [{ part, day, keepUntil, body }] の JSON。json_each で 1 文にまとめる（1 回の呼び出しで使える文の数に上限があるため） */
const ADD_PAST = `INSERT INTO roster_past (shop, part, day, keep_until, body, moved_at)
  SELECT ?1, json_extract(value, '$.part'), json_extract(value, '$.day'), json_extract(value, '$.keepUntil'), json_extract(value, '$.body'), ?3
  FROM json_each(?2) WHERE COALESCE((SELECT version FROM rosters WHERE shop = ?1), 0) = ?4
  ON CONFLICT(shop, part) DO NOTHING`;
/* 1 年を過ぎた済んだ便を消す（名簿の本体と同じ。済んだ便を足すときに一緒に。Cron が動けば Cron でも） */
const DROP_PAST = 'DELETE FROM roster_past WHERE shop = ?1 AND keep_until < ?2';

/* 書けたら { ok: true, version }。版が合わない（別の端末が先に書いた）ときは { ok: false }。today は 1 年を過ぎた済んだ便を消す日 */
export async function putRoster(db, shop, base, text, at, { parts = [], today = '' } = {}) {
  const write = base === 0 ? db.prepare(WRITE_NEW).bind(shop, text, at) : db.prepare(WRITE_NEXT).bind(shop, text, at, base);
  let result;
  if (parts.length) {
    const results = await db.batch([
      db.prepare(ADD_PAST).bind(shop, JSON.stringify(parts), at, base),
      db.prepare(DROP_PAST).bind(shop, today),
      write
    ]);
    result = results[results.length - 1];
  } else {
    result = await write.run();
  }
  const changed = result && result.meta ? Number(result.meta.changes) : 0;
  return changed === 1 ? { ok: true, version: base + 1 } : { ok: false };
}

/* 済んだ便を日付の範囲（from〜to、YYYY-MM-DD）で読む。1 年を過ぎた行は渡さない。返すのは [{ part, day, body }] */
export async function getPast(db, shop, from, to, today, limit) {
  const got = await db.prepare('SELECT part, day, body FROM roster_past WHERE shop = ?1 AND day >= ?2 AND day <= ?3 AND keep_until >= ?4 ORDER BY day, part LIMIT ?5')
    .bind(shop, from, to, today, limit).all();
  return (got && got.results ? got.results : []).map(r => ({ part: String(r.part), day: String(r.day), body: String(r.body) }));
}
