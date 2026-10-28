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
const personOf = (st, id) => st.people.find(p => p.id === id);
const staffEdit = (st, id, patch) => freeze(C.editPerson(st, { id, patch, who: 'staff', at: AT }));

const fullInput = (patch) => ({
  birthDate: '1990-04-01', address: '沖縄県那覇市見本町 1-2-3',
  emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
  cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '', answers: NO5, consent: true, ...patch
});
const passOf = (patch) => freeze({ ...P.blank(), name: '見本 太郎', certs: [
  { agency: 'PADI', level: 'Open Water Diver', no: '1', date: '2024-05' },
  { agency: 'PADI', level: 'Advanced Open Water Diver', no: '2', date: '2025-08' }],
dives: 14, lastDive: '2026-03', medical: { form: P.FORM, answeredAt: '2026-10-02', answers: ['no', 'no', 'yes', 'no', 'no'] }, ...patch });

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

test('13 項目: お客さんが入れて、当日の体調を答えると「そろった」になる。同意の日と版が残る', () => {
  const first = G.applyGuest(base, { id: hanako.id, input: fullInput(), today: TODAY, at: AT });
  assert.deepEqual(first.problems, []);
  const before = C.status(personOf(first.state, hanako.id), trip);
  assert.deepEqual(before.missing, ['today'], `まだ: ${before.missing}`);
  const second = G.answerToday(first.state, { id: hanako.id, answer: 'ok', day: trip.date, today: trip.date, at: AT });
  assert.deepEqual(second.problems, []);
  const p = personOf(second.state, hanako.id);
  assert.equal(S.ITEMS.dive.length, 13);
  assert.ok(C.status(p, trip).done, `そろっていない: ${C.status(p, trip).missing}`);
  assert.equal(p.health.consentAt, TODAY);
  assert.equal(p.health.consentVer, G.CONSENT_VER);
  assert.ok(S.validateState(second.state).ok);
  assert.equal(second.state.log[second.state.log.length - 1].who, 'guest');
  assert.equal(p.src.address, 'guest');
});

test('同意が無いと、健康の答えは入らない（入力の欄でも当日の体調でも）', () => {
  const r = G.applyGuest(base, { id: hanako.id, input: fullInput({ consent: false }), today: TODAY, at: AT });
  assert.deepEqual(r.problems, ['consent']);
  assert.equal(r.state, base);
  const t = G.answerToday(base, { id: hanako.id, answer: 'ok', day: trip.date, at: AT });
  assert.deepEqual(t.problems, ['consent']);
  const ok = G.answerToday(base, { id: hanako.id, answer: 'ok', day: trip.date, consent: true, today: TODAY, at: AT });
  assert.equal(personOf(ok.state, hanako.id).health.consentAt, TODAY);
});

test('当日の体調: 前の日に答えても当日の分にはならない。デモで当日として答えたら記録に印', () => {
  const early = G.answerToday(base, { id: hanako.id, answer: 'ok', day: '2026-10-23', consent: true, at: AT }).state;
  assert.ok(!C.filled(personOf(early, hanako.id), trip, 'today'));
  const demo = G.answerToday(base, { id: hanako.id, answer: 'ok', day: trip.date, consent: true, today: TODAY, demo: true, at: AT }).state;
  assert.equal(demo.log[demo.log.length - 1].demo, true);
  assert.ok(S.validateState(demo).ok);
  const real = G.answerToday(base, { id: hanako.id, answer: 'ok', day: trip.date, consent: true, at: AT }).state;
  assert.equal(real.log[real.log.length - 1].demo, undefined);
  assert.throws(() => G.answerToday(base, { id: hanako.id, answer: 'maybe', day: trip.date, consent: true, at: AT }));
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
  assert.ok(G.guestProblems(fullInput({ address: 'あ'.repeat(121) }), ['address']).includes('address'), '住所の上限は名簿の形と同じ 120 字');
});

test('「なし（体験）」の人は、潜った本数が空なら 0 本と読む（欄の説明は「0 本なら空のまま」）', () => {
  const ask = ['certDate', 'courses', 'dives', 'lastDive'];
  const none = fullInput({ cert: { course: 'NONE', date: '' }, dives: '', lastDive: '' });
  assert.deepEqual(G.guestProblems(none, ask), [], 'C カードの欄で「なし（体験）」を選んだとき');
  assert.equal(G.guestPatch(none, ask, TODAY).dives, 0);
  assert.ok(!('lastDive' in G.guestPatch(none, ask, TODAY)));
  const known = { emergency: S.SUB.emergency, cert: [], course: 'NONE' };
  assert.deepEqual(G.guestProblems(none, ['dives', 'lastDive'], known), [], '名簿に「なし（体験）」が入っているとき');
  assert.equal(G.guestPatch(none, ['dives', 'lastDive'], TODAY, known).dives, 0);
  assert.ok(G.guestProblems(fullInput({ cert: { course: 'OW', date: '2020-01' }, dives: '' }), ask).includes('dives'), 'C カードありなら本数は要る');
});

