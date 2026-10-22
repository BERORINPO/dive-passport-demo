// 今日の名簿・条例の名簿（印刷・CSV）・カレンダー（.ics）・記録を確かめる（P4）。
// 実行: node test/day.test.mjs （Node 18 以上。依存なし）
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
load('../js/data-samples.js');
const { roster: S, rosterCore: C, rosterGuest: G, rosterDay: D, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-21T09:00:00.000Z';
const TODAY = '2026-10-21';
const STAMP = '20261021T090000Z';
const NO5 = ['no', 'no', 'no', 'no', 'no'];
const HEALTH_SHORT = ['治療中の病気', '心臓・肺', '耳・鼻', '妊娠', '手術・けが'];
let n = 0;
const newId = () => `id${(n += 1)}`;

function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}

/* 前の便（10/20、ポイントは砂辺）と、今日の便（10/24、ポイントとガイドがまだ）。今日の便に見本メール e1 の 2 人 */
const past = { ...S.blankTrip(), id: 't0', date: '2026-10-20', start: '08:30', kind: 'dive', tour: '体験ダイビング', site: '砂辺', guides: ['見本 ガイド'], createdAt: AT };
const trip = { ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', createdAt: AT };
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const base = freeze(C.addBooking({ ...S.blankState('B マリン（見本）'), trips: [past, trip] },
  { trip, booking: { source: 'mail', site: reading.booking.site, people: 2, leadPhone: '090-1234-5678' }, reading, src: 'mail', at: AT, newId }));
const [hanako, taro] = base.people;
const tripOf = (st) => st.trips.find(t => t.id === 't1');

const fullInput = { birthDate: '1990-04-01', address: '沖縄県那覇市見本町 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
  cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '', answers: NO5, consent: true };
function fillAll(st, id) {
  const a = G.applyGuest(st, { id, input: fullInput, today: TODAY, at: AT }).state;
  return G.answerToday(a, { id, answer: 'ok', day: trip.date, at: AT }).state;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('便で決めること: 潜水場所とガイドを入れると、前と後が記録に残る', () => {
  const st = C.editTrip(base, { tripId: 't1', patch: { site: ' 北の根 ', guides: ['見本 ガイド', ''] }, at: AT });
  assert.equal(tripOf(st).site, '北の根');
  assert.deepEqual(tripOf(st).guides, ['見本 ガイド']);
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.who, e.act, e.kind, e.id], ['staff', 'edit', 'trip', 't1']);
  assert.deepEqual(e.before, { site: '', guides: [] });
  assert.equal(C.editTrip(st, { tripId: 't1', patch: { site: '北の根' }, at: AT }), st, '変わらなければ記録しない');
  assert.throws(() => C.editTrip(base, { tripId: 't1', patch: { site: 'あ'.repeat(81) }, at: AT }));
  assert.equal(C.editTrip(base, { tripId: 't1', patch: { date: '2030-01-01' }, at: AT }), base, '日付などは直せない');
  assert.ok(S.validateState(st).ok);
});

test('前の便と同じポイントを出す（同じ種類で、いちばん近い前の便）', () => {
  assert.equal(D.previousSite(base, tripOf(base)), '砂辺');
  assert.equal(D.previousSite(base, past), '');
  assert.deepEqual(D.usedSites(base), ['砂辺']);
  assert.deepEqual(D.usedGuides(base), ['見本 ガイド']);
});

test('今日の名簿の人分け: 見てほしい人が上、そろった人が下。便の項目は便の欄に出す', () => {
  let g = D.dayGroups(base, 't1', TODAY);
  assert.deepEqual(g.tripMissing, ['site', 'guide']);
  assert.equal(g.check.length, 2);
  assert.equal(g.ready.length, 0);
  assert.equal(g.count, 2);
  const st = fillAll(C.editTrip(base, { tripId: 't1', patch: { site: '北の根', guides: ['見本 ガイド'] }, at: AT }), hanako.id);
  g = D.dayGroups(st, 't1', TODAY);
  assert.deepEqual(g.tripMissing, []);
  assert.deepEqual(g.ready.map(x => x.person.id), [hanako.id]);
  assert.ok(g.ready[0].done, '13 項目そろった');
  assert.deepEqual(g.check.map(x => x.person.id), [taro.id]);
  assert.ok(g.check[0].guest.includes('address') && !g.check[0].guest.includes('site'));
  assert.equal(D.dayGroups(base, 'nope', TODAY), null);
});

