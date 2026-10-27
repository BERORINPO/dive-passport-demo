// 済んだ便を名簿の本体から分けて置く（worker/past-core.mjs・worker/roster-db.mjs・/api/roster/past。plan/server.md の「済んだ便を分けて置く」）を確かめる。
// 済んで 7 日を過ぎた便が、便ごとに 1 行へ移ること、何も消えないこと、分けた日の書き込みを「人が大きく消えた」と見ないこと、
// 別の端末に負けた書き込みは済んだ便も書かないこと、1 年を過ぎた行は消えること、読む口の守り。SQL は node:sqlite（本物の SQLite）でも流す。
// 実行: node test/past.test.mjs （Node 18 以上。node:sqlite が無い Node では SQL の 1 本だけ飛ばす。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { putRoster, getPast } from '../worker/roster-db.mjs';
import { splitPast, joinPast, checkPastRange, readPast, ARCHIVE_DAYS } from '../worker/past-core.mjs';
import { checkPut } from '../worker/sync-core.mjs';
import { changeRoster } from '../worker/auto.mjs';
import { fakeKv, fakeAccess, fakeD1, checkRedirect } from '../worker/fakes.mjs';

vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterCore: C, rosterShare: X, rosterAuto: A } = R;

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const DAY_MS = 86400000;
const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
const TODAY = '2026-10-27';
const OWN = 'B マリン（見本）';
let n = 0;
const newId = () => `id${(n += 1)}`;

const access = await fakeAccess(TEAM);
const jwtFor = (email, now) => access.sign({ iss: `https://${TEAM}`, aud: [AUD], email, exp: now / 1000 + 365 * 86400, iat: now / 1000 - 10, nbf: now / 1000 - 10, type: 'app' });
/* 時計を 10/02 に戻すテストもあるので、10/01 に作って 1 年使える鍵にする */
const goodJwt = await jwtFor(EMAIL, Date.parse('2026-10-01T00:00:00Z'));

function setup() {
  resetAccessCache();
  const db = fakeD1();
  const clock = { now: NOW };
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db };
  const io = {
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => clock.now
  };
  return { db, env, io, clock };
}

