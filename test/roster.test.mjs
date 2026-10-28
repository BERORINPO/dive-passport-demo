// 予約と名簿の形・判定・記録・条例の名簿を確かめる。保存して読み戻しても同じになるかも見る。
// 実行: node test/roster.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/roster-schema.js');
load('../js/roster-core.js');
load('../js/health-redact.js');
load('../js/data-samples.js');
const { roster: S, rosterCore: C, healthRedact: H, SAMPLE_READINGS } = globalThis.REDUX;

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
  assert.ok(S.validateRequest({ doc: 'list', image: 'QUJD', masked: false }).ok, '予約の一覧は塗らなくても送れる');
  assert.equal(S.validateRequest({ doc: 'list', image: 'QUJD', note: 'x' }).ok, false, '知らない項目');
  assert.equal(S.validateRequest({ doc: 'mail', text: '   ' }).ok, false);
  assert.equal(S.validateRequest({ doc: 'paper', image: 'not base64!', masked: true }).ok, false);
});

test('予約メールの健康に触れていそうな行は外す。見本のメールは何も外れない', () => {
  const r = H.redact('人数: 2 名\n備考: 喘息があります\nAsthma: yes\n代表者: 見本 花子');
  assert.equal(r.redacted, 2);
  assert.ok(!/喘息|Asthma/.test(r.text));
  assert.ok(r.text.includes('代表者: 見本 花子'));
  for (const id of ['e1', 'e2', 'e3', 'e4']) {
    const text = readFileSync(new URL(`../assets/samples/${id}.txt`, import.meta.url), 'utf8');
    assert.equal(H.redact(text).redacted, 0, id);
  }
});

test('健康の質問の次の行の答えも外す。空行か次の項目で止まる', () => {
  const r = H.redact('人数: 1 名\n健康上の問題はありますか？\nはい、少しだけ\n腰のあたりです\n代表者: 見本 花子\nQ: 持病は?\nA: はい\n\n日時: 10/24');
  assert.deepEqual(r.text.split('\n'), ['人数: 1 名', H.REDACTED_LINE, H.REDACTED_LINE,
    H.REDACTED_LINE, '代表者: 見本 花子', H.REDACTED_LINE, H.REDACTED_LINE, '', '日時: 10/24']);
  assert.equal(r.redacted, 5);
});

test('書き方を変えた健康の言葉も外す（全角・半角カナ・カタカナ・ゼロ幅文字・中国語・韓国語・英語）', () => {
  const words = ['ＡＳＴＨＭＡ', 'ｱﾚﾙｷﾞｰ', 'ゼンソク', 'ぜん息', '入院', '中耳炎', '耳が弱い', '風邪', '熱', '発作', 'うつ', 'パニック',
    'ペースメーカー', 'seizure', 'hospital', 'prescription', '哮喘', '高血压', '心脏', '氣喘', '懷孕', '천식', '임신', '喘\u200B息'];
  for (const w of words) assert.equal(H.redact(`備考 ${w} です`).redacted, 1, w);
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
  const p = freeze(person({ name: '見本 花子', birthDate: '1998-04-21', emergency: { name: '見本 洋子', relation: '母', phone: '' }, src: { birthDate: 'guest', emergency: 'guest' } }));
  const read = { ...emptyRead(), birthDate: '1998-04-12', emergency: { name: '見本洋子', relation: '叔母', phone: '090-0000-0001' }, cert: { course: 'OW', date: '2023-08-20' }, unsure: [] };
  const { person: next, fields } = C.mergeReading(p, read, 'paper');
  assert.equal(next.birthDate, '1998-04-21');
  assert.deepEqual(next.emergency, { name: '見本 洋子', relation: '母', phone: '090-0000-0001' }, '同じ人なので電話だけ埋める');
  assert.deepEqual(fields, ['emergency', 'cert']);
  assert.deepEqual(next.unsure, []);
  assert.deepEqual([next.src.emergency, next.src.cert], ['guest', 'paper'], '人が一部だけ入れていた項目は出どころを変えない');
  assert.deepEqual(C.mergeReading(p, { ...read, unsure: ['emergency'] }, 'paper').person.unsure, ['emergency'], 'AI が自信なしなら印を付ける');
});

