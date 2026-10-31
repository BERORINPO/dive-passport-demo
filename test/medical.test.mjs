// 医師の診断書の一覧を確かめる（お店の決まりを年齢と健康の答えに当てはめる。js/roster-medical.js）。
// お店の決まり（shop.medical）と診断日（health.medAt）は、入れた店・人にだけ付く欄。無い名簿もそのまま読めること。
// 実行: node test/medical.test.mjs （Node 18 以上。依存なし）
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
load('../js/roster-medical.js');
load('../js/data-samples.js');
const { roster: S, rosterCore: C, rosterMedical: M, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-31T09:00:00.000Z';
let n = 0;
const newId = () => `id${(n += 1)}`;
let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };

const trip = { ...S.blankTrip(), id: 't1', date: '2026-11-03', start: '08:30', kind: 'dive', tour: 'ケラマ 2 ボート', createdAt: AT };
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const made = C.addBooking({ ...S.blankState('B マリン（見本）'), trips: [trip] },
  { trip, booking: { source: 'mail', people: 2, leadPhone: '090-1234-5678' }, reading, src: 'mail', at: AT, newId });
const [first, second] = made.people;
const edit = (st, id, patch) => C.editPerson(st, { id, patch, who: 'staff', at: AT });
const NO = ['no', 'no', 'no', 'no', 'no'];
/* first: 64 歳・答えは全部「いいえ」 / second: 37 歳・「はい」が 1 つ */
const base = edit(edit(made, first.id, { birthDate: '1962-05-01', health: { answers: NO, historyAt: '2026-10-30' } }),
  second.id, { birthDate: '1989-01-15', health: { answers: ['no', 'yes', 'no', 'no', 'no'], historyAt: '2026-10-30' } });
const row = (st, id) => M.medicalList(st, 't1').rows.find(r => r.person.id === id);

test('決まりも診断日も無い名簿は、そのまま形の検査を通る', () => {
  assert.equal(S.validateState(base).ok, true);
  assert.equal('medical' in base.shop, false);
  assert.equal('medAt' in base.people[0].health, false);
});

test('最初の決まり: 60 歳以上は答えに関わらず要る・「はい」があれば要る', () => {
  const m = M.medicalList(base, 't1');
  assert.deepEqual(m.rules, { ...S.MEDICAL_DEFAULT });
  assert.equal(row(base, first.id).status, 'missing');
  assert.deepEqual(row(base, first.id).why, ['age']);
  assert.equal(row(base, second.id).status, 'missing');
  assert.deepEqual(row(base, second.id).why, ['yes']);
  assert.equal(row(base, second.id).yes, 1);
  assert.equal(m.counts.missing, 2);
});

test('59 歳で答えが全部「いいえ」なら要らない。答えがまだなら決められない', () => {
  const st = edit(base, first.id, { birthDate: '1967-05-01' });
  assert.equal(row(st, first.id).status, 'none');
  const blank = edit(st, first.id, { health: { answers: [null, null, null, null, null] } });
  assert.equal(row(blank, first.id).status, 'unknown');
  const noBirth = edit(st, first.id, { birthDate: '' });
  assert.equal(row(noBirth, first.id).status, 'unknown');
});

test('診断日を入れる: 期限内は ok、期限は診断日を 1 日目に数える', () => {
  const st = edit(base, second.id, { health: { medAt: '2025-11-04' } });
  const r = row(st, second.id);
  assert.equal(r.status, 'ok');
  assert.equal(r.until, '2026-11-03');
  assert.equal(S.validateState(st).ok, true);
  const late = edit(base, second.id, { health: { medAt: '2025-11-03' } });
  assert.equal(row(late, second.id).status, 'expired');
  assert.equal(row(late, second.id).until, '2026-11-02');
});

test('65 歳以上は短い期限（90 日）', () => {
  const st = edit(base, first.id, { birthDate: '1960-01-01', health: { medAt: '2026-08-01' } });
  const r = row(st, first.id);
  assert.equal(r.older, true);
  assert.equal(r.days, 90);
  assert.equal(r.until, '2026-10-29');
  assert.equal(r.status, 'expired');
});

