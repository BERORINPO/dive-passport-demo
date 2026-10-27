// D1 の文を本物の SQLite（node:sqlite）で流す（ジンのレビュー 2026-10-27 MEDIUM 11: fakeD1 は SQL を文字で照らすだけで、表を作る SQL も一度も流れていなかった）。
// 1. 同じ操作を fakeD1 と SQLite の両方に流し、答えが同じかを比べる（fakeD1 が本物とずれたら、ここで落ちる）
// 2. adapter（worker/*-db.mjs）の SQL が全部、SQLite で 1 回は流れたかを確かめる（文を足したのにここを足し忘れたら落ちる）
// 3. 名簿・済んだ便・読めなかった予約メールを、本物の handler から SQLite につないで通しで動かす
// 実行: node test/d1-sql.test.mjs （node:sqlite が無い Node では全部飛ばす）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { sqliteD1 } from './d1-sqlite.mjs';
import { fakeD1, fakeKv, fakeAccess, checkRedirect } from '../worker/fakes.mjs';
import { getRoster, putRoster, getPast } from '../worker/roster-db.mjs';
import { putLink, findLink, countLinks, useLink, dropExpired } from '../worker/ask-db.mjs';
import { listShops, rosterShops } from '../worker/shop-db.mjs';
import { addUnread, listUnread, dropUnread } from '../worker/unread-db.mjs';
import { checkPut } from '../worker/sync-core.mjs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';

const first = await sqliteD1();
if (!first) { console.log('skip (node:sqlite が無い)'); process.exit(0); }

vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterShare: X } = R;
const TODAY = '2026-10-27';
const AT = '2026-10-27T01:00:00.000Z';
let n = 0;
const newId = () => `id${(n += 1)}`;
const sample = () => {
  n = 0;
  let st = X.addBigSample(S.blankState('B マリン（見本）'), { day: '2026-10-01', at: '2026-09-30T01:00:00.000Z', newId }).state;
  st = X.addBigSample(st, { day: '2026-10-29', at: AT, newId }).state;
  return st;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* fakeD1 と SQLite に同じ操作を流し、答えを並べる */
async function scenario(db) {
  const out = [];
  const log = async (label, p) => { try { out.push([label, await p]); } catch (e) { out.push([label, 'throw']); } };
  await log('shops-empty', listShops(db));
  db.addShop({ id: 'shop-a', name: 'A ダイブ', members: ['a@example.com'], sites: ['https://a.example.com'], inbox: '', senders: [] });
  await log('shops', listShops(db));
  await log('roster-none', getRoster(db, 'shop-a'));
  const c1 = checkPut({ base: 0, state: sample() }, { today: TODAY, at: AT });
  await log('put-0', putRoster(db, 'shop-a', 0, c1.text, AT, { parts: c1.parts, today: TODAY }));
  await log('put-0-again', putRoster(db, 'shop-a', 0, c1.text, AT, { parts: c1.parts, today: TODAY }));
  await log('put-stale', putRoster(db, 'shop-a', 5, c1.text, AT));
  await log('put-1', putRoster(db, 'shop-a', 1, c1.text, AT));
  await log('roster', getRoster(db, 'shop-a').then(r => ({ version: r.version, size: r.text.length })));
  await log('roster-shops', rosterShops(db));
  await log('past', getPast(db, 'shop-a', '2026-09-27', TODAY, TODAY, 400).then(rows => rows.map(r => [r.part.split(':')[0], r.day, r.body.length])));
  await log('past-other-shop', getPast(db, 'shop-b', '2026-09-27', TODAY, TODAY, 400));
  await log('past-limit', getPast(db, 'shop-a', '2026-09-27', TODAY, TODAY, 1).then(rows => rows.length));
  await log('link-put', putLink(db, { hash: 'h1', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-put-again', putLink(db, { hash: 'h2', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-person', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-dup', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-find-old', findLink(db, 'h1'));
  await log('link-find', findLink(db, 'h2'));
  await log('link-count', countLinks(db, { shop: 'shop-a', bookingId: 'b1', personId: '' }));
  for (let i = 0; i < 4; i += 1) await log(`link-use-${i}`, useLink(db, 'h2', TODAY, 3));
  await log('link-use-next-day', useLink(db, 'h2', '2026-10-28', 3));
  await log('link-drop', dropExpired(db, TODAY));
  await log('link-after-drop', findLink(db, 'h3'));
  await log('unread-add', addUnread(db, 'shop-a', { id: 'u1', at: '2026-10-27T01:00:00.000Z', why: 'ai', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-add-2', addUnread(db, 'shop-a', { id: 'u2', at: '2026-10-27T02:00:00.000Z', why: 'text', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-same-id', addUnread(db, 'shop-a', { id: 'u2', at: '2026-10-27T03:00:00.000Z', why: 'many', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-list', listUnread(db, 'shop-a', '2026-09-27T00:00:00.000Z', 50));
  await log('unread-other', listUnread(db, 'shop-b', '2026-09-27T00:00:00.000Z', 50));
  await log('unread-drop', dropUnread(db, 'shop-a', 'u1'));
  await log('unread-drop-again', dropUnread(db, 'shop-a', 'u1'));
  await log('unread-old-gone', addUnread(db, 'shop-a', { id: 'u3', at: '2026-10-27T04:00:00.000Z', why: 'ai', before: '2026-10-27T03:00:00.000Z' }).then(() => listUnread(db, 'shop-a', '', 50)));
  return out;
}

test('fakeD1 と本物の SQLite に同じ操作を流すと、答えが全部同じ', async () => {
  const fake = fakeD1();
  const real = await sqliteD1();
  const a = await scenario(fake);
  const b = await scenario(real);
  assert.equal(a.length, b.length);
  a.forEach(([label, got], i) => assert.deepEqual(got, b[i][1], `${label}: fakeD1 と SQLite で答えが違う`));
});

test('adapter（worker/*-db.mjs）の SQL は、全部 SQLite で流れた', async () => {
  const real = await sqliteD1();
  await scenario(real);
  const dir = new URL('../worker/', import.meta.url);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const ran = new Set([...real.executed].map(norm));
  /* adapter のファイルの、prepare に渡した文字（直書きと、上で名前を付けた定数） */
  const missing = [];
  readdirSync(dir).filter(f => f.endsWith('-db.mjs')).forEach(f => {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const consts = Object.fromEntries([...src.matchAll(/const (\w+) = (`[^`]*`|'[^']*')/g)].map(m => [m[1], m[2].slice(1, -1)]));
    for (const m of src.matchAll(/prepare\((?:'((?:[^'\\]|\\.)*)'|(\w+))\)/g)) {
      const sql = norm(m[1] !== undefined ? m[1].replace(/\\'/g, "'") : consts[m[2]] || '');
      if (sql && !ran.has(sql)) missing.push(`${f}: ${sql.slice(0, 70)}`);
    }
  });
  assert.deepEqual(missing, [], '流れていない SQL がある（scenario に足す）');
});

test('名簿・済んだ便・読めなかった予約メールを、本物の handler から SQLite につないで通しで動かす', async () => {
  resetAccessCache();
  const TEAM = 'mihon-team.cloudflareaccess.com';
  const AUD = 'aud-0123456789abcdef';
  const EMAIL = 'mihon.member@example.com';
  const NOW = Date.parse('2026-10-27T01:00:00Z');
  const access = await fakeAccess(TEAM);
  const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
  const db = await sqliteD1();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL, DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db };
  const io = { fetch: async (url, init) => { checkRedirect(init); return new Response(JSON.stringify({ keys: access.keys }), { status: 200 }); }, now: () => NOW };
  const call = async (method, path, body) => {
    const h = { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt, ...(body ? { 'content-type': 'application/json' } : {}) };
    const res = await handle(new Request(`https://x.example${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, io);
    return { status: res.status, body: await res.json() };
  };
  const st = sample();
  const put = await call('PUT', '/api/roster', { base: 0, state: st, shop: 'default' });
  assert.equal(put.status, 200);
  assert.ok(put.body.state.trips.every(t => t.date !== '2026-10-01'));
  const got = await call('GET', '/api/roster');
  assert.equal(got.body.version, 1);
  const past = await call('GET', '/api/roster/past?from=2026-09-27&to=2026-10-27');
  assert.equal(past.body.state.trips.length, 1);
  assert.equal(past.body.skipped, 0);
  const stale = await call('PUT', '/api/roster', { base: 0, state: st });
  assert.equal(stale.status, 409);
  db.raw.prepare("INSERT INTO mail_unread (shop, id, at, why) VALUES ('default', 'u1', '2026-10-27T00:00:00.000Z', 'ai')").run();
  assert.equal((await call('GET', '/api/mail-unread')).body.items.length, 1);
  assert.equal((await call('POST', '/api/mail-unread', { id: 'u1' })).status, 200);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
