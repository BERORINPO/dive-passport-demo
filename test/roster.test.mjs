// 予約と名簿の形・判定・記録・条例の名簿を確かめる。保存して読み戻しても同じになるかも見る。
// 実行: node test/roster.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/roster-schema.js');
load('../js/roster-core.js');
load('../js/data-samples.js');
const { roster: S, rosterCore: C, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-21T09:00:00.000Z';
const HEALTH_SHORT = ['治療中の病気', '心臓・肺', '耳・鼻', '妊娠', '手術・けが'];
const NO5 = ['no', 'no', 'no', 'no', 'no'];
let n = 0;
const newId = () => `id${(n += 1)}`;

/* 入れ子まで凍らせる。core が受け取った物を書き換えたら、ここで例外になる */
function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}
const SAMPLES = freeze(JSON.parse(JSON.stringify(SAMPLE_READINGS)));

const trip = freeze({ ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', site: '北の根', guides: ['見本 ガイド'], createdAt: AT });
const base = freeze({ ...S.blankState('B マリン（見本）'), trips: [trip] });
const withMail = (id) => freeze(C.addBooking(base, {
  trip, booking: { source: 'mail', site: SAMPLES[id].booking.site, people: SAMPLES[id].booking.people },
  reading: SAMPLES[id], src: 'mail', at: AT, newId
}));
const person = (patch) => ({ ...S.blankPerson(), id: 'p1', bookingId: 'b1', ...patch });
const health = (answers, today) => ({ historyAt: '2026-10-20', answers, todayAt: today ? trip.date : '', today: today || '' });
const emptyRead = () => SAMPLES.c1.people[0] && { ...JSON.parse(JSON.stringify(SAMPLES.c1.people[0])), name: '', birthDate: '', cert: { course: '', date: '' } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- 形 ---------- */
test('空の形に id を入れると検査を通る', () => {
  assert.ok(S.validateTrip(trip).ok);
  assert.ok(S.validateBooking({ ...S.blankBooking(), id: 'b1', tripId: 't1' }).ok);
  assert.ok(S.validatePerson(person()).ok);
  assert.deepEqual(S.validateState(base), { ok: true, errors: [] });
});

test('形に合わない物は弾く（ありえない日・時刻、知らない項目、入れ子の健康）', () => {
  assert.equal(S.validateTrip({ ...trip, kind: 'sup' }).ok, false);
  assert.equal(S.validateTrip({ ...trip, start: '25:00' }).ok, false);
  assert.equal(S.validateBooking({ ...S.blankBooking(), id: 'b1', tripId: 't1', people: 0 }).ok, false);
  assert.equal(S.validatePerson(person({ dives: -3 })).ok, false);
  assert.equal(S.validatePerson(person({ birthDate: '1998-14-45' })).ok, false);
  assert.equal(S.validatePerson(person({ birthDate: '1998-02-31' })).ok, false);
  assert.ok(S.validatePerson(person({ birthDate: '2000-02-29' })).ok);
  assert.equal(S.validatePerson(person({ medical: 'x' })).ok, false);
  assert.equal(S.validatePerson(person({ emergency: { name: '', relation: '', phone: '', history: '喘息' } })).ok, false);
  assert.equal(S.validatePerson(person({ health: { today: 'ok' } })).ok, false);
});

test('保存して読み戻すと同じ（予約・人・記録）', () => {
  const s = withMail('e4');
  const back = JSON.parse(JSON.stringify(s));
  assert.deepEqual(back, s);
  assert.deepEqual(S.validateState(back), { ok: true, errors: [] });
});

/* ---------- AI に送る物・AI の答え ---------- */
test('送る物は決まった項目だけ。健康の項目を紛れ込ませると弾く', () => {
  assert.equal(S.validateRequest({ doc: 'mail', text: '予約です', history: '喘息' }).ok, false);
  assert.equal(S.validateRequest({ doc: 'mail', text: '予約です', health: { answers: ['yes'] } }).ok, false);
  assert.deepEqual(S.requestBody({ doc: 'mail', text: '予約です', sampleId: 'e1' }), { doc: 'mail', text: '予約です' });
  assert.deepEqual(S.requestBody({ doc: 'paper', image: 'QUJD', masked: true, sampleId: 'f1' }), { doc: 'paper', image: 'QUJD', masked: true });
  assert.equal(S.validateRequest({ doc: 'paper', image: 'QUJD' }).ok, false, '塗った印が無い');
  assert.ok(S.validateRequest({ doc: 'paper', image: 'QUJD', masked: true }).ok);
  assert.ok(S.validateRequest({ doc: 'ccard', image: 'QUJD' }).ok);
  assert.equal(S.validateRequest({ doc: 'mail', text: '   ' }).ok, false);
  assert.equal(S.validateRequest({ doc: 'paper', image: 'not base64!', masked: true }).ok, false);
});

test('予約メールの健康に触れていそうな行は外す。見本のメールは何も外れない', () => {
  const r = S.redactHealthLines('人数: 2 名\n備考: 喘息があります\nAsthma: yes\n代表者: 見本 花子');
  assert.equal(r.redacted, 2);
  assert.ok(!/喘息|Asthma/.test(r.text));
  assert.ok(r.text.includes('代表者: 見本 花子'));
  for (const id of ['e1', 'e2', 'e3', 'e4']) {
    const text = readFileSync(new URL(`../assets/samples/${id}.txt`, import.meta.url), 'utf8');
    assert.equal(S.redactHealthLines(text).redacted, 0, id);
  }
});

test('健康の質問の次の行の答えも外す。空行か次の項目で止まる', () => {
  const r = S.redactHealthLines('人数: 1 名\n健康上の問題はありますか？\nはい、少しだけ\n腰のあたりです\n代表者: 見本 花子\nQ: 持病は?\nA: はい\n\n日時: 10/24');
  assert.deepEqual(r.text.split('\n'), ['人数: 1 名', '（健康についての行は送っていません）', '（健康についての行は送っていません）',
    '（健康についての行は送っていません）', '代表者: 見本 花子', '（健康についての行は送っていません）', '（健康についての行は送っていません）', '', '日時: 10/24']);
  assert.equal(r.redacted, 5);
});

test('書き方を変えた健康の言葉も外す（全角・半角カナ・カタカナ・ゼロ幅文字・中国語・韓国語・英語）', () => {
  const words = ['ＡＳＴＨＭＡ', 'ｱﾚﾙｷﾞｰ', 'ゼンソク', 'ぜん息', '入院', '中耳炎', '耳が弱い', '風邪', '熱', '発作', 'うつ', 'パニック',
    'ペースメーカー', 'seizure', 'hospital', 'prescription', '哮喘', '高血压', '心脏', '氣喘', '懷孕', '천식', '임신', '喘​息'];
  for (const w of words) assert.equal(S.redactHealthLines(`備考 ${w} です`).redacted, 1, w);
});

test('メールのソース（quoted-printable・base64）は読まずに断る', () => {
  assert.equal(S.validateRequest({ doc: 'mail', text: 'Content-Transfer-Encoding: base64\n\nQUJD' }).errors.includes('encoded'), true);
  assert.equal(S.validateRequest({ doc: 'mail', text: '=E5=96=98=E6=81=AF' }).errors.includes('encoded'), true);
  const block = `${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0'}\n`.repeat(4);
  assert.equal(S.validateRequest({ doc: 'mail', text: block }).errors.includes('encoded'), true);
  assert.ok(S.validateRequest({ doc: 'mail', text: readFileSync(new URL('../assets/samples/e2.txt', import.meta.url), 'utf8') }).ok);
});

test('見本の読み取り 16 件はすべて答えの形に合い、健康の項目が無い', () => {
  assert.equal(Object.keys(SAMPLES).length, 16);
  for (const [id, r] of Object.entries(SAMPLES)) {
    assert.ok(S.validateReading(r).ok, id);
    assert.equal(r.healthSeen, false, id);
  }
});

test('AI の答えに健康が入っていたら、1 段目でも入れ子でも弾く', () => {
  const p = SAMPLES.f6.people[0];
  const ok = { booking: null, people: [p], healthSeen: false };
  assert.ok(S.validateReading(ok).ok);
  assert.equal(S.validateReading({ ...ok, people: [{ ...p, health: 'x' }] }).ok, false);
  assert.equal(S.validateReading({ ...ok, people: [{ ...p, emergency: { ...p.emergency, history: '喘息' } }] }).ok, false);
  assert.equal(S.validateReading({ ...ok, people: [{ ...p, cert: { ...p.cert, today: 'unwell' } }] }).ok, false);
  assert.equal(S.validateReading({ ...ok, medical: 'x' }).ok, false);
  assert.equal(S.validateReading({ ...ok, people: [{ ...p, birthDate: '1998-14-45' }] }).ok, false);
});

test('モデルの答えを直すとき、知らない項目と健康は捨て、C カードの 2 通りの名前は日本語にする', () => {
  const r = S.fromModel({
    participants: [{ name: 'MIHON HANAKO / 見本 花子', birth_date: '1998-02-31', health: '喘息', medical_history: 'x',
      cert_course: 'aow', dive_count: 12.5, unsure: ['birth_date', 'medical_history', 'toString', 'constructor'] }],
    booking: { start: '8:30', date: '2026-13-01', unsure: ['lead_name', '__proto__'] },
    health_info_visible: true
  });
  assert.equal(r.people[0].name, '見本 花子');
  assert.equal(r.people[0].birthDate, '', 'ありえない日は捨てる');
  assert.equal(r.people[0].cert.course, 'AOW');
  assert.equal(r.people[0].dives, '');
  assert.deepEqual(r.people[0].unsure, ['birthDate']);
  assert.deepEqual([r.booking.start, r.booking.date, r.booking.unsure], ['', '', ['leadName']]);
  assert.equal(r.healthSeen, true);
  assert.ok(S.validateReading(r).ok);
});

/* ---------- 予約と名簿 ---------- */
test('予約メールから予約を足すと、名前の分かる人と空の行で人数分そろう', () => {
  const s = withMail('e1');
  const people = C.peopleOf(s, 't1');
  assert.deepEqual(people.map(p => p.name), ['見本 花子', '見本 太郎']);
  assert.equal(people[0].src.name, 'mail');
  assert.equal(C.peopleOf(withMail('e4'), 't1').length, 3, '見本の答えのとおり 3 人（お店の人は答えに入っていない）');
  assert.equal(s.log.filter(e => e.act === 'add').length, 3);
  assert.ok(s.log.every(e => e.who === 'ai'));
});

test('人数が空や 0 の予約でも、検査に通る state になる', () => {
  const s = C.addBooking(base, { trip, booking: { source: 'mail', people: '' }, reading: { booking: null, people: [], healthSeen: false }, src: 'mail', at: AT, newId });
  assert.deepEqual(S.validateState(s), { ok: true, errors: [] });
  assert.equal(C.peopleOf(s, 't1').length, 1);
  const zero = C.addBooking(base, { trip, booking: { source: 'phone', people: 0 }, reading: null, src: 'staff', at: AT, newId });
  assert.ok(S.validateState(zero).ok);
  assert.equal(zero.log[0].who, 'staff');
});

test('名簿は 13 項目。健康と当日の体調がそろうまで「そろった」にならない', () => {
  assert.equal(S.ITEMS.dive.length, 13);
  assert.equal(S.ITEMS.snorkel.length, 11);
  const p0 = C.peopleOf(withMail('e1'), 't1')[0];
  const full = { ...p0, birthDate: '1998-04-12', address: '見本市 1-1', emergency: { name: '見本 母', relation: '母', phone: '090-0000-0000' }, health: health(NO5) };
  assert.deepEqual(C.status(full, trip).missing, ['today']);
  const ready = { ...full, health: health(['no', 'yes', 'no', 'no', 'no'], 'ok') };
  assert.ok(C.status(ready, trip).done);
  assert.equal(C.status({ ...ready, health: { ...ready.health, todayAt: '2026-10-23' } }, trip).done, false, '前の日の体調は数えない');
  assert.deepEqual(C.askGuest(p0, trip), ['birthDate', 'address', 'emergency', 'history', 'today']);
  assert.ok(C.status({ ...ready, lastDive: '2025', dives: 30 }, trip).missing.includes('lastDive'), '年だけの「最後に潜った日」はお客さんに聞く');
});

test('AI の読み取りは空の所だけ埋め、人が入れた所は上書きしない（入れ子の中も）', () => {
  const p = freeze(person({ name: '見本 花子', birthDate: '1998-04-21', emergency: { name: '', relation: '兄', phone: '' }, src: { birthDate: 'guest', emergency: 'guest' } }));
  const read = { ...emptyRead(), birthDate: '1998-04-12', emergency: { name: '見本 洋子', relation: '母', phone: '090-0000-0001' }, cert: { course: 'OW', date: '2023-08-20' }, unsure: ['emergency'] };
  const { person: next, fields } = C.mergeReading(p, read, 'paper');
  assert.equal(next.birthDate, '1998-04-21');
  assert.deepEqual(next.emergency, { name: '見本 洋子', relation: '兄', phone: '090-0000-0001' });
  assert.deepEqual(fields, ['emergency', 'cert']);
  assert.deepEqual(next.unsure, ['emergency']);
});

test('C カードの取得日は、コースが空か同じときだけ入れる', () => {
  const ow = person({ cert: { course: 'OW', date: '' } });
  assert.deepEqual(C.mergeReading(ow, { ...emptyRead(), cert: { course: 'OW', date: '2012-03-04' } }, 'ccard').person.cert, { course: 'OW', date: '2012-03-04' });
  assert.deepEqual(C.mergeReading(ow, { ...emptyRead(), cert: { course: 'AOW', date: '2015-01-01' } }, 'ccard').fields, []);
});

test('写真の読み取りは、その便の同じ人に入り、前と後を記録に残す。名前の書き方の違いも同じ人とみなす', () => {
  const s = withMail('e4');
  const daisuke = C.peopleOf(s, 't1').find(p => p.name === '見本 大輔');
  assert.deepEqual(daisuke.cert, { course: 'OW', date: '' });
  const hit = C.applyReading(s, { tripId: 't1', read: { ...emptyRead(), name: '見本大輔', cert: { course: 'OW', date: '2012-03-04' } }, src: 'ccard', at: AT });
  assert.equal(hit.state.people.find(p => p.id === daisuke.id).cert.date, '2012-03-04');
  const last = hit.state.log[hit.state.log.length - 1];
  assert.deepEqual([last.who, last.before.cert, last.after.cert], ['ai', { course: 'OW', date: '' }, { course: 'OW', date: '2012-03-04' }]);
  const kim = withMail('e2');
  assert.ok(C.applyReading(kim, { tripId: 't1', read: SAMPLES.c4.people[0], src: 'ccard', at: AT }), 'Seo-yeon Kim と KIM SEOYEON');
  assert.equal(C.applyReading(s, { tripId: 't1', read: { ...emptyRead(), name: '別の 人' }, src: 'ccard', at: AT }), null);
});

test('人が直すと前と後が記録に残り、その項目の「自信なし」が外れる。who と出どころは分けて持つ', () => {
  const s = freeze(C.addBooking(base, { trip, booking: { source: 'mail', people: 1 }, reading: SAMPLES.f6, src: 'paper', at: AT, newId }));
  const p = C.peopleOf(s, 't1')[0];
  assert.deepEqual(p.unsure, ['lastDive']);
  const s2 = C.editPerson(s, { id: p.id, patch: { lastDive: '2025-08' }, who: 'guest', src: 'passport', at: AT });
  const last = s2.log[s2.log.length - 1];
  assert.deepEqual([last.who, last.before.lastDive, last.after.lastDive], ['guest', '2025', '2025-08']);
  const after = s2.people.find(x => x.id === p.id);
  assert.deepEqual([after.unsure, after.src.lastDive], [[], 'passport']);
  assert.deepEqual(S.validateState(s2), { ok: true, errors: [] });
  assert.equal(C.editPerson(s2, { id: p.id, patch: { lastDive: '2025-08' }, who: 'staff', at: AT }), s2, '変わらなければ記録しない');
  const sys = C.editPerson(s2, { id: p.id, patch: { guide: '見本 ガイド2' }, who: 'system', at: AT });
  assert.ok(S.validateState(sys).ok);
});

/* ---------- 条例の名簿 ---------- */
test('条例の名簿: 13 列、体験の人は「なし（体験）」、CSV は式にならない', () => {
  const s = withMail('e1');
  const ids = C.peopleOf(s, 't1').map(p => p.id);
  const s2 = C.editPerson(s, { id: ids[0], patch: { address: '=HYPERLINK("x")', health: health(['no', 'yes', 'no', 'no', 'no'], 'ok') }, who: 'guest', at: AT });
  const table = C.rosterRows(s2, 't1', HEALTH_SHORT);
  assert.equal(table.items.length, 13);
  const c = table.rows[0].cells;
  assert.deepEqual([c.certDate, c.dives, c.history, c.today, c.when, c.guide],
    ['なし（体験）', 'なし（初めて）', 'あり（心臓・肺）', '良好', '2026/10/24 08:30', '見本 ガイド']);
  const csv = C.toCsv(table);
  assert.ok(csv.startsWith('\uFEFF氏名,生年月日,住所'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
});

test('既往症に未回答が 1 つでもあれば、名簿には何も書かない（「なし」にしない）', () => {
  const p = person({ health: { historyAt: '2026-10-20', answers: [null, null, 'no', null, null], todayAt: '', today: '' } });
  assert.equal(C.cellText(p, trip, 'history', HEALTH_SHORT), '');
  assert.equal(C.cellText({ ...p, health: health(NO5) }, trip, 'history', HEALTH_SHORT), 'なし');
});

test('CSV は頭に空白や全角の記号がある式も止める', () => {
  const csv = C.toCsv({ items: [{ key: 'a', ja: 'A' }], rows: [{ cells: { a: ' =1+1' } }, { cells: { a: '＝1+1' } }, { cells: { a: '見本' } }] });
  assert.deepEqual(csv.replace('﻿', '').trim().split('\r\n'), ['A', "' =1+1", "'＝1+1", '見本']);
});

test('保存期間を過ぎた便は、予約・人・記録ごと消え、消した件数だけが残る', () => {
  const s = freeze(C.logAi(withMail('e1'), { at: '2026-10-24T00:00:00.000Z', sent: { doc: 'mail', size: 10, masked: false, mode: 'sample', healthSeen: false, redacted: 0 } }));
  assert.equal(C.purgeExpired(s, { today: '2027-10-24', at: AT }), s, 'まだ 1 年たっていない');
  const after = C.purgeExpired(s, { today: '2027-10-25', at: AT });
  assert.deepEqual([after.trips.length, after.bookings.length, after.people.length], [0, 0, 0]);
  assert.equal(after.log.length, 1);
  assert.deepEqual([after.log[0].act, after.log[0].after], ['remove', { trips: 1, people: 2, log: s.log.length }]);
  assert.ok(S.validateState(after).ok);
});

test('保存は作った日から 1 年', () => {
  assert.equal(C.keepUntil('2026-10-24'), '2027-10-24');
  assert.equal(C.keepUntil('2028-02-29'), '2029-03-01');
  assert.equal(C.expired(trip, '2027-10-24'), false);
  assert.equal(C.expired(trip, '2027-10-25'), true);
});

test('AI に送った記録は量と印だけで、中身は入らない', () => {
  const s = C.logAi(base, { at: AT, sent: { doc: 'paper', size: 123456, masked: true, mode: 'sample', healthSeen: true, redacted: 0, text: 'x' } });
  const e = s.log[0];
  assert.deepEqual(e.sent, { doc: 'paper', size: 123456, masked: true, mode: 'sample', healthSeen: true, redacted: 0 });
  assert.deepEqual([e.fields, e.before, e.after], [[], {}, {}]);
  assert.ok(S.validateState(s).ok);
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