test('当日の健康状態だけがまだの人は、便の日の前なら「当日の朝」に分ける（見てほしい人に混ぜない）', () => {
  const a = G.applyGuest(base, { id: hanako.id, input: fullInput, today: TODAY, at: AT }).state;
  const before = D.dayGroups(a, 't1', TODAY);
  assert.deepEqual(before.morning.map(x => x.person.id), [hanako.id]);
  assert.ok(!before.check.some(x => x.person.id === hanako.id));
  const onTheDay = D.dayGroups(a, 't1', trip.date);
  assert.ok(onTheDay.check.some(x => x.person.id === hanako.id), '当日になったら見てほしい人に出る');
  assert.equal(onTheDay.morning.length, 0);
});

test('条例の名簿: 13 項目全部が列になり、健康の欄は短い言葉で入る', () => {
  const st = fillAll(C.editTrip(base, { tripId: 't1', patch: { site: '北の根', guides: ['見本 ガイド'] }, at: AT }), hanako.id);
  const { items, rows } = C.rosterRows(st, 't1', HEALTH_SHORT);
  assert.equal(items.length, 13);
  const h = rows.find(r => r.personId === hanako.id);
  assert.ok(h.done);
  assert.deepEqual(items.map(i => h.cells[i.key] !== ''), Array(13).fill(true), '13 項目全部に中身がある');
  assert.equal(h.cells.history, 'なし');
  assert.equal(h.cells.today, '良好');
  assert.equal(h.cells.site, '北の根');
  const csv = C.toCsv({ items, rows });
  assert.ok(csv.startsWith('\uFEFF氏名,生年月日,住所'));
  assert.equal(csv.split('\r\n').filter(Boolean).length, 3, '見出し + 2 人');
});

test('印刷と CSV は、人数だけを記録に残す', () => {
  const st = C.logOutput(base, { tripId: 't1', act: 'print', people: 2, at: AT });
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.id, e.after.people], ['print', 'trip', 't1', 2]);
  const csv = C.logOutput(base, { tripId: 't1', act: 'csv', people: 2, health: false, at: AT });
  assert.equal(csv.log[csv.log.length - 1].after.health, false, 'CSV に健康の欄を入れたかを残す');
  assert.ok(S.validateState(st).ok);
  assert.throws(() => C.logOutput(base, { tripId: 't1', act: 'mail', people: 2, at: AT }));
  assert.throws(() => C.logOutput(base, { tripId: 'nope', act: 'csv', people: 2, at: AT }));
});

test('.ics: 便ごとに予定 1 つ。時刻・ツアー・人数だけで、名前・電話・健康は入らない', () => {
  const st = fillAll(C.editTrip(base, { tripId: 't1', patch: { site: '北の根', guides: ['見本 ガイド'] }, at: AT }), hanako.id);
  const trips = D.icsTrips(st, { from: TODAY });
  assert.deepEqual(trips.map(t => t.id), ['t1'], '今日から先の便だけ');
  const ics = D.toIcs(st, { trips, stamp: STAMP });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.split('BEGIN:VEVENT').length - 1, 1);
  assert.ok(ics.includes('DTSTART;TZID=Asia/Tokyo:20261024T083000'));
  assert.ok(ics.includes('DTEND;TZID=Asia/Tokyo:20261024T113000'));
  assert.ok(ics.includes('SUMMARY:体験ダイビング（ボート2本） 2人'));
  assert.ok(ics.includes('LOCATION:北の根'));
  const unfolded = ics.replace(/\r\n /g, '');
  ['見本 花子', '見本 太郎', '090-', '沖縄県那覇市', '見本 母', '良好'].forEach(w => assert.ok(!unfolded.includes(w), `入れてはいけない: ${w}`));
  ics.split('\r\n').forEach(l => assert.ok(new TextEncoder().encode(l).length <= 75, `75 バイトを超える行: ${l}`));
  assert.deepEqual(D.icsTrips(st, { from: TODAY, day: '2026-10-20' }).map(t => t.id), ['t0'], 'この日の便だけ');
});

