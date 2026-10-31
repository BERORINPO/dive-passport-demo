// 試用をやめたお店の後始末の道具（tools/offboard.mjs。手順は docs/deploy.md の 10）を確かめる。
// 1. 消す文が、migrations の全部の表を覆う（表を足して消し忘れたら落ちる）。SQL は node:sqlite（本物の SQLite）で、2 店分の行のうち片方だけ消え、もう片方が残ることを確かめる
// 2. 消えたかを数える文が、消し漏れ（特に鍵の id でつながる表）を見つける
// 3. KV の消すキーが、本物の Cron・上限の数え方が書いたキーを全部覆い、名前の似たほかのお店のキーに当たらない
// 4. CSV が、画面の CSV と同じ列で、今の名簿と済んだ便を日付の順に 1 つにし、ほかのお店のお客さんと他店の乗り合いのお客さんを入れない
// 5. docs/deploy.md の手順の順と、道具が出す文が合っている
// 実行: node test/offboard.test.mjs （Node 18 以上。node:sqlite が無い Node では SQL の確かめを飛ばさず落とす。SKIP_SQLITE=1 のときだけ飛ばす。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { sqliteD1 } from './d1-sqlite.mjs';
import { fakeKv, fakeD1 } from '../worker/fakes.mjs';
import { reserve, spend } from '../worker/budget.mjs';
import { dailyBackup } from '../worker/backup.mjs';
import { splitPast } from '../worker/past-core.mjs';
import { SHOP_ID } from '../worker/shop-core.mjs';
import { SHOP_ROWS, shopOf, wipeSql, checkSql, namesOf, kvKeys, KV_BINDINGS, rowsOf, LIVE_SQL, PAST_SQL, HEALTH_SHORT, stateOf, offboardCsv, parseArgs } from '../tools/offboard.mjs';

vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterCore: C, rosterShare: X } = R;
const TOOL = new URL('../tools/offboard.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const OWN = 'B マリン（見本）';
const A = 'shop-a';
const B = 'shop-ab';   // A の名前で始まる。前方一致や LIKE で消すと巻き込まれる
let n = 0;
const newId = () => `id${(n += 1)}`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const migrationText = () => readdirSync(new URL('../worker/migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(new URL(`../worker/migrations/${f}`, import.meta.url), 'utf8')).join('\n');
/* CREATE TABLE ごとの列の名前 { 表: [列…] }（制約の行は除く） */
function tablesOf(sql) {
  const out = {};
  for (const m of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);/g)) {
    out[m[1]] = m[2].split('\n').map(l => l.trim()).filter(l => l && !/^(--|PRIMARY|UNIQUE)/.test(l)).map(l => l.split(/\s+/)[0]);
  }
  return out;
}

/* ---------- 1. 消す文が全部の表を覆う ---------- */

test('覆い: 消す文は、migrations の全部の表を覆い、お店の列（shop・shops の id・鍵の key_id）を持つ表の漏れが無い', () => {
  const tables = tablesOf(migrationText());
  assert.ok(Object.keys(tables).length >= 10, `migrations から表を拾えていない (${Object.keys(tables)})`);
  const covered = new Set(SHOP_ROWS.map(r => r.table));
  Object.keys(tables).forEach(t => assert.ok(covered.has(t), `表 ${t} を SHOP_ROWS に足す（そのお店の行を消す条件を書く。お店と関係しない表なら、その理由をここに書いて外す）`));
  [...covered].forEach(t => assert.ok(tables[t], `SHOP_ROWS に migrations に無い表 ${t}`));
  /* お店を指す列を持つ表は全部、その列で消している */
  Object.entries(tables).forEach(([t, cols]) => {
    const shopCols = cols.filter(c => c === 'shop' || c === 'key_id' || (t === 'shops' && c === 'id'));
    assert.ok(shopCols.length > 0, `${t} にお店を指す列が無い。お店と無関係なら、test のこの検査に理由つきで例外を足す`);
    const rows = SHOP_ROWS.filter(r => r.table === t);
    rows.forEach(r => assert.ok(cols.includes(r.col), `${t} に列 ${r.col} が無い`));
    shopCols.forEach(c => assert.ok(rows.some(r => r.col === c), `${t}.${c} で消していない`));
  });
  /* 鍵の id でつながる表は、鍵（api_keys）を消す前に消す。お店の一覧（shops）は最初 */
  const order = SHOP_ROWS.map(r => r.label || r.table);
  assert.equal(order[0], 'shops');
  assert.ok(order.indexOf('api_idempotency') < order.indexOf('api_keys') && order.indexOf('daily_counts(api)') < order.indexOf('api_keys'));
});

/* ---------- SQL を本物の SQLite で流す ---------- */

const first = await sqliteD1();
const needSqlite = () => {
  if (first) return false;
  if (process.env.SKIP_SQLITE === '1') return true;
  throw new Error('node:sqlite が無い（Node 22.5 以上で流す）');
};

/* お店 1 つ分の行を全部の表に入れる。keys はそのお店の API キーの id */
function seed(raw, { shop, keys, inbox }) {
  const ins = (sql, ...args) => raw.prepare(sql).run(...args);
  ins('INSERT INTO shops (id, name, members, sites, inbox, senders) VALUES (?, ?, ?, ?, ?, ?)', shop, `${shop} ダイブ`, '["staff@example.com"]', '[]', inbox, '[]');
  ins('INSERT INTO rosters VALUES (?, 1, ?, ?)', shop, '{}', 'x');
  ['trip:t1', 'trip:t2'].forEach((part, i) => ins('INSERT INTO roster_past VALUES (?, ?, ?, ?, ?, ?)', shop, part, `2026-09-0${i + 1}`, '2027-09-01', '{}', 'x'));
  [0, 1].forEach(i => ins("INSERT INTO ask_links (hash, shop, booking_id, person_id, expires_on, created_at) VALUES (?, ?, ?, '', ?, ?)", `${shop}-h${i}`, shop, `b${i}`, '2026-12-01', 'x'));
  ins("INSERT INTO mail_unread VALUES (?, 'u1', 'x', 'why')", shop);
  ins("INSERT INTO walkin_keys VALUES (?, ?, 'x')", shop, `${shop}-wk`);
  ins("INSERT INTO walkin_pending (shop, id, body, created_at, expires_on) VALUES (?, 'w1', '{}', 'x', '2026-11-01')", shop);
  keys.forEach((id, i) => {
    ins("INSERT INTO api_keys (id, shop, hash, label, created_at, revoked_at) VALUES (?, ?, ?, 'l', 'x', ?)", id, shop, `${shop}-k${i}`, i ? 'y' : '');
    ins("INSERT INTO api_idempotency VALUES (?, ?, 'bk', 'x')", id, `idem-${id}`);
    ins("INSERT INTO daily_counts VALUES ('api', ?, '2026-10-27', 3)", id);
  });
  ['site', 'mail', 'unread', 'walkin', 'api-shop'].forEach(scope => ins("INSERT INTO daily_counts VALUES (?, ?, '2026-10-27', 2)", scope, shop));
}
function seeded(raw) {
  seed(raw, { shop: A, keys: ['ka1', 'ka2'], inbox: 'a@example.com' });
  seed(raw, { shop: B, keys: ['kb1', A], inbox: 'b@example.com' });   // B の鍵の id が A のお店の id と同じ文字（api の件数の行は鍵の id なので、A を消すときに巻き込まない）
  raw.prepare("INSERT INTO daily_counts VALUES ('site', '*', '2026-10-27', 9)").run();
}
const tableNames = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
const dump = (raw) => Object.fromEntries(tableNames(raw).map(t => [t, raw.prepare(`SELECT * FROM ${t}`).all().map(r => JSON.stringify(r)).sort()]));
/* A の行か（道具の条件とは別に、行を見て決める） */
function ownedByA(raw) {
  const keys = new Set(raw.prepare('SELECT id FROM api_keys WHERE shop = ?').all(A).map(r => r.id));
  return (t, row) => {
    if (t === 'shops') return row.id === A;
    if (t === 'api_idempotency') return keys.has(row.key_id);
    if (t === 'daily_counts') return row.scope === 'api' ? keys.has(row.shop) : row.shop === A;
    return row.shop === A;
  };
}

test('SQL: 2 店の行を入れて A を消すと、A の行だけが全部の表から消え、B（名前が A で始まる）と全店あわせた数は 1 行も変わらない', () => {
  if (needSqlite()) return 'skip';
  const raw = first.raw;
  seeded(raw);
  const tables = tableNames(raw);
  const mine = ownedByA(raw);
  const before = dump(raw);
  tables.forEach(t => {
    const rows = raw.prepare(`SELECT * FROM ${t}`).all();
    assert.ok(rows.some(r => mine(t, r)), `見本に A の ${t} の行が無い（表を足したら、seed にも足す）`);
    assert.ok(rows.some(r => !mine(t, r)), `見本に A 以外の ${t} の行が無い`);
  });
  wipeSql(A).forEach(sql => {
    assert.ok(!sql.includes('?'), '貼るだけで動く（値は文の中）');
    assert.ok(sql.startsWith('DELETE FROM '), sql);
    raw.exec(sql);
  });
  const after = dump(raw);
  tables.forEach(t => {
    const want = before[t].filter(j => !mine(t, JSON.parse(j)));
    assert.deepEqual(after[t], want, `${t}: A の行だけが消える`);
  });
  assert.ok(after.daily_counts.some(j => JSON.parse(j).scope === 'api' && JSON.parse(j).shop === A), 'B の鍵（id が A と同じ文字）の件数の行は残る');
  assert.ok(after.daily_counts.some(j => JSON.parse(j).shop === '*'), '全店あわせた数は残る');
  /* 同じ文をもう一度流しても何も起きない（途中で止まったら、最初からやり直せる） */
  wipeSql(A).forEach(sql => raw.exec(sql));
  assert.deepEqual(dump(raw), after);
  /* 後始末: この DB は使い捨て */
  tables.forEach(t => raw.exec(`DELETE FROM ${t}`));
});

test('SQL: 数える文は、消す前は A の行を表ごとに数え、消したあとは全部 0 になる。消し漏れ（鍵の id でつながる表）は 0 にならず見つかる', () => {
  if (needSqlite()) return 'skip';
  const raw = first.raw;
  const run = (sql) => raw.prepare(sql).all().map(r => [r.tbl, Number(r.n)]);
  seeded(raw);
  const before = run(checkSql(A, { before: true }));
  assert.deepEqual(before.map(r => r[0]), SHOP_ROWS.map(r => r.label || r.table), '表ごとに 1 行');
  before.forEach(([t, c]) => assert.ok(c > 0, `消す前の ${t} が 0`));
  assert.deepEqual(Object.fromEntries(before), { shops: 1, rosters: 1, roster_past: 2, ask_links: 2, mail_unread: 1, walkin_keys: 1, walkin_pending: 1, api_idempotency: 2,
    'daily_counts(api)': 2, daily_counts: 5, api_keys: 2 });
  /* 鍵（api_keys）だけを消して、鍵の id でつながる 2 表を消し忘れた → 消した「あと」の数え方で見つかる */
  wipeSql(A).filter(s => s.startsWith('DELETE FROM api_keys') || s.startsWith('DELETE FROM shops')).forEach(s => raw.exec(s));
  const leaked = Object.fromEntries(run(checkSql(A)));
  assert.equal(leaked.api_idempotency, 2, '鍵が無い api_idempotency の行');
  assert.equal(leaked['daily_counts(api)'], 2, '鍵が無い api の件数の行');
  /* 見つかった行は人が消す（道具の「鍵が無い行」の条件と同じ） */
  raw.exec('DELETE FROM api_idempotency WHERE key_id NOT IN (SELECT id FROM api_keys)');
  raw.exec("DELETE FROM daily_counts WHERE scope = 'api' AND shop NOT IN (SELECT id FROM api_keys)");
  wipeSql(A).forEach(s => raw.exec(s));
  const wiped = run(checkSql(A));
  assert.ok(wiped.every(([, c]) => c === 0) && wiped.length === SHOP_ROWS.length, JSON.stringify(wiped));
  /* B の行は消える前も後も数えに入らない */
  assert.ok(raw.prepare("SELECT COUNT(*) AS n FROM rosters WHERE shop = ?").get(B).n === 1);
  assert.ok(Object.values(Object.fromEntries(run(checkSql(B, { before: true })))).every(c => c > 0));
  tableNames(raw).forEach(t => raw.exec(`DELETE FROM ${t}`));
});

test('入力: お店の id は SHOP_ID の形だけ。引用符・: ・大文字・長すぎ・空・見本の default は、どの道具の文にも入れずに止める', () => {
  ['a\'b', "a'; DROP TABLE rosters; --", 'A', 'a:b', 'a b', '', 'x'.repeat(41), 'default', undefined, null, 12, 'a\n'].forEach(bad => {
    assert.throws(() => shopOf(bad), /--shop|見本/, JSON.stringify(bad));
    assert.throws(() => wipeSql(bad));
    assert.throws(() => checkSql(bad));
    assert.throws(() => kvKeys('[]', 'BACKUP', bad));
  });
  assert.equal(shopOf('shop-a1'), 'shop-a1');
  assert.ok(SHOP_ID.test(A));
  assert.ok(wipeSql('x').every(s => /^DELETE FROM \w+ WHERE [^;]+;$/.test(s)), '1 文 1 行');
  assert.throws(() => kvKeys('[]', 'OTHER', A), /--binding/);
});

/* ---------- 3. KV ---------- */

test('KV: 消すキーは、本物の dailyBackup・reserve・spend が書いたそのお店のキーを全部覆い、名前の似たお店と cron:last に当たらない', async () => {
  const names = { BACKUP: new Set(), BUDGET: new Set() };
  const backup = fakeKv();
  const budget = fakeKv();
  const T0 = Date.parse('2026-10-27T15:30:00Z');   // 日本で 10/28 の 0:30
  for (const shop of [A, B, 'shop-b']) {
    const db = fakeD1();
    const env = { DB: db, BACKUP: backup, BUDGET: budget };
    const io = { clock: T0, now: () => io.clock };
    db.rows.set(shop, { version: 1, state: JSON.stringify({ people: [{}, {}, {}, {}, {}, {}, {}, {}] }), updated_at: 'x' });
    db.past.set(`${shop}\ntrip:t1`, { shop, part: 'trip:t1', day: '2026-09-01', keep_until: '2027-09-01', body: '{}', moved_at: '2026-10-20T00:00:00.000Z' });
    await dailyBackup(env, io, shop, {});
    /* 翌日に名簿の行が消えると、警報（alert:）も残る */
    db.rows.delete(shop);
    io.clock = T0 + 86400000;
    await dailyBackup(env, io, shop, {});
    const keys = { day: '2026-10-28', month: '2026-10', shop };
    assert.deepEqual(await reserve(budget, keys, { day: 100, monthMicro: 1e9 }), { ok: true });
    await spend(budget, keys, 1234);
  }
  await budget.put('cron:last', '{}');
  const keysOf = (kv) => kv.puts.map(p => p.k);
  const seen = (binding, kv) => {
    const all = [...new Set(keysOf(kv))];
    const list = JSON.stringify(all.map(name => ({ name, expiration: 1 })));
    const got = kvKeys(list, binding, A);
    /* 道具の規則とは別に、キーを見て決める: A のキーは 2 つ目の欄が A */
    const mine = all.filter(k => k.split(':')[1] === A).sort();
    assert.deepEqual(got.keys, mine, `${binding}: そのお店のキーを全部、ほかのお店のキーは 1 つも選ばない`);
    return { all, mine };
  };
  const b = seen('BACKUP', backup);
  const u = seen('BUDGET', budget);
  ['day:', 'past:', 'alert:', 'pastcursor:'].forEach(p => assert.ok(b.mine.some(k => k.startsWith(p)), `見本に BACKUP の ${p} が無い`));
  ['day:', 'month:'].forEach(p => assert.ok(u.mine.some(k => k.startsWith(p)), `見本に BUDGET の ${p} が無い`));
  assert.ok(u.all.includes('cron:last') && !kvKeys(JSON.stringify(u.all), 'BUDGET', A).keys.includes('cron:last'));
  assert.ok(b.all.some(k => k.includes(`:${B}`)), '名前が A で始まるお店のキーも見本にある');
  assert.deepEqual(KV_BINDINGS, ['BACKUP', 'BUDGET']);
});

test('KV: 一覧の形は wrangler の出力でも API の答えでも読める。読めない形は止める。消したあとの一覧は 0 件', () => {
  const list = [{ name: `day:${A}:2026-10-28` }, { name: `day:${B}:2026-10-28` }];
  assert.deepEqual(namesOf(JSON.stringify(list)), list.map(x => x.name));
  assert.deepEqual(namesOf(JSON.stringify({ result: list, success: true })), list.map(x => x.name));
  assert.deepEqual(namesOf('["a"]'), ['a']);
  assert.throws(() => namesOf('{'), /JSON/);
  assert.throws(() => namesOf('{"x":1}'), /形/);
  assert.throws(() => namesOf('[{"nom":"a"}]'), /name/);
  assert.deepEqual(kvKeys(JSON.stringify(list), 'BACKUP', A).keys, [`day:${A}:2026-10-28`]);
  assert.deepEqual(kvKeys(JSON.stringify([list[1]]), 'BACKUP', A).keys, [], '消したあと');
  assert.deepEqual(kvKeys('[]', 'BUDGET', A), { keys: [], by: { [`day:${A}:`]: 0, [`month:${A}:`]: 0 } });
});

/* ---------- 4. CSV ---------- */

/* 簡単な CSV の読み取り（引用符・"" ・CRLF）。BOM は外す */
function parseCsv(text) {
  const rows = [[]];
  let cell = '';
  let quoted = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (quoted) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i += 1; } else if (c === '"') quoted = false; else cell += c; }
    else if (c === '"') quoted = true;
    else if (c === ',') { rows[rows.length - 1].push(cell); cell = ''; }
    else if (c === '\r') { /* 次の \n で改行 */ }
    else if (c === '\n') { rows[rows.length - 1].push(cell); cell = ''; rows.push([]); }
    else cell += c;
  }
  assert.equal(cell, '', '最後は改行で終わる');
  rows.pop();
  return rows;
}