test('聞いていない項目は、入力に入っていても書き換えない', () => {
  const known = staffEdit(base, hanako.id, { address: 'お店が入れた住所' });
  const r = G.applyGuest(known, { id: hanako.id, input: fullInput({ address: '別の住所' }), today: TODAY, at: AT });
  assert.equal(personOf(r.state, hanako.id).address, 'お店が入れた住所');
});

test('緊急時の連絡先: 名前か電話が欠けていたら、組ごと聞き直して入れ替える（別の人の電話が混ざらないように）', () => {
  const partial = freeze(C.applyReadingTo(base, { personId: hanako.id, read: { ...S.blankPerson(), name: '見本 花子', emergency: { name: '見本 母', relation: '母', phone: '' } }, src: 'paper', at: AT }).state);
  const v = G.guestView(partial, bookingId).people.find(x => x.person.id === hanako.id);
  assert.deepEqual(v.parts.emergency, ['name', 'relation', 'phone']);
  assert.ok(G.guestProblems(fullInput({ emergency: { name: '', phone: '090-1' } }), v.ask, v.parts).includes('emergency'), '名前も聞く');
  const r = G.applyGuest(partial, { id: hanako.id, input: fullInput({ emergency: { name: '見本 兄', relation: '兄', phone: '090-1' } }), today: TODAY, at: AT });
  const p = personOf(r.state, hanako.id);
  assert.deepEqual(p.emergency, { name: '見本 兄', relation: '兄', phone: '090-1' });
  assert.equal(p.src.emergency, 'guest');
  /* 名前と電話がそろっていれば聞かない */
  const full = staffEdit(base, hanako.id, { emergency: { name: '見本 母', relation: '', phone: '090-9' } });
  assert.ok(!G.guestView(full, bookingId).people.find(x => x.person.id === hanako.id).ask.includes('emergency'));
});

test('C カード: 分かっている方は残し、片方だけ入れたら自信なしの印を付けてお店の確かめに出す', () => {
  /* AI が写真から読んだ講習（年月が空）は、お客さんが講習を選んでも替わらない */
  const read = staffEdit(base, taro.id, { cert: { course: 'AOW', date: '' } });
  const t = G.guestView(read, bookingId).people.find(x => x.person.id === taro.id);
  assert.deepEqual(t.parts.cert, ['date']);
  const after = G.applyGuest(read, { id: taro.id, input: fullInput({ cert: { course: 'OW', date: '2023-07' } }), today: TODAY, at: AT });
  const p = personOf(after.state, taro.id);
  assert.deepEqual(p.cert, { course: 'AOW', date: '2023-07' });
  assert.ok(p.unsure.includes('cert'), '片方だけ入れたら自信なし');
  assert.equal(p.src.cert, 'guest');
  assert.ok(C.status(p, trip).unsure.includes('certDate') || C.status(p, trip).unsure.includes('courses'), 'お店の確かめに出る');
});

test('取得年月が分かっている人は、講習で「なし（体験）」を選べない', () => {
  const read = staffEdit(base, taro.id, { cert: { course: '', date: '2024-05' } });
  const v = G.guestView(read, bookingId).people.find(x => x.person.id === taro.id);
  assert.ok(G.guestProblems(fullInput({ cert: { course: 'NONE', date: '' } }), v.ask, v.parts).includes('cert'));
  assert.ok(!G.guestProblems(fullInput({ cert: { course: 'OW', date: '' } }), v.ask, v.parts).includes('cert'));
});

test('講習だけを聞いたときは、AI が読んだ取得年月を残す', () => {
  const read = staffEdit(base, taro.id, { cert: { course: '', date: '2024-05' } });
  const v = G.guestView(read, bookingId).people.find(x => x.person.id === taro.id);
  assert.ok(v.ask.includes('courses') && !v.ask.includes('certDate'));
  const r = G.applyGuest(read, { id: taro.id, input: fullInput({ cert: { course: 'OW', date: '' } }), today: TODAY, at: AT });
  assert.deepEqual(personOf(r.state, taro.id).cert, { course: 'OW', date: '2024-05' });
});