test('.ics: 時刻の無い便は終日。文字の , ; \\ は逃がす。長い行は折り返す', () => {
  const t = { ...S.blankTrip(), id: 't9', date: '2026-12-31', start: '', kind: 'snorkel', tour: '青の洞窟, 北;西\\', site: 'あ'.repeat(40), createdAt: AT };
  const st = { ...base, trips: [...base.trips, t] };
  const ics = D.toIcs(st, { trips: [t], stamp: STAMP });
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261231'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20270101'), '年をまたぐ');
  assert.ok(ics.includes('SUMMARY:青の洞窟\\, 北\\;西\\\\ 0人'));
  assert.ok(ics.includes('\r\n '), '長い行は折り返す');
  assert.throws(() => D.toIcs(st, { trips: [t], stamp: '2026-10-21' }));
});

test('.ics: CR だけの改行や制御文字で、別の行を差し込めない', () => {
  const t = { ...S.blankTrip(), id: 't8', date: '2026-11-01', start: '09:00', kind: 'dive', tour: 'ツアー\rURL:https://evil.example.com\rEND:VEVENT\u0007', site: '', createdAt: AT };
  const ics = D.toIcs({ ...base, trips: [...base.trips, t] }, { trips: [t], stamp: STAMP });
  const lines = ics.replace(/\r\n /g, '').split('\r\n');
  assert.ok(!lines.some(l => l.startsWith('URL:')), 'URL の行が出来ない');
  assert.equal(lines.filter(l => l === 'END:VEVENT').length, 1);
  assert.ok(!ics.includes('\u0007'));
  assert.ok(/\r(?!\n)/.test(ics) === false, 'CR は CRLF の中にだけある');
});

test('AI の答えの文字: 改行は空白に、制御文字は消す', () => {
  const r = S.fromModel({ booking: { tour: '体験\r\nダイビング\u0000', site: 'サイト\r見本' }, people: [], health_info_visible: false });
  assert.equal(r.booking.tour, '体験 ダイビング');
  assert.equal(r.booking.site, 'サイト 見本');
});

test('記録: その便に関わる物（便・予約・人）を新しい順に。AI に送った記録は別に出す', () => {
  let st = C.editTrip(base, { tripId: 't1', patch: { site: '北の根' }, at: '2026-10-22T00:00:00.000Z' });
  st = C.logAi(st, { at: '2026-10-21T08:00:00.000Z', sent: { doc: 'mail', size: 1200, masked: false, mode: 'sample', healthSeen: false, redacted: 1 } });
  st = C.logOutput(st, { tripId: 't1', act: 'print', people: 2, at: '2026-10-23T00:00:00.000Z' });
  const { entries, ai } = D.tripLog(st, 't1');
  assert.equal(entries[0].act, 'print', '新しい順');
  assert.ok(entries.some(e => e.kind === 'booking') && entries.some(e => e.kind === 'person'));
  assert.ok(entries.every(e => e.act !== 'ai'));
  assert.equal(ai.length, 1);
  assert.equal(D.tripLog(st, 't0').entries.length, 0, '別の便の記録は出さない');
});

/* ---------- 血中酸素と年齢の印（県警の体調チェック表） ---------- */
const sp = (...pairs) => [0, 1, 2].map(i => ({ pre: pairs[i] ? pairs[i][0] : '', post: pairs[i] ? pairs[i][1] : '' }));

