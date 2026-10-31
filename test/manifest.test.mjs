// 乗船者名簿とダイビング計画を確かめる（国交省のダイビング船の安全対策ガイドラインの項目。js/roster-manifest.js）。
// 便の計画（trip.plan）と人の性別（person.sex）は、入れた便・人にだけ付く欄。無い名簿もそのまま読めること。
// 実行: node test/manifest.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/data-sipe.js');
load('../js/roster-schema.js');
load('../js/pass-schema.js');
load('../js/roster-core.js');
load('../js/roster-guest.js');
load('../js/roster-day.js');
load('../js/roster-share.js');
load('../js/roster-manifest.js');
load('../js/data-samples.js');
const { roster: S, rosterCore: C, rosterManifest: M, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-21T09:00:00.000Z';
let n = 0;
const newId = () => `id${(n += 1)}`;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

const trip = { ...S.blankTrip(), id: 't1', date: '2026-11-03', start: '08:30', kind: 'dive', tour: 'ケラマ 2 ボート', guides: ['宮里'], createdAt: AT };
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const base = C.addBooking({ ...S.blankState('B マリン（見本）'), trips: [trip] },
  { trip, booking: { source: 'mail', site: reading.booking.site, people: 2, leadPhone: '090-1234-5678' }, reading, src: 'mail', at: AT, newId });
const [first, second] = base.people;

test('計画も性別も無い前の名簿は、そのまま形の検査を通る', () => {
  assert.equal(S.validateState(base).ok, true);
  assert.equal('plan' in base.trips[0], false);
  assert.equal('sex' in first, false);
});

test('計画の無い便: ポイント・潜水時間・タンク・出港が足りず、見張りは確かめる所', () => {
  const m = M.manifest(base, 't1');
  assert.deepEqual(m.planMissing, ['site', 'minutes', 'tanks', 'depart']);
  assert.deepEqual(m.planCheck, ['watch']);
  assert.equal(m.counts.guests, 2);
  assert.equal(m.counts.guides, 1);
  assert.equal(m.counts.total, 3);
  assert.deepEqual(m.suggest, { size: 10, count: 4 });
});

test('お客さんの行: 年齢は便の日の満年齢、性別が無ければ足りない', () => {
  const m = M.manifest(base, 't1');
  const row = m.rows.find(r => r.personId === first.id);
  assert.ok(row.missing.includes('sex'));
  const age = globalThis.REDUX.rosterDay.ageOn(first.birthDate, '2026-11-03');
  assert.equal(row.cells.age, age === null ? '' : String(age));
  assert.equal(m.rows.find(r => r.kind === 'guide').missing.length, 0);
});

test('性別をお店が入れる: 記録の前は空、行の足りない所から消える', () => {
  const st = C.editPerson(base, { id: first.id, patch: { sex: 'f' }, who: 'staff', at: AT });
  const p = st.people.find(x => x.id === first.id);
  assert.equal(p.sex, 'f');
  assert.equal(p.src.sex, 'staff');
  const log = st.log[st.log.length - 1];
  assert.deepEqual(log.fields, ['sex']);
  assert.deepEqual(log.before, { sex: '' });
  assert.deepEqual(log.after, { sex: 'f' });
  const row = M.manifest(st, 't1').rows.find(r => r.personId === first.id);
  assert.equal(row.cells.sex, '女');
  assert.equal(row.missing.includes('sex'), false);
  assert.equal(S.validateState(st).ok, true);
});

test('性別を空のまま入れても、欄は増えない（変わっていない）', () => {
  assert.equal(C.editPerson(base, { id: first.id, patch: { sex: '' }, who: 'staff', at: AT }), base);
});

test('決まった値でない性別は断る', () => {
  assert.throws(() => C.editPerson(base, { id: first.id, patch: { sex: 'male' }, who: 'staff', at: AT }), /sex/);
});

test('計画を入れる: 渡した所だけ重ね、記録に前と後を残す', () => {
  const a = C.editTrip(base, { tripId: 't1', patch: { plan: { depart: '08:45', port: ' 泊ふ頭 ' } }, at: AT });
  const b = C.editTrip(a, { tripId: 't1', patch: { plan: { minutes: 45, tanks: [{ size: 10, count: 4 }] }, site: 'ナガンヌ北' }, at: AT });
  const plan = b.trips[0].plan;
  assert.equal(plan.depart, '08:45');
  assert.equal(plan.port, '泊ふ頭');
  assert.equal(plan.minutes, 45);
  assert.deepEqual(plan.tanks, [{ size: 10, count: 4 }]);
  const m = M.manifest(b, 't1');
  assert.deepEqual(m.planMissing, []);
  assert.equal(m.tankTotal, 4);
  assert.deepEqual(b.log[b.log.length - 1].fields.sort(), ['plan', 'site']);
  assert.equal(S.validateState(b).ok, true);
});

test('船長を入れると乗る人に 1 人足す。見張りを入れると確かめる所が消える', () => {
  const st = C.editTrip(base, { tripId: 't1', patch: { plan: { captain: '比嘉', watch: '大城' } }, at: AT });
  const m = M.manifest(st, 't1');
  assert.equal(m.counts.crew, 1);
  assert.equal(m.counts.total, 4);
  assert.deepEqual(m.planCheck, []);
});

test('形の合わない計画は断る（時刻・分・タンクの容量の重なり・知らない欄）', () => {
  const bad = [{ depart: '25:00' }, { minutes: 0 }, { minutes: 181 }, { minutes: '45' },
    { tanks: [{ size: 10, count: 2 }, { size: 10, count: 1 }] }, { tanks: [{ size: 0, count: 1 }] },
    { tanks: Array.from({ length: 5 }, (_, i) => ({ size: i + 8, count: 1 })) }, { boatName: 'x' }];
  bad.forEach(plan => assert.throws(() => C.editTrip(base, { tripId: 't1', patch: { plan }, at: AT }), /plan/, JSON.stringify(plan)));
});

test('乗り合いの他のお店のお客さんは人数だけ（住所などを持たない）', () => {
  const shared = C.editTrip(base, { tripId: 't1', patch: { partners: ['C ダイブ（見本）'] }, at: AT });
  const booking = { ...S.blankBooking(), id: 'pb1', tripId: 't1', source: 'partner', shop: 'C ダイブ（見本）', people: 3, createdAt: AT };
  const st = { ...shared, bookings: [...shared.bookings, booking] };
  const m = M.manifest(st, 't1');
  assert.deepEqual(m.partners, [{ shop: 'C ダイブ（見本）', guests: 3 }]);
  assert.equal(m.counts.partnerGuests, 3);
  assert.equal(m.rows.filter(r => r.kind === 'guest').length, 2);
  assert.deepEqual(m.suggest, { size: 10, count: 10 });
});

test('健康の欄は行に出ない', () => {
  const m = M.manifest(base, 't1');
  m.rows.forEach(r => assert.deepEqual(Object.keys(r.cells), ['name', 'sex', 'age', 'address', 'emergency']));
});

test('緊急連絡先: 電話が無ければ空、あれば名前（続柄）電話', () => {
  assert.equal(M.emergencyText({ name: '見本 母', relation: '母', phone: '' }), '');
  assert.equal(M.emergencyText({ name: '見本 母', relation: '母', phone: '090-0000-0000' }), '見本 母（母） 090-0000-0000');
  assert.equal(M.emergencyText({ name: '', relation: '', phone: '090-0000-0000' }), '090-0000-0000');
});

test('無い便は null', () => {
  assert.equal(M.manifest(base, 'nope'), null);
});

console.log(`manifest: ${passed} passed`);
