// お店の名簿をサーバーに置く口（/api/roster。plan/server.md）を、外との境目を見本（worker/fakes.mjs）に差し替えて確かめる。
// 版の番号で書き込みを守ること、2 台で同時に直しても両方の変更が残ること、サーバーが画面を信じずに直してから置くこと、ログに中身が出ないこと。
// 実行: node test/sync.test.mjs （Node 18 以上。依存なし。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { getRoster, putRoster } from '../worker/roster-db.mjs';
import { checkPut, readStored, MAX_PUT_BODY, SHOP_DEFAULT } from '../worker/sync-core.mjs';
import { fakeKv, fakeAccess, fakeD1, checkRedirect } from '../worker/fakes.mjs';

vm.runInThisContext(readFileSync(new URL('../js/data-samples.js', import.meta.url), 'utf8'));
vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterCore: C, rosterShare: X, SAMPLE_READINGS } = R;

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
const AT = '2026-10-27T01:00:00.000Z';
const TODAY = '2026-10-27';
const OWN = 'B マリン（見本）';
const PARTNER = 'C ダイブ（見本）';
const NO5 = ['no', 'no', 'no', 'no', 'no'];
let n = 0;
const newId = () => `id${(n += 1)}`;

const access = await fakeAccess(TEAM);
const goodJwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

function setup(over = {}) {
  resetAccessCache();
  const db = fakeD1();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, SINGLE_SHOP: 'default', ...over
  };
  const io = {
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => NOW
  };
  return { db, env, io };
}

function req(method, { body, headers = {}, jwt = goodJwt, site = 'same-origin', path = '/api/roster' } = {}) {
  const h = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers };
  if (jwt) h['cf-access-jwt-assertion'] = jwt;
  if (site) h['sec-fetch-site'] = site;
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

const logs = [];
const realLog = console.log;
async function call(s, request) {
  console.log = (line) => logs.push(String(line));
  try {
    const res = await handle(request, s.env, s.io);
    return { status: res.status, body: await res.json(), headers: res.headers };
  } finally { console.log = realLog; }
}
const put = (s, base, state) => call(s, req('PUT', { body: { base, state } }));
const get = (s) => call(s, req('GET'));

