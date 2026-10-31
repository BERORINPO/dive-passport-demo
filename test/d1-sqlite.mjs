// テストだけが使う: 本物の SQLite（node:sqlite）を、Cloudflare D1 の binding の形（prepare / bind / first / run / all / batch）に包む。
// worker/migrations/ の表を全部作ってから渡す。fakeD1（worker/fakes.mjs）は SQL を文字で照らすだけなので、SQL そのものと表の形はここで確かめる
// （ジンのレビュー 2026-10-27 MEDIUM 11）。node:sqlite が無い Node では null を返す（呼ぶ側が飛ばす）
import { readFileSync, readdirSync } from 'node:fs';

export async function sqliteD1() {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch (e) { return null; }
  const raw = new sqlite.DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  readdirSync(dir).filter(f => f.endsWith('.sql')).sort().forEach(f => raw.exec(readFileSync(new URL(f, dir), 'utf8')));
  const plain = (row) => (row ? JSON.parse(JSON.stringify(row)) : null);   // node:sqlite の行は prototype が null
  const executed = new Set();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => { executed.add(sql); return plain(raw.prepare(sql).get(...args)); },
    run: async () => { executed.add(sql); return { success: true, meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }; },
    all: async () => { executed.add(sql); return { results: raw.prepare(sql).all(...args).map(plain) }; }
  });
  return {
    raw,
    executed,
    prepare: (sql) => stmt(sql),
    /* D1 と同じく 1 つの transaction。どれかが失敗したら全部を戻す */
    async batch(list) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const x of list) out.push(await x.run());
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    /* テストの手伝い: fakeD1 の addShop と同じ形でお店を 1 つ足す */
    addShop({ id, name, members = [], sites = [], inbox = '', senders = [], replyTo = '' }) {
      raw.prepare('INSERT INTO shops (id, name, members, sites, inbox, senders, reply_to) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .run(id, name, JSON.stringify(members), JSON.stringify(sites), inbox, JSON.stringify(senders), replyTo);
    }
  };
}
