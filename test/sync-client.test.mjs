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

const SCRIPTS = ['core.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-guest.js', 'roster-day.js', 'roster-share.js', 'roster-auto.js',
  'data-samples.js', 'data-big-sample.js', 'roster-sync.js'];
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
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, SINGLE_SHOP: 'default' };
  const io = { fetch: async (url, init) => { checkRedirect(init); return new Response(JSON.stringify({ keys: access.keys }), { status: 200 }); }, now: () => NOW };
  const srv = { db, down: false, calls: 0 };
  /* ブラウザの fetch の代わり。Access と同じ場所からの呼び出しの印を足して、本物の handler に渡す */
  srv.fetch = async (path, init = {}) => {
    srv.calls += 1;
    if (srv.down) throw new TypeError('Failed to fetch');
    /* Access のログインが切れたとき: ログインの画面への転送になり、redirect: 'manual' では中身の見えない答えになる */
    if (srv.loginExpired) return { type: 'opaqueredirect', status: 0, json: async () => { throw new Error('opaque'); } };
    /* 送る直前に別の端末が書く、を作る（1 回だけ） */
    if (srv.beforePut && init.method === 'PUT') { const f = srv.beforePut; srv.beforePut = null; await f(); }
    const headers = { ...(init.headers || {}), 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt };
    if (headers['content-encoding'] === 'gzip') srv.gzipped = (srv.gzipped || 0) + 1;
    /* Worker の 1 行のログは出さない（同時に呼んでも、元の console.log に戻す） */
    quiet += 1;
    try { return await handle(new Request(ORIGIN + path, { method: init.method || 'GET', headers, body: init.body }), env, io); } finally { quiet -= 1; }
  };
  return srv;
}

/* 端末 1 台。同じ localStorage で読み直せば、開き直したのと同じ。
   R.on は window に登録された online などの受け口、R.timers は試し直しの予約（R.later）。時間は進めず、テストが 1 つずつ動かす */
function device(srv, local = memory()) {
  const on = {};
  const ctx = vm.createContext({ localStorage: local, sessionStorage: memory(), setTimeout, clearTimeout, AbortController, TextEncoder, btoa, console,
    CompressionStream, Blob, Response,
    addEventListener: (type, fn) => { (on[type] = on[type] || []).push(fn); }, fetch: (p, init) => srv.fetch(p, init) });
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.local = local;
  R.on = on;
  R.timers = [];
  R.later = (fn, ms) => { R.timers.push({ fn, ms }); return R.timers.length; };
  return R;
}

