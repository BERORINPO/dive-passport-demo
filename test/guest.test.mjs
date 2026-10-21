// お客さんが自分で入れる所（roster-guest.js）を確かめる。13 項目がそろうと「そろった」になるか、パスポートから入れられるか。
// 実行: node test/guest.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/roster-schema.js');
load('../js/pass-schema.js');
load('../js/roster-core.js');
load('../js/roster-guest.js');
load('../js/data-samples.js');
const { roster: S, rosterCore: C, rosterGuest: G, pass: P, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-21T09:00:00.000Z';
const TODAY = '2026-10-21';
const NO5 = ['no', 'no', 'no', 'no', 'no'];
let n = 0;
const newId = () => `id${(n += 1)}`;

function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}

/* 便はポイントとガイドが決まっている（P4 でお店が決める所）。予約は見本メール e1（2 人、名前だけ分かる） */
const trip = freeze({ ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング', site: '北の根', guides: ['見本 ガイド'], createdAt: AT });
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const base = freeze(C.addBooking({ ...S.blankState('B マリン（見本）'), trips: [trip] },
  { trip, booking: { source: 'mail', site: reading.booking.site, people: 2 }, reading, src: 'mail', at: AT, newId }));
const bookingId = base.bookings[0].id;
const [hanako, taro] = base.people;

const fullInput = (patch) => ({
  birthDate: '1990-04-01', address: '沖縄県那覇市見本町 1-2-3',
  emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
  cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '', answers: NO5, ...patch
});

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('リンクの中身: 予約の人ごとに、まだの項目を出す（便とお店の項目は聞かない）', () => {
  const v = G.guestView(base, bookingId);
  assert.equal(v.people.length, 2);
  const h = v.people.find(x => x.person.id === hanako.id);
  assert.ok(h.ask.includes('birthDate') && h.ask.includes('address') && h.ask.includes('emergency') && h.ask.includes('history'));
  assert.ok(!h.ask.includes('when') && !h.ask.includes('site') && !h.ask.includes('guide'), '便の項目は聞かない');
  assert.ok(!h.ask.includes('today') && h.needsToday, '当日の体調は入力の欄でなく別に聞く');
  assert.ok(h.known.includes('name'));
  assert.equal(G.guestView(base, 'nope'), null);
});

test('13 項目: お客さんが入れて、当日の体調を答えると「そろった」になる', () => {
  const first = G.applyGuest(base, { id: hanako.id, input: fullInput(), today: TODAY, at: AT });
  assert.deepEqual(first.problems, []);
  let st = first.state;
  const before = C.status(st.people.find(p => p.id === hanako.id), trip);
  assert.deepEqual(before.missing, ['today'], `まだ: ${before.missing}`);
  st = G.answerToday(st, { id: hanako.id, answer: 'ok', day: trip.date, at: AT });
  const after = C.status(st.people.find(p => p.id === hanako.id), trip);
  assert.equal(S.ITEMS.dive.length, 13);
  assert.ok(after.done, `そろっていない: ${after.missing} / ${after.unsure}`);
  assert.ok(S.validateState(st).ok);
  const last = st.log[st.log.length - 1];
  assert.equal(last.who, 'guest');
  assert.equal(st.people.find(p => p.id === hanako.id).src.address, 'guest');
});

test('当日の体調を前の日に答えても、当日の分にはならない', () => {
  const st = G.answerToday(base, { id: hanako.id, answer: 'ok', day: '2026-10-23', at: AT });
  assert.ok(!C.filled(st.people.find(p => p.id === hanako.id), trip, 'today'));
  assert.throws(() => G.answerToday(base, { id: hanako.id, answer: 'maybe', day: trip.date, at: AT }));
});

test('入力の誤り: 直してほしい項目の名前を返し、state は変えない', () => {
  const bad = G.applyGuest(base, { id: hanako.id, input: fullInput({ birthDate: '1990-02-30', emergency: { name: '見本 母', phone: '' }, answers: ['no', null, 'no', 'no', 'no'] }), today: TODAY, at: AT });
  assert.deepEqual(bad.problems.sort(), ['birthDate', 'emergency', 'history']);
  assert.equal(bad.state, base);
  assert.ok(G.guestProblems(fullInput({ cert: { course: 'OW', date: '' } }), ['certDate']).includes('certDate'), 'C カードありなら取得年月が要る');
  assert.deepEqual(G.guestProblems(fullInput({ cert: { course: 'NONE', date: '' } }), ['certDate', 'courses']), [], 'C カードなしなら年月は要らない');
  assert.deepEqual(G.guestProblems(fullInput({ dives: 0, lastDive: '' }), ['dives', 'lastDive']), [], '0 本なら最後に潜った日は要らない');
  assert.ok(G.guestProblems(fullInput({ dives: 3, lastDive: '' }), ['dives', 'lastDive']).includes('lastDive'));
  assert.ok(G.guestProblems(fullInput({ dives: -1 }), ['dives']).includes('dives'));
});

test('聞いていない項目は、入力に入っていても書き換えない', () => {
  const known = freeze(C.editPerson(base, { id: hanako.id, patch: { address: 'お店が入れた住所' }, who: 'staff', at: AT }));
  const r = G.applyGuest(known, { id: hanako.id, input: fullInput({ address: '別の住所' }), today: TODAY, at: AT });
  assert.equal(r.state.people.find(p => p.id === hanako.id).address, 'お店が入れた住所');
});

test('講習だけを聞いたときは、AI が読んだ取得年月を残す', () => {
  const read = freeze(C.editPerson(base, { id: taro.id, patch: { cert: { course: '', date: '2024-05' } }, who: 'staff', at: AT }));
  const v = G.guestView(read, bookingId).people.find(x => x.person.id === taro.id);
  assert.ok(v.ask.includes('courses') && !v.ask.includes('certDate'));
  const r = G.applyGuest(read, { id: taro.id, input: fullInput({ cert: { course: 'OW', date: '' } }), today: TODAY, at: AT });
  assert.deepEqual(r.state.people.find(p => p.id === taro.id).cert, { course: 'OW', date: '2024-05' });
});

test('パスポートから: C カード・本数・既往症を出し、選んだ物だけ入れる', () => {
  const pass = freeze({ ...P.blank(), name: 'Mihon Taro', certs: [
    { agency: 'PADI', level: 'Open Water Diver', no: '1', date: '2024-05' },
    { agency: 'PADI', level: 'Advanced Open Water Diver', no: '2', date: '2025-08' }],
  dives: 14, lastDive: '2026-03', medical: { form: P.FORM, answeredAt: '2026-10-02', answers: ['no', 'no', 'yes', 'no', 'no'] } });
  const offer = G.passportOffer(pass, { today: TODAY, maxDays: 365 });
  assert.deepEqual(offer.items.map(i => i.key), ['cert', 'dives', 'history']);
  assert.deepEqual(offer.items[0].patch.cert, { course: 'AOW', date: '2025-08' }, 'いちばん上の講習');
  assert.equal(offer.items[2].days, 19);
  const st = G.applyPassport(base, { id: taro.id, offer, keys: ['cert', 'history'], at: AT });
  const t = st.people.find(p => p.id === taro.id);
  assert.equal(t.cert.course, 'AOW');
  assert.equal(t.dives, taro.dives, '選ばなかった物は入れない');
  assert.notEqual(t.src.dives, 'passport');
  assert.deepEqual(t.health.answers, ['no', 'no', 'yes', 'no', 'no']);
  assert.equal(t.health.historyAt, '2026-10-02');
  assert.equal(t.src.cert, 'passport');
  assert.equal(st.log[st.log.length - 1].who, 'guest');
  assert.ok(S.validateState(st).ok);
});

test('パスポートから: 古い既往症の答えは入れない（お店の決まりの日数を過ぎた）', () => {
  const pass = freeze({ ...P.blank(), name: 'x', medical: { form: P.FORM, answeredAt: '2025-01-01', answers: NO5 } });
  const offer = G.passportOffer(pass, { today: TODAY, maxDays: 365 });
  const h = offer.items.find(i => i.key === 'history');
  assert.ok(h.old && h.patch === null);
  assert.equal(G.applyPassport(base, { id: taro.id, offer, keys: ['history'], at: AT }), base);
  assert.deepEqual(G.passportOffer(null, { today: TODAY, maxDays: 365 }).items, []);
});

test('C カードの名前から講習の記号へ', () => {
  assert.equal(G.courseOf('Open Water Diver'), 'OW');
  assert.equal(G.courseOf('Junior Open Water Diver'), 'JOW');
  assert.equal(G.courseOf('アドバンスド・オープン・ウォーター'), 'AOW');
  assert.equal(G.courseOf('Rescue Diver'), 'RESCUE');
  assert.equal(G.courseOf('Divemaster'), 'DM');
  assert.equal(G.courseOf('Nitrox'), 'OTHER');
});

test('日数を時計なしで数える（うるう年も）', () => {
  assert.equal(G.daysBetween('2026-10-02', '2026-10-21'), 19);
  assert.equal(G.daysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(G.daysBetween('2025-10-21', '2026-10-21'), 365);
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
process.exit(failed ? 1 : 0);