function req(method, { body, path = '/api/roster', jwt = goodJwt } = {}) {
  const h = { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}
const logs = [];
const realLog = console.log;
async function call(s, request) {
  console.log = (line) => logs.push(String(line));
  try {
    const res = await handle(request, s.env, s.io);
    return { status: res.status, body: await res.json() };
  } finally { console.log = realLog; }
}
const put = (s, base, state, more = {}) => call(s, req('PUT', { body: { base, state, ...more } }));
const pastOf = (s, from, to) => call(s, req('GET', { path: `/api/roster/past?from=${from}&to=${to}` }));

const big = (state, day, at = '2026-09-30T01:00:00.000Z') => X.addBigSample(state, { day, at, newId }).state;
const aiLog = (state, at) => C.logAi(state, { at, sent: { doc: 'mail', size: 120, masked: false, mode: 'real', healthSeen: false, redacted: 0 } });
/* 10/01 の乗り合い便（30 人。済んで 7 日を過ぎた）・10/24 の便（3 日前。まだ本体）・日付の無い便・10/02 の AI の読み取りの記録 */
function sample() {
  let st = big(S.blankState(OWN), '2026-10-01');
  st = big(st, '2026-10-24', '2026-10-20T01:00:00.000Z');
  st = C.addTrip(st, { trip: { date: '', kind: 'dive', tour: '日付未定' }, at: '2026-10-20T01:00:00.000Z', newId }).state;
  return aiLog(st, '2026-10-02T03:00:00.000Z');
}
const ids = (list) => list.map(x => x.id).sort();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test(`core: 済んで ${ARCHIVE_DAYS} 日を過ぎた便を、予約・人・予定・連絡・記録ごと便ごとに分ける。日付の無い便・最近の便は本体に残り、何も消えない`, () => {
  const st = sample();
  const old = st.trips.find(t => t.date === '2026-10-01');
  const { state: live, parts } = splitPast(st, { today: TODAY });
  assert.deepEqual(live.trips.map(t => t.date).sort(), ['', '2026-10-24']);
  assert.deepEqual(parts.map(p => p.part), [old.id, 'log:2026-10-02']);
  assert.equal(parts[0].day, '2026-10-01');
  assert.equal(parts[0].keepUntil, '2027-10-01', '名簿と同じ 1 年');
  assert.equal(parts[1].keepUntil, '2027-10-03', 'お店全体の記録は、その日の次の日から 1 年（purgeExpired と同じ）');
  const bodies = parts.map(p => JSON.parse(p.body));
  assert.equal(bodies[0].people.length, 30);
  assert.ok(bodies[0].log.length > 0 && bodies[0].log.every(e => e.id !== ''), '便・予約・人の記録は便と一緒に');
  assert.equal(bodies[1].log.length, 1);
  assert.ok(!live.log.some(e => e.at.startsWith('2026-10-02') && e.id === ''), '本体に残さない');
  /* 本体と分けた物を合わせると、元と同じ人・予約・便・記録の数になる */
  const back = joinPast(bodies, OWN);
  assert.ok(back.ok);
  assert.deepEqual(ids([...live.people, ...back.state.people]), ids(st.people));
  assert.deepEqual(ids([...live.bookings, ...back.state.bookings]), ids(st.bookings));
  assert.deepEqual(ids([...live.trips, ...back.state.trips]), ids(st.trips));
  assert.equal(live.log.length + back.state.log.length, st.log.length);
  assert.ok(S.validateState(live).ok);
  /* 分ける物が無ければ、同じ名簿をそのまま返す */
  assert.equal(splitPast(live, { today: TODAY }).state, live);
  assert.equal(splitPast(st, { today: '2026-10-08' }).parts.length, 0, '10/01 から 7 日の日はまだ分けない');
  assert.equal(splitPast(st, { today: '2026-10-09' }).parts.length, 1);
});

test('core: 予定と送った連絡も、便と一緒に分ける', () => {
  let st = big(S.blankState(OWN), '2026-10-01');
  const b = st.bookings[0];
  st = A.planJobs({ ...st, bookings: st.bookings.map(x => (x.id === b.id ? { ...x, leadEmail: 'guest@example.com' } : x)) },
    { bookingId: b.id, nowJst: '2026-09-25T10:00', newId });
  assert.ok(st.jobs.length > 0);
  const { state: live, parts } = splitPast(st, { today: TODAY });
  assert.equal((live.jobs || []).length, 0);
  assert.equal(JSON.parse(parts[0].body).jobs.length, st.jobs.length);
});

test('PUT: 済んだ便は本体から外れて roster_past に移り、GET /api/roster/past で読める。本体の GET には出ない', async () => {
  const s = setup();
  const st = sample();
  const r = await put(s, 0, st);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.state.trips.map(t => t.date).sort(), ['', '2026-10-24']);
  assert.equal(s.db.past.size, 2);
  const g = await call(s, req('GET'));
  assert.equal(g.body.state.people.length, 30 + 0, '本体は 10/24 の 30 人だけ');
  const p = await pastOf(s, '2026-09-27', TODAY);
  assert.equal(p.status, 200);
  assert.equal(p.body.skipped, 0);
  assert.equal(p.body.full, false);
  assert.deepEqual(p.body.state.trips.map(t => t.date), ['2026-10-01']);
  assert.equal(p.body.state.people.length, 30);
  assert.equal(p.body.state.shop.name, '', 'お店の一覧が空のあいだは名前を持たない（画面が本体の名前を使う）');
  assert.ok(S.validateState(p.body.state).ok);
  assert.equal((await pastOf(s, '2026-10-02', TODAY)).body.state.trips.length, 0, '範囲の外の便は返さない');
  assert.ok(logs.some(l => /"moved":2/.test(l)), 'ログに分けた数');
  assert.ok(!logs.some(l => l.includes('見本')), 'ログに名前は出ない');
});