test('血中酸素の目安: 1 本目の前か潜った後が 95 以下、次の前が直前の後より低いと高リスク（表の 3 つだけ）', () => {
  assert.deepEqual(D.spo2Risk(sp()), { measured: false, high: false, why: [], pending: [] });
  assert.equal(D.spo2Risk(sp([96, 96], [96, ''])).high, false, '96 と、戻った 96 は目安の範囲');
  assert.deepEqual(D.spo2Risk(sp([95, ''])).why, [{ dive: 1, side: 'pre', kind: 'low', value: 95 }], '95 は「95 以下」に入る');
  assert.deepEqual(D.spo2Risk(sp([98, 94])).why, [{ dive: 1, side: 'post', kind: 'low', value: 94 }]);
  assert.deepEqual(D.spo2Risk(sp([97, 98], [97, ''])).why, [{ dive: 2, side: 'pre', kind: 'notBack', value: 97, ref: 98 }]);
  assert.equal(D.spo2Risk(sp([97, ''], [96, ''])).high, false, '直前の「潜った後」が無ければ比べない（表に無い判定は足さない）');
  assert.equal(D.spo2Risk(sp([97, 97], [97, 97], [96, ''])).why[0].dive, 3);
  assert.equal(D.spo2Risk(sp(['', 97])).measured, true);
  assert.deepEqual(D.spo2Risk(sp([97, ''], [88, ''])).pending, [2], '直前の後が空で比べられない本は pending（目安に当たらない、とは言わない）');
  assert.deepEqual(D.spo2Risk(sp([97, 96], [96, ''])).pending, []);
});

test('血中酸素は、条例の名簿の行と CSV（健康の欄あり）に出さない。健康の欄の出どころも変えない', () => {
  const st = D.setSpo2(fillAll(base, hanako.id), { id: hanako.id, dive: 1, side: 'pre', value: 87, at: AT });
  const p = st.people.find(x => x.id === hanako.id);
  assert.equal(p.src.health, 'guest', 'お客さんが答えた出どころのまま');
  const table = C.rosterRows(st, 't1', HEALTH_SHORT, { own: true });
  assert.ok(!JSON.stringify(table.rows.map(r => r.cells)).includes('87'));
  assert.ok(!C.toCsv(table).includes('87'));
});

test('年齢: その日の満年齢。年だけ・年月だけは 1 月 1 日として数え、分からなければ null', () => {
  assert.equal(D.ageOn('1976-10-24', '2026-10-24'), 50, '誕生日の当日');
  assert.equal(D.ageOn('1976-10-25', '2026-10-24'), 49);
  assert.equal(D.ageOn('1976-10', '2026-10-24'), 50);
  assert.equal(D.ageOn('1976', '2026-01-01'), 50);
  assert.equal(D.ageOn('', '2026-10-24'), null);
  assert.equal(D.ageOn('1976-10-24', ''), null);
  assert.equal(D.ageOn('2027-01-01', '2026-10-24'), null, '便より後の生年月日');
});

test('血中酸素を入れる: 健康の欄として残し、記録には数値を残さない。幅の外・他のお店の人は断る', () => {
  const id = taro.id;
  let st = D.setSpo2(base, { id, dive: 1, side: 'pre', value: 97, at: AT });
  st = D.setSpo2(st, { id, dive: 1, side: 'post', value: 94, at: AT });
  const p = st.people.find(x => x.id === id);
  assert.deepEqual(p.health.spo2[0], { pre: 97, post: 94 });
  assert.equal(p.health.spo2.length, S.SPO2_DIVES);
  assert.deepEqual(p.health.answers, taro.health.answers, 'ほかの健康の欄は変えない');
  assert.ok(S.validateState(st).ok);
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.who, e.act, e.fields], ['staff', 'edit', ['health']]);
  assert.ok(!JSON.stringify(e).includes('94') && !JSON.stringify(e).includes('spo2'), '記録に数値を残さない');
  st = D.setSpo2(st, { id, dive: 1, side: 'post', value: '', at: AT });
  assert.equal(st.people.find(x => x.id === id).health.spo2[0].post, '', '消せる');
  [49, 101, 97.5, '97', null].forEach(v => assert.throws(() => D.setSpo2(base, { id, dive: 1, side: 'pre', value: v, at: AT }), undefined, String(v)));
  assert.throws(() => D.setSpo2(base, { id, dive: 4, side: 'pre', value: 97, at: AT }));
  assert.throws(() => D.setSpo2(base, { id, dive: 1, side: 'during', value: 97, at: AT }));
  assert.throws(() => D.setSpo2(base, { id: 'nobody', dive: 1, side: 'pre', value: 97, at: AT }));
});