test('パスポートから: まだの所に合わせて絞り、選んだ物だけ入れる。健康の答えには同意が要る', () => {
  const empty = staffEdit(base, taro.id, { cert: { course: '', date: '' }, dives: '', lastDive: '' });
  const offer = G.passportOffer(passOf(), { today: TODAY, maxDays: 365 });
  assert.deepEqual(offer.items.map(i => i.key), ['cert', 'dives', 'history']);
  assert.deepEqual(offer.items[0].patch.cert, { course: 'AOW', date: '2025-08' }, 'いちばん上の講習');
  assert.equal(offer.items[2].days, 19);
  const noConsent = G.applyPassport(empty, { id: taro.id, offer, keys: ['cert', 'history'], at: AT });
  assert.deepEqual(noConsent.problems, ['consent']);
  const r = G.applyPassport(empty, { id: taro.id, offer, keys: ['cert', 'history'], consent: true, today: TODAY, at: AT });
  assert.deepEqual(r.problems, []);
  const t = personOf(r.state, taro.id);
  assert.equal(t.cert.course, 'AOW');
  assert.equal(t.dives, '', '選ばなかった物は入れない');
  assert.deepEqual(t.health.answers, ['no', 'no', 'yes', 'no', 'no']);
  assert.equal(t.health.historyAt, '2026-10-02');
  assert.equal(t.health.consentAt, TODAY);
  assert.equal(t.src.cert, 'passport');
  assert.equal(r.state.log[r.state.log.length - 1].who, 'guest');
  assert.ok(S.validateState(r.state).ok);
});

test('パスポートから: 分かっている所は入れない（メールで読めた本数を、パスポートの本数で上書きしない）', () => {
  const known = staffEdit(base, taro.id, { dives: 40, lastDive: '' });
  const offer = G.passportOffer(passOf(), { today: TODAY, maxDays: 365 });
  const choices = G.passportChoices(known, { id: taro.id, offer });
  assert.deepEqual(choices.find(i => i.key === 'dives').patch, { lastDive: '2026-03' });
  const r = G.applyPassport(known, { id: taro.id, offer, keys: ['dives'], at: AT });
  assert.equal(personOf(r.state, taro.id).dives, 40);
  assert.equal(personOf(r.state, taro.id).lastDive, '2026-03');
});

test('パスポートから: C カードの片方だけは、名簿にある方と同じカードからだけ取る', () => {
  const pass = passOf({ certs: [{ agency: 'PADI', level: 'Rescue Diver', no: '1', date: '2021-03' }, { agency: 'PADI', level: 'Open Water Diver', no: '2', date: '2019-07' }] });
  const offer = G.passportOffer(pass, { today: TODAY, maxDays: 365 });
  /* C カードの写真から年月 2019-07 だけ読めた → 同じ年月の OW を取る（一番上の RESCUE ではない） */
  const dateOnly = staffEdit(base, taro.id, { cert: { course: '', date: '2019-07' } });
  assert.deepEqual(G.passportChoices(dateOnly, { id: taro.id, offer }).find(i => i.key === 'cert').patch, { cert: { course: 'OW' } });
  const r = G.applyPassport(dateOnly, { id: taro.id, offer, keys: ['cert'], at: AT });
  assert.deepEqual(personOf(r.state, taro.id).cert, { course: 'OW', date: '2019-07' });
  assert.ok(personOf(r.state, taro.id).unsure.includes('cert'));
  /* 同じ年月のカードが無ければ出さない */
  const other = staffEdit(base, taro.id, { cert: { course: '', date: '2018-01' } });
  assert.equal(G.passportChoices(other, { id: taro.id, offer }).find(i => i.key === 'cert'), undefined);
  /* 講習 AOW が分かっていて年月が空 → AOW のカードが無ければ出さない */
  const courseOnly = staffEdit(base, taro.id, { cert: { course: 'AOW', date: '' } });
  assert.equal(G.passportChoices(courseOnly, { id: taro.id, offer }).find(i => i.key === 'cert'), undefined);
});

test('パスポートから: 名簿の名前が空だと、同じ人と確かめられないので健康の答えは入れない', () => {
  const noName = staffEdit(base, taro.id, { name: '', cert: { course: '', date: '' } });
  const offer = G.passportOffer(passOf(), { today: TODAY, maxDays: 365 });
  assert.equal(G.passportSameName(noName, { id: taro.id, offer }), false);
  assert.equal(G.passportChoices(noName, { id: taro.id, offer }).find(i => i.key === 'history').blocked, 'name');
  assert.deepEqual(G.applyPassport(noName, { id: taro.id, offer, keys: ['cert'], at: AT }).problems, ['name']);
});