const DIVE_HEADER = ['氏名', '生年月日', '住所', '緊急時の連絡先', '認定証取得年月日', '講習受講歴', '潜水経験', '最後に潜水をした日', '既往症', '当日の健康状態', '潜水日時', '潜水場所', 'ガイドダイバーの氏名'];
const TODAY = '2026-10-27';
const AT = '2026-10-20T01:00:00.000Z';
const big = (state, day) => X.addBigSample(state, { day, at: AT, newId }).state;

/* 8/1・9/1 のダイビング便（済んで 7 日を過ぎた）、9/15 のスノーケリング便、10/24 のダイビング便、日付の無い便 */
function sample() {
  let st = big(big(big(S.blankState(OWN), '2026-09-01'), '2026-08-01'), '2026-10-24');
  const made = C.addTrip(st, { trip: { date: '2026-09-15', start: '09:00', kind: 'snorkel', tour: 'スノーケル' }, at: AT, newId });
  st = C.addBooking(made.state, { trip: made.trip, booking: { source: 'phone', people: 1, leadName: '見本 スノ', leadPhone: '090-0000-0000' }, src: 'staff', at: AT, newId });
  const person = st.people[st.people.length - 1];
  st = C.editPerson(st, { id: person.id, patch: { name: '=SUM(1)スノ' }, who: 'staff', at: AT });
  return C.addTrip(st, { trip: { date: '', kind: 'dive', tour: '日付未定' }, at: AT, newId }).state;
}
/* D1 の答えの形（Cloudflare の API）にする */
const api = (rows) => JSON.stringify({ result: [{ results: rows, success: true }], success: true });
function d1Rows(st) {
  const { state: live, parts } = splitPast(st, { today: TODAY, tag: 'v1' });
  return { live, parts, liveRows: [{ state: JSON.stringify(live) }], pastRows: parts.map(p => ({ part: p.part, day: p.day, body: p.body })) };
}
const ownPeople = (st) => st.people.filter(p => !C.isPartnerBooking(st.bookings.find(b => b.id === p.bookingId))).length;

