/* お店の名簿を Cloudflare D1 に読み書きする（adapter）。表の形は worker/migrations/0001_rosters.sql、決まりは plan/server.md。
   書くときは版の番号で守る: base が 0 なら新しく作り（同じお店が既にあれば書かない）、それ以外は今の版が base のときだけ書き換える。
   見本は worker/fakes.mjs の fakeD1 */

/* 返すのは { version, text }。まだ無ければ { version: 0, text: null } */
export async function getRoster(db, shop) {
  const row = await db.prepare('SELECT version, state FROM rosters WHERE shop = ?1').bind(shop).first();
  return row ? { version: Number(row.version), text: String(row.state) } : { version: 0, text: null };
}

/* 書けたら { ok: true, version }。版が合わない（別の端末が先に書いた）ときは { ok: false } */
export async function putRoster(db, shop, base, text, at) {
  const result = base === 0
    ? await db.prepare('INSERT INTO rosters (shop, version, state, updated_at) VALUES (?1, 1, ?2, ?3) ON CONFLICT(shop) DO NOTHING')
      .bind(shop, text, at).run()
    : await db.prepare('UPDATE rosters SET version = version + 1, state = ?2, updated_at = ?3 WHERE shop = ?1 AND version = ?4')
      .bind(shop, text, at, base).run();
  const changed = result && result.meta ? Number(result.meta.changes) : 0;
  return changed === 1 ? { ok: true, version: base + 1 } : { ok: false };
}
