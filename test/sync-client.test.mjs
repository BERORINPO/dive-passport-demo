// 画面の名簿（js/core.js の rosterStore と js/roster-sync.js）と、サーバー（worker/handler.mjs の /api/roster）を通しで確かめる。
// 2 台の端末が同じ名簿をそろえること、同時に直しても両方残ること、電波が無いときに貯めて後で送ること、送れないうちに別の端末が直したら端末の名簿を退避すること。
// 画面のファイルは index.html と同じ順で vm に読み、fetch だけを本物の handler（D1 は fakeD1、Access は fakeAccess）へつなぐ。
// 実行: node test/sync-client.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { fakeKv, fakeAccess, fakeD1, checkRedirect } from '../worker/fakes.mjs';

const SCRIPTS = ['core.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-share.js', 'data-samples.js', 'roster-sync.js'];
const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');
const AT = '2026-10-27T01:00:00.000Z';
const PARTNER = 'C ダイブ（見本）';

const REAL_LOG = console.log;
let quiet = 0;
console.log = (...args) => { if (!quiet) REAL_LOG(...args); };
const access = await fakeAccess(TEAM);
const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

const memory = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, raw: m };
};

/* サーバー 1 つ（D1 の見本を共有）。down のときは届かない（電波が無い） */
function server() {
  resetAccessCache();
  const db = fakeD1();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db };
  const io = { fetch: async (url, init) => { checkRedirect(init); return new Response(JSON.stringify({ keys: access.keys }), { status: 200 }); }, now: () => NOW };
  const srv = { db, down: false, calls: 0 };
  /* ブラウザの fetch の代わり。Access と同じ場所からの呼び出しの印を足して、本物の handler に渡す */
  srv.fetch = async (path, init = {}) => {
    srv.calls += 1;
    if (srv.down) throw new TypeError('Failed to fetch');
    const headers = { ...(init.headers || {}), 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt };
    /* Worker の 1 行のログは出さない（同時に呼んでも、元の console.log に戻す） */
    quiet += 1;
    try { return await handle(new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body }), env, io); } finally { quiet -= 1; }
  };
  return srv;
}

/* 端末 1 台。同じ localStorage で読み直せば、開き直したのと同じ */
function device(srv, local = memory()) {
  const ctx = vm.createContext({ localStorage: local, sessionStorage: memory(), setTimeout, clearTimeout, AbortController, TextEncoder, btoa, console,
    addEventListener: () => {}, fetch: (p, init) => srv.fetch(p, init) });
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  ctx.REDUX.local = local;
  return ctx.REDUX;
}

let n = 0;
const newId = () => `id${(n += 1)}`;
/* 見本メール e1 の 2 人を、3 日後の便に入れる直し（端末の時計で 1 年を過ぎた便は消えるので、日付は今日から数える） */
const addTrip = (R) => (s) => {
  const trip = { ...R.roster.blankTrip(), id: 't1', date: R.ymd(R.addDays(new Date(), 3)), start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', site: '北の根', guides: ['見本 ガイド'], createdAt: AT };
  const reading = JSON.parse(JSON.stringify(R.SAMPLE_READINGS.e1));
  return R.rosterCore.addBooking({ ...s, trips: [...s.trips, trip] }, { trip, booking: { source: 'mail', people: 2 }, reading, src: 'mail', at: AT, newId });
};
const addGuide = (R, name) => (s) => R.rosterCore.editTrip(s, { tripId: 't1', patch: { guides: [...s.trips.find(t => t.id === 't1').guides, name] }, at: AT });
const addShop = (R) => (s) => R.rosterShare.addPartner(s, { tripId: 't1', name: PARTNER, at: AT }).state;
const tripOf = (R) => R.rosterStore.get().trips.find(t => t.id === 't1');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('サーバーに名簿がまだ無いとき、最初の端末の名簿を置き、2 台目はそれを受け取る', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(addTrip(a));   // サーバーにつなぐ前に入れた予約
  assert.equal(await a.rosterStore.startSync(), true);
  assert.equal(srv.db.rows.get('default').version, 1);
  const b = device(srv);
  assert.equal(await b.rosterStore.startSync(), true);
  assert.deepEqual(b.rosterStore.get(), a.rosterStore.get());
  assert.equal(b.rosterStore.get().bookings.length, 1);
});

test('2 台で同時に直す: 後から届いた方が最新に当て直し、両方の変更が両方の端末に残る', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  const b = device(srv);
  await b.rosterStore.startSync();
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  b.rosterStore.update(addShop(b));   // a の直しを知らないまま直す
  await Promise.all([a.rosterStore.whenSynced(), b.rosterStore.whenSynced()]);
  await a.rosterStore.refresh();
  await b.rosterStore.refresh();
  for (const R of [a, b]) {
    assert.deepEqual(tripOf(R).guides, ['見本 ガイド', '見本 次郎']);
    assert.deepEqual(tripOf(R).partners, [PARTNER]);
  }
  assert.equal(srv.db.rows.get('default').version, 3);
});