test('同意の文の版が古いと、同意し直してもらう', () => {
  const old = freeze(C.editPerson(base, { id: hanako.id, patch: { health: { consentAt: '2026-01-01', consentVer: '2025-01-01' } }, who: 'guest', at: AT }));
  assert.equal(G.guestView(old, bookingId).people.find(x => x.person.id === hanako.id).consented, false);
  assert.deepEqual(G.answerToday(old, { id: hanako.id, answer: 'ok', day: trip.date, at: AT }).problems, ['consent']);
});

test('パスポートから: 名前が違うと、健康の答えは入れられず、ほかの物は「この人に入れる」の印が要る', () => {
  const empty = staffEdit(base, taro.id, { cert: { course: '', date: '' } });
  const offer = G.passportOffer(passOf({ name: 'Emily Carter' }), { today: TODAY, maxDays: 365 });
  const choices = G.passportChoices(empty, { id: taro.id, offer });
  assert.equal(choices.find(i => i.key === 'history').blocked, 'name');
  assert.deepEqual(G.applyPassport(empty, { id: taro.id, offer, keys: ['cert'], at: AT }).problems, ['name']);
  const r = G.applyPassport(empty, { id: taro.id, offer, keys: ['cert', 'history'], otherName: true, consent: true, at: AT });
  assert.deepEqual(r.problems, []);
  assert.equal(personOf(r.state, taro.id).cert.course, 'AOW');
  assert.deepEqual(personOf(r.state, taro.id).health.answers, personOf(empty, taro.id).health.answers, '健康の答えは入らない');
});

test('パスポートから: 古い既往症の答えは入れない（お店の決まりの日数を過ぎた）', () => {
  const offer = G.passportOffer(passOf({ medical: { form: P.FORM, answeredAt: '2025-01-01', answers: NO5 } }), { today: TODAY, maxDays: 365 });
  const h = offer.items.find(i => i.key === 'history');
  assert.ok(h.old && h.patch === null);
  assert.equal(G.applyPassport(base, { id: taro.id, offer, keys: ['history'], consent: true, at: AT }).state, base);
  assert.deepEqual(G.passportOffer(null, { today: TODAY, maxDays: 365 }).items, []);
});

test('C カードの名前から講習の記号へ（略した書き方・中黒も）', () => {
  [['Open Water Diver', 'OW'], ['オープン・ウォーター・ダイバー', 'OW'], ['OW', 'OW'], ['Junior Open Water Diver', 'JOW'],
    ['アドバンスド・オープン・ウォーター', 'AOW'], ['AOW', 'AOW'], ['Rescue Diver', 'RESCUE'], ['Divemaster', 'DM'], ['DM', 'DM'],
    ['Nitrox', 'OTHER'], ['', 'OTHER']].forEach(([level, want]) => assert.equal(G.courseOf(level), want, level));
});

test('日数を時計なしで数える（うるう年も）', () => {
  assert.equal(G.daysBetween('2026-10-02', '2026-10-21'), 19);
  assert.equal(G.daysBetween('2024-02-28', '2024-03-01'), 2);
  assert.equal(G.daysBetween('2025-10-21', '2026-10-21'), 365);
});

/* ---------- 同伴者の名前（名前が空の人にだけ、お客さんが入れられる） ---------- */
const nameless = staffEdit(base, taro.id, { name: '' });
const askOf = (st, id) => G.guestView(st, bookingId).people.find(x => x.person.id === id).ask;

test('同伴者の名前: 聞く項目に name が出るのは名前が空の人だけ', () => {
  assert.ok(askOf(nameless, taro.id).includes('name'));
  assert.ok(!askOf(nameless, hanako.id).includes('name'), '名前が入っている人には聞かない');
});

test('同伴者の名前: { name } だけを送ると名前だけが入り、他の項目は聞いたまま。出どころは guest で記録に残る', () => {
  const r = G.applyGuest(nameless, { id: taro.id, input: { name: '  見本   次郎 ' }, today: TODAY, at: AT });
  assert.deepEqual(r.problems, []);
  const p = personOf(r.state, taro.id);
  assert.equal(p.name, '見本 次郎', '前後の空白と続く空白は 1 つにそろえる');
  assert.equal(p.src.name, 'guest');
  assert.equal(p.address, '');
  const after = askOf(r.state, taro.id);
  assert.ok(!after.includes('name') && after.includes('address') && after.includes('birthDate'));
  const last = r.state.log[r.state.log.length - 1];
  assert.equal(last.who, 'guest');
  assert.deepEqual(last.fields, ['name']);
  assert.ok(S.validateState(r.state).ok);
});