test('緊急連絡先は名前と電話の組。別の人の電話を混ぜない', () => {
  const passport = person({ emergency: { name: '見本 母', relation: '母', phone: '' }, src: { emergency: 'passport' } });
  const aunt = { ...emptyRead(), emergency: { name: '見本 叔母', relation: '叔母', phone: '090-1111-2222' } };
  assert.deepEqual(C.mergeReading(passport, aunt, 'paper').fields, []);
  assert.deepEqual(C.mergeReading(passport, { ...aunt, emergency: { name: '', relation: '', phone: '090-1111-2222' } }, 'paper').fields, [], '名前の無い電話も入れない');
  const byPhone = person({ emergency: { name: '', relation: '', phone: '090-1111-2222' }, src: { emergency: 'guest' } });
  assert.equal(C.mergeReading(byPhone, aunt, 'paper').person.emergency.name, '見本 叔母', '電話が同じなら同じ人');
  const fromMail = person({ emergency: { name: '見本 叔母', relation: '', phone: '' }, src: { emergency: 'mail' } });
  const second = C.mergeReading(fromMail, { ...aunt, unsure: ['emergency'] }, 'paper').person;
  assert.deepEqual([second.src.emergency, second.unsure], ['paper', ['emergency']], '元が AI の読み取りなら、新しい読み取りに替える');
});

test('人やお店がわざと空にした項目は、AI が埋め直さない', () => {
  const p = person({ name: '見本 花子', address: '', src: { address: 'staff' } });
  const { person: next, fields } = C.mergeReading(p, { ...emptyRead(), address: '見本市 1-1' }, 'paper');
  assert.equal(next.address, '');
  assert.ok(!fields.includes('address'));
});

test('人の側に日付だけあってコースが空なら、AI の日付が同じときだけコースを入れる', () => {
  const p = person({ cert: { course: '', date: '2012-03-04' } });
  assert.deepEqual(C.mergeReading(p, { ...emptyRead(), cert: { course: 'AOW', date: '2019-07-01' } }, 'ccard').fields, []);
  assert.deepEqual(C.mergeReading(p, { ...emptyRead(), cert: { course: 'OW', date: '2012-03-04' } }, 'ccard').person.cert, { course: 'OW', date: '2012-03-04' });
});

test('人が直すときの引数が違えば例外にする（壊れた state を黙って返さない）', () => {
  const s = withMail('e1');
  const id = C.peopleOf(s, 't1')[0].id;
  assert.throws(() => C.editPerson(s, { id, patch: { address: 'x' }, who: 'passport', at: AT }), /who/);
  assert.throws(() => C.editPerson(s, { id, patch: { address: 'x' }, at: AT }), /who/);
  assert.throws(() => C.editPerson(s, { id, patch: { address: 'x' }, who: 'staff', src: 'mail', at: AT }), /src/);
  assert.throws(() => C.editPerson(s, { id, patch: { dives: '12' } , who: 'staff', at: AT }), /形が合わない/, '本数は数で渡す');
  assert.throws(() => C.editPerson(s, { id: 'nobody', patch: { address: 'x' }, who: 'staff', at: AT }), /見つからない/);
  const p = C.peopleOf(s, 't1')[0];
  const part = C.editPerson(s, { id, patch: { emergency: { phone: '090-0000-0000' }, health: { today: 'ok', todayAt: '2026-10-24' } }, who: 'guest', at: AT });
  const after = part.people.find(x => x.id === id);
  assert.deepEqual([after.emergency.phone, after.health.today, after.health.answers.length], ['090-0000-0000', 'ok', 5], '入れ子は渡した所だけ重ねる');
  const reordered = { relation: p.emergency.relation, phone: p.emergency.phone, name: p.emergency.name };
  assert.equal(C.editPerson(s, { id, patch: { emergency: reordered }, who: 'staff', at: AT }), s, 'key の順が違うだけなら記録しない');
});

test('予約には予約の形の項目だけが入る（読み取りの日付や unsure を混ぜない）', () => {
  const s = C.addBooking(base, { trip, booking: { source: 'mail', ...SAMPLES.e1.booking }, reading: SAMPLES.e1, src: 'mail', at: AT, newId });
  const b = s.bookings[0];
  assert.ok(!('date' in b) && !('unsure' in b) && !('tour' in b));
  assert.ok(!s.log[0].fields.includes('unsure'));
  assert.equal(S.validateBooking({ ...b, date: '2026-10-24' }).ok, false);
  assert.equal(S.validateTrip({ ...trip, extra: 1 }).ok, false);
});

