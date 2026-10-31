// 試用をやめたお店の後始末（shops.html の約束「やめるとき: 名簿を CSV でお渡しし、30 日以内に、こちらの控えも含めて消します」。手順は docs/deploy.md の 10）。
// 本番の D1・KV には自分ではつながない（tools/shop.mjs・restore.mjs と同じ。出た文と一覧を、人が確かめて実行する。消す操作は取り消せないので、実行は人）。
//   csv   お店の名簿（今の名簿 + 済んだ便）を 1 つの CSV にする。入力は D1 から取った JSON 2 つ（取り方は deploy.md）。列は js/day-roster.js の CSV と同じ
//   wipe  D1 の全部の表からそのお店の行を消す文（1 文 1 行）。shops の行を最初に消す（Cron・予約の口が止まる）
//   check 消えたかを数える 1 文（全部 0 なら消えている）。--before を付けると、消す前にあるものを数える
//   kv    KV の BACKUP・BUDGET から消すキーの一覧（wrangler kv bulk delete に渡す JSON）。--verify は 1 つでも残っていれば失敗にする
// 使い方:
//   node tools/offboard.mjs csv --shop shop-a --live live.json --past past.json [--no-health] [--allow-skipped] [--out shop-a.csv]
//   node tools/offboard.mjs wipe --shop shop-a
//   node tools/offboard.mjs check --shop shop-a [--before]
//   node tools/offboard.mjs kv --shop shop-a --binding BACKUP --list backup-keys.json [--verify] > backup-delete.json
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHOP_ID } from '../worker/shop-core.mjs';
import { readPast } from '../worker/past-core.mjs';
import { dayKey, pastKey, alertKey, cursorKey } from '../worker/backup-core.mjs';

const R = globalThis.REDUX;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/* 見本の名簿（default）は試用のお店ではない。打ち間違いで消さない */
const SAMPLE_SHOP = 'default';

/* SQL や KV のキーに入れる前に、お店の id の形を確かめる（SHOP_ID は英小文字・数字・- だけ。引用符も : も入らない）。合わなければ例外 */
export function shopOf(id) {
  if (typeof id !== 'string' || !SHOP_ID.test(id)) throw new Error('--shop は英小文字・数字・- の 40 字まで');
  if (id === SAMPLE_SHOP) throw new Error(`${SAMPLE_SHOP} は見本の名簿で、試用のお店ではない`);
  return id;
}

/* ---------- D1: 消す文と、消えたかを数える文 ---------- */

/* 表ごとの「そのお店の行」。並びが消す順。表を足したら、ここにも足す（test/offboard.test.mjs が migrations と突き合わせる）。
   where: 消す前にそのお店の行を見つける条件 / left: 消したあとに残っていてはいけない行の条件（省くと where と同じ）。
   - shops は最初に消す。お店の一覧から外れると、予約フォーム・届いたメール・Access のスタッフ・Cron の控え（worker/auto.mjs）が、そのお店を相手にしなくなる
     （一覧に残したまま名簿を消すと、Cron は「名簿が無くなりました」の警報を出し、KV にまた書く）
   - api_idempotency は鍵（api_keys）の id でつながる。daily_counts の scope 'api' も、shop の欄に鍵の id が入る。鍵を消す前に消す。
     鍵を消したあとは条件が空になるので、left は「鍵が無い行」を数える（消し漏れがあれば 0 にならない）
   - daily_counts の scope 'api' 以外は shop の欄がお店の id。'api' の行は鍵の id なので、お店の id と同じ文字の他店の鍵の行を消さないよう分ける
   - 全店あわせた数の行（shop = '*'）は、お店の情報を持たないので消さない */