/* 10/24 の便に、見本メール e1 の 2 人。乗り合いのお店 C ダイブ（見本）付き */
const trip = { ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', site: '北の根', guides: ['見本 ガイド'], createdAt: AT };
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const base = C.addBooking({ ...S.blankState(OWN), trips: [trip] }, { trip, booking: { source: 'mail', people: 2 }, reading, src: 'mail', at: AT, newId });
const withPartner = X.addPartner(base, { tripId: 't1', name: PARTNER, at: AT }).state;
/* サーバーが置くと、記録の新しい行に rx（受けた時刻）と by（ログインしたメール）が付く */
const stamped = (st, rx = AT, by = EMAIL) => ({ ...st, log: st.log.map(e => ({ ...e, rx, by })) });
const guideOf = (st) => st.trips.find(t => t.id === 't1').guides;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('はじめは名簿が無い（版 0）。base 0 で置くと版 1 になり、読み直すと同じ名簿', async () => {
  const s = setup();
  assert.deepEqual((await get(s)).body, { version: 0, state: null, shop: 'default' });
  const r = await put(s, 0, base);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  assert.deepEqual(r.body.state, stamped(base));
  const g = await get(s);
  assert.deepEqual(g.body, { version: 1, state: stamped(base), shop: 'default' });
  assert.equal(g.headers.get('cache-control'), 'no-store');
});

test('古い版を元にした書き込みは断り、最新を返す（409）。最新を元にすれば書ける', async () => {
  const s = setup();
  await put(s, 0, base);
  const stale = await put(s, 0, withPartner);
  assert.equal(stale.status, 409);
  assert.deepEqual([stale.body.error, stale.body.version], ['conflict', 1]);
  assert.deepEqual(stale.body.state, stamped(base));
  const ok = await put(s, 1, withPartner);
  assert.deepEqual([ok.status, ok.body.version], [200, 2]);
  assert.equal(s.db.writes, 2);
});

test('2 台で同時に直す: 後の 1 台は最新に同じ直しを当て直して送り、両方の変更が残る', async () => {
  const s = setup();
  await put(s, 0, base);
  const start = (await get(s)).body;
  /* 端末 A はガイドを足し、端末 B は乗り合いのお店を足す。どちらも版 1 を元に直す */
  const addGuide = (st) => C.editTrip(st, { tripId: 't1', patch: { guides: [...st.trips.find(t => t.id === 't1').guides, '見本 次郎'] }, at: AT });
  const addShop = (st) => X.addPartner(st, { tripId: 't1', name: PARTNER, at: AT }).state;
  const a = await put(s, start.version, addGuide(start.state));
  assert.equal(a.status, 200);
  const b = await put(s, start.version, addShop(start.state));
  assert.equal(b.status, 409, 'B は A より後');
  const retry = await put(s, b.body.version, addShop(b.body.state));
  assert.equal(retry.status, 200);
  const last = (await get(s)).body.state;
  assert.deepEqual(guideOf(last), ['見本 ガイド', '見本 次郎'], 'A の変更が残る');
  assert.deepEqual(last.trips.find(t => t.id === 't1').partners, [PARTNER], 'B の変更も残る');
});

test('ジンのレビュー 2026-10-28 H1・H2: 送る連絡と予定の動きはサーバーの物。画面が足した連絡・書き換えた宛先は置かず、「届いていた」と「送り直しを頼む」だけ受ける', async () => {
  const s = setup();
  const bookingId = base.bookings[0].id;
  const people = [base.people[0].id];
  const out = (id, over) => ({ v: S.VERSION, id, kind: 'request', bookingId, tripId: 't1', to: 'guest@mail.example', lang: 'ja', subject: '名簿の項目のお願い',
    body: 'お願いします [[ask-link]]', people, status: 'queued', why: '', at: AT, sentAt: '', ...over });
  const job = { v: S.VERSION, id: 'j1', kind: 'request', bookingId, tripId: 't1', due: '2026-10-27T09:00', status: 'done', doneAt: AT };
  /* 1. 画面が連絡を足し、予定を済んだにして送る（古い画面・乗っ取られた端末） */
  const first = await put(s, 0, { ...base, jobs: [job], outbox: [out('evil', { to: 'victim@attacker.example', body: '本文を差し替えた' })] });
  assert.equal(first.status, 200);
  let st = JSON.parse(s.db.rows.get('default').state);
  /* 名簿が無い所への最初の書き込み（base 0）は、端末の送った記録を残す（ジンの点検 2026-10-28 H2）。ただし宛先と本文はサーバーが作り直し、
     送る途中の物は「送れたか分からない」にして送らない。済んだと来た予定は済んだのまま（送らない向きは信じる） */
  assert.ok(st.outbox.every(o => o.status !== 'queued'), '画面が足した連絡を送る形では置かない（作り直せなければ捨てる。見本の予約はメールが無いので捨てる）');
  assert.ok(st.outbox.every(o => o.to !== 'victim@attacker.example' && !o.body.includes('差し替え')), '宛先と本文は画面の物を使わない');
  assert.deepEqual(st.jobs.map(j => j.status), ['done'], '済んだと来た予定を待ちに戻して送り直さない');
  /* 2. サーバー（Cron）が送った結果を置いた形: o1 は送れたか分からない、o2 は送れなかった */
  const serverState = { ...st, outbox: [out('o1', { status: 'failed', why: 'maybe-sent' }), out('o2', { status: 'failed', why: 'send' })] };
  assert.ok((await putRoster(s.db, 'default', 1, JSON.stringify(serverState), AT, { parts: [], today: TODAY })).ok);
  /* 3. 画面: o1 を届いていたにし（ついでに宛先を書き換え）、o2 に送り直しを頼み、o3 を足す */
  const edited = { ...serverState, outbox: [
    out('o1', { status: 'sent', why: 'confirmed', sentAt: AT, to: 'victim@attacker.example' }),
    out('o2', { status: 'failed', why: 'resend' }),
    out('o3', { to: 'victim@attacker.example' })
  ] };
  assert.equal((await put(s, 2, edited)).status, 200);
  st = JSON.parse(s.db.rows.get('default').state);
  assert.deepEqual(st.outbox.map(o => [o.id, o.status, o.why, o.to]), [
    ['o1', 'sent', 'confirmed', 'guest@mail.example'],
    ['o2', 'failed', 'resend', 'guest@mail.example']
  ], '受けるのは「届いていた」と「送り直しを頼む」だけ。宛先の書き換えと、足した連絡は捨てる');
});

test('ザクのレビュー 2026-10-28 MEDIUM-2: 今ある予定はサーバーの物。済んだ予定を消して新しい id で足し直しても受けない', async () => {
  const s = setup();
  const bookingId = base.bookings[0].id;
  const job = (id, over) => ({ v: S.VERSION, id, kind: 'request', bookingId, tripId: 't1', due: '2026-10-27T09:00', status: 'waiting', doneAt: '', ...over });
  assert.equal((await put(s, 0, { ...base, jobs: [job('j1')] })).status, 200);
  /* サーバー（Cron）が送って、済んだにした形 */
  const st1 = JSON.parse(s.db.rows.get('default').state);
  const serverState = { ...st1, jobs: [job('j1', { status: 'done', doneAt: AT })] };
  assert.ok((await putRoster(s.db, 'default', 1, JSON.stringify(serverState), AT, { parts: [], today: TODAY })).ok);
  /* 画面: j1 を消して同じお願いを新しい id で足し、remind の時刻を書き換えずに足す（remind はまだ無いので受ける） */
  assert.equal((await put(s, 2, { ...serverState, jobs: [job('j2'), job('r1', { kind: 'remind' })] })).status, 200);
  let st = JSON.parse(s.db.rows.get('default').state);
  assert.deepEqual(st.jobs.map(j => [j.id, j.kind, j.status]), [['r1', 'remind', 'waiting']], '済んだお願いの足し直しは受けない。まだ無い種類の予定だけ受ける');
  /* 画面: r1 の時刻と状態を書き換え、同じ remind を別の id でもう 1 つ足す */
  assert.equal((await put(s, 3, { ...st, jobs: [job('r1', { kind: 'remind', due: '2026-10-20T00:00', status: 'done' }), job('r2', { kind: 'remind' })] })).status, 200);
  st = JSON.parse(s.db.rows.get('default').state);
  assert.deepEqual(st.jobs.map(j => [j.id, j.due, j.status]), [['r1', '2026-10-27T09:00', 'waiting']], '今ある予定の時刻と状態はサーバーの物。同じ種類の 2 つ目は受けない');
});

test('ザクのレビュー 2026-10-28 LOW: 版は合うのに保存済みの名簿が読めないときは、空の名簿を元にせず 500 で断る', async () => {
  const s = setup();
  assert.equal((await put(s, 0, base)).status, 200);
  s.db.rows.get('default').state = '{"読めない名簿"';
  const writes = s.db.writes;
  const r = await put(s, 1, { ...base, outbox: [] });
  assert.equal(r.status, 500);
  assert.equal(s.db.writes, writes, '何も書いていない');
});

test('形の合わない名簿は置かない（400）。本文が大きすぎれば読まずに断る（413）', async () => {
  const s = setup();
  for (const body of [{ base: 0, state: { trips: 'x' } }, { base: -1, state: base }, { base: 0 }, { base: '0', state: base }, [base]]) {
    const r = await call(s, req('PUT', { body }));
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call(s, req('PUT', { body: '{"base":0,' }))).status, 400, '読めない JSON');
  const big = await call(s, req('PUT', { body: JSON.stringify({ base: 0, state: base, pad: 'x'.repeat(MAX_PUT_BODY) }) }));
  assert.equal(big.status, 413);
  assert.equal((await call(s, req('PUT', { body: { base: 0, state: base }, headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal(s.db.writes, 0, '何も書いていない');
});

test('サーバーは画面を信じない: 他のお店のお客さんの健康の答えを外し、保存期間を過ぎた便を消してから置く', async () => {
  const s = setup();
  const r = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [{ name: '見本 一郎', emergency: { name: '見本 京子', relation: '妻', phone: '090-0000-5566' } }], guide: '見本 三郎', at: AT, newId });
  const id = r.ids[0];
  /* 前の版の形: 他のお店が渡した健康の答え（今はそのお店だけが持つ） */
  const leaked = C.editPerson(r.state, { id, who: 'staff', src: 'partner', at: AT, patch: { health: {
    answers: NO5, historyAt: TODAY, today: 'ok', todayAt: '2026-10-24', consentAt: TODAY, consentVer: 'partner-2026-10-21', heldBy: '' } } });
  const old = { ...S.blankTrip(), id: 't0', date: '2025-09-01', start: '08:30', kind: 'dive', tour: '体験ダイビング', createdAt: '2025-08-01T00:00:00.000Z' };
  const withOld = { ...leaked, trips: [...leaked.trips, old] };
  assert.ok(S.validateState(withOld).ok);
  const res = await put(s, 0, withOld);
  assert.equal(res.status, 200);
  const stored = JSON.parse(s.db.rows.get(SHOP_DEFAULT).state);
  assert.ok(stored.people.find(p => p.id === id).health.answers.every(a => a === null), '置いた名簿に、他のお店のお客さんの健康の答えが無い');
  assert.ok(!stored.trips.some(t => t.id === 't0'), '1 年を過ぎた便は置かない');
  assert.deepEqual(res.body.state, stored, '画面には、サーバーが直した後の名簿を返す');
});

test('画面の検査より厳しく見る: 余分な項目と、重なった id は置かない（ザクのレビュー 2026-10-27）', async () => {
  const s = setup();
  const p0 = withPartner.people[0];
  const cases = {
    '名簿の一番上の余分な項目': { ...withPartner, extra: { answers: NO5 } },
    'お店の余分な項目': { ...withPartner, shop: { ...withPartner.shop, memo: 'x' } },
    '記録の 1 件の余分な項目': { ...withPartner, log: [...withPartner.log.slice(0, -1), { ...withPartner.log[withPartner.log.length - 1], junk: 'y' }] },
    '同じ id の人が 2 人': { ...withPartner, people: [...withPartner.people, { ...p0 }] },
    '同じ id の便が 2 つ': { ...withPartner, trips: [...withPartner.trips, { ...withPartner.trips[0] }] }
  };
  for (const [name, state] of Object.entries(cases)) {
    assert.ok(S.validateState(state).ok, `${name}: 画面の検査は通る形`);
    const r = await put(s, 0, state);
    assert.deepEqual([r.status, r.body.error], [400, 'input'], name);
  }
  assert.equal(s.db.writes, 0);
});

test('入口の守り: Access・同じ場所からの呼び出し・method。D1 が無いときは名簿の道も、お店ごとに数える healthz と AI の読み取りも 503 (config)', async () => {
  const s = setup();
  assert.equal((await call(s, req('GET', { jwt: null }))).status, 403);
  assert.equal((await call(s, req('GET', { site: 'cross-site' }))).status, 403);
  const post = await call(s, req('POST', { body: { base: 0, state: base } }));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, PUT');
  const noDb = setup({ DB: undefined });
  assert.deepEqual([(await get(noDb)).status, (await get(noDb)).body.error], [503, 'config']);
  noDb.io.fetch = async (url, init) => { checkRedirect(init); return new Response(JSON.stringify({ keys: access.keys }), { status: 200 }); };
  assert.equal((await call(noDb, req('GET', { path: '/api/healthz' }))).status, 503, '上限をお店ごとに数えるので、D1 が無ければ healthz も止める');
});

test('D1 が落ちたら 503。置いてある名簿が壊れていたら渡さない（500）', async () => {
  const s = setup();
  s.db.failing = true;
  assert.deepEqual([(await get(s)).status, (await put(s, 0, base)).status], [503, 503]);
  s.db.failing = false;
  s.db.rows.set(SHOP_DEFAULT, { version: 3, state: '{"trips":"x"}', updated_at: AT });
  assert.deepEqual([(await get(s)).status, (await get(s)).body.error], [500, 'stored']);
  assert.equal((await put(s, 1, base)).status, 500, '版が違って最新を返す所でも、壊れた物は渡さない');
});

test('ログは 1 要求 1 行で、名簿の中身（名前・電話）を出さない', async () => {
  const s = setup();
  logs.length = 0;
  await put(s, 0, base);
  await put(s, 0, base);
  await get(s);
  assert.equal(logs.length, 3);
  const all = logs.join('\n');
  assert.ok(!/見本|090-|hanako|@/.test(all), all);
  assert.deepEqual(logs.map(l => JSON.parse(l).status), [200, 409, 200]);
  assert.equal(JSON.parse(logs[1]).why, 'conflict');
});

test('D1 との境目: base 0 は同じお店が既にあれば書かない。版が合わない UPDATE も書かない', async () => {
  const db = fakeD1();
  assert.deepEqual(await getRoster(db, 's1'), { version: 0, text: null });
  assert.deepEqual(await putRoster(db, 's1', 0, '{}', AT), { ok: true, version: 1 });
  assert.deepEqual(await putRoster(db, 's1', 0, '{"x":1}', AT), { ok: false });
  assert.deepEqual(await putRoster(db, 's1', 2, '{"x":1}', AT), { ok: false });
  assert.deepEqual(await putRoster(db, 's1', 1, '{"x":1}', AT), { ok: true, version: 2 });
  assert.deepEqual(await getRoster(db, 's1'), { version: 2, text: '{"x":1}' });
});

test('人が大きく消える書き込みは 409（shrink）で断り、今の名簿を返す。allowShrink なら通る。数人を消すのは通る', async () => {
  const s = setup();
  const big = X.addBigSample(S.blankState(OWN), { day: '2026-10-30', at: AT, newId }).state;
  await call(s, req('PUT', { body: { base: 0, state: big } }));
  const n0 = big.people.length;
  const fewer = { ...big, people: big.people.slice(0, n0 - 3) };
  const small = await call(s, req('PUT', { body: { base: 1, state: fewer } }));
  assert.equal(small.status, 200, '数人なら消せる');
  const empty = S.blankState(OWN);
  const r = await call(s, req('PUT', { body: { base: 2, state: empty } }));
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'shrink');
  assert.equal(r.body.state.people.length, n0 - 3);
  const ok = await call(s, req('PUT', { body: { base: 2, state: empty, allowShrink: true } }));
  assert.equal(ok.status, 200);
  assert.equal((await call(s, req('PUT', { body: { base: 3, state: empty, other: 1 } }))).status, 400, '本文の余分な項目は断る');
});

test('名簿の形の版（ジンのレビュー HIGH 7）: 移し替えの表で順に上げる。道が無ければ元のまま。置いてある古い版は読むときに上げ、古い版の画面からの書き込みは 426', async () => {
  const v1 = { ...S.blankState(OWN), v: 1, trips: [{ ...trip, v: 1 }] };
  const steps = { 1: (s) => ({ ...S.bumpAll(s, 2), shop: { ...s.shop, note: '2 で足した欄' } }), 2: (s) => S.bumpAll(s, 3) };
  const up = S.upgradeWith(v1, steps, 3);
  assert.equal(up.v, 3);
  assert.equal(up.trips[0].v, 3, '便などの v も上がる');
  assert.equal(up.shop.note, '2 で足した欄');
  assert.equal(S.upgradeWith(v1, { 2: steps[2] }, 3), v1, '途中の道が無ければ元のまま');
  assert.equal(S.upgradeWith(v1, { 1: (s) => ({ ...s, v: 5 }) }, 3), v1, '1 つずつ上がらない道は使わない');
  assert.equal(S.upgradeWith({ ...v1, v: 4 }, steps, 3).v, 4, '新しすぎる名簿はそのまま（検査に落ちる）');
  assert.ok(S.isNewer({ v: S.VERSION + 1 }));
  /* 本物の表に「0 → 1」を一時に足して、サーバーが置いてある v0 の名簿を上げて読むことを確かめる */
  const s = setup();
  S.MIGRATIONS[0] = (st) => S.bumpAll(st, 1);
  try {
    const old = S.bumpAll(base, 0);
    s.db.rows.set('default', { version: 4, state: JSON.stringify(old), updated_at: AT });
    const g = await get(s);
    assert.equal(g.status, 200);
    assert.equal(g.body.state.v, S.VERSION);
    assert.equal(g.body.state.people.length, base.people.length);
    const r = await put(s, 4, old);
    assert.equal(r.status, 426, '古い版の画面からの名簿は上げずに断る');
    assert.equal(r.body.error, 'version');
  } finally { delete S.MIGRATIONS[0]; }
});

test('点検 2026-10-28 H8: 記録は足すだけ。画面が記録を消したり書き換えたりして送っても、置いてある記録は戻り、書き換えは新しい行として残る', async () => {
  const s = setup();
  const pid = base.people[0].id;
  const edited = R.rosterCore.editPerson(base, { id: pid, who: 'staff', src: 'staff', at: AT, patch: { phone: '090-1111-2222' } });
  assert.equal((await put(s, 0, edited)).status, 200);
  const first = JSON.parse(s.db.rows.get('default').state).log;
  assert.ok(first.length >= 1);
  /* 1. 記録を空にして送る */
  assert.equal((await put(s, 1, { ...JSON.parse(s.db.rows.get('default').state), log: [] })).status, 200);
  let log = JSON.parse(s.db.rows.get('default').state).log;
  assert.deepEqual(log, first, '消した記録は戻る');
  /* 2. 記録の時刻を書き換えて送る */
  const cur = JSON.parse(s.db.rows.get('default').state);
  const forged = { ...cur, log: cur.log.map((e, i) => (i === 0 ? { ...e, at: '2020-01-01T00:00:00.000Z' } : e)) };
  assert.equal((await put(s, 2, forged)).status, 200);
  log = JSON.parse(s.db.rows.get('default').state).log;
  assert.deepEqual(log.slice(0, first.length), first, '元の行はそのまま');
  assert.ok(log.some(e => e.at === '2020-01-01T00:00:00.000Z'), '書き換えた行は新しい行として残る（書き換えが分かる）');
  /* 3. ふつうに足すだけなら、そのまま */
  const more = R.rosterCore.editPerson(JSON.parse(s.db.rows.get('default').state), { id: pid, who: 'staff', src: 'staff', at: AT, patch: { phone: '090-3333-4444' } });
  assert.equal((await put(s, 3, more)).status, 200);
  assert.equal(JSON.parse(s.db.rows.get('default').state).log.length, log.length + 1);
});

const OTHER = 'mihon.other@example.com';
const LATER = Date.parse('2026-10-27T02:30:00Z');
const AT_LATER = '2026-10-27T02:30:00.000Z';
const storedState = (s) => JSON.parse(s.db.rows.get(SHOP_DEFAULT).state);

test('記録の rx・by: 新しい行にサーバーが受けた時刻とログインしたメールを付ける。at は操作した時刻のまま、画面が付けた rx・by は捨てる', async () => {
  const s = setup();
  const pid = base.people[0].id;
  /* オフラインで直して、あとで送る: 操作した時刻（at）は古いまま。画面は rx・by を自分で付けて送ってくる */
  const OFFLINE = '2026-10-26T20:15:00.000Z';
  const edited = C.editPerson(base, { id: pid, who: 'staff', src: 'staff', at: OFFLINE, patch: { phone: '090-1111-2222' } });
  const last = edited.log[edited.log.length - 1];
  const forged = { ...edited, log: [...edited.log.slice(0, -1), { ...last, rx: '2020-01-01T00:00:00.000Z', by: 'someone.else@example.com' }] };
  assert.ok(S.validateState(forged).ok, '画面の検査は通る形');
  const r = await put(s, 0, forged);
  assert.equal(r.status, 200);
  const log = storedState(s).log;
  assert.ok(log.length >= 2 && log.every(e => e.rx === AT && e.by === EMAIL), '足した行は全部、サーバーの受けた時刻とログインしたメール');
  assert.equal(log[log.length - 1].at, OFFLINE, 'at は操作した時刻のまま');
  assert.ok(!JSON.stringify(log).includes('someone.else') && !JSON.stringify(log).includes('2020-01-01'), '画面が付けた rx・by は残らない');
  assert.deepEqual(r.body.state.log, log, '画面には、付けた後の記録を返す');
});

test('記録の rx・by: 置いてある行は付けたまま変わらない。次の書き込み（別の人・別の時刻）は新しい行にだけ付き、書き換えた rx・by は新しい行として残る', async () => {
  const s = setup();
  const pid = base.people[0].id;
  assert.equal((await put(s, 0, base)).status, 200);
  const first = storedState(s).log;
  /* 別の人（OTHER）が、1 時間半あとに直す。画面は GET で受けた記録（rx・by 付き）にそのまま 1 行足して送る */
  s.env.ALLOWED_EMAILS = `${EMAIL},${OTHER}`;
  s.io.now = () => LATER;
  const otherJwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: OTHER, exp: LATER / 1000 + 3600, iat: LATER / 1000 - 10, nbf: LATER / 1000 - 10, type: 'app' });
  const edited = C.editPerson(storedState(s), { id: pid, who: 'staff', src: 'staff', at: AT_LATER, patch: { phone: '090-3333-4444' } });
  const r = await call(s, req('PUT', { body: { base: 1, state: edited }, jwt: otherJwt }));
  assert.equal(r.status, 200);
  const log = storedState(s).log;
  assert.deepEqual(log.slice(0, first.length), first, '前の行は rx・by ごとそのまま（比べても外れない）');
  assert.deepEqual(log.slice(first.length).map(e => [e.rx, e.by]), [[AT_LATER, OTHER]], '足した行だけ、今の時刻と今の人');
  /* 置いてある行の rx・by を書き換えて送る: 元の行が戻り、書き換えた行は新しい行（本人の rx・by）として残る */
  const cur = storedState(s);
  const tampered = { ...cur, log: cur.log.map((e, i) => (i === 0 ? { ...e, rx: '2020-01-01T00:00:00.000Z', by: 'someone.else@example.com' } : e)) };
  assert.equal((await call(s, req('PUT', { body: { base: 2, state: tampered }, jwt: otherJwt }))).status, 200);
  const after = storedState(s).log;
  assert.deepEqual(after.slice(0, cur.log.length), cur.log, '元の行はそのまま');
  assert.equal(after.length, cur.log.length + 1);
  assert.deepEqual([after[after.length - 1].rx, after[after.length - 1].by], [AT_LATER, OTHER], '書き換えた行は、書き換えた人と時刻で新しい行になる');
  /* 何も足さない書き込みは、記録を変えない */
  assert.equal((await call(s, req('PUT', { body: { base: 3, state: storedState(s) }, jwt: otherJwt }))).status, 200);
  assert.deepEqual(storedState(s).log, after);
});