test('依頼の値が undefined や null の項目は、無いのと同じに扱う', () => {
  assert.ok(S.validateRequest({ doc: 'mail', text: '予約です', sampleId: undefined }).ok);
  assert.ok(S.validateRequest({ doc: 'mail', text: '予約です', sampleId: null }).ok);
  assert.ok(S.validateRequest({ doc: 'ccard', image: 'QUJD', masked: undefined }).ok);
  assert.equal(C.logAi(base, { at: AT, sent: null }), base, '送る前に断ったときは記録しない');
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
  assert.deepEqual(csv.replace('\uFEFF', '').trim().split('\r\n'), ['A', "' =1+1", "'＝1+1", '見本']);
});

test('保存期間を過ぎた便は、予約・人・記録ごと消え、消した件数だけが残る', () => {
  const s = freeze(C.logAi(withMail('e1'), { at: '2026-10-23T00:00:00.000Z', sent: { doc: 'mail', size: 10, masked: false, mode: 'sample', healthSeen: false, redacted: 0 } }));
  assert.equal(C.purgeExpired(s, { today: '2027-10-24', at: AT }), s, 'まだ 1 年たっていない');
  const after = C.purgeExpired(s, { today: '2027-10-25', at: AT });
  assert.deepEqual([after.trips.length, after.bookings.length, after.people.length], [0, 0, 0]);
  assert.equal(after.log.length, 1);
  assert.deepEqual([after.log[0].act, after.log[0].after], ['remove', { trips: 1, people: 2, log: s.log.length }]);
  assert.ok(S.validateState(after).ok);
});

test('消すときは種類と id の組で照合する。どの便にも付かない記録は 1 日の余裕を見る', () => {
  const kept = { ...S.blankTrip(), id: 't2', date: '2027-09-01', start: '08:30', createdAt: AT };
  const s = { ...base, trips: [trip, kept], log: [
    { at: AT, who: 'staff', act: 'add', kind: 'trip', id: 't1', fields: [], before: {}, after: {}, sent: null },
    { at: AT, who: 'staff', act: 'edit', kind: 'person', id: 't1', fields: [], before: {}, after: {}, sent: null },
    { at: '2026-10-24T20:00:00.000Z', who: 'ai', act: 'ai', kind: 'state', id: '', fields: [], before: {}, after: {}, sent: null }
  ] };
  const after = C.purgeExpired(s, { today: '2027-10-25', at: AT });
  assert.deepEqual(after.log.map(e => e.kind), ['person', 'state', 'state'], '別の種類の同じ id は残り、UTC の 10/24 の記録は 1 日余分に 2027-10-25 まで残る');
  assert.equal(C.purgeExpired(s, { today: '2027-10-26', at: AT }).log.filter(e => e.act === 'ai').length, 0);
  assert.equal(S.nextDay('2028-02-28'), '2028-02-29');
  assert.equal(S.nextDay('2026-12-31'), '2027-01-01');
});

test('健康の行を外しても、予約の項目の行は残す（名前・住所・ツアー名・連絡先）', () => {
  const keep = ['住所：福岡市中央区薬院1-2-3', '代表者：薬師寺 涼子', 'フリガナ：ウツミ ハナコ', 'Name: Priya Pillai', 'ツアー名：熱帯魚と泳ぐ',
    'プラン：ボート2本・傷害保険込み', 'ご予約日時：10月24日 8:30（ご都合に支障なければ）', 'メール：sweetheart88@mail.example',
    'Hotel: Okinawa Hospitality Inn'];
  for (const line of keep) assert.equal(H.redact(line).redacted, 0, line);
});

test('健康の質問の答えは外すが、結び・署名・電話は残す。1 段落のメールは文だけ外す', () => {
  const mail = 'Hi, we would like to book 2 people on Oct 24 at 8:30.\nMy friend has a mild heart condition, is it ok?\nThanks,\nSeo-yeon Kim\n+82 10-1234-5678';
  assert.deepEqual(H.redact(mail).text.split('\n'), ['Hi, we would like to book 2 people on Oct 24 at 8:30.', H.REDACTED_LINE, 'Thanks,', 'Seo-yeon Kim', '+82 10-1234-5678']);
  const sign = H.redact('備考：喘息の持病があります\n--\n見本 花子\n090-1234-5678');
  assert.deepEqual([sign.redacted, sign.text.split('\n').slice(1)], [1, ['--', '見本 花子', '090-1234-5678']]);
  const one = H.redact('10月24日に2名でお願いします。持病で喘息があります。代表は見本 花子、電話は090-1234-5678です。');
  assert.equal(one.text, `10月24日に2名でお願いします。${H.REDACTED_PART}代表は見本 花子、電話は090-1234-5678です。`);
  const inline = H.redact('持病はありますか？はい、少し。電話は090-1234-5678です。');
  assert.equal(inline.text, `${H.REDACTED_PART}${H.REDACTED_PART}電話は090-1234-5678です。`);
});