let n = 0;
const newId = () => `id${(n += 1)}`;
/* 見本メール e1 の 2 人を、3 日後の便に入れる直し（端末の時計で 1 年を過ぎた便は消えるので、日付は今日から数える） */
const addTrip = (R) => (s) => {
  const trip = { ...R.roster.blankTrip(), id: 't1', date: R.ymd(R.addDays(new Date(), 3)), start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', site: '北の根', guides: ['見本 ガイド'], createdAt: AT };
  const reading = JSON.parse(JSON.stringify(R.SAMPLE_READINGS.e1));
  return R.rosterCore.addBooking({ ...s, trips: [...s.trips, trip] }, { trip, booking: { source: 'mail', people: 2 }, reading, src: 'mail', at: AT, newId });
};
const addGuideToFirst = (R, name) => (s) => R.rosterCore.editTrip(s, { tripId: s.trips[0].id, patch: { guides: [...s.trips[0].guides, name] }, at: AT });
const addGuide = (R, name) => (s) => R.rosterCore.editTrip(s, { tripId: 't1', patch: { guides: [...s.trips.find(t => t.id === 't1').guides, name] }, at: AT });
const addShop = (R) => (s) => R.rosterShare.addPartner(s, { tripId: 't1', name: PARTNER, at: AT }).state;
const tripOf = (R) => R.rosterStore.get().trips.find(t => t.id === 't1');
/* 画面と同じ入れ方（R.rosterStore.apply）。入力の値は押した時に全部渡す */
const day3 = (R) => R.ymd(R.addDays(new Date(), 3));
const tripArgs = (R) => ({ trip: { date: day3(R), start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', site: '北の根', guides: ['見本 ガイド'] } });
const mkTrip = (R) => R.rosterStore.apply('core.addTrip', tripArgs(R)).out.trip.id;
const mkBooking = (R, booking, { tripId = '', date = day3(R), at } = {}) => R.rosterStore.apply('core.addBookingToTrip', {
  tripId, want: { date, start: '08:30', tour: '体験ダイビング（ボート2本）', kind: 'dive' }, booking: { source: 'phone', ...booking }, reading: null, src: 'staff', ...(at ? { at } : {}) });
const editSite = (R, tripId, site) => R.rosterStore.apply('core.editTrip', { tripId, patch: { site } });
const serverState = (srv) => JSON.parse(srv.db.rows.get('default').state);
const plain = (x) => JSON.parse(JSON.stringify(x));   // 別の realm（vm）で作られた物を、deepEqual で比べられる形に
const OPS = 'redux-roster-v1-ops';
const keptKeys = (local) => [...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-'));

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
  const kept = [...localA.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-'));
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
  const tidied = JSON.parse(local.getItem(key.replace('-broken-', '-kept-')));   // 名簿の形の退避は -kept- に移る
  assert.deepEqual(tidied.trips.map(t => t.id), ['t1'], '1 年を過ぎた便だけが消える');
});

test('別の端末が便を消して当てられなくなった直しは外し、知らせる（外した直しは別の場所に残す）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
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
  const kept = [...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-'));
  assert.equal(kept.length, 1, '外した直しは消さずに残す');
  assert.ok(local.getItem(kept[0]).includes('見本 次郎'), '残した名簿に外した直しが入っている');
});

test('直しの中で作った id は、送るときの当て直しでも変わらない（その id を指す後の直しが外れない）。R.newId は差し替えない', async () => {
  const srv = server();
  const a = device(srv);
  await a.rosterStore.startSync();
  const realNewId = a.newId;
  const made = mkBooking(a, { leadName: '見本 花子', people: 1 });   // 電話の予約を入れる → その予約の人数を直す、の形
  const id = made.out.state.bookings[0].id;
  a.rosterStore.apply('core.editPerson', { id: made.out.state.people[0].id, patch: { name: '見本 花子' }, who: 'staff' });
  await a.rosterStore.whenSynced();
  await a.rosterStore.refresh();
  const b = a.rosterStore.get().bookings;
  assert.equal(b.length, 1);
  assert.equal(b[0].id, id);
  assert.equal(srv.db.rows.get('default').version, 2);
  assert.equal(a.newId, realNewId, '共有の R.newId を一時的に差し替えない');
});

/* 見本の乗り合い便（30 人）を入れた端末をサーバーにつなぐ */
async function bigSynced(srv, local = memory()) {
  const a = device(srv, local);
  a.rosterStore.update(s => a.rosterShare.addBigSample(s, { day: a.ymd(a.addDays(new Date(), 3)), at: AT, newId: a.newId }).state);
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  return a;
}
const peopleOnServer = (srv) => JSON.parse(srv.db.rows.get('default').state).people.length;

test('人が大きく消える書き込みはサーバーが止め、端末はサーバーの名簿に戻して自分の名簿を残す。わざとの全消し（reset）は通る（ジンのレビュー CRITICAL）', async () => {
  const srv = server();
  await bigSynced(srv);
  const before = peopleOnServer(srv);
  assert.ok(before > 20);
  const local = memory();
  const b = device(srv, local);
  await b.rosterStore.startSync();
  b.rosterStore.update(() => b.roster.blankState('B マリン（見本）'));   // 事故: 空の名簿で上書きしようとする
  await b.rosterStore.whenSynced();
  assert.equal(peopleOnServer(srv), before, 'サーバーの名簿は消えない');
  assert.equal(b.rosterStore.note(), 'sync-shrink');
  assert.equal(b.rosterStore.get().people.length, before, '端末はサーバーの名簿に戻る');
  assert.equal([...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-')).length, 1, '端末の名簿は別の場所に残す');
  b.rosterStore.reset();   // 「デモの予約をすべて消す」
  await b.rosterStore.whenSynced();
  assert.equal(peopleOnServer(srv), 0, 'わざと消すときは通る');
});

test('端末の名簿が読めずに空から始めたら、送れなかった直しがあっても、空の名簿でサーバーを上書きしない（ジンのレビュー CRITICAL）', async () => {
  const srv = server();
  const local = memory();
  await bigSynced(srv, local);
  const before = peopleOnServer(srv);
  const meta = JSON.parse(local.getItem('redux-roster-v1-sync'));
  local.setItem('redux-roster-v1-sync', JSON.stringify({ ...meta, pending: true }));   // 送れなかった直しがある印
  local.setItem('redux-roster-v1', '{broken');   // 名簿が読めない
  const reopened = device(srv, local);
  await reopened.rosterStore.startSync();
  await reopened.rosterStore.whenSynced();
  assert.equal(peopleOnServer(srv), before);
  assert.equal(reopened.rosterStore.get().people.length, before, 'サーバーの名簿を受け取る');
});

test('ログインが切れたら「電波なし」と分けて知らせ、直しは残す。ログインし直せば送る（ジンのレビュー HIGH）', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  srv.loginExpired = true;
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-login');
  srv.loginExpired = false;
  await a.rosterStore.refresh();
  assert.equal(a.rosterStore.note(), null);
  assert.deepEqual(JSON.parse(srv.db.rows.get('default').state).trips[0].guides, ['見本 ガイド', '見本 次郎']);
});

test('サーバーが中身を断った直し（400）は送り直さず、端末の名簿を残してサーバーの名簿に戻す（ジンのレビュー HIGH）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  const calls = srv.calls;
  /* 画面の検査は通るが、サーバーの厳しい検査（名簿の余分な項目）に落ちる直し */
  a.rosterStore.update(s => ({ ...s, extra: 'x' }));
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-rejected');
  assert.equal(srv.calls, calls + 1, '1 回だけ送って、送り直さない');
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  assert.deepEqual(JSON.parse(srv.db.rows.get('default').state).trips[0].guides, ['見本 ガイド', '見本 次郎'], '後の直しは止まらない');
});

test('済んで 7 日を過ぎた便は、送るとサーバーが便ごとに分けて置き、端末の名簿から外れる。済んだ便の画面の口で読める（ジンのレビュー CRITICAL）', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(s => a.rosterShare.addBigSample(s, { day: '2026-10-01', at: AT, newId: a.newId }).state);
  a.rosterStore.update(addTrip(a));
  const kept = a.rosterStore.get().trips.find(t => t.date !== '2026-10-01').id;
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  assert.deepEqual(a.rosterStore.get().trips.map(t => t.id), [kept], '端末には先の便だけ');
  assert.equal(a.rosterStore.note(), null);
  const past = await a.rosterStore.past('2026-10-01', '2026-10-20');   // サーバーの今日は 10/27。今日より先は断る
  assert.equal(past.ok, true);
  assert.equal(past.state.people.length, 30);
  assert.equal(past.skipped, 0);
  assert.equal((await a.rosterStore.past('2026-10-01', '2027-01-31')).ok, false, '長すぎる範囲・今日より先はサーバーが断る');
  /* サーバーを使わない端末では読めない */
  const local = device({ fetch: async () => new Response('{}', { status: 404 }) });
  await local.rosterStore.startSync();
  assert.equal(JSON.stringify(await local.rosterStore.past('2026-10-01', '2026-10-20')), JSON.stringify({ ok: false, why: 'local' }));
});

test('開き直した端末の送れていなかった名簿は、送る間に別の端末が書いていたら当てない。別の端末の直しを消さず、端末の名簿は残す（ジンのレビュー 2026-10-27）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  const meta = JSON.parse(local.getItem('redux-roster-v1-sync'));
  local.setItem('redux-roster-v1-sync', JSON.stringify({ ...meta, pending: true }));   // 送れなかった直しがある印
  const b = device(srv);
  await b.rosterStore.startSync();
  srv.beforePut = async () => { b.rosterStore.update(addGuide(b, '見本 次郎')); await b.rosterStore.whenSynced(); };
  const reopened = device(srv, local);
  await reopened.rosterStore.startSync();
  await reopened.rosterStore.whenSynced();
  assert.deepEqual(JSON.parse(srv.db.rows.get('default').state).trips[0].guides, ['見本 ガイド', '見本 次郎'], '別の端末の直しが残る');
  assert.equal(reopened.rosterStore.note(), 'sync-kept');
  assert.equal([...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-')).length, 1, '端末の名簿は別の場所に残す');
});

test('ジンのレビュー HIGH 8: 端末の名簿が別のお店の物なら、ログインしたお店に送らず、端末の別の場所に残して、そのお店の名簿にする', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  assert.equal(JSON.parse(local.getItem('redux-roster-v1-sync')).shop, 'default', 'どのお店の名簿かを覚える');
  /* この端末のメールが、別のお店（shop-a）の人になった。shop-a の名簿はまだ無い */
  srv.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [EMAIL] });
  const reopened = device(srv, local);
  assert.equal(await reopened.rosterStore.startSync(), true);
  await reopened.rosterStore.whenSynced();
  assert.equal(srv.db.rows.has('shop-a'), false, 'default の名簿を shop-a に送らない');
  assert.equal(reopened.rosterStore.get().trips.length, 0, 'shop-a の名簿（空）にする');
  assert.equal(reopened.rosterStore.note(), 'sync-shop');
  assert.equal([...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-')).length, 1, '端末の名簿は別の場所に残す');
  assert.equal(JSON.parse(local.getItem('redux-roster-v1-sync')).shop, 'shop-a');
  /* shop-a で入れた直しは shop-a に届く */
  reopened.rosterStore.update(addTrip(reopened));
  await reopened.rosterStore.whenSynced();
  assert.equal(JSON.parse(srv.db.rows.get('shop-a').state).trips.length, 1);
  assert.equal(JSON.parse(srv.db.rows.get('default').state).trips.length, 1, 'default の名簿はそのまま');
});

test('ジンのレビュー HIGH 8（開いたままの画面）: ログインしたお店が途中で変わったら、前のお店の直しを送らず、取り込みもせず、端末の名簿を残して止める', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  const before = srv.db.rows.get('default').state;
  /* 別のタブで、別のお店（shop-a）の人としてログインし直した。shop-a にも同じ版の番号の名簿がある */
  srv.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [EMAIL] });
  srv.db.rows.set('shop-a', { ...srv.db.rows.get('default'), state: JSON.stringify(a.roster.blankState('A ダイブ')) });
  a.rosterStore.update(addGuide(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-shop-changed');
  assert.equal(JSON.parse(srv.db.rows.get('shop-a').state).trips.length, 0, 'shop-a の名簿に A の直しは入らない');
  assert.equal(srv.db.rows.get('default').state, before);
  assert.equal([...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-')).length, 1, '端末の直しは残す');
  const calls = srv.calls;
  a.rosterStore.update(addGuide(a, '見本 三郎'));
  await a.rosterStore.whenSynced();
  assert.equal(srv.calls, calls, '止めたあとは送らない');
  /* 取り込み（refresh）も、別のお店の名簿なら取り込まない */
  const srv2 = server();
  const b = device(srv2);
  b.rosterStore.update(addTrip(b));
  await b.rosterStore.startSync();
  await b.rosterStore.whenSynced();
  srv2.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [EMAIL] });
  srv2.db.rows.set('shop-a', { version: 5, state: JSON.stringify(b.roster.blankState('A ダイブ')), updated_at: AT });
  assert.equal(await b.rosterStore.refresh(), false);
  assert.equal(b.rosterStore.note(), 'sync-shop-changed');
  assert.equal(b.rosterStore.get().trips.length, 1, '画面は前のお店の名簿のまま（別のお店の名簿に替えない）');
});

test('ジンのレビュー HIGH 7: サーバーの名簿がこの画面より新しい版なら、つながずに読み込み直しを頼む。送る途中で 426 が来たら、端末の名簿を残して送るのを止める', async () => {
  const srv = server();
  const a = device(srv);
  a.rosterStore.update(addTrip(a));
  await a.rosterStore.startSync();
  await a.rosterStore.whenSynced();
  /* サーバーを新しい版に置き直した（新しい版のサーバーの答えを真似る） */
  const newer = JSON.parse(srv.db.rows.get('default').state);
  const newServer = { fetch: async () => new Response(JSON.stringify({ version: 9, state: { ...newer, v: newer.v + 1 }, shop: 'default' }), { status: 200 }) };
  const b = device(newServer);
  assert.equal(await b.rosterStore.startSync(), false);
  assert.equal(b.rosterStore.note(), 'sync-newer');
  /* つないだままの端末が送ると、サーバーは 426（古い版の画面）を返す。ここでは本物の handler の 426 を作るため、端末の名簿の版を 1 つ下げて送る */
  const local = memory();
  const c = device(srv, local);
  await c.rosterStore.startSync();
  const realPush = c.rosterSync.push;
  c.rosterSync.push = (base, state, opt) => realPush(base, { ...state, v: 0 }, opt);
  c.rosterStore.update(addGuide(c, '見本 次郎'));
  await c.rosterStore.whenSynced();
  assert.equal(c.rosterStore.note(), 'sync-newer');
  assert.equal([...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-kept-')).length, 1);
  const calls = srv.calls;
  c.rosterStore.update(addGuide(c, '見本 三郎'));
  await c.rosterStore.whenSynced();
  assert.equal(srv.calls, calls, '止めたあとは送らない');
});

test('ジンのレビュー MEDIUM 10: 大きな名簿は gzip で縮めて送り、サーバーがほどいて書く。壊れた gzip は 400、ほどくと大きすぎる物は 413', async () => {
  const srv = server();
  const a = await bigSynced(srv);
  assert.ok(srv.gzipped >= 1, '30 人の名簿は縮めて送った');
  a.rosterStore.update(addGuideToFirst(a, '見本 次郎'));
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), null);
  assert.ok(JSON.parse(srv.db.rows.get('default').state).trips[0].guides.includes('見本 次郎'), 'サーバーに届いた');
  const put = (body, enc) => srv.fetch('/api/roster', { method: 'PUT', headers: { 'content-type': 'application/json', 'content-encoding': enc }, body });
  const bad = new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]);
  assert.equal((await put(bad, 'gzip')).status, 400);
  const bomb = await new Response(new Blob([JSON.stringify({ base: 1, state: { pad: ' '.repeat(2000000) } })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  assert.ok(bomb.byteLength < 20000);
  assert.equal((await put(bomb, 'gzip')).status, 413, 'ほどいた後の大きさで止める');
});

test('ジンのレビュー MEDIUM 9: 退避は新しい 3 つまで。容量切れのときは、古い退避から消して名簿の本体を保存する', async () => {
  /* 中身の文字数の合計が limit を超えると書けない保存場所（ブラウザの 5 MB の見本） */
  const limited = (limit) => {
    const m = memory();
    const size = () => [...m.raw.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
    const set = m.setItem;
    m.setItem = (k, v) => {
      const old = m.raw.has(k) ? k.length + m.raw.get(k).length : 0;
      if (size() - old + k.length + String(v).length > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      set(k, v);
    };
    return m;
  };
  const local = limited(60000);
  const big = (n) => JSON.stringify({ v: 1, filler: 'x'.repeat(n) });
  const t0 = Date.now() - 60000;
  [1, 2, 3, 4, 5].forEach(i => local.raw.set(`redux-roster-v1-broken-${t0 + i}`, big(9000)));
  const a = device({ fetch: async () => new Response('{}', { status: 404 }) }, local);
  a.rosterStore.get();
  const kept = () => [...local.raw.keys()].filter(k => k.startsWith('redux-roster-v1-broken-')).sort();
  assert.deepEqual(kept(), [3, 4, 5].map(i => `redux-roster-v1-broken-${t0 + i}`), '開いたときに、新しい 3 つだけ残す');
  /* 名簿の本体が大きくなって入らない: 古い退避から消して書く */
  const saved = a.rosterStore.update(s => a.rosterShare.addBigSample(s, { day: a.ymd(a.addDays(new Date(), 3)), at: AT, newId: a.newId }).state);
  assert.equal(saved, true, '本体を保存できた');
  assert.ok(kept().length < 3, '古い退避を消した');
  assert.ok(local.raw.get('redux-roster-v1').length > 30000);
});

test('ジンのレビュー（MEDIUM 9 の直しの穴）: 送れなかった直しの退避は、容量切れの整理にはかけず、数は新しい 5 つまで（H7）。残せなければ sync-lost と知らせる', async () => {
  const srv = server();
  const local = memory();
  const a = await bigSynced(srv, local);
  const t0 = Date.now() - 60000;
  [1, 2, 3, 4, 5].forEach(i => local.raw.set(`redux-roster-v1-kept-${t0 + i}`, JSON.stringify({ v: 1, i })));
  [1, 2, 3, 4].forEach(i => local.raw.set(`redux-roster-v1-broken-${t0 + i}`, JSON.stringify({ v: 1, i })));
  /* 前の版が -broken- に残した、送れなかった直し（名簿の形をしている） */
  local.raw.set(`redux-roster-v1-broken-${t0}`, JSON.stringify(a.rosterStore.get()));
  device(srv, local).rosterStore.get();   // 開き直すと退避を片付ける
  const keys = (p) => [...local.raw.keys()].filter(k => k.startsWith(p));
  assert.equal(keys('redux-roster-v1-kept-').length, 5, '送れなかった直しの退避は新しい 5 つまで（H7）。前の版の -broken- の物は、同じ時刻のまま -kept- に移ってから数える');
  assert.ok(!local.raw.has(`redux-roster-v1-kept-${t0}`), '古い物から消える（t0 の物が最も古い）');
  assert.equal(keys('redux-roster-v1-broken-').length, 3, '読めなかった名簿の退避は 3 つまで');
  /* 容量切れで本体が書けない: 消すのは読めなかった名簿の退避だけ */
  const set = local.setItem;
  let room = 2;
  local.setItem = (k, v) => { if (k === 'redux-roster-v1' && room > 0) { room -= 1; throw new Error('QuotaExceededError'); } set(k, v); };
  a.rosterStore.update(addGuideToFirst(a, '見本 次郎'));
  local.setItem = set;
  assert.equal(keys('redux-roster-v1-kept-').length, 5, '容量切れの整理は -kept- を消さない');
  assert.ok(keys('redux-roster-v1-broken-').length < 3);
  /* 直しを残せない: sync-lost */
  const lost = memory();
  const b = await bigSynced(srv, lost);
  lost.setItem = (k, v) => { if (k.startsWith('redux-roster-v1-kept-')) throw new Error('QuotaExceededError'); lost.raw.set(k, String(v)); };
  b.rosterStore.update(() => b.roster.blankState('B マリン（見本）'));   // 人が大きく消える → サーバーが断り、端末の名簿を残そうとする
  await b.rosterStore.whenSynced();
  assert.equal(b.rosterStore.note(), 'sync-lost');
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

/* ---------- 直しの記録（op log）。電波が無いまま閉じても、開き直して当て直せる（C1・C2・H7・L4） ---------- */
test('op log: 電波が無いまま画面を閉じても、貯めた直しは端末に残り、開き直したあとにサーバーの最新の名簿へ当て直して送る', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  await a.rosterStore.startSync();
  const tripId = mkTrip(a);
  await a.rosterStore.whenSynced();
  srv.down = true;
  editSite(a, tripId, '南の根');
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.link(), 'down');
  assert.equal(a.rosterStore.pending(), 1);
  assert.deepEqual(JSON.parse(local.getItem(OPS)).ops.map(o => o.op), ['core.editTrip'], '貯めた直しは関数でなくデータで端末に置く');
  /* その間に別の端末が、別の項目を直した */
  srv.down = false;
  const b = device(srv);
  await b.rosterStore.startSync();
  b.rosterStore.apply('core.editTrip', { tripId, patch: { boat: '第一丸' } });
  await b.rosterStore.whenSynced();
  /* 画面を閉じて、開き直す（貯めた直しの関数は無い。データだけが残っている） */
  const reopened = device(srv, local);
  assert.equal(await reopened.rosterStore.startSync(), true);
  const t = serverState(srv).trips[0];
  assert.deepEqual([t.site, t.boat], ['南の根', '第一丸'], '別の端末の直しを消さず、貯めた直しも届く');
  assert.equal(reopened.rosterStore.note(), null, '退避に回さない');
  assert.equal(keptKeys(local).length, 0);
  assert.equal(local.getItem(OPS), null, '送れたら端末の貯めを空にする');
  assert.equal(reopened.rosterStore.pending(), 0);
});

test('op log: 電波が無いまま電話の予約を 2 件入れて閉じても、2 件は別の予約のままサーバーに届き、記録の時刻は押した時刻（C2・L4）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  await a.rosterStore.startSync();
  srv.down = true;
  /* 画面の電話の予約と同じ。入力の値は押した時に渡し、渡した物を画面があとで書き換えても貯めた直しは変わらない */
  const first = { leadName: '見本 一郎', people: 1 };
  mkBooking(a, first, { date: day3(a), at: '2026-10-27T01:00:00.000Z' });
  first.leadName = '書き換えられた名前';
  mkBooking(a, { leadName: '見本 二郎', people: 2 }, { date: a.ymd(a.addDays(new Date(), 5)), at: '2026-10-27T02:00:00.000Z' });
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.pending(), 2);
  srv.down = false;
  const reopened = device(srv, local);   // 開き直す
  await reopened.rosterStore.startSync();
  const s = serverState(srv);
  assert.deepEqual(s.bookings.map(x => [x.leadName, x.people]), [['見本 一郎', 1], ['見本 二郎', 2]], '2 件は別の予約（中身が入れ替わらない）');
  assert.deepEqual(s.bookings.map(x => s.trips.find(t => t.id === x.tripId).date), [day3(a), a.ymd(a.addDays(new Date(), 5))], '日付も別のまま');
  assert.equal(new Set([...s.bookings, ...s.people, ...s.trips].map(x => x.id)).size, s.bookings.length + s.people.length + s.trips.length, 'id は重ならない');
  assert.deepEqual(s.log.filter(e => e.act === 'add' && e.kind === 'booking').map(e => e.at), ['2026-10-27T01:00:00.000Z', '2026-10-27T02:00:00.000Z'], '記録の時刻は押した時刻');
});

test('op log: 時刻を渡さない直しは、押した時の時刻で記録される（送れた時刻にならない）', async () => {
  const srv = server();
  const local = memory();
  const a = device(srv, local);
  await a.rosterStore.startSync();
  srv.down = true;
  mkTrip(a);
  await a.rosterStore.whenSynced();
  const pressed = JSON.parse(local.getItem(OPS)).ops[0].at;
  assert.match(pressed, /^\d{4}-\d{2}-\d{2}T/);
  srv.down = false;
  await device(srv, local).rosterStore.startSync();
  assert.equal(serverState(srv).log.find(e => e.act === 'add' && e.kind === 'trip').at, pressed);
});

test('op log: 同じ項目を別の端末が先に直していたら、押した方の値にして、ぶつかったと知らせる。別の項目なら知らせない（M6）', async () => {
  const srv = server();
  const a = device(srv);
  await a.rosterStore.startSync();
  const tripId = mkTrip(a);
  await a.rosterStore.whenSynced();
  const b = device(srv);
  await b.rosterStore.startSync();
  srv.down = true;
  editSite(a, tripId, '南の根');
  a.rosterStore.apply('core.editTrip', { tripId, patch: { host: '' } });   // 変わらない直しは貯めない
  await a.rosterStore.whenSynced();
  srv.down = false;
  editSite(b, tripId, '西の根');
  await b.rosterStore.whenSynced();
  await a.rosterStore.refresh();
  assert.equal(a.rosterStore.note(), 'sync-conflict');
  assert.deepEqual(plain(a.rosterStore.conflicts()), [{ kind: 'trip', id: tripId, field: 'site' }]);
  assert.equal(serverState(srv).trips[0].site, '南の根', '押した方の値で当てる');
  a.rosterStore.clearConflicts();
  assert.equal(a.rosterStore.note(), null);
  assert.deepEqual(plain(a.rosterStore.conflicts()), []);
  /* 別の項目なら、ぶつからない */
  const c = device(srv);
  await c.rosterStore.startSync();
  srv.down = true;
  c.rosterStore.apply('core.editTrip', { tripId, patch: { boat: '第二丸' } });
  await c.rosterStore.whenSynced();
  srv.down = false;
  editSite(b, tripId, '東の根');
  await b.rosterStore.whenSynced();
  await c.rosterStore.refresh();
  assert.equal(c.rosterStore.note(), null);
  assert.deepEqual(plain(c.rosterStore.conflicts()), []);
  const t = serverState(srv).trips[0];
  assert.deepEqual([t.site, t.boat], ['東の根', '第二丸']);
});

test('試し直し: 起動のときにつながらなくても、間隔を延ばしながら試し直し、その間の直しは貯めて、つながったら送る（C1）', async () => {
  const srv = server();
  const local = memory();
  srv.down = true;
  const a = device(srv, local);
  assert.equal(await a.rosterStore.startSync(), false);
  assert.equal(a.rosterStore.link(), 'down', '「つながっていない」を画面に出せる');
  assert.equal(a.rosterStore.synced(), true, 'サーバーを使う版のまま（見本のボタンなどは出さない）');
  assert.deepEqual(a.timers.map(t => t.ms), [2000]);
  mkTrip(a);   // つながっていない間の直し: 端末に書くだけでなく、貯める
  assert.equal(a.rosterStore.pending(), 1);
  assert.equal(JSON.parse(local.getItem(OPS)).ops.length, 1);
  /* 1 回目の試し直しも失敗: 次は間隔が延びる */
  a.timers.shift().fn();
  await a.rosterStore.whenSynced();
  assert.deepEqual(a.timers.map(t => t.ms), [5000]);
  /* 2 回目でつながる */
  srv.down = false;
  a.timers.shift().fn();
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.link(), 'up');
  assert.equal(serverState(srv).trips.length, 1, '貯めた直しが届く');
  assert.equal(a.timers.length, 0, 'つながったら試し直しは止まる');
  assert.equal(a.rosterStore.pending(), 0);
  assert.equal(a.rosterStore.get().trips.length, 1);
});

test('試し直し: online と、画面に戻ったとき（refresh）でも、待たずにつなぎ直す。送れなかった直しも試し直す', async () => {
  const srv = server();
  srv.down = true;
  const a = device(srv);
  await a.rosterStore.startSync();
  mkTrip(a);
  await a.rosterStore.whenSynced();
  assert.equal(typeof a.on.online[0], 'function', 'online の受け口がある');
  srv.down = false;
  a.on.online[0]();
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.link(), 'up');
  assert.equal(serverState(srv).trips.length, 1);
  /* 画面に戻ったとき（visibilitychange → refresh） */
  const srv2 = server();
  srv2.down = true;
  const b = device(srv2);
  await b.rosterStore.startSync();
  srv2.down = false;
  assert.equal(await b.rosterStore.refresh(), true);
  assert.equal(b.rosterStore.link(), 'up');
  /* つないだあとで送れなかった直し: 試し直しの予約が入り、予約を動かすと送れる */
  b.timers.length = 0;
  srv2.down = true;
  mkTrip(b);
  await b.rosterStore.whenSynced();
  assert.equal(b.rosterStore.link(), 'down');
  assert.deepEqual(b.timers.map(t => t.ms), [2000]);
  srv2.down = false;
  b.timers.shift().fn();
  await b.rosterStore.whenSynced();
  assert.equal(b.rosterStore.link(), 'up');
  assert.equal(JSON.parse(srv2.db.rows.get('default').state).trips.length, 1);
});

test('開いたままの画面: 見えている間は 30 秒ごとに別の端末の直しを取り込む。隠れている間は読まない。サーバーを使わない版では何もしない', async () => {
  const srv = server();
  const a = device(srv);
  const b = device(srv);
  await a.rosterStore.startSync();
  await b.rosterStore.startSync();
  let visible = true;
  b.rosterStore.keepFresh(() => visible);
  b.rosterStore.keepFresh(() => visible);   // 2 回呼んでも 1 本だけ
  const fresh = () => b.timers.filter(t => t.ms === 30000);
  assert.equal(fresh().length, 1);
  mkTrip(a);
  await a.rosterStore.whenSynced();
  assert.equal(b.rosterStore.get().trips.length, 0, 'まだ取り込んでいない');
  /* 隠れている間: サーバーに聞かず、次の予約だけ入る */
  visible = false;
  const calls = srv.calls;
  let t = fresh().pop(); b.timers.splice(b.timers.indexOf(t), 1); t.fn();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(srv.calls, calls, '隠れている間は読まない');
  assert.equal(fresh().length, 1, '次の予約がある');
  /* 見えている間: 取り込む */
  visible = true;
  t = fresh().pop(); b.timers.splice(b.timers.indexOf(t), 1); t.fn();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(b.rosterStore.get().trips.length, 1, '開いたままでも、別の端末で足した便が出る');
  assert.equal(fresh().length, 1);
  /* サーバーを使わない版 */
  const c = device({ fetch: async () => new Response('{}', { status: 404 }) });
  c.rosterStore.keepFresh(() => true);
  assert.equal(c.timers.length, 0, 'サーバーを使わない版では何もしない');
});

test('試し直し: /api/roster が無い場所（404）や、サーバーの名簿が新しい版のときは、試し直さない', async () => {
  const gone = device({ fetch: async () => new Response('{}', { status: 404 }) });
  assert.equal(await gone.rosterStore.startSync(), false);
  assert.equal(gone.rosterStore.link(), 'local');
  assert.equal(gone.timers.length, 0);
  mkTrip(gone);
  assert.equal(gone.rosterStore.pending(), 0, '端末だけで動くときは貯めない');
});

test('端末に残した名簿は新しい 5 つまで。一覧で見て、選んで戻せる。戻す前の名簿も残す（H7）', async () => {
  const srv = server();
  const local = memory();
  const a = await bigSynced(srv, local);
  const few = device(server());   // 便が 1 つで人のいない、小さな名簿
  mkTrip(few);
  const saved = JSON.stringify(few.rosterStore.get());
  const t0 = Date.now() - 600000;
  for (let i = 1; i <= 7; i += 1) local.raw.set(`redux-roster-v1-kept-${t0 + i}`, saved);
  const again = device(srv, local);
  again.rosterStore.get();   // 開くと数を整える
  assert.deepEqual(plain(again.rosterStore.kept()).map(k => k.key), [7, 6, 5, 4, 3].map(i => `redux-roster-v1-kept-${t0 + i}`), '新しい順に 5 つ');
  const list = again.rosterStore.kept(true);
  assert.ok(list.every(k => k.ok && k.people === 0 && k.trips === 1));
  assert.equal(again.rosterStore.restoreKept('redux-roster-v1-kept-nothing'), false, '一覧に無い物は戻さない');
  await again.rosterStore.startSync();
  const before = again.rosterStore.get().people.length;
  assert.ok(before > 20);
  assert.equal(again.rosterStore.restoreKept(list[0].key), true);
  await again.rosterStore.whenSynced();
  assert.deepEqual([again.rosterStore.get().trips.length, again.rosterStore.get().people.length], [1, 0], '戻した名簿になる');
  assert.deepEqual([serverState(srv).trips.length, serverState(srv).people.length], [1, 0], 'サーバーの名簿もその名簿に置き換わる（わざとなので、人が減っても通る）');
  const after = again.rosterStore.kept(true);
  assert.ok(!after.some(k => k.key === list[0].key), '戻した物は一覧から外れる');
  assert.ok(after.some(k => k.people === before), '戻す前の名簿が残っている（戻したあとに戻せる）');
  assert.ok(after.length <= 5);
});

test('M6: つないでいたサーバーの名簿の行が無くなったら、空の名簿に直しを当てて置かず、端末の名簿を残して止める', async () => {
  const srv = server();
  const local = memory();
  const a = await bigSynced(srv, local);
  const tripId = a.rosterStore.get().trips[0].id;
  srv.db.rows.delete('default');
  editSite(a, tripId, '南の根');
  await a.rosterStore.whenSynced();
  assert.equal(a.rosterStore.note(), 'sync-gone');
  assert.equal(a.rosterStore.link(), 'stopped');
  assert.equal(srv.db.rows.has('default'), false, '空の名簿を置き直さない');
  assert.equal(keptKeys(local).length, 1);
  assert.ok(a.rosterStore.get().people.length > 20, '端末の名簿は消えない');
  assert.equal(JSON.parse(local.getItem(OPS)).ops.length, 1, '貯めた直しは捨てない（行が戻ったあとの読み込み直しで当て直す）');
});

test('M6: 別の端末の名簿を取り込むとき、人が大きく減っていたら、手元の名簿を残してから取り込む', async () => {
  const srv = server();
  const local = memory();
  const a = await bigSynced(srv, local);
  const people = a.rosterStore.get().people.length;
  assert.ok(people > 20);
  const row = srv.db.rows.get('default');
  srv.db.rows.set('default', { ...row, version: row.version + 1, state: JSON.stringify(a.roster.blankState('B マリン（見本）')) });
  assert.equal(await a.rosterStore.refresh(), true);
  assert.equal(a.rosterStore.note(), 'sync-shrunk');
  assert.equal(a.rosterStore.get().people.length, 0);
  const kept = keptKeys(local);
  assert.equal(kept.length, 1);
  assert.equal(JSON.parse(local.getItem(kept[0])).people.length, people, '手元の名簿は残してある');
});

test('M7: 端末の名簿が読めず書けないときも、サーバーの名簿は画面に出す。端末の元の文字は消さない', async () => {
  const srv = server();
  await bigSynced(srv);
  const local = memory();
  local.raw.set('redux-roster-v1', '{broken');
  const set = local.setItem;
  local.setItem = (k, v) => { if (k.startsWith('redux-roster-v1-broken-')) throw new Error('QuotaExceededError'); set(k, v); };   // 退避が書けない
  const b = device(srv, local);
  assert.equal(b.rosterStore.get().people.length, 0);
  assert.equal(b.rosterStore.note(), 'unreadable');
  assert.equal(await b.rosterStore.startSync(), true);
  assert.ok(b.rosterStore.get().people.length > 20, 'サーバーの名簿が出る');
  assert.equal(local.getItem('redux-roster-v1'), '{broken', '読めなかった元の文字には書かない');
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    REAL_LOG(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    REAL_LOG(`FAIL ${t.name}\n     ${e.stack || e.message}`);
  }
}
REAL_LOG(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