test('CSV: 今の名簿と済んだ便を日付の順に 1 つにし、元の名簿（分ける前）から作った物と同じ。ほかの店の乗り合いのお客さんは入れない', () => {
  const st = sample();
  const { live, parts, liveRows, pastRows } = d1Rows(st);
  assert.ok(parts.length >= 3 && live.trips.length === 2, `済んだ便に移っている (${parts.length}, ${live.trips.length})`);
  const split = stateOf(liveRows, pastRows, 'shop-a');
  assert.equal(split.skipped, 0);
  const whole = stateOf([{ state: JSON.stringify(st) }], [], 'shop-a').state;
  const out = offboardCsv(split.state);
  assert.equal(out.csv, offboardCsv(whole).csv, '分ける前の名簿から作った物と同じ');
  assert.equal(out.trips, 5);
  assert.equal(out.people, ownPeople(st));
  assert.ok(out.csv.startsWith('﻿') && out.csv.includes('\r\n'), '画面の CSV と同じ（BOM つき・CRLF）');
  const rows = parseCsv(out.csv);
  const header = rows[0];
  assert.deepEqual(header, ['氏名', '生年月日', '住所', '緊急時の連絡先', '認定証取得年月日', '講習受講歴', '潜水経験／スノーケリング経験', '最後に潜水をした日／最後にスノーケリングをした日',
    '既往症', '当日の健康状態', '潜水日時／スノーケリング日時', '潜水場所／スノーケリング場所', 'ガイドダイバーの氏名／ガイドの氏名'], '種類で名前が違う列は「／」でつなぐ');
  assert.equal(rows.length - 1, out.people);
  assert.ok(rows.every(r => r.length === header.length), '全部の行が同じ列数');
  const whenAt = header.indexOf('潜水日時／スノーケリング日時');
  const days = rows.slice(1).map(r => r[whenAt].slice(0, 10));
  assert.deepEqual(days, [...days].sort(), '便の日付の順');
  assert.deepEqual([...new Set(days)], ['2026/08/01', '2026/09/01', '2026/09/15', '2026/10/24']);
  const names = rows.slice(1).map(r => r[0]);
  assert.ok(names.includes('見本 健'), 'この店のお客さん');
  assert.ok(!names.includes('Lena Fischer') && !names.some(x => /Fischer/.test(x)), '乗り合いの他のお店のお客さんは入れない');
  assert.equal(names.filter(x => x === '見本 健').length, 3, '3 つの便（済んだ便 2 つと今の便）の分');
  const sno = rows.find(r => r[whenAt].startsWith('2026/09/15'));
  assert.equal(sno[0], "'=SUM(1)スノ", '表計算で式として動かないように、画面の CSV と同じ印を付ける');
  assert.equal(sno[header.indexOf('認定証取得年月日')], '', 'スノーケリングに無い列は空');
});