test('血中酸素の形: 前の版（spo2 なし）も通る。本数が違う・他のお店の人に数値がある形は通さない', () => {
  const h = taro.health;
  const ok = (health) => S.validatePerson({ ...taro, health }).ok;
  assert.ok(ok(h));
  assert.ok(ok({ ...h, spo2: sp([97, 96]) }));
  assert.ok(!ok({ ...h, spo2: sp([97, 96]).slice(0, 2) }));
  assert.ok(!ok({ ...h, spo2: sp([97, 'x']) }));
  assert.ok(!ok({ ...h, spo2: sp().map((d, i) => (i === 0 ? { ...d, note: '' } : d)) }), '決まった名前だけ');
  const held = { historyAt: '', answers: [null, null, null, null, null], todayAt: '', today: '', heldBy: 'C ダイブ' };
  assert.ok(ok({ ...held, spo2: sp() }));
  assert.ok(!ok({ ...held, spo2: sp([97, '']) }), '他のお店の人の数値は持たない');
  const partnerBase = { ...base, bookings: [...base.bookings, { ...S.blankBooking(), id: 'bp', tripId: 't1', source: 'partner', shop: 'C ダイブ', people: 1, createdAt: AT }],
    people: [...base.people, { ...S.blankPerson(), id: 'pp', bookingId: 'bp', name: '見本 他店', health: held }] };
  assert.ok(S.validateState(partnerBase).ok);
  assert.throws(() => D.setSpo2(partnerBase, { id: 'pp', dive: 1, side: 'pre', value: 97, at: AT }), /他のお店/);
});

test('血中酸素の一覧: この店のお客さんだけ。50 歳以上の数、高リスクの人、出す本数（3 本目に数値があれば 3）', () => {
  let st = C.editPerson(base, { id: hanako.id, patch: { birthDate: '1970-05-05' }, who: 'staff', at: AT });
  st = C.editPerson(st, { id: taro.id, patch: { birthDate: '1990-05-05' }, who: 'staff', at: AT });
  st = { ...st, bookings: [...st.bookings, { ...S.blankBooking(), id: 'bp', tripId: 't1', source: 'partner', shop: 'C ダイブ', people: 1, createdAt: AT }],
    people: [...st.people, { ...S.blankPerson(), id: 'pp', bookingId: 'bp', name: '見本 他店', birthDate: '1950-01-01',
      health: { historyAt: '', answers: [null, null, null, null, null], todayAt: '', today: '', heldBy: 'C ダイブ' } }] };
  let g = D.sipeRows(st, 't1');
  assert.deepEqual(g.rows.map(r => r.person.id), [hanako.id, taro.id], '乗り合いの他のお店のお客さんは入れない');
  assert.deepEqual(g.rows.map(r => r.age), [56, 36]);
  assert.equal(g.older, 1);
  assert.equal(g.shown, 2);
  assert.equal(g.measured, 0);
  st = D.setSpo2(st, { id: taro.id, dive: 3, side: 'pre', value: 95, at: AT });
  g = D.sipeRows(st, 't1');
  assert.equal(g.shown, 3);
  assert.equal(g.measured, 1);
  assert.deepEqual(g.high.map(r => r.person.id), [], '3 本目の前は、直前の後と比べるだけ（95 でも 1 本目の前ではない）');
  st = D.setSpo2(st, { id: taro.id, dive: 1, side: 'pre', value: 93, at: AT });
  assert.deepEqual(D.sipeRows(st, 't1').high.map(r => r.person.id), [taro.id]);
  assert.equal(D.sipeRows(st, 'nope'), null);
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
