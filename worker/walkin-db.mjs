/* 店頭の QR の鍵と、店頭で入れた人（adapter。D1）。表は worker/migrations/0007_walkin.sql。お店の Worker だけが読み書きする（redux-ask は D1 を持たない）。
   鍵は SHA-256 だけを置く（鍵そのものは ask-key.mjs の newKey が作り、QR にして印刷するときに 1 回だけ画面に出る）。
   店頭で入れた人の body は名前・住所などの個人情報なので、名簿の本体には入れず、押したら消す（dropWalkin）・期限を過ぎたら消す（dropExpiredWalkins、Cron）。
   見本は worker/fakes.mjs の fakeD1（同じ文を読む）。決まりは spec/architecture.md の決定ログ 2026-10-28 walkin-qr */

/* お店の鍵を置く（作り直したら前の鍵は上書きされ、開けなくなる） */
export async function putWalkinKey(db, { shop, hash, at }) {
  await db.prepare('INSERT INTO walkin_keys (shop, hash, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(shop) DO UPDATE SET hash = ?2, created_at = ?3')
    .bind(shop, hash, at).run();
}

/* 鍵の SHA-256 から、そのお店の id。無ければ ''（作り直して前の鍵になったものも '' ） */
export async function findWalkinShop(db, hash) {
  const row = await db.prepare('SELECT shop FROM walkin_keys WHERE hash = ?1').bind(hash).first();
  return row ? String(row.shop) : '';
}

/* そのお店の鍵を作った時刻。まだ作っていなければ '' */
export async function walkinKeyAt(db, shop) {
  const row = await db.prepare('SELECT created_at FROM walkin_keys WHERE shop = ?1').bind(shop).first();
  return row ? String(row.created_at) : '';
}

export async function addWalkin(db, { shop, id, tripId, body, at, expiresOn }) {
  await db.prepare('INSERT INTO walkin_pending (shop, id, trip_id, body, created_at, expires_on) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(shop, id, tripId, body, at, expiresOn).run();
}

/* 期限が切れていない行を、古い順に。body は JSON の文字のまま（形は呼ぶ側が確かめ直す） */
export async function listWalkins(db, shop, today, limit) {
  const { results } = await db.prepare('SELECT id, trip_id, body, created_at FROM walkin_pending WHERE shop = ?1 AND expires_on >= ?2 ORDER BY created_at LIMIT ?3')
    .bind(shop, today, limit).all();
  return results.map(r => ({ id: String(r.id), tripId: String(r.trip_id), body: String(r.body), at: String(r.created_at) }));
}

/* 「入れた」「入れない」を押した行を消す。消せた（行があった）ら true */
export async function dropWalkin(db, shop, id) {
  const r = await db.prepare('DELETE FROM walkin_pending WHERE shop = ?1 AND id = ?2').bind(shop, id).run();
  return Boolean(r && r.meta && Number(r.meta.changes) === 1);
}

/* 期限を過ぎた行を消す（Cron） */
export async function dropExpiredWalkins(db, today) {
  await db.prepare('DELETE FROM walkin_pending WHERE expires_on < ?1').bind(today).run();
}