test('CSV: ダイビングだけなら列は条例の 13 項目で画面の CSV と同じ。--no-health は健康の 2 欄を外す', () => {
  let st = big(S.blankState(OWN), '2026-09-01');
  st = big(st, '2026-10-24');
  const { liveRows, pastRows } = d1Rows(st);
  const state = stateOf(liveRows, pastRows, 'shop-a').state;
  assert.deepEqual(parseCsv(offboardCsv(state).csv)[0], DIVE_HEADER);
  assert.equal(DIVE_HEADER.length, 13);
  const noHealth = parseCsv(offboardCsv(state, { health: false }).csv);
  assert.deepEqual(noHealth[0], DIVE_HEADER.filter(h => h !== '既往症' && h !== '当日の健康状態'));
  /* 画面の CSV と同じ行: 1 つの便だけを画面と同じ関数で作った物が、そのまま入っている */
  const trip = state.trips.find(t => t.date === '2026-10-24');
  const table = C.rosterRows(state, trip.id, HEALTH_SHORT, { own: true });
  const one = parseCsv(C.toCsv(table));
  const all = parseCsv(offboardCsv(state).csv);
  one.slice(1).forEach(r => assert.ok(all.some(a => JSON.stringify(a) === JSON.stringify(r)), `画面の CSV の行が入っている: ${r[0]}`));
  /* 名簿が空のお店でも、見出しだけの CSV ができる */
  assert.deepEqual(parseCsv(offboardCsv(stateOf([], [], 'shop-a').state).csv), [DIVE_HEADER]);
  /* 健康の短い名前は、画面（js/data.js の R.HEALTH）と同じ */
  assert.deepEqual([...readFileSync(new URL('../js/data.js', import.meta.url), 'utf8').matchAll(/short: '([^']+)'/g)].map(m => m[1]), HEALTH_SHORT);
});

test('CSV: D1 の答えは 3 つの形（API・wrangler --json・行の配列）で読める。読めない済んだ便の行・二重の便は黙って落とさない', () => {
  const rows = [{ state: '{}' }];
  assert.deepEqual(rowsOf(api(rows)), rows);
  assert.deepEqual(rowsOf(JSON.stringify([{ results: rows, success: true }])), rows);
  assert.deepEqual(rowsOf(JSON.stringify(rows)), rows);
  assert.deepEqual(rowsOf(api([])), []);
  assert.deepEqual(rowsOf('[]'), []);
  assert.throws(() => rowsOf('{"a":1}'), /形/);
  assert.throws(() => rowsOf('x'), /JSON/);
  const st = sample();
  const { liveRows, pastRows } = d1Rows(st);
  const bad = stateOf(liveRows, [...pastRows, { part: 'trip:zzz', day: '2026-01-01', body: '{"v":1}' }], 'shop-a');
  assert.equal(bad.skipped, 1);
  assert.throws(() => stateOf([{ state: '{broken' }], [], 'shop-a'), /名簿が読めない/);
  assert.throws(() => stateOf([{ state: '{"v":2}' }], [], 'shop-a'), /検査に通らない/);
  /* 今の名簿と済んだ便に同じ便がある（古い写しからの書き込み）と、人が二重になるので止める */
  const live = { ...splitPast(st, { today: TODAY, tag: 'v1' }).state };
  const dup = pastRows.find(r => r.part.startsWith('trip:'));
  const tripOfDup = JSON.parse(dup.body).trip;
  assert.throws(() => stateOf([{ state: JSON.stringify({ ...live, trips: [...live.trips, tripOfDup] }) }], pastRows, 'shop-a'), /二重/);
});

/* ---------- コマンドとして ---------- */

const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('コマンド: csv は --out に BOM つきで書く。読めない行があれば止まる（--allow-skipped で通す）。wipe・check・kv の引数の誤りは 1 で終わる', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offboard-'));
  const st = sample();
  const { liveRows, pastRows } = d1Rows(st);
  const f = (name, text) => { writeFileSync(join(dir, name), text); return join(dir, name); };
  const live = f('live.json', api(liveRows));
  const past = f('past.json', api(pastRows));
  const out = join(dir, 'shop-a.csv');
  const ok = run('csv', '--shop', A, '--live', live, '--past', past, '--out', out);
  assert.equal(ok.status, 0, ok.stderr);
  const bytes = readFileSync(out);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'BOM つきの UTF-8');
  assert.equal(parseCsv(bytes.toString('utf8')).length - 1, ownPeople(st));
  assert.match(ok.stderr, /便 5 本・お客さん \d+ 人/);
  const stdout = run('csv', '--shop', A, '--live', live, '--past', past, '--no-health');
  assert.equal(stdout.status, 0);
  assert.ok(!parseCsv(stdout.stdout)[0].includes('既往症'));
  /* 読めない行 */
  const brokenPast = f('broken.json', api([...pastRows, { part: 'trip:zzz', day: '2026-01-01', body: '{"v":1}' }]));
  const stop = run('csv', '--shop', A, '--live', live, '--past', brokenPast, '--out', join(dir, 'no.csv'));
  assert.equal(stop.status, 1);
  assert.match(stop.stderr, /--allow-skipped/);
  assert.equal(run('csv', '--shop', A, '--live', live, '--past', brokenPast, '--allow-skipped', '--out', join(dir, 'yes.csv')).status, 0);
  /* wipe・check は出た文がそのまま関数の物 */
  const wipe = run('wipe', '--shop', A);
  assert.equal(wipe.status, 0);
  assert.equal(wipe.stdout.trim(), wipeSql(A).join('\n'));
  assert.equal(run('check', '--shop', A).stdout.trim(), checkSql(A));
  assert.equal(run('check', '--shop', A, '--before').stdout.trim(), checkSql(A, { before: true }));
  /* 引数の誤り */
  ['wipe', 'check'].forEach(c => {
    assert.equal(run(c).status, 1, `${c}: --shop が無い`);
    assert.equal(run(c, '--shop', "a'b").status, 1);
    assert.equal(run(c, '--shop', 'default').status, 1);
  });
  assert.equal(run('csv', '--shop', A, '--live', live).status, 1, '--past が無い');
  assert.equal(run('wipe', '--shop', A, '--nani').status, 1);
  assert.equal(run('nani').status, 1);
  assert.equal(run('wipe', '--shop').status, 1, '値が無い');
  /* kv: 一覧を渡すと消すキーの JSON が標準出力に出る。--verify は残っていれば 1、無ければ 0 */
  const keys = f('keys.json', JSON.stringify([{ name: `day:${A}:2026-10-28` }, { name: `past:${A}:trip:t1` }, { name: `pastcursor:${A}` }, { name: `day:${B}:2026-10-28` }, { name: 'cron:last' }]));
  const kv = run('kv', '--shop', A, '--binding', 'BACKUP', '--list', keys);
  assert.equal(kv.status, 0, kv.stderr);
  assert.deepEqual(JSON.parse(kv.stdout), [`day:${A}:2026-10-28`, `past:${A}:trip:t1`, `pastcursor:${A}`].sort());
  assert.equal(run('kv', '--shop', A, '--binding', 'BACKUP', '--list', keys, '--verify').status, 1, '残っている');
  const empty = f('empty.json', '[]');
  assert.equal(run('kv', '--shop', A, '--binding', 'BACKUP', '--list', empty, '--verify').status, 0);
  const budget = run('kv', '--shop', A, '--binding', 'BUDGET', '--list', keys);
  assert.deepEqual(JSON.parse(budget.stdout), [`day:${A}:2026-10-28`], 'BUDGET の規則に当たるのは day: だけ（past: と pastcursor: は BACKUP のキー）');
  assert.equal(run('kv', '--shop', A, '--binding', 'X', '--list', keys).status, 1);
  assert.deepEqual(parseArgs(['csv', '--shop', 'a', '--no-health', '--allow-skipped']), { cmd: 'csv', shop: 'a', noHealth: true, allowSkipped: true });
});