test('診断日の記録には受け取った印だけ残り、日付は残らない', () => {
  const st = edit(base, first.id, { health: { medAt: '2026-10-01' } });
  const e = st.log[st.log.length - 1];
  assert.deepEqual(e.fields, ['health']);
  assert.equal(e.after.health.med, true);
  assert.equal('med' in e.before.health, false);
  assert.equal(JSON.stringify(e).includes('2026-10-01'), false);
  assert.equal(S.validateState(st).ok, true);
});

test('お店の決まりを変える: 年齢を空にすると年齢では決めない。記録に残る', () => {
  const st = C.setMedicalRules(base, { rules: { age: '' }, at: AT });
  assert.equal(st.shop.medical.age, '');
  assert.equal(st.log[st.log.length - 1].fields[0], 'medical');
  assert.equal(row(st, first.id).status, 'none');
  assert.equal(row(st, second.id).status, 'missing');
  assert.equal(S.validateState(st).ok, true);
});

test('決まりの形が違えば例外（0 日・121 歳・知らない欄は名簿に入らない）', () => {
  assert.throws(() => C.setMedicalRules(base, { rules: { days: 0 }, at: AT }));
  assert.throws(() => C.setMedicalRules(base, { rules: { age: 121 }, at: AT }));
  const st = C.setMedicalRules(base, { rules: { other: 1 }, at: AT });
  assert.equal('other' in st.shop.medical, false);
  assert.equal(S.validateState({ ...base, shop: { ...base.shop, medical: { ...S.MEDICAL_DEFAULT, extra: 1 } } }).ok, false);
});

test('体験ダイビング（C カードなし）は 65 歳を超えると印が付く', () => {
  const st = edit(base, first.id, { birthDate: '1955-01-01', cert: { course: 'NONE', date: '' } });
  assert.equal(row(st, first.id).trialOver, true);
  assert.equal(row(base, second.id).trialOver, false);
});

test('健康を紙で聞く店は、年齢の決まりだけで決める（答えは見ない）', () => {
  const st = C.setHealthPaper(base, { paper: true, at: AT });
  assert.equal(row(st, first.id).status, 'missing');
  assert.equal(row(st, second.id).status, 'none');
  assert.equal(M.medicalList(st, 't1').paper, true);
});

test('乗り合いの他のお店のお客さんは数えず、診断日も持てない', () => {
  const held = { ...second, health: { ...second.health, answers: [null, null, null, null, null], historyAt: '', heldBy: 'A マリン' } };
  assert.equal(S.validatePerson(held).ok, true);
  assert.equal(S.validatePerson({ ...held, health: { ...held.health, medAt: '2026-10-01' } }).ok, false);
  const st = { ...base, people: base.people.map(p => (p.id === second.id ? held : p)) };
  const m = M.medicalList(st, 't1');
  assert.equal(m.held, 1);
  assert.equal(m.rows.some(r => r.person.id === second.id), false);
});

test('お客さんへの知らせ: 要る人だけ。年齢そのものと「はい」の項目は出さない', () => {
  assert.deepEqual(M.guestMedical(base, first.id), { status: 'missing', why: ['age'], ageFrom: 60, days: 365, until: '' });
  assert.deepEqual(M.guestMedical(base, second.id), { status: 'missing', why: ['yes'], ageFrom: '', days: 365, until: '' });
  const got = edit(base, second.id, { health: { medAt: '2026-10-01' } });
  assert.deepEqual(M.guestMedical(got, second.id), { status: 'ok', why: ['yes'], ageFrom: '', days: 365, until: '2027-09-30' });
  const young = edit(base, first.id, { birthDate: '1990-01-01' });
  assert.equal(M.guestMedical(young, first.id), null);
  assert.equal(M.guestMedical(base, 'nobody'), null);
});

test('暦の計算: 月末・うるう年をまたぐ', () => {
  assert.equal(M.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(M.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(M.validUntil('2026-11-03', 365), '2027-11-02');
  assert.equal(M.medicalList(base, 'nothing'), null);
  /* 1999〜2101 の毎月 1 日・28 日から 0〜800 日先を、テストだけで使う Date と見比べる */
  for (let y = 1999; y <= 2101; y += 1) {
    for (let m = 1; m <= 12; m += 1) {
      for (const d of [1, 28]) {
        const day = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        for (const k of [0, 1, 59, 365, 366, 800]) {
          assert.equal(M.addDays(day, k), new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10), `${day} + ${k}`);
        }
      }
    }
  }
});

console.log(`medical: ${passed} passed`);
