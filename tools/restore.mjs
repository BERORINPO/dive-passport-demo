// 名簿を毎日の控え（Workers KV の BACKUP。worker/backup.mjs）から D1 に戻す 1 文を作る（docs/deploy.md の 8「控えから戻す」）。
// 控えの名簿を、置くときと同じ検査（sync-core.mjs の readStored）にかけてから、Cloudflare の D1 の API に送る本文（JSON）を出す。D1 には自分ではつながない。
// 名簿は大きい（D1 のコンソールは 1 文 100 KB まで）ので、名簿は SQL に埋めず、params で渡す。戻すと版が 1 つ進み、開いている画面は戻した名簿を受け取る。
// 取り違えと上書きの守り（ジンのレビュー 2026-10-28）:
// - 控えに入っているお店と --shop が違えば止める
// - 今の名簿（--current。戻す前に書き出した物）の版でだけ書く（その間に予約が入って版が進んだら、D1 が書かずに 0 行になる。もう一度 1 から）
// - 今の名簿にあって控えに無い予約と人の数を出す（戻すと消える分。必要なら、戻した後に入れ直す）
// 使い方:
//   npx wrangler kv key get --binding BACKUP --remote "day:default:2026-10-28" > snap.json
//   （今の名簿を current.json に書き出す。手順は docs/deploy.md）
//   node tools/restore.mjs snap.json --shop default --current current.json > restore-body.json
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStored } from '../worker/sync-core.mjs';
import { SHOP_ID } from '../worker/shop-core.mjs';

/* 版が expect のときだけ書き換える。名簿の行が無い（expect が 0）ときは新しく作る */
const RESTORE_SQL = 'INSERT INTO rosters (shop, version, state, updated_at) VALUES (?1, 1, ?2, ?3) ' +
  'ON CONFLICT(shop) DO UPDATE SET version = rosters.version + 1, state = excluded.state, updated_at = excluded.updated_at WHERE rosters.version = ?4';

/* 今の名簿の書き出し（D1 の API の答え、または { version, state } の行）から { version, state } を取る。行が無ければ版 0 */
export function currentOf(text) {
  const o = JSON.parse(text);
  const row = o && Array.isArray(o.result) ? (o.result[0] && o.result[0].results && o.result[0].results[0]) || null : o;
  if (!row) return { version: 0, state: null };
  if (!Number.isInteger(Number(row.version))) throw new Error('今の名簿の書き出しに版が無い');
  let state = null;
  try { state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state; } catch (e) { state = null; }
  return { version: Number(row.version), state };
}

/* 控え（{ shop, at, version, people, text }）と今の名簿から、D1 の API の本文と、戻すと消える数を作る。合わなければ例外 */
export function restoreBody(snapshotText, { shop, at, current }) {
  if (!SHOP_ID.test(shop)) throw new Error(`お店の id が合わない: ${shop}`);
  if (!current) throw new Error('今の名簿（--current）が要る（戻す前に書き出す）');
  let snap;
  try { snap = JSON.parse(snapshotText); } catch (e) { throw new Error('控えが JSON として読めない'); }
  if (!snap || typeof snap.text !== 'string') throw new Error('控えの形が合わない（text が無い）');
  if (snap.shop !== shop) throw new Error(`控えのお店（${snap.shop || '書いていない'}）と --shop（${shop}）が違う`);
  const state = readStored(snap.text, { today: at.slice(0, 10), at });
  if (!state) throw new Error('控えの名簿が、名簿の形の検査に通らない');
  const now = current.state && typeof current.state === 'object' ? current.state : { bookings: [], people: [] };
  const kept = (list, ids) => (Array.isArray(list) ? list.filter(x => x && !ids.has(x.id)).length : 0);
  const lost = { bookings: kept(now.bookings, new Set(state.bookings.map(b => b.id))), people: kept(now.people, new Set(state.people.map(p => p.id))) };
  return { sql: RESTORE_SQL, params: [shop, JSON.stringify(state), at, current.version], people: state.people.length, from: snap.at || '', lost };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = args[0];
  const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : ''; };
  const shop = opt('--shop');
  const currentFile = opt('--current');
  if (!file || !shop || !currentFile) {
    console.error('使い方: node tools/restore.mjs <控えの JSON> --shop <お店の id> --current <今の名簿の書き出し>');
    process.exit(2);
  }
  try {
    const body = restoreBody(readFileSync(file, 'utf8'), { shop, at: new Date().toISOString(), current: currentOf(readFileSync(currentFile, 'utf8')) });
    console.error(`戻す名簿: ${body.people} 人（控えを取った時刻 ${body.from}）`);
    console.error(`戻すと消える分（今の名簿にあって控えに無い）: 予約 ${body.lost.bookings} 件・人 ${body.lost.people} 人。必要なら、戻した後に入れ直す`);
    const { people, from, lost, ...apiBody } = body;
    process.stdout.write(`${JSON.stringify(apiBody)}\n`);
  } catch (e) {
    console.error(`止めた: ${e.message}`);
    process.exit(1);
  }
}