/* ---------- 5. 手順書 ---------- */

test('手順書: docs/deploy.md の 10 に、道具の使い方と D1 から取る文があり、9 つの手順が（CSV → 渡して確かめる → 控える → 消す → 残りの確認 → KV → Time Travel → Access → Email Routing）の順', () => {
  const doc = readFileSync(new URL('../docs/deploy.md', import.meta.url), 'utf8');
  const at = doc.indexOf('## 10. 試用をやめたお店の後始末');
  assert.ok(at > 0, '節がある');
  const next = doc.indexOf('\n## ', at + 5);
  const sec = doc.slice(at, next < 0 ? undefined : next);
  [LIVE_SQL, PAST_SQL].forEach(sql => assert.ok(sec.includes(sql), `D1 から取る文が手順書にある: ${sql}`));
  ['offboard.mjs csv', 'offboard.mjs wipe', 'offboard.mjs check', 'offboard.mjs kv', '--verify', 'kv key list --binding $B', 'kv bulk delete', 'ALLOWED_EMAILS'].forEach(c => assert.ok(sec.includes(c), `手順書に ${c}`));
  KV_BINDINGS.forEach(b => assert.ok(sec.includes(b), `手順書に ${b}`));
  assert.ok(sec.includes(`出た ${SHOP_ROWS.length} 文`) && sec.includes(`表は ${SHOP_ROWS.length} 行`), '消す文・数える行の数が道具と合う');
  assert.match(sec, /消した日 \+ 30 日/);
  assert.match(sec, /やめた日のうちに/);
  /* 番号つきの手順が、この順に 9 つ */
  const steps = sec.split(/\n(?=\d+\. )/).slice(1);
  const markers = ['offboard.mjs csv', 'お店に確かめ', '--before', 'offboard.mjs wipe', '全部の n が 0', 'offboard.mjs kv', 'Time Travel は消せない', 'Access から外す', 'Email Routing'];
  assert.equal(steps.length, markers.length, '手順の数');
  markers.forEach((m, k) => assert.ok(steps[k].startsWith(`${k + 1}. `) && steps[k].includes(m), `${k + 1} 番目の手順に「${m}」`));
});

test('KV: 一覧が 1000 件ちょうど（途中で切れている恐れ）のときは、「残っていない」と見誤らず止める', () => {
  const dir = mkdtempSync(join(tmpdir(), 'offboard-'));
  const list = (count) => { const file = join(dir, `l${count}.json`); writeFileSync(file, JSON.stringify(Array.from({ length: count }, (_, i) => ({ name: `day:shop-z:${i}` })))); return file; };
  const cut = run('kv', '--shop', A, '--binding', 'BACKUP', '--list', list(1000), '--verify');
  assert.equal(cut.status, 1);
  assert.match(cut.stderr, /途中で切れている恐れ/);
  assert.equal(run('kv', '--shop', A, '--binding', 'BACKUP', '--list', list(999), '--verify').status, 0);
});

let failed = 0;
for (const t of tests) {
  try {
    const out = await t.fn();
    console.log(`${out === 'skip' ? 'skip' : 'ok  '} ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.stack}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
