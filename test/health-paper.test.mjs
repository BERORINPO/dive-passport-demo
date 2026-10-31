// 健康の質問を紙の申込書で聞くお店（試用の形。state.shop.health === 'paper'。plan/meibo.md の「健康を紙で聞く」）を確かめる。
// 健康の 2 項目を待たずに名簿がそろうこと、お客さんのリンクと自動の連絡で健康を聞かないこと、当日の朝の質問を送らないこと、
// 名簿の紙に「紙の申込書」と出ること、切り替えが記録に残ること、サーバーの厳しい検査が通すこと。
// 実行: node test/health-paper.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { checkPut } from '../worker/sync-core.mjs';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
['../js/data-samples.js'].forEach(load);
const { roster: S, rosterCore: C, rosterAuto: A, rosterGuest: G, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-27T01:00:00.000Z';
const NOW = '2026-10-27T10:00';
let n = 0;
const newId = () => `id${(n += 1)}`;
const reading = () => {
  const r = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
  r.booking = { ...r.booking, date: '2026-10-31' };
  return r;
};
/* 健康以外の名簿の項目を全部入れる */
function fillButHealth(st, bookingId) {
  return st.people.filter(p => p.bookingId === bookingId).reduce((s, p) => C.editPerson(s, { id: p.id, who: 'guest', src: 'guest', at: AT, patch: {
    birthDate: '1990-04-01', address: '沖縄県那覇市見本町 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
    cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '' } }), st);
}
const setup = (paper) => {
  const made = A.addFromReading(S.blankState('B マリン（見本）'), { reading: reading(), at: AT, nowJst: NOW, newId });
  let st = fillButHealth(made.state, made.bookingId);
  st = C.editTrip(st, { tripId: st.trips[0].id, patch: { site: '北の根', guides: ['見本 ガイド'] }, at: AT });
  return { st: paper ? C.setHealthPaper(st, { paper: true, at: AT }) : st, bookingId: made.bookingId };
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('切り替え: 名簿に印が付き、記録に残り、形の検査とサーバーの厳しい検査を通る。同じ値なら何も変えない。戻せる', () => {
  const { st } = setup(true);
  assert.equal(st.shop.health, 'paper');
  assert.ok(C.paperOf(st));
  const last = st.log[st.log.length - 1];
  assert.deepEqual([last.act, last.kind, last.fields, last.before, last.after], ['edit', 'state', ['health'], { health: 'app' }, { health: 'paper' }]);
  assert.ok(S.validateState(st).ok);
  assert.equal(checkPut({ base: 0, state: st }, { today: '2026-10-27', at: AT }).ok, true);
  assert.equal(C.setHealthPaper(st, { paper: true, at: AT }), st);
  const back = C.setHealthPaper(st, { paper: false, at: AT });
  assert.equal(back.shop.health, undefined);
  assert.ok(!S.validateState({ ...st, shop: { name: 'x', health: 'other' } }).ok, '決まった値だけ');
});

test('名簿のそろい具合: 紙のお店では、健康の 2 項目を待たない。アプリで聞くお店では待つ', () => {
  const app = setup(false);
  const paper = setup(true);
  const tripId = app.st.trips[0].id;
  assert.equal(C.tripSummary(app.st, tripId).done, 0);
  const p = paper.st.people[0];
  const trip = paper.st.trips[0];
  assert.deepEqual(C.status(p, trip, { paper: true }).missing, []);
  assert.equal(C.tripSummary(paper.st, paper.st.trips[0].id).done, paper.st.people.length);
  assert.deepEqual(C.askGuest(p, trip, { paper: true }), []);
  assert.ok(C.askGuest(app.st.people[0], app.st.trips[0]).includes('history'));
});

test('お客さんのリンク: 紙のお店では、健康の質問も当日の体調も聞かない', () => {
  const app = setup(false);
  const paper = setup(true);
  const va = G.guestView(app.st, app.bookingId).people[0];
  const vp = G.guestView(paper.st, paper.bookingId).people[0];
  assert.ok(va.ask.includes('history'));
  assert.ok(!vp.ask.includes('history'));
  assert.equal(vp.needsToday, false);
});

test('自動の連絡: お願いの本文は「健康は当日の紙で」と書き、当日の朝の体調の質問は送らない', () => {
  const { st } = setup(true);
  const fresh = C.setHealthPaper(A.addFromReading(S.blankState('B マリン（見本）'), { reading: reading(), at: AT, nowJst: NOW, newId }).state, { paper: true, at: AT });
  const req = A.runDue(fresh, { nowJst: NOW, at: AT, newId, askBase: 'https://example.test/#ask=' }).state.outbox[0];
  assert.equal(req.kind, 'request');
  assert.ok(req.body.includes('健康の質問は、当日の受付で紙の申込書にお願いします'));
  assert.ok(!req.body.includes('このお店だけが見ます'));
  const morning = A.runDue(st, { nowJst: '2026-10-31T06:00', at: AT, newId, askBase: 'https://example.test/#ask=' }).state;
  assert.ok(!morning.outbox.some(o => o.kind === 'today'), '当日の朝の質問は送らない');
  assert.ok(morning.trips[0].rosterAt, '名簿は作る');
});

test('名簿の紙: 健康の 2 欄は「紙の申込書」と出し、そろった人として数える', () => {
  const { st } = setup(true);
  const table = C.rosterRows(st, st.trips[0].id, [], { own: true });
  assert.ok(table.rows.every(r => r.done));
  assert.ok(table.rows.every(r => r.cells.history === C.PAPER_TEXT && r.cells.today === C.PAPER_TEXT));
});

test('血中酸素: 紙のお店では名簿に入れない（健康の数値を預からない。決定ログ 2026-11-01 trial-health-paper）。アプリで聞くお店は今まで通り', () => {
  ['../js/data-sipe.js', '../js/roster-day.js'].forEach(load);
  const D = globalThis.REDUX.rosterDay;
  const put = (st) => D.setSpo2(st, { id: st.people[0].id, dive: 1, side: 'pre', value: 98, at: AT });
  assert.throws(() => put(setup(true).st), /紙のお店/);
  assert.equal(put(setup(false).st).people[0].health.spo2[0].pre, 98);
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