test('記録の rx・by: メール（個人情報）は名簿の中だけ。console.log の行には出ない', async () => {
  const s = setup();
  logs.length = 0;
  assert.equal((await put(s, 0, base)).status, 200);
  assert.ok(storedState(s).log.every(e => e.by === EMAIL));
  assert.ok(logs.length > 0 && !logs.join('\n').includes(EMAIL) && !/mihon\.member|@/.test(logs.join('\n')), logs.join('\n'));
});

test('版 1 → 2: 置いてある版 1 の名簿は読むときに版 2 へ上がり、前の行に rx・by は作らない。そのあと足した行にだけ付く。版 1 の画面は 426', async () => {
  assert.equal(S.VERSION, 2);
  assert.equal(typeof S.MIGRATIONS[1], 'function');
  const s = setup();
  const pid = base.people[0].id;
  const v1 = S.bumpAll(base, 1);
  assert.ok(v1.log.length > 0 && v1.log.every(e => e.rx === undefined && e.by === undefined));
  s.db.rows.set(SHOP_DEFAULT, { version: 4, state: JSON.stringify(v1), updated_at: AT });
  const g = await get(s);
  assert.equal(g.status, 200);
  assert.equal(g.body.state.v, 2);
  assert.deepEqual(g.body.state.log, base.log, '前の行はそのまま（受けた時刻も誰かも、そのとき記録していないので作らない）');
  assert.equal((await put(s, 4, v1)).status, 426, '版 1 の画面からの書き込みは断る');
  const edited = C.editPerson(g.body.state, { id: pid, who: 'staff', src: 'staff', at: AT, patch: { phone: '090-5555-6666' } });
  assert.equal((await put(s, 4, edited)).status, 200);
  const log = storedState(s).log;
  assert.deepEqual(log.slice(0, base.log.length), base.log, '前の行に rx・by は付かない');
  assert.deepEqual(log.slice(base.log.length).map(e => [e.rx, e.by]), [[AT, EMAIL]]);
  assert.equal(storedState(s).v, 2);
});

test('core: checkPut と readStored は時計を読まず、渡した今日で期限を決める', () => {
  const ok = checkPut({ base: 0, state: base }, { today: TODAY, at: AT });
  assert.ok(ok.ok);
  assert.equal(ok.text, JSON.stringify(ok.state));
  assert.equal(checkPut({ base: 0, state: base }, { today: '2027-12-01', at: AT }).state.trips.length, 0, '1 年後の今日なら、10/24 の便は消える');
  assert.equal(readStored('not json', { today: TODAY, at: AT }), null);
  assert.deepEqual(readStored(JSON.stringify(base), { today: TODAY, at: AT }), base);
});

test('core: お店の診断書の決まり（shop.medical）は置ける。お店の余分な項目は断る', () => {
  const R = globalThis.REDUX;
  const ruled = R.rosterCore.setMedicalRules(base, { rules: { age: '' }, at: AT });
  const got = checkPut({ base: 0, state: ruled }, { today: TODAY, at: AT });
  assert.ok(got.ok, got.error);
  assert.equal(got.state.shop.medical.age, '');
  assert.equal(checkPut({ base: 0, state: { ...base, shop: { ...base.shop, other: 1 } } }, { today: TODAY, at: AT }).ok, false);
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
