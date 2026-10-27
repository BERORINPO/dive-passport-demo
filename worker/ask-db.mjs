/* お客さんのリンクの鍵（adapter）。鍵は 32 バイトの乱数を base64url にし、D1 には鍵の SHA-256 だけを置く（表は worker/migrations/0002_ask_links.sql）。
   決まりは plan/meibo.md「お客さんのリンク」。見本は worker/fakes.mjs の fakeD1（同じ文を読む） */

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* 新しい鍵（43 字）。crypto.randomUUID は 122 bit で足りないので使わない */
export function newKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function keyHash(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/* 鍵を置く。予約のリンク（personId が空）は前の鍵を消す（作り直したら古いリンクは開けない）。
   1 人ずつのリンクは前の鍵を残す（同行者に送ったリンクを、写し直しで止めない。本数は countLinks で絞る。ザクのレビュー 2026-10-27 M-3） */
export async function putLink(db, { hash, shop, bookingId, personId, expiresOn, at }) {
  if (!personId) await db.prepare('DELETE FROM ask_links WHERE shop = ?1 AND booking_id = ?2 AND person_id = ?3').bind(shop, bookingId, personId).run();
  await db.prepare('INSERT INTO ask_links (hash, shop, booking_id, person_id, expires_on, created_at, day, uses) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \'\', 0)')
    .bind(hash, shop, bookingId, personId, expiresOn, at).run();
}

/* 鍵の行。無ければ null */
export async function findLink(db, hash) {
  const row = await db.prepare('SELECT shop, booking_id, person_id, expires_on FROM ask_links WHERE hash = ?1').bind(hash).first();
  return row ? { shop: String(row.shop), bookingId: String(row.booking_id), personId: String(row.person_id), expiresOn: String(row.expires_on) } : null;
}

/* 同じ予約・同じ人の、今ある鍵の数 */
/* 期限が切れた行は数えない（消すのは Cron 頼み。Cron が止まっていても作り直せるように。Codex のレビュー 2026-10-28） */
export async function countLinks(db, { shop, bookingId, personId, today }) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM ask_links WHERE shop = ?1 AND booking_id = ?2 AND person_id = ?3 AND expires_on >= ?4')
    .bind(shop, bookingId, personId, today).first();
  return row ? Number(row.n) : 0;
}

/* 1 日に受ける回数を数える。上限を超えたら false（数えない） */
export async function useLink(db, hash, day, max) {
  const r = await db.prepare('UPDATE ask_links SET uses = CASE WHEN day = ?2 THEN uses + 1 ELSE 1 END, day = ?2 WHERE hash = ?1 AND (day <> ?2 OR uses < ?3)')
    .bind(hash, day, max).run();
  return Boolean(r && r.meta && Number(r.meta.changes) === 1);
}

/* 期限を過ぎた鍵を消す（Cron） */
export async function dropExpired(db, today) {
  await db.prepare('DELETE FROM ask_links WHERE expires_on < ?1').bind(today).run();
}

/* リンクを作って置き、開く URL を返す。鍵は URL の # の後ろだけに置く（サーバーの記録・Referer・履歴に残さない） */
export async function mintLink(db, { shop, bookingId, personId, expiresOn, at, base }) {
  const key = newKey();
  await putLink(db, { hash: await keyHash(key), shop, bookingId, personId: personId || '', expiresOn, at });
  return `${String(base).replace(/\/+$/, '')}/ask#k=${key}`;
}