const SHOP_KEYS = (s) => `SELECT id FROM api_keys WHERE shop = ${q(s)}`;
const byShop = (s) => `shop = ${q(s)}`;
export const SHOP_ROWS = [
  { table: 'shops', col: 'id', where: (s) => `id = ${q(s)}` },
  { table: 'rosters', col: 'shop', where: byShop },
  { table: 'roster_past', col: 'shop', where: byShop },
  { table: 'ask_links', col: 'shop', where: byShop },
  { table: 'mail_unread', col: 'shop', where: byShop },
  { table: 'walkin_keys', col: 'shop', where: byShop },
  { table: 'walkin_pending', col: 'shop', where: byShop },
  { table: 'api_idempotency', col: 'key_id', where: (s) => `key_id IN (${SHOP_KEYS(s)})`, left: () => 'key_id NOT IN (SELECT id FROM api_keys)' },
  { table: 'daily_counts', label: 'daily_counts(api)', col: 'shop', where: (s) => `scope = 'api' AND shop IN (${SHOP_KEYS(s)})`,
    left: () => "scope = 'api' AND shop NOT IN (SELECT id FROM api_keys)" },
  { table: 'daily_counts', col: 'shop', where: (s) => `scope <> 'api' AND ${byShop(s)}` },
  { table: 'api_keys', col: 'shop', where: byShop }
];

/* 消す文（1 文 1 つの DELETE）。D1 のコンソール（redux-rosters）に貼る */
export function wipeSql(id) {
  const shop = shopOf(id);
  return SHOP_ROWS.map(r => `DELETE FROM ${r.table} WHERE ${r.where(shop)};`);
}

/* 数える 1 文。表の名前と行数（n）が表の数だけ返る。after（既定）は消したあとの確かめ、before: true は消す前にあるものを数える */
export function checkSql(id, { before = false } = {}) {
  const shop = shopOf(id);
  const rows = SHOP_ROWS.map(r => `SELECT ${q(r.label || r.table)} AS tbl, COUNT(*) AS n FROM ${r.table} WHERE ${before || !r.left ? r.where(shop) : r.left(shop)}`);
  return `${rows.join(' UNION ALL ')};`;
}

/* ---------- KV: 消すキー ---------- */

/* お店の id に : は入らない（SHOP_ID）ので、`<種類>:<お店>:` で始まるキーは、ほかのお店のキーに当たらない（shop-a が shop-ab を巻き込まない）。
   BACKUP のキーは worker/backup-core.mjs の作り方をそのまま使う。BUDGET の `day:`・`month:` は worker/budget.mjs の keyOf と同じ形
   （test/offboard.test.mjs が本物の reserve・spend・dailyBackup の書いたキーで突き合わせる）。cron:last はお店のものではないので消さない */
const KV_RULES = {
  BACKUP: (s) => ({ prefixes: [dayKey(s, ''), pastKey(s, ''), alertKey(s, '')], exact: [cursorKey(s)] }),
  BUDGET: (s) => ({ prefixes: [`day:${s}:`, `month:${s}:`], exact: [] })
};
export const KV_BINDINGS = Object.keys(KV_RULES);
const LIST_PAGE = 1000;

/* wrangler kv key list の答え（[{ name }]）、または API の答え（{ result: [{ name }] }）から、キーの名前の一覧を取る */
export function namesOf(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new Error('キーの一覧が JSON として読めない'); }
  const list = Array.isArray(v) ? v : v && Array.isArray(v.result) ? v.result : null;
  if (!list) throw new Error('キーの一覧の形が合わない（wrangler kv key list の出力を渡す）');
  return list.map(x => (typeof x === 'string' ? x : x && typeof x.name === 'string' ? x.name : null)).map((n, i) => {
    if (n === null) throw new Error(`キーの一覧の ${i + 1} 番目に name が無い`);
    return n;
  });
}

/* 一覧のうち、そのお店のキーだけ。返すのは { keys, by }（by は prefix ごとの数） */
export function kvKeys(listText, binding, id) {
  const shop = shopOf(id);
  if (!KV_RULES[binding]) throw new Error(`--binding は ${KV_BINDINGS.join(' か ')}`);
  const { prefixes, exact } = KV_RULES[binding](shop);
  const names = namesOf(listText);
  const keys = names.filter(n => exact.includes(n) || prefixes.some(p => n.startsWith(p))).sort();
  const by = Object.fromEntries([...prefixes, ...exact].map(p => [p, keys.filter(k => (exact.includes(p) ? k === p : k.startsWith(p))).length]));
  return { keys, by };
}

