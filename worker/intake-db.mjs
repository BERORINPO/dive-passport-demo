/* 予約の受け口 API の API キーと、同じ予約を 2 回入れないための記録（adapter。D1）。表は worker/migrations/0008_api_keys.sql。
   お店の Worker だけが読み書きする（redux-ask は D1 を持たない）。API キーは SHA-256 だけを置く（鍵そのものは ask-key.mjs の newKey が作り、
   スタッフの画面に作った 1 回だけ出る）。Idempotency-Key も SHA-256 にして置く。1 日の件数は daily_counts（limit-db.mjs。scope 'api'）。
   見本は worker/fakes.mjs の fakeD1（同じ文を読む）。決まりは spec/architecture.md の決定ログ 2026-10-28 intake-api */

const PUT_KEY_SQL = `INSERT INTO api_keys (id, shop, hash, label, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`;
const FIND_KEY_SQL = `SELECT id, shop, label FROM api_keys WHERE hash = ?1 AND revoked_at = ''`;
const COUNT_KEYS_SQL = `SELECT COUNT(*) AS n FROM api_keys WHERE shop = ?1 AND revoked_at = ''`;
const LIST_KEYS_SQL = `SELECT id, label, created_at, revoked_at FROM api_keys WHERE shop = ?1 ORDER BY created_at DESC, id LIMIT ?2`;
const ROTATE_KEY_SQL = `UPDATE api_keys SET hash = ?3, created_at = ?4 WHERE shop = ?1 AND id = ?2 AND revoked_at = ''`;
const REVOKE_KEY_SQL = `UPDATE api_keys SET revoked_at = ?3 WHERE shop = ?1 AND id = ?2 AND revoked_at = ''`;
const CLAIM_SQL = `INSERT INTO api_idempotency (key_id, idem, booking_id, created_at) VALUES (?1, ?2, '', ?3)
  ON CONFLICT(key_id, idem) DO UPDATE SET booking_id = '', created_at = ?3 WHERE (booking_id = '' AND created_at < ?4) OR created_at < ?5`;
const READ_IDEM_SQL = `SELECT booking_id FROM api_idempotency WHERE key_id = ?1 AND idem = ?2`;
const FINISH_IDEM_SQL = `UPDATE api_idempotency SET booking_id = ?3 WHERE key_id = ?1 AND idem = ?2 AND booking_id = ''`;
const RELEASE_IDEM_SQL = `DELETE FROM api_idempotency WHERE key_id = ?1 AND idem = ?2 AND booking_id = ''`;
const DROP_OLD_SQL = `DELETE FROM api_idempotency WHERE created_at < ?1`;

const changed = (r) => Boolean(r && r.meta && Number(r.meta.changes) === 1);

/* 鍵を足す。hash が重なったら例外（UNIQUE） */
export async function putApiKey(db, { id, shop, hash, label, at }) {
  await db.prepare(PUT_KEY_SQL).bind(id, shop, hash, label, at).run();
}

/* 使える鍵（止めていない）を SHA-256 から引く。無ければ null */
export async function findApiKey(db, hash) {
  const row = await db.prepare(FIND_KEY_SQL).bind(hash).first();
  return row ? { id: String(row.id), shop: String(row.shop), label: String(row.label) } : null;
}

/* そのお店の使える鍵の数 */
export async function countApiKeys(db, shop) {
  const row = await db.prepare(COUNT_KEYS_SQL).bind(shop).first();
  return row ? Number(row.n) : 0;
}

/* そのお店の鍵（止めた物も）。新しい順。hash は返さない */
export async function listApiKeys(db, shop, limit) {
  const { results } = await db.prepare(LIST_KEYS_SQL).bind(shop, limit).all();
  return results.map(r => ({ id: String(r.id), label: String(r.label), at: String(r.created_at), revokedAt: String(r.revoked_at) }));
}

/* 作り直す: 同じ鍵の id・名前のまま、新しい SHA-256 に替える（前の鍵はこの瞬間に開けなくなる）。止めた鍵・他のお店の鍵・無い鍵は false */
export async function rotateApiKey(db, { shop, id, hash, at }) {
  return changed(await db.prepare(ROTATE_KEY_SQL).bind(shop, id, hash, at).run());
}

/* 止める（行は残す）。止められたら true。もう止めてある・他のお店の鍵・無い鍵は false */
export async function revokeApiKey(db, { shop, id, at }) {
  return changed(await db.prepare(REVOKE_KEY_SQL).bind(shop, id, at).run());
}

/* ---------- 同じ予約を 2 回入れない ---------- */

/* この Idempotency-Key を自分が受け付けると決める（1 文で原子的）。行が無い・7 日を過ぎている・受け付け中のまま staleBefore より古い、のとき true。
   false なら、先に別の要求が受け付けている（readIdem で結果を引く） */
export async function claimIdem(db, { keyId, idem, at, staleBefore, expiredBefore }) {
  return changed(await db.prepare(CLAIM_SQL).bind(keyId, idem, at, staleBefore, expiredBefore).run());
}

/* 受け付けた行の予約の id。行が無ければ null、受け付け中なら '' */
export async function readIdem(db, { keyId, idem }) {
  const row = await db.prepare(READ_IDEM_SQL).bind(keyId, idem).first();
  return row ? String(row.booking_id) : null;
}

/* 予約を入れた。結果（予約の id）を書く */
export async function finishIdem(db, { keyId, idem, bookingId }) {
  await db.prepare(FINISH_IDEM_SQL).bind(keyId, idem, bookingId).run();
}

/* 入れられなかった。同じ鍵でやり直せるよう、受け付け中の行を消す（結果が入った行は消さない） */
export async function releaseIdem(db, { keyId, idem }) {
  await db.prepare(RELEASE_IDEM_SQL).bind(keyId, idem).run();
}

/* 覚えておく日数を過ぎた行を消す（Cron） */
export async function dropOldIdem(db, before) {
  await db.prepare(DROP_OLD_SQL).bind(before).run();
}