test('健康の文の後ろの文や行も外す（質問でなくても）。予約の話で止まる', () => {
  const cases = [
    ['実は持病があります。毎日打っています。', `${H.REDACTED_LINE}`],
    ['備考：持病があります\n毎日打っています\n代表者: 見本 花子', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}\n代表者: 見本 花子`],
    ['【持病】\nなし', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}`],
    ['持病はありますか。\nはい', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}`],
    ['持病はありますか？はい。毎日使っています。', H.REDACTED_LINE],
    ['Any medical conditions? Yes, e.g. bad back and so on', H.REDACTED_LINE],
    ['持病があります。10月24日に2名でお願いします。', `${H.REDACTED_PART}10月24日に2名でお願いします。`],
    ['持病はありますか？\nはい、毎日使っています。緊急連絡先 090-1234-5678', `${H.REDACTED_LINE}\n${H.REDACTED_PART}緊急連絡先 090-1234-5678`],
    ['Any medical conditions?\nYes, 2019 - 2021, now fine', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}`],
    ['Any medical conditions?\nYes: lower back and so on', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}`],
    ['持病はありますか？\nはい\n内容：毎日の注射', `${H.REDACTED_LINE}\n${H.REDACTED_LINE}\n${H.REDACTED_LINE}`],
    ['Any medical conditions?\n\nYes, every day', `${H.REDACTED_LINE}\n\n${H.REDACTED_LINE}`],
    ['名前: 見本 花子\u2028備考: 中耳炎気味です', `名前: 見本 花子\n${H.REDACTED_LINE}`]
  ];
  for (const [input, want] of cases) assert.equal(H.redact(input).text, want, input);
});

test('予約の項目に書かれた健康の話も外す。名前・住所の行は括弧の中だけ 1 字の言葉を見る', () => {
  for (const line of ['人数：大人2名（1名は中耳炎気味）', '希望日：10/24（熱が下がれば）', 'プラン：ファンダイブ2本（前回減圧症の疑い）',
    'ご予約時の質問への回答：耳が痛くなりやすいです', 'Preferences: my ear hurts', '代表者：見本 花子（貧血ぎみ）', '備考：生理中です', 'Note: I get seasick']) {
    assert.equal(H.redact(line).redacted, 1, line);
  }
  for (const line of ['フリガナ：イケガミ ハナコ', 'Name: Priya Panicker', 'プラン：うつぼ観察ツアー', 'Hotel: Okinawa Hospitality Inn']) {
    assert.equal(H.redact(line).redacted, 0, line);
  }
});

test('健康の答えの中に日付や「お願いします」があっても外す。予約の話で始まる文で止まる', () => {
  const removed = [
    ['健康上の問題はありますか？\nはい、1名が毎日通っています', 2],
    ['持病はありますか？\nはい、薬を飲んでいるので浅めでお願いします', 2],
    ['Any medical conditions?\nYes, every day on 10/23 so I am tired on 10/24', 2],
    ['持病があります。2人とも毎日飲んでいます。', 2],
    ['息子は喘息です。持参しますのでよろしくお願いします。', 2],
    ['持病はありますか？\n■ご回答：毎日しています', 2],
    ['持病はありますか？\nお答え：毎日', 2],
    ['Any medical conditions?\nResponse: every day', 2],
    ['Any medical conditions?\nYour answer: every day', 2]
  ];
  for (const [input, n] of removed) assert.equal(H.redact(input).redacted, n, input);
  assert.equal(H.redact('持病で喘息があります。代表は見本 花子です。').text, `${H.REDACTED_PART}代表は見本 花子です。`);
  assert.equal(H.redact('My friend has asthma. We stay at Hotel Mihon in Onna.').text, `${H.REDACTED_PART} We stay at Hotel Mihon in Onna.`);
  assert.equal(H.redact('備考: 喘息があります\nピックアップ希望 ホテル見本').text, `${H.REDACTED_LINE}\nピックアップ希望 ホテル見本`);
});

test('固有名詞の項目でも、項目名に健康の字があるか、名前の後ろの注記なら外す。ふりがなは残す', () => {
  for (const line of ['お薬の名前：ワーファリン', 'かかりつけ医の名前：山田（循環器）', '主治医の電話番号：090-1234-5678',
    '代表者：見本 花子、腰痛あり', '代表者：見本 花子【腰痛】', '代表者：見本 花子（腰痛があります', 'Hotel: Hilton, 医者に止められたら連絡します']) {
    assert.ok(H.redact(line).redacted >= 1, line);
  }
  const para = H.redact('お名前：見本 花子。10/24 に2名で予約したいです。息子が鼻炎で耳が痛くなりやすいです。').text;
  assert.equal(para, `お名前：見本 花子。10/24 に2名で予約したいです。${H.REDACTED_PART}`);
  for (const line of ['代表者：池上 花子（イケガミ ハナコ）', '代表：見本 花子 (うつみ)', '参加者2: イケガミ タロウ', '同行者: ウツミ タロウ']) {
    assert.equal(H.redact(line).redacted, 0, line);
  }
});

test('番号付きの答え、名前の後ろの注記、仮名だけの健康の言葉、服用も外す', () => {
  for (const [input, n] of [
    ['Q1: 持病はありますか？\nA1: ワーファリンを飲んでいます', 2], ['質問1：持病はありますか？\n回答1：毎日飲んでいます', 2],
    ['Question 1: Any medical conditions?\nAnswer 1: on warfarin', 2], ['参加者2：見本 太郎 32歳 腰痛', 1],
    ['同行者：見本太郎　貧血ぎみ', 1], ['Participant 2: Kim 30 耳が痛くなりやすい', 1], ['代表者：見本 花子（うつ）', 1],
    ['参加者2：見本 太郎（けが）', 1], ['代表者：見本 花子（かぜぎみ）', 1], ['備考：持病があります\n代表者本人が毎日服用しています', 2],
    ['備考：ワーファリンを服用しています', 1], ['参加者2：見本 太郎、かぜをひいています', 1], ['同行者：見本 次郎、かぜぎみです', 1],
    ['お名前：見本 花子、けがした', 1], ['参加者2：見本 太郎 けがをしています', 1], ['代表者：見本 花子 うつっぽい', 1],
    ['電話：090-1234-5678 耳が遠いのでメールで', 1]
  ]) assert.equal(H.redact(input).redacted, n, input);
  for (const line of ['代表：見本 花子 (うつみ)', 'フリガナ：ウツノミヤ ハナコ', '参加者2: ウツギ タロウ', '電話番号：090 1234 5678']) {
    assert.equal(H.redact(line).redacted, 0, line);
  }
});

test('名前の項目名に括弧があっても、読点の後ろのふりがなでも、名前の行は残す。住所は空白があっても残す', () => {
  for (const line of ['お名前（フリガナ）: 池上 花子（イケガミ ハナコ）', 'お名前: 池上 花子、イケガミ ハナコ', '氏名（漢字）：池上 花子',
    '住所：福岡市 中央区 薬院 1-2-3', 'ご宿泊先: ホテル熱帯うつぼ館', '代表者：見本 花子（ミホン ハナコ）様']) {
    assert.equal(H.redact(line).redacted, 0, line);
  }
  assert.equal(H.redact('My friend has asthma. We’re staying at Hotel Mihon.').text, `${H.REDACTED_PART} We’re staying at Hotel Mihon.`);
});

test('外した後の文面にもう一度かけても同じ（Worker で 2 回かけるため）', () => {
  const inputs = ['10月24日に2名でお願いします。持病で喘息があります。代表は見本 花子、電話は090-1234-5678です。',
    'Hi, we would like to book 2 people.\nMy friend has a mild heart condition, is it ok?\nThanks,\nSeo-yeon Kim',
    '持病はありますか？はい、少し。電話は090-1234-5678です。', '人数: 1 名\n健康上の問題はありますか？\nはい\n\n日時: 10/24',
    readFileSync(new URL('../assets/samples/e2.txt', import.meta.url), 'utf8')];
  for (const x of inputs) {
    const once = H.redact(x).text;
    assert.equal(H.redact(once).text, once, x.slice(0, 20));
    assert.equal(H.redact(once).redacted, 0);
  }
});

test('入れ子の一部だけ直しても、触っていない所は確かめ済みにならない', () => {
  const s = C.addBooking(base, { trip, booking: { source: 'mail', people: 1 }, reading: { booking: null, healthSeen: false,
    people: [{ ...emptyRead(), name: '見本 花子', emergency: { name: '見本 母', relation: '', phone: '090-9999-9999' }, unsure: ['emergency'] }] }, src: 'paper', at: AT, newId });
  const id = C.peopleOf(s, 't1')[0].id;
  const part = C.editPerson(s, { id, patch: { emergency: { relation: '母' } }, who: 'guest', at: AT }).people.find(p => p.id === id);
  assert.deepEqual([part.unsure, part.src.emergency], [['emergency'], 'paper'], '続柄だけ直しても、AI が読んだ電話は自信なしのまま');
  const whole = C.editPerson(s, { id, patch: { emergency: { name: '見本 母', relation: '母', phone: '090-9999-9999' } }, who: 'guest', at: AT }).people.find(p => p.id === id);
  assert.deepEqual([whole.unsure, whole.src.emergency], [[], 'guest'], '全部を確かめて入れ直せば、確かめ済み');
});

test('予約は形の項目の値が undefined なら拾わず、形が合わなければ例外にする', () => {
  assert.throws(() => C.addBooking(base, { trip, booking: { source: 'phone', people: '3' }, reading: null, src: 'staff', at: AT, newId }), /人数は数/);
  const s = C.addBooking(base, { trip, booking: { source: 'mail', leadName: undefined, people: 1 }, reading: null, src: 'mail', at: AT, newId });
  assert.ok(S.validateState(s).ok);
  assert.throws(() => C.addBooking(base, { trip, booking: { source: 'fax' }, reading: null, src: 'staff', at: AT, newId }), /予約の形/);
  assert.ok(S.validateRequest({ doc: 'mail', text: '予約です', masked: undefined }).ok, 'mail でも undefined の項目は無いのと同じ');
});

test('便: ツアーの名前から種類を決め、同じ日・同じ種類の便を候補に出す', () => {
  assert.deepEqual(['体験ダイビング（ボート2本）', 'Fun Dive, 2 tanks', '午後のスノーケル', 'Snorkeling tour'].map(C.kindOf), ['dive', 'dive', 'snorkel', 'snorkel']);
  const { state: s1, trip: am } = C.addTrip(S.blankState('見本'), { trip: { date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング' }, at: AT, newId });
  assert.ok(S.validateState(s1).ok);
  assert.deepEqual(C.suggestTrip(s1, { date: '2026-10-24', start: '08:30', tour: '体験ダイビング' }).tripId, am.id);
  assert.equal(C.suggestTrip(s1, { date: '2026-10-24', start: '', tour: 'Fun Dive' }).tripId, am.id, '時刻が分からなくても、その日の便が 1 つならそれ');
  assert.equal(C.suggestTrip(s1, { date: '2026-10-24', start: '13:30', tour: '体験ダイビング' }).tripId, null, '時刻が違えば新しい便');
  assert.equal(C.suggestTrip(s1, { date: '2026-10-24', start: '', tour: 'スノーケル' }).tripId, null, '種類が違えば新しい便');
  const { state: s2, trip: pm } = C.addTrip(s1, { trip: { date: '2026-10-24', start: '', kind: 'dive' }, at: AT, newId });
  assert.equal(C.suggestTrip(s2, { date: '2026-10-24', start: '', tour: 'Fun Dive' }).tripId, null, 'その日の便が 2 つなら、お店が選ぶ');
  assert.deepEqual(C.tripList(s2).map(t => t.id), [am.id, pm.id], '時刻の決まっていない便は最後');
  assert.throws(() => C.addTrip(s2, { trip: { date: '2026-02-31', kind: 'dive' }, at: AT, newId }), /便の形/);
});

test('便の種類: スノーケリング・シュノーケル体験もスノーケル。お店が選んだ種類が先', () => {
  assert.deepEqual(['青の洞窟シュノーケリング', 'スノーケリング体験', 'しゅのーける', 'Snorkelling'].map(C.kindOf), ['snorkel', 'snorkel', 'snorkel', 'snorkel']);
  assert.equal(C.suggestTrip(base, { date: '2026-10-24', start: '', tour: '体験ダイビング', kind: 'snorkel' }).kind, 'snorkel');
});

test('予約を便に入れる: 便が無ければ作る。読み取りから予約を組み、聞く項目を数える', () => {
  const r = SAMPLES.e4;
  const want = { date: '2026-10-25', start: '', tour: 'シュノーケリング', kind: '' };
  const { state: s, trip } = C.addBookingToTrip(base, { tripId: 'nope', want, booking: C.bookingFromReading(r), reading: r, src: 'mail', at: AT, newId });
  assert.deepEqual([trip.date, trip.kind, s.trips.length, C.peopleOf(s, trip.id).length], ['2026-10-25', 'snorkel', 2, 3]);
  assert.ok(S.validateState(s).ok);
  const again = C.addBookingToTrip(s, { tripId: trip.id, want, booking: C.bookingFromReading(r), reading: r, src: 'mail', at: AT, newId });
  assert.equal(again.state.trips.length, 2, '便があればそこへ');
  assert.deepEqual(C.bookingFromReading({ booking: null, people: [], healthSeen: false }), { source: 'mail', site: '', ref: '', leadName: '', leadPhone: '', leadEmail: '', people: 1 });
  const miss = C.missingForReading(SAMPLES.e1, 'dive');
  assert.equal(miss.unknown, 0);
  assert.deepEqual(miss.items.map(i => i.key), ['birthDate', 'address', 'emergency', 'history', 'today']);
  assert.equal(C.missingForReading({ ...SAMPLES.e2, people: [SAMPLES.e2.people[0]] }, 'dive').unknown, 1, '名前の分からない人を数える');
});

test('手で入れる予約の誤りを、項目の名前で返す', () => {
  assert.deepEqual(C.bookingProblems({ date: '2026-10-24', people: 2, leadName: '見本', leadPhone: '090', note: '' }), []);
  assert.deepEqual(C.bookingProblems({ date: '', people: NaN, leadName: 'x'.repeat(61), leadPhone: '0'.repeat(31), note: 'x'.repeat(401) }),
    ['date', 'leadName', 'leadPhone', 'people', 'note']);
  assert.deepEqual(C.bookingProblems({ date: '2026-02-31', people: 31, leadName: '', leadPhone: '', note: '' }), ['date', 'people']);
});

test('確かめる画面には、名簿の項目に無い自信なし（電話・サイズ・スノーケル便の C カード）も出す', () => {
  const snorkel = { ...trip, kind: 'snorkel' };
  const p = person({ phone: '090', sizes: { height: 160, weight: '', foot: 24 }, cert: { course: 'OW', date: '2023' }, unsure: ['phone', 'sizes', 'cert'] });
  const rows = C.reviewRows(p, snorkel);
  assert.deepEqual(rows.filter(r => r.unsure).map(r => [r.field, r.text]), [['phone', '090'], ['sizes', '160 cm 足 24 cm'], ['cert', 'オープンウォーター 2023']]);
  assert.equal(C.reviewRows(p, trip).filter(r => r.field === 'cert').length, 2, 'ダイビングの便では cert は名簿の 2 行（取得日・講習）に出る');
});

test('確かめる画面 v12: 自信なしを先に出し、ほかの AI が読む項目も全部直せる。健康は出さない', () => {
  const p = person({ address: '大阪府見本市', dives: 85, unsure: ['address'] });
  const f = C.reviewFields(p, trip);
  assert.deepEqual(f.unsure.map(r => [r.field, r.label]), [['address', '住所']]);
  assert.deepEqual(f.others.map(r => r.field), ['name', 'birthDate', 'phone', 'emergency', 'cert', 'dives', 'lastDive', 'sizes']);
  assert.ok(![...f.unsure, ...f.others].some(r => r.field === 'health'), '健康の答えはお店の確かめる画面に出さない');
  const snorkel = { ...trip, kind: 'snorkel' };
  assert.deepEqual(C.reviewFields(p, snorkel).others.map(r => r.field), ['name', 'birthDate', 'phone', 'emergency', 'dives', 'lastDive', 'sizes'],
    'スノーケル便では名簿に無い C カードを出さない（経験と最後の日はスノーケルの名簿にもある）');
  assert.ok(C.reviewFields({ ...p, unsure: ['cert'] }, snorkel).unsure.some(r => r.field === 'cert'), '自信なしなら名簿に無い項目も出す');
});

test('確かめる画面 v12: 名簿に入れると、直した項目は前と後を記録に残し、自信なしの印を外す。健康は受け取らない', () => {
  const s0 = withMail('e1');
  const id = s0.people[0].id;
  const s = freeze({ ...s0, people: s0.people.map(x => (x.id === id ? { ...x, unsure: ['address'] } : x)) });
  const before = s.people.find(x => x.id === id).dives;
  const out = C.confirmReview(s, { id, patch: { dives: 58 }, at: AT });
  const after = out.people.find(x => x.id === id);
  assert.deepEqual([after.dives, after.unsure, after.src.dives], [58, [], 'staff']);
  const [edit, check] = out.log.slice(-2);
  assert.deepEqual([edit.act, edit.who, edit.fields, edit.before, edit.after], ['edit', 'staff', ['dives'], { dives: before }, { dives: 58 }]);
  assert.deepEqual([check.act, check.fields], ['check', ['address']], '直さずに認めた自信なしの項目も、確かめたと残す');
  assert.equal(C.confirmReview(s, { id, patch: {}, at: AT }).log.slice(-1)[0].act, 'check', '何も直さなければ確かめた記録だけ');
  assert.throws(() => C.confirmReview(s, { id, patch: { health: { historyAt: AT, answers: NO5 } }, at: AT }), /直せない項目 \(health\)/);
});

test('予約の一覧の 1 便分: 予約ごとに人のそろい具合を付ける', () => {
  const s = withMail('e1');
  const rows = C.bookingRows(s, 't1');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].people.length, rows[0].done, rows[0].people[0].name], [2, 0, '見本 花子']);
  assert.ok(rows[0].people[0].missing.includes('birthDate'));
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

/* ---------- 自社の予約フォーム（予約前の確認）から予約の一覧と名簿へ（決定ログ form-to-roster） ---------- */
const DIVE_TOUR = freeze({ id: 'dive', diving: true, start: '08:30', name: { ja: '体験ダイビング（ボート 2 本）' } });
const SNORKEL_TOUR = freeze({ id: 'snorkel', diving: false, start: '09:00', name: { ja: 'ボートスノーケル（1 回）' } });
const intakeOf = (extra) => freeze({ id: 'i1', at: AT, tour: 'dive', date: '2026-10-30', people: 2, name: ' 見本 花子 ', lang: 'ja',
  exp: 'first', dives: '', health: { consent: true, answers: ['yes', 'no', 'no', 'no', 'no'] }, medicalAt: '2026-10-27', ...(extra || {}) });

test('予約前の確認から: 同じ日・種類・開始時刻の便に入る（無ければ作る）。代表者の名前と経験だけで、健康の答えは入れない', () => {
  const one = C.addFromIntake(S.blankState('見本の店'), { intake: intakeOf(), tour: DIVE_TOUR, at: AT, newId });
  const st = one.state;
  assert.equal(st.trips.length, 1);
  assert.deepEqual([st.trips[0].date, st.trips[0].start, st.trips[0].kind, st.trips[0].tour], ['2026-10-30', '08:30', 'dive', '体験ダイビング（ボート 2 本）']);
  const b = st.bookings.find(x => x.id === one.bookingId);
  assert.deepEqual([b.source, b.site, b.leadName, b.people], ['form', '', '見本 花子', 2]);
  const [lead, other] = st.people.filter(p => p.bookingId === b.id);
  assert.deepEqual([lead.name, lead.dives, lead.cert.course, lead.src.name], ['見本 花子', 0, 'NONE', 'guest']);
  assert.ok(lead.health.answers.every(a => a === null) && lead.health.historyAt === '', '健康の答えは名簿に入れない（同意の使い道と残す長さが違う）');
  assert.equal(other.name, '', '2 人目の名前は、お客さんに聞く');
  assert.ok(st.log.some(e => e.act === 'add' && e.kind === 'booking' && e.who === 'guest'), 'お客さんが入れた記録');
  assert.ok(S.validateState(st).ok);
  const two = C.addFromIntake(st, { intake: intakeOf({ id: 'i2', name: '見本 次郎', people: 1 }), tour: DIVE_TOUR, at: AT, newId });
  assert.equal(two.state.trips.length, 1, '同じ便に入る');
  assert.equal(two.state.bookings.length, 2);
});

test('予約前の確認から: C カードありは本数、スノーケルは経験を入れない。数でない本数は入れない', () => {
  const card = C.addFromIntake(S.blankState('見本の店'), { intake: intakeOf({ exp: 'card', dives: '85' }), tour: DIVE_TOUR, at: AT, newId });
  const lead = card.state.people[0];
  assert.deepEqual([lead.dives, lead.cert.course], [85, '']);
  const odd = C.addFromIntake(S.blankState('見本の店'), { intake: intakeOf({ exp: 'card', dives: '10本くらい' }), tour: DIVE_TOUR, at: AT, newId });
  assert.equal(odd.state.people[0].dives, '');
  const sn = C.addFromIntake(S.blankState('見本の店'), { intake: intakeOf({ tour: 'snorkel' }), tour: SNORKEL_TOUR, at: AT, newId });
  assert.deepEqual([sn.state.trips[0].kind, sn.state.people[0].dives, sn.state.people[0].cert.course], ['snorkel', '', '']);
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