/* ---------- CSV: 今の名簿 + 済んだ便 ---------- */

/* D1 の答え（Cloudflare の API の { result: [{ results }] }、wrangler d1 execute --json の [{ results }]、行の配列のどれでも）から行を取る */
export function rowsOf(text) {
  let v;
  try { v = JSON.parse(text); } catch (e) { throw new Error('D1 の答えが JSON として読めない'); }
  const sets = Array.isArray(v) && v.length && v.every(x => x && Array.isArray(x.results)) ? v : v && Array.isArray(v.result) ? v.result : null;
  if (sets) return sets[0] && Array.isArray(sets[0].results) ? sets[0].results : [];
  if (Array.isArray(v)) return v;
  throw new Error('D1 の答えの形が合わない（deploy.md の 10 の取り方で書き出す）');
}

/* D1 から取る 2 つの文（deploy.md の 10 にも同じ文を書いてある。test/offboard.test.mjs が突き合わせる） */
export const LIVE_SQL = 'SELECT state FROM rosters WHERE shop = ?1';
export const PAST_SQL = 'SELECT part, day, body FROM roster_past WHERE shop = ?1 ORDER BY day, part';

/* js/data.js の R.HEALTH の short（健康の答えが「はい」の項目の短い名前）。画面の CSV と同じ字にする（test/offboard.test.mjs が data.js と突き合わせる） */
export const HEALTH_SHORT = ['治療中の病気', '心臓・肺', '耳・鼻', '妊娠', '手術・けが'];

/* 今の名簿の行（0 または 1 行）と済んだ便の行から、1 つの名簿にする。返すのは { state, skipped }（skipped は形が合わずに外した済んだ便の行の数） */
export function stateOf(liveRows, pastRows, shop) {
  const S = R.roster;
  let live = S.blankState(shop);
  if (liveRows.length) {
    try { live = S.upgradeState(JSON.parse(String(liveRows[0].state))); } catch (e) { throw new Error('今の名簿が読めない'); }
    if (!S.validateState(live).ok) throw new Error('今の名簿が、名簿の形の検査に通らない');
  }
  const past = readPast(pastRows, live.shop.name || shop);
  const ids = new Set(live.trips.map(t => t.id));
  if (past.state.trips.some(t => ids.has(t.id))) throw new Error('同じ便が今の名簿と済んだ便の両方にある。人数が二重になるので、D1 を見て直してから');
  return {
    state: { ...live, trips: [...live.trips, ...past.state.trips], bookings: [...live.bookings, ...past.state.bookings], people: [...live.people, ...past.state.people],
      log: [...live.log, ...past.state.log] },
    skipped: past.skipped
  };
}

const tripOrder = (t) => `${t.date || '9999-99-99'}|${t.start}|${t.id}`;

/* 全部の便のこのお店のお客さんを、日付の順に 1 つの CSV にする（js/day-roster.js の exportCsv と同じ rosterRows・toCsv。健康の欄は health で出す・出さない）。
   便の種類（ダイビング・スノーケリング）で項目の名前が違う列は「／」でつなぐ。乗り合いの他のお店のお客さんは入れない（own） */
export function offboardCsv(state, { health = true } = {}) {
  const S = R.roster;
  const C = R.rosterCore;
  const trips = [...state.trips].sort((a, b) => (tripOrder(a) < tripOrder(b) ? -1 : 1));
  const tables = trips.map(t => C.rosterRows(state, t.id, HEALTH_SHORT, { own: true }));
  const kinds = ['dive', 'snorkel'].filter(k => trips.some(t => t.kind === k));
  const labels = new Map();
  (kinds.length ? kinds : ['dive']).forEach(k => S.ITEMS[k].filter(i => health || !i.health).forEach(i => {
    labels.set(i.key, [...new Set([...(labels.get(i.key) || []), i.ja])]);
  }));
  const items = [...labels].map(([key, ja]) => ({ key, ja: ja.join('／') }));
  const rows = tables.flatMap(t => t.rows);
  return { csv: C.toCsv({ items, rows }), trips: trips.length, people: rows.length };
}