test('電波が無いときは端末に貯め、つながったら送る。開き直しても、版が同じなら送る', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  srv.down = true;
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-offline');
  assert.deepEqual(tripOf(a).guides, ['見本 ガイド', '見本 次郎'], '画面と端末には残る');
  assert.equal(JSON.parse(local.getItem('redux-roster-v1-sync')).pending, true);
  /* 送れないまま閉じて、開き直す */
  srv.down = false;
  const again = device(srv, local);
  assert.equal(await again.rosterStore.startSync(), true);
  assert.equal(srv.db.rows.get('default').version, 2);
  assert.deepEqual(JSON.parse(srv.db.rows.get('default').state).trips[0].guides, ['見本 ガイド', '見本 次郎']);
  assert.equal(JSON.parse(local.getItem('redux-roster-v1-sync')).pending, false);
});

test('送れないうちに別の端末が直していたら、この端末の名簿は消さずに退避して、サーバーの名簿にする', async () => {
  const srv = server();
  const localA = memory();
  const a = device(srv, localA);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  srv.down = true;
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  srv.down = false;
  const b = device(srv);
  await b.rosterStore.startSync();
  b.rosterStore.update(addShop(b));
  await b.rosterStore.whenSynced();
  const reopened = device(srv, localA);   // a を開き直す（貯めた直しの関数は消えている）
  await reopened.rosterStore.startSync();
  assert.equal(reopened.rosterStore.note(), 'sync-kept');
  assert.deepEqual(tripOf(reopened).partners, [PARTNER], 'サーバーの名簿（b の直し）になる');
  const kept = [...localA.raw.keys()].filter(k => k.startsWith('redux-roster-v1-broken-'));
  assert.equal(kept.length, 1, 'この端末の名簿を 1 つ残す');
  assert.deepEqual(JSON.parse(localA.getItem(kept[0])).trips[0].guides, ['見本 ガイド', '見本 次郎']);
});

test('端末の退避も、便の日から 1 年を過ぎた便は消える（退避した日から数えない。ザクのレビュー 2026-10-27）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  const old = { ...a.roster.blankTrip(), id: 't0', date: a.ymd(a.addDays(new Date(), -400)), start: '08:30', kind: 'dive', tour: '体験ダイビング', createdAt: AT };
  const recent = addTrip(a)(a.roster.blankState('B マリン（見本）'));
  const backup = { ...recent, trips: [...recent.trips, old] };
  assert.ok(a.roster.validateState(backup).ok);
  const key = `redux-roster-v1-broken-${Date.now() - 1000}`;
  local.setItem(key, JSON.stringify(backup));
  device(srv, local).rosterStore.get();   // 開き直すと退避を片付ける
  const tidied = JSON.parse(local.getItem(key));
  assert.deepEqual(tidied.trips.map(t => t.id), ['t1'], '1 年を過ぎた便だけが消える');
});

test('別の端末が便を消して当てられなくなった直しは外し、知らせる', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  const b = device(srv);
  await b.rosterStore.startSync();
  b.rosterStore.update(() => b.roster.blankState('B マリン（見本）'));   // b が全部消す
  await b.rosterStore.whenSynced();
  a.rosterStore.update(addGuide(a, '見本 次郎'));   // a はまだ便があると思っている
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-dropped');
  assert.equal(a.rosterStore.get().trips.length, 0);
});

test('/api/roster が無い（GitHub Pages・D1 がまだ無い Worker）ときは、端末だけで今までどおり動く', async () => {
  const srv = server();
  srv.fetch = async () => new Response('{"error":"config"}', { status: 503 });
  const a = device(srv);
  assert.equal(await a.rosterStore.startSync(), false);
  assert.equal(a.rosterStore.synced(), false);
  a.rosterStore.update(addTrip(a));
  assert.equal(a.rosterStore.get().bookings.length, 1);
  assert.equal(a.rosterStore.note(), null);
});

test('サーバーから届いた名簿の形が合わなければ使わない', async () => {
  const srv = server();
  srv.fetch = async () => new Response(JSON.stringify({ version: 4, state: { trips: 'x' } }), { status: 200 });
  const a = device(srv);
  a.rosterStore.update(addTrip(a));
  assert.equal(await a.rosterStore.startSync(), false);
  assert.equal(a.rosterStore.get().bookings.length, 1, '端末の名簿のまま');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
