// 名簿を毎日の控え（Workers KV の BACKUP。worker/backup.mjs）から D1 に戻す 1 文を作る（docs/deploy.md の「控えから戻す」）。
// 控えの名簿を、置くときと同じ検査（sync-core.mjs の readStored）にかけてから、Cloudflare の D1 の API に送る本文（JSON）を出す。D1 には自分ではつながない。
// 名簿は大きい（D1 のコンソールは 1 文 100 KB まで）ので、名簿は SQL に埋めず、params で渡す。戻すと版が 1 つ進み、開いている画面は戻した名簿を受け取る。
// 使い方:
//   npx wrangler kv key get --binding BACKUP --remote "day:default:2026-10-28" > snap.json
//   node tools/restore.mjs snap.json --shop default > restore-body.json
//   （送り方は docs/deploy.md。送る前に restore-body.json の people の数を確かめる）
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readStored } from '../worker/sync-core.mjs';
import { SHOP_ID } from '../worker/shop-core.mjs';

const RESTORE_SQL = 'INSERT INTO rosters (shop, version, state, updated_at) VALUES (?1, 1, ?2, ?3) ' +
  'ON CONFLICT(shop) DO UPDATE SET version = rosters.version + 1, state = excluded.state, updated_at = excluded.updated_at';

/* 控え（{ at, version, people, text }）から、D1 の API の本文を作る。読めない・形が合わない控えは例外 */
export function restoreBody(snapshotText, { shop, at }) {
  if (!SHOP_ID.test(shop)) throw new Error(`お店の id が合わない: ${shop}`);
  let snap;
  try { snap = JSON.parse(snapshotText); } catch (e) { throw new Error('控えが JSON として読めない'); }
  if (!snap || typeof snap.text !== 'string') throw new Error('控えの形が合わない（text が無い）');
  const today = at.slice(0, 10);
  const state = readStored(snap.text, { today, at });
  if (!state) throw new Error('控えの名簿が、名簿の形の検査に通らない');
  return { sql: RESTORE_SQL, params: [shop, JSON.stringify(state), at], people: state.people.length, from: snap.at || '' };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, flag, shop] = process.argv.slice(2);
  if (!file || flag !== '--shop' || !shop) {
    console.error('使い方: node tools/restore.mjs <控えの JSON> --shop <お店の id>');
    process.exit(2);
  }
  try {
    const body = restoreBody(readFileSync(file, 'utf8'), { shop, at: new Date().toISOString() });
    console.error(`戻す名簿: ${body.people} 人（控えを取った時刻 ${body.from}）`);
    const { people, from, ...apiBody } = body;
    process.stdout.write(`${JSON.stringify(apiBody)}\n`);
  } catch (e) {
    console.error(`止めた: ${e.message}`);
    process.exit(1);
  }
}