/* ---------- 引数と実行 ---------- */

const FLAGS = ['--no-health', '--allow-skipped', '--before', '--verify'];
const VALUES = { '--shop': 'shop', '--live': 'live', '--past': 'past', '--list': 'list', '--binding': 'binding', '--out': 'out' };

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const out = { cmd };
  for (let i = 0; i < rest.length; i += 1) {
    const k = rest[i];
    if (FLAGS.includes(k)) out[k.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    else if (VALUES[k]) {
      if (rest[i + 1] === undefined) throw new Error(`${k} の値が無い`);
      out[VALUES[k]] = rest[i + 1];
      i += 1;
    } else throw new Error(`知らない指定: ${k}`);
  }
  return out;
}

const need = (a, ...names) => names.forEach(n => { if (!a[n]) throw new Error(`--${n} が要る`); });

function runCsv(a) {
  need(a, 'shop', 'live', 'past');
  const shop = shopOf(a.shop);
  const { state, skipped } = stateOf(rowsOf(readFileSync(a.live, 'utf8')), rowsOf(readFileSync(a.past, 'utf8')), shop);
  if (skipped && !a.allowSkipped) throw new Error(`済んだ便の ${skipped} 行が名簿の形に合わず読めない。CSV に入らないので止めた（D1 の roster_past を見る。承知なら --allow-skipped）`);
  const out = offboardCsv(state, { health: !a.noHealth });
  if (skipped) console.error(`注意: 済んだ便の ${skipped} 行は読めず、CSV に入っていない`);
  console.error(`便 ${out.trips} 本・お客さん ${out.people} 人（健康の欄${a.noHealth ? 'なし' : 'あり。受け取れるのはそのお店の人だけにする'}）`);
  console.error('渡し終えたら、CSV と live.json・past.json を消す（お客さんの情報そのもの）');
  if (a.out) writeFileSync(a.out, out.csv, 'utf8');   // PowerShell の > は字の符号を変えるので、--out を勧める
  else process.stdout.write(out.csv);
}

function runKv(a) {
  need(a, 'shop', 'binding', 'list');
  const text = readFileSync(a.list, 'utf8');
  /* KV の一覧は 1 回で 1000 件まで。ちょうど 1000 の倍数なら途中で切れている恐れがあり、「残っていない」と見誤る */
  const listed = namesOf(text).length;
  if (listed > 0 && listed % LIST_PAGE === 0) throw new Error(`一覧が ${listed} 件ちょうどで、途中で切れている恐れがある。--prefix "day:${a.shop}:" のように絞って取り直す（種類ごとに）`);
  const { keys, by } = kvKeys(text, a.binding, a.shop);
  Object.entries(by).forEach(([p, n]) => console.error(`${a.binding} ${p} ${n} 件`));
  console.error(`${a.binding} 合計 ${keys.length} 件${keys.length ? '' : '（残っていない）'}`);
  if (a.verify) {
    if (keys.length) throw new Error('KV にまだ残っている（消した直後は最長 1 分ほど一覧に出ることがある。少し待って、一覧を取り直す）');
    return;
  }
  process.stdout.write(`${JSON.stringify(keys, null, 1)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (a.cmd === 'csv') runCsv(a);
    else if (a.cmd === 'wipe') {
      need(a, 'shop');
      console.log(wipeSql(a.shop).join('\n'));
      console.error('↑ D1 のコンソール（redux-rosters）に 1 文ずつ貼って Execute。取り消せない。先に deploy.md の 10 の 1〜3（CSV を渡して確かめる）が済んでいること');
    } else if (a.cmd === 'check') {
      need(a, 'shop');
      console.log(checkSql(a.shop, { before: a.before }));
      console.error(a.before ? '↑ 消す前にあるものの数' : '↑ 全部の n が 0 なら消えている。0 でない表があれば、その表の行を見る');
    } else if (a.cmd === 'kv') runKv(a);
    else throw new Error('使えるのは csv・wipe・check・kv');
  } catch (e) {
    console.error(`止めました: ${e.message}`);
    process.exit(1);
  }
}