test('同伴者の名前: 全部の項目と一緒でも入る。名前が無い・空なら personName で断り、state は変えない', () => {
  const ok = G.applyGuest(nameless, { id: taro.id, input: fullInput({ name: '見本 次郎' }), today: TODAY, at: AT });
  assert.deepEqual(ok.problems, []);
  assert.equal(personOf(ok.state, taro.id).name, '見本 次郎');
  assert.equal(personOf(ok.state, taro.id).address, '沖縄県那覇市見本町 1-2-3');
  [fullInput(), fullInput({ name: '   ' }), { name: '' }].forEach(input => {
    const r = G.applyGuest(nameless, { id: taro.id, input, today: TODAY, at: AT });
    assert.ok(r.problems.includes('personName'), JSON.stringify(input));
    assert.equal(r.state, nameless);
  });
});

test('同伴者の名前: 予約フォームの名前と同じ決まりで断る（URL・ドメイン・制御文字・61 字・文字でない物）', () => {
  ['見本 http://evil.example', '見本 www.evil', 'evil.example.com', 'a@b.co', '見本\n次郎', '見本\u0000次郎', '見本\u2028次郎', 'あ'.repeat(61), 42, null, ['見本'], { a: 1 }]
    .forEach(name => {
      const r = G.applyGuest(nameless, { id: taro.id, input: { name }, today: TODAY, at: AT });
      assert.deepEqual(r.problems, ['personName'], String(JSON.stringify(name)).slice(0, 30));
      assert.equal(r.state, nameless);
    });
  assert.deepEqual(G.applyGuest(nameless, { id: taro.id, input: { name: 'あ'.repeat(60) }, today: TODAY, at: AT }).problems, [], '60 字はよい');
  assert.deepEqual(G.applyGuest(nameless, { id: taro.id, input: { name: 'Taro Mihon-Jr' }, today: TODAY, at: AT }).problems, []);
});

test('同伴者の名前: 入っている名前は書き換えられない（名前だけでも、全部の項目と一緒でも）', () => {
  const only = G.applyGuest(base, { id: hanako.id, input: { name: '別の人' }, today: TODAY, at: AT });
  assert.deepEqual(only.problems, ['nothing']);
  assert.equal(only.state, base);
  const full = G.applyGuest(base, { id: hanako.id, input: fullInput({ name: '別の人' }), today: TODAY, at: AT });
  assert.deepEqual(full.problems, []);
  assert.equal(personOf(full.state, hanako.id).name, personOf(base, hanako.id).name, '他の項目は入るが、名前は変わらない');
  /* 1 度入れたあとの 2 度目も同じ */
  const first = G.applyGuest(nameless, { id: taro.id, input: { name: '見本 次郎' }, today: TODAY, at: AT }).state;
  const again = G.applyGuest(first, { id: taro.id, input: { name: '見本 三郎' }, today: TODAY, at: AT });
  assert.deepEqual(again.problems, ['nothing']);
  assert.equal(personOf(again.state, taro.id).name, '見本 次郎');
});

test('同伴者の名前: 1 人ずつのリンク（only が健康だけ）では入れられない。パスポートからは名前を入れない', () => {
  const r = G.applyGuest(nameless, { id: taro.id, input: { name: '見本 次郎' }, today: TODAY, at: AT, only: ['history'] });
  assert.deepEqual(r.problems, ['nothing']);
  assert.equal(r.state, nameless);
  const offer = G.passportOffer(passOf({ name: '見本 次郎' }), { today: TODAY, maxDays: 365 });
  const done = G.applyPassport(nameless, { id: taro.id, offer, keys: ['cert', 'dives', 'history'], otherName: true, consent: true, today: TODAY, at: AT });
  assert.equal(personOf(done.state, taro.id).name, '', 'パスポートの名前を名簿の名前にはしない');
});

test('同伴者の名前: 名前の決まりは、予約フォームの名前（worker/auto-core.mjs の NAME_BAD）と同じ式', () => {
  const lit = (file) => /const NAME_BAD = (\/.+\/[a-z]*);/.exec(readFileSync(new URL(file, import.meta.url), 'utf8'))[1];
  assert.equal(lit('../js/roster-guest.js'), lit('../worker/auto-core.mjs'));
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