test('時計が進んで便が済んだ日の書き込み: 30 人が本体から移っても「人が大きく消えた」と断らない', async () => {
  const s = setup();
  s.clock.now = Date.parse('2026-10-02T01:00:00Z');   // 10/01 の便の翌日に置く
  const first = await put(s, 0, big(S.blankState(OWN), '2026-10-01'));
  assert.equal(first.status, 200);
  assert.equal(s.db.past.size, 0);
  s.clock.now = NOW;   // 26 日たった
  const now = first.body.state;
  const edited = C.editTrip(now, { tripId: now.trips[0].id, patch: { site: '北の根' }, at: '2026-10-27T01:00:00.000Z' });
  const r = await put(s, 1, edited);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 80));
  assert.equal(r.body.state.people.length, 0);
  assert.equal(s.db.past.size, 1);
  const p = await pastOf(s, '2026-10-01', '2026-10-01');
  assert.equal(p.body.state.trips[0].site, '北の根', '最後の直しまで入った便を移す');
});

test('別の端末に負けた書き込み（版が古い）は、済んだ便も書かない。batch が途中で失敗したら全部戻る', async () => {
  const s = setup();
  s.clock.now = Date.parse('2026-10-02T01:00:00Z');
  const first = await put(s, 0, big(S.blankState(OWN), '2026-10-01'));
  await put(s, 1, C.editTrip(first.body.state, { tripId: first.body.state.trips[0].id, patch: { site: 'A' }, at: '2026-10-02T01:00:00.000Z' }));
  s.clock.now = NOW;
  const stale = await put(s, 1, C.editTrip(first.body.state, { tripId: first.body.state.trips[0].id, patch: { site: 'B' }, at: '2026-10-27T01:00:00.000Z' }));
  assert.equal(stale.status, 409);
  assert.equal(s.db.past.size, 0, '負けた書き込みの済んだ便は置かない');
  /* 直接: 版が合わない putRoster */
  const checked = checkPut({ base: 1, state: first.body.state }, { today: TODAY, at: '2026-10-27T01:00:00.000Z' });
  assert.equal(checked.parts.length, 1);
  assert.deepEqual(await putRoster(s.db, 'default', 1, checked.text, 'x', { parts: checked.parts, today: TODAY }), { ok: false });
  assert.equal(s.db.past.size, 0);
  /* batch の途中の失敗: 名簿の本体も済んだ便も書かない */
  const latest = (await call(s, req('GET'))).body;
  s.db.failBatch = true;
  const failed = await put(s, latest.version, latest.state);
  assert.equal(failed.status, 503);
  assert.equal(s.db.past.size, 0);
  assert.equal(s.db.rows.get('default').version, latest.version);
  s.db.failBatch = false;
  assert.equal((await put(s, latest.version, latest.state)).status, 200);
  assert.equal(s.db.past.size, 1);
});

test('1 年を過ぎた済んだ便は、次に済んだ便を移すときに消え、読む口も渡さない', async () => {
  const s = setup();
  s.db.past.set('default\nold', { shop: 'default', part: 'old', day: '2025-10-20', keep_until: '2026-10-20', body: '{}', moved_at: 'x' });
  s.db.past.set('other\nold', { shop: 'other', part: 'old', day: '2025-10-20', keep_until: '2026-10-20', body: '{}', moved_at: 'x' });
  const p = await pastOf(s, '2025-09-01', '2025-12-31');
  assert.equal(p.status, 400, '93 日より長い範囲は断る');
  assert.equal((await pastOf(s, '2025-10-01', '2025-10-31')).body.state.trips.length, 0, '1 年を過ぎた行は渡さない');
  await put(s, 0, sample());
  assert.ok(!s.db.past.has('default\nold'), '消えた');
  assert.ok(s.db.past.has('other\nold'), '他のお店の行には触らない');
});

