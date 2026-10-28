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
import { getRoster, putRoster, getPast, getMovedSince } from '../worker/roster-db.mjs';
import { putLink, findLink, countLinks, useLink, dropExpired } from '../worker/ask-db.mjs';
import { listShops, rosterShops } from '../worker/shop-db.mjs';
import { addUnread, listUnread, dropUnread } from '../worker/unread-db.mjs';
import { takeDaily, takeDailyAll, dropOldCounts } from '../worker/limit-db.mjs';
import { putWalkinKey, findWalkinShop, walkinKeyAt, addWalkin, listWalkins, dropWalkin, dropExpiredWalkins } from '../worker/walkin-db.mjs';
import { checkPut } from '../worker/sync-core.mjs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';

const first = await sqliteD1();
/* node:sqlite が無い Node では、何も確かめずに通さない（SKIP_SQLITE=1 を付けたときだけ飛ばす） */
if (!first) { console.log(process.env.SKIP_SQLITE === '1' ? 'skip (node:sqlite が無い)' : 'FAIL node:sqlite が無い（Node 22.5 以上で流す）'); process.exit(process.env.SKIP_SQLITE === '1' ? 0 : 1); }

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
  await log('moved-since', getMovedSince(db, 'shop-a', '2026-10-26T00:00:00.000Z', 100).then(rows => rows.map(r => [r.part.split(':')[0], r.day, r.keepUntil])));
  await log('moved-later', getMovedSince(db, 'shop-a', '2026-10-28T00:00:00.000Z', 100));
  await log('link-put', putLink(db, { hash: 'h1', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-put-again', putLink(db, { hash: 'h2', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-person', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-dup', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-find-old', findLink(db, 'h1'));
  await log('link-find', findLink(db, 'h2'));
  await log('link-count', countLinks(db, { shop: 'shop-a', bookingId: 'b1', personId: '', today: '2026-10-01' }));
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
  for (let i = 0; i < 4; i += 1) await log(`daily-${i}`, takeDaily(db, { scope: 'site', shop: 'shop-a', day: TODAY, max: 3 }));
  await log('daily-other-shop', takeDaily(db, { scope: 'site', shop: 'shop-b', day: TODAY, max: 3 }));
  await log('daily-other-scope', takeDaily(db, { scope: 'mail', shop: 'shop-a', day: TODAY, max: 3 }));
  await log('daily-next-day', takeDaily(db, { scope: 'site', shop: 'shop-a', day: '2026-10-28', max: 3 }));
  await log('daily-zero-max', takeDaily(db, { scope: 'site', shop: 'shop-c', day: TODAY, max: 0 }));
  for (let i = 0; i < 3; i += 1) await log(`daily-all-${i}`, takeDailyAll(db, { scope: 'mail', shop: 'shop-b', day: TODAY, max: 2, maxAll: 1 }));
  await log('daily-all-shop-full', takeDaily(db, { scope: 'mail', shop: 'shop-b', day: TODAY, max: 2 }));
  await log('daily-drop', dropOldCounts(db, '2026-10-28'));
  await log('daily-after-drop', takeDaily(db, { scope: 'site', shop: 'shop-a', day: TODAY, max: 1 }));
  await log('daily-keep-today', takeDaily(db, { scope: 'site', shop: 'shop-a', day: '2026-10-28', max: 1 }));
  /* 店頭の QR（0007）: 鍵の SHA-256 は 1 つのお店に 1 つ、作り直すと前の鍵は開けない。同じ SHA-256 を別のお店には置けない */
  await log('walkin-key-none', findWalkinShop(db, 'w1'));
  await log('walkin-key-at-none', walkinKeyAt(db, 'shop-a'));
  await log('walkin-key-put', putWalkinKey(db, { shop: 'shop-a', hash: 'w1', at: AT }));
  await log('walkin-key-find', findWalkinShop(db, 'w1'));
  await log('walkin-key-at', walkinKeyAt(db, 'shop-a'));
  await log('walkin-key-rotate', putWalkinKey(db, { shop: 'shop-a', hash: 'w2', at: '2026-10-27T02:00:00.000Z' }));
  await log('walkin-key-old', findWalkinShop(db, 'w1'));
  await log('walkin-key-new', findWalkinShop(db, 'w2'));
  await log('walkin-key-other-shop-dup', putWalkinKey(db, { shop: 'shop-b', hash: 'w2', at: AT }));
  await log('walkin-add-1', addWalkin(db, { shop: 'shop-a', id: 'x1', tripId: 't1', body: '{"a":1}', at: AT, expiresOn: '2026-10-29' }));
  await log('walkin-add-2', addWalkin(db, { shop: 'shop-a', id: 'x2', tripId: '', body: '{"a":2}', at: '2026-10-27T02:00:00.000Z', expiresOn: '2026-10-27' }));
  await log('walkin-add-dup', addWalkin(db, { shop: 'shop-a', id: 'x1', tripId: '', body: '{}', at: AT, expiresOn: '2026-10-29' }));
  await log('walkin-list', listWalkins(db, 'shop-a', TODAY, 50));
  await log('walkin-list-limit', listWalkins(db, 'shop-a', TODAY, 1));
  await log('walkin-list-later', listWalkins(db, 'shop-a', '2026-10-28', 50));
  await log('walkin-list-other', listWalkins(db, 'shop-b', TODAY, 50));
  await log('walkin-drop', dropWalkin(db, 'shop-a', 'x1'));
  await log('walkin-drop-again', dropWalkin(db, 'shop-a', 'x1'));
  await log('walkin-drop-other-shop', dropWalkin(db, 'shop-b', 'x2'));
  await log('walkin-expire', dropExpiredWalkins(db, '2026-10-28').then(() => listWalkins(db, 'shop-a', '2000-01-01', 50)));
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

test('1 日の回数（0006）: 上限ちょうどで止め、お店・scope・日で別に数える。同時に何件来ても上限を超えない', async () => {
  const db = await sqliteD1();
  const take = (shop, max = 30, day = TODAY) => takeDaily(db, { scope: 'site', shop, day, max });
  const burst = await Promise.all(Array.from({ length: 50 }, () => take('shop-a')));
  assert.equal(burst.filter(Boolean).length, 30, '50 件を一度に呼んでも通るのは 30 件（読んでから書く 2 手ではなく 1 文なので、間に別の呼び出しが入っても超えない）');
  assert.equal(db.raw.prepare("SELECT n FROM daily_counts WHERE scope = 'site' AND shop = 'shop-a'").get().n, 30, '数えた値は上限と同じ（超えて書かない）');
  assert.equal(await take('shop-b'), true, '別のお店は別に数える');
  assert.equal(await take('shop-a', 30, '2026-10-28'), true, '日が変われば戻る');
  assert.equal(await take('shop-a', 31), true, '上限が上がれば通る');
  assert.equal(await take('shop-a', 31), false);
  assert.equal(await take('shop-z', 0), false, '上限 0 は何も通さず、行も作らない');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_counts WHERE shop = 'shop-z'").get().n, 0);
  const failing = fakeD1();
  failing.failing = true;
  await assert.rejects(takeDaily(failing, { scope: 'site', shop: 'x', day: TODAY, max: 1 }), /d1 down/, 'D1 の不調は「上限に届いた」と見分けて例外にする');
});

test('migration 0006: 2 店が同じ受け口（大文字小文字・空白違いも）を持つ行は入らない。空の受け口は何店でもよい', async () => {
  const db = await sqliteD1();
  db.addShop({ id: 'shop-a', name: 'A', inbox: 'a@yoyaku.example' });
  db.addShop({ id: 'shop-b', name: 'B', inbox: '' });
  db.addShop({ id: 'shop-c', name: 'C', inbox: '  ' });
  assert.throws(() => db.addShop({ id: 'shop-d', name: 'D', inbox: ' A@Yoyaku.example' }), /UNIQUE/);
  assert.equal((await listShops(db, {})).length, 3);
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
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL, DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, SINGLE_SHOP: 'default' };
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