test('読む口の守り: 日付の形・順番・今日より先・長すぎる範囲・余分な項目は 400。一覧に無いメールは 403。形の合わない行は外して数を知らせる', async () => {
  const s = setup();
  for (const q of ['from=2026-10-01', 'from=2026-1-01&to=2026-10-02', 'from=2026-10-05&to=2026-10-01', 'from=2026-10-01&to=2026-10-28',
    'from=2026-02-30&to=2026-03-01', 'from=2026-10-01&to=2026-10-02&x=1']) {
    const r = await call(s, req('GET', { path: `/api/roster/past?${q}` }));
    assert.equal(r.status, 400, q);
  }
  assert.equal((await call(s, req('PUT', { path: '/api/roster/past?from=2026-10-01&to=2026-10-02', body: {} }))).status, 405);
  assert.deepEqual(checkPastRange('2026-07-27', TODAY, { today: TODAY }), { ok: true, from: '2026-07-27', to: TODAY });
  assert.equal(checkPastRange('2026-07-26', TODAY, { today: TODAY }).ok, false);

  await put(s, 0, sample());
  const [good] = [...s.db.past.values()].filter(p => !p.part.startsWith('log:'));
  s.db.past.set('default\nbad1', { ...good, part: 'bad1', body: '{broken' });
  s.db.past.set('default\nbad2', { ...good, part: 'bad2' });   // 中身の便の id と part が合わない
  const r = await pastOf(s, '2026-09-27', TODAY);
  assert.equal(r.body.skipped, 2);
  assert.equal(r.body.state.trips.length, 1);
  const rows = await getPast(s.db, 'default', '2026-09-27', TODAY, TODAY, 400);
  assert.equal(readPast(rows, OWN).skipped, 2);

  s.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: ['someone@example.com'] });
  assert.equal((await pastOf(s, '2026-09-27', TODAY)).status, 403);
});

test('サーバーの自動の書き込み（changeRoster）でも、済んだ便を移す', async () => {
  const s = setup();
  s.db.rows.set('default', { version: 3, state: JSON.stringify(sample()), updated_at: 'x' });
  const r = await changeRoster(s.env, s.io, st => ({ state: C.editTrip(st, { tripId: st.trips.find(t => t.date === '2026-10-24').id, patch: { site: 'テストの根' }, at: '2026-10-27T01:00:00.000Z' }) }));
  assert.equal(r.ok, true);
  assert.equal(s.db.rows.get('default').version, 4);
  assert.equal(s.db.past.size, 2);
  assert.ok(!JSON.parse(s.db.rows.get('default').state).trips.some(t => t.date === '2026-10-01'));
});

test('SQL を本物の SQLite（node:sqlite）で流す: 版の守り・上書き・1 年後に消す・範囲で読む', async () => {
  let sqlite;
  try { sqlite = await import('node:sqlite'); } catch (e) { return 'skip'; }
  const raw = new sqlite.DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../worker/migrations/0001_rosters.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../worker/migrations/0004_roster_past.sql', import.meta.url), 'utf8'));
  /* D1 の形（prepare / bind / first / run / all / batch）に包む */
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => raw.prepare(sql).get(...args) || null,
    run: async () => ({ meta: { changes: Number(raw.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: raw.prepare(sql).all(...args) })
  });
  const db = {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      raw.exec('BEGIN');
      try { const out = []; for (const x of list) out.push(await x.run()); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    }
  };
  const at = '2026-10-27T01:00:00.000Z';
  const st = sample();
  const checked = checkPut({ base: 0, state: st }, { today: TODAY, at });
  assert.deepEqual(await putRoster(db, 's', 0, checked.text, at, { parts: checked.parts, today: TODAY }), { ok: true, version: 1 });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM roster_past').get().n, 2);
  assert.deepEqual(await putRoster(db, 's', 0, checked.text, at, { parts: [{ ...checked.parts[0], part: 'x' }], today: TODAY }), { ok: false });
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM roster_past').get().n, 2, '負けた書き込みは足さない');
  raw.prepare("INSERT INTO roster_past VALUES ('s', 'gone', '2025-01-01', '2026-01-01', '{}', 'x')").run();
  const again = checkPut({ base: 1, state: st }, { today: TODAY, at });   // 同じ済んだ便をもう一度移しても、行は増えない（上書き）
  assert.deepEqual(await putRoster(db, 's', 1, again.text, at, { parts: again.parts, today: TODAY }), { ok: true, version: 2 });
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM roster_past WHERE part = 'gone'").get().n, 0, '1 年を過ぎた行は消えた');
  const rows = await getPast(db, 's', '2026-09-27', TODAY, TODAY, 400);
  assert.equal(rows.length, 2);
  const got = readPast(rows, OWN);
  assert.equal(got.skipped, 0);
  assert.equal(got.state.people.length, 30);
  return '';
});

let failed = 0;
for (const t of tests) {
  try {
    const out = await t.fn();
    realLog(`${out === 'skip' ? 'skip' : 'ok  '} ${t.name}`);
  } catch (e) {
    failed += 1;
    realLog(`FAIL ${t.name}\n     ${e.stack}`);
  }
}
realLog(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
