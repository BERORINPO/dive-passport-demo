// 乗り合い便（他のお店のお客さん・合同名簿・札・ポイントを離れる前）を確かめる（P5）。
// 実行: node test/share.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/roster-schema.js');
load('../js/pass-schema.js');
load('../js/roster-core.js');
load('../js/roster-guest.js');
load('../js/roster-day.js');
load('../js/roster-share.js');
load('../js/data-samples.js');
load('../js/data-big-sample.js');
const { roster: S, rosterCore: C, rosterGuest: G, rosterDay: D, rosterShare: X, SAMPLE_READINGS, BIG_SAMPLE } = globalThis.REDUX;

const AT = '2026-10-21T09:00:00.000Z';
const TODAY = '2026-10-21';
const NO5 = ['no', 'no', 'no', 'no', 'no'];
const HEALTH_SHORT = ['治療中の病気', '心臓・肺', '耳・鼻', '妊娠', '手術・けが'];
const OWN = 'B マリン（見本）';
const PARTNER = 'C ダイブ（見本）';
let n = 0;
const newId = () => `id${(n += 1)}`;

function freeze(x) {
  if (x && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.values(x).forEach(freeze);
    Object.freeze(x);
  }
  return x;
}

/* 10/24 の便（ガイドは 見本 ガイド、ポイントは北の根）に、見本メール e1 の 2 人。乗り合いのお店はまだ無い */
const trip = { ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）',
  boat: 'サンプル丸', site: '北の根', guides: ['見本 ガイド'], createdAt: AT };
const reading = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
const base = freeze(C.addBooking({ ...S.blankState(OWN), trips: [trip] },
  { trip, booking: { source: 'mail', people: 2 }, reading, src: 'mail', at: AT, newId }));
const withPartner = freeze(X.addPartner(base, { tripId: 't1', name: ` ${PARTNER} `, at: AT }).state);
const tripOf = (st) => st.trips.find(t => t.id === 't1');

/* 他のお店の見本の 2 人（架空）。健康の答えと当日の体調つき（入れても、この店には入らないことを確かめる） */
const ICHIRO = { name: '見本 一郎', birthDate: '1985-09-09', address: '大阪府大阪市見本区 4-4', emergency: { name: '見本 京子', relation: '妻', phone: '090-0000-5566' },
  cert: { course: 'AOW', date: '2015-08' }, dives: 120, lastDive: '2026-09', health: { answers: NO5, today: 'ok' } };
const SAKURA = { name: '見本 さくら', birthDate: '2001-03-03', emergency: { name: '見本 陸', relation: '兄', phone: '090-7777-8888' },
  cert: { course: 'NONE', date: '' }, dives: 0, lastDive: '', health: { answers: NO5, today: 'ok' } };
/* 見本として 2 人を入れる（demo。そのお店が便の日に当日の体調を確かめた扱い）。健康の答えは付いていても入らない */
const addTwo = (st) => X.addPartnerPeople(st, { tripId: 't1', shop: PARTNER, people: [ICHIRO, SAKURA], guide: '見本 三郎', demo: true, at: AT, newId });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('乗り合いのお店を足す: 名前の誤り（空・この店と同じ・2 回目・長い・11 店目）は足さない', () => {
  assert.deepEqual(tripOf(withPartner).partners, [PARTNER]);
  const e = withPartner.log[withPartner.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.fields], ['edit', 'trip', ['partners']]);
  assert.equal(X.addPartner(withPartner, { tripId: 't1', name: '  ', at: AT }).problem, 'empty');
  assert.equal(X.addPartner(withPartner, { tripId: 't1', name: OWN, at: AT }).problem, 'same');
  assert.equal(X.addPartner(withPartner, { tripId: 't1', name: PARTNER, at: AT }).problem, 'same');
  assert.equal(X.addPartner(withPartner, { tripId: 't1', name: 'あ'.repeat(61), at: AT }).problem, 'long');
  let st = withPartner;
  for (let i = 2; i <= 10; i += 1) st = X.addPartner(st, { tripId: 't1', name: `見本 ${i} 号店`, at: AT }).state;
  assert.equal(tripOf(st).partners.length, 10);
  assert.equal(X.addPartner(st, { tripId: 't1', name: '見本 11 号店', at: AT }).problem, 'many');
  assert.ok(S.validateState(st).ok);
  assert.equal(S.validateTrip({ ...tripOf(withPartner), partners: [PARTNER, PARTNER] }).ok, false, '同じお店を 2 回入れた便は形が合わない');
});

test('船を出す店: この店か乗り合いのお店。外したお店が船を出す店なら、この店に戻す', () => {
  const r = X.setHost(withPartner, { tripId: 't1', host: PARTNER, at: AT });
  assert.equal(tripOf(r.state).host, PARTNER);
  assert.equal(X.boatOwner(r.state, tripOf(r.state)), PARTNER);
  assert.equal(X.setHost(withPartner, { tripId: 't1', host: '知らない店', at: AT }).problem, 'unknown');
  assert.equal(tripOf(X.setHost(r.state, { tripId: 't1', host: OWN, at: AT }).state).host, '');
  const removed = X.removePartner(r.state, { tripId: 't1', name: PARTNER, at: AT });
  assert.deepEqual([tripOf(removed.state).partners, tripOf(removed.state).host], [[], '']);
});

test('人のいるお店は外せない', () => {
  const st = addTwo(withPartner).state;
  assert.equal(X.removePartner(st, { tripId: 't1', name: PARTNER, at: AT }).problem, 'people');
});

test('他のお店のお客さん: 出どころ partner の予約に入る。健康の答えが付いていても入れず、そのお店が確かめた印だけ持つ', () => {
  const r = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO, SAKURA], guide: '見本 三郎', at: AT, newId });
  assert.equal(r.problem, null);
  assert.equal(r.ids.length, 2);
  const b = r.state.bookings.find(x => x.source === 'partner');
  assert.deepEqual([b.shop, b.people, b.tripId], [PARTNER, 2, 't1']);
  const [ichiro, sakura] = r.ids.map(id => r.state.people.find(p => p.id === id));
  assert.deepEqual([ichiro.name, ichiro.guide, ichiro.src.name, ichiro.src.guide], ['見本 一郎', '見本 三郎', 'partner', 'partner']);
  [ichiro, sakura].forEach(p => {
    assert.ok(p.health.answers.every(a => a === null), '既往症の答えを持たない');
    assert.deepEqual([p.health.today, p.health.todayAt, p.health.historyAt, p.health.heldBy, p.health.consentVer], ['', '', '', PARTNER, '']);
  });
  assert.ok(!JSON.stringify(r.state).includes('"ok"'), '当日の体調の答えも、どこにも入っていない');
  const t = tripOf(r.state);
  assert.equal(C.cellText(sakura, t, 'history', HEALTH_SHORT), `${PARTNER}が確かめた`);
  assert.equal(C.cellText(sakura, t, 'today', HEALTH_SHORT), '', '便の前は、当日の体調をまだ誰も確かめていない');
  assert.deepEqual(C.status(sakura, t).missing, ['address', 'today'], '住所と当日の欄がまだ');
  assert.deepEqual(C.status(ichiro, t).missing, ['today']);
  assert.deepEqual(C.askGuest(sakura, t), ['address'], 'この店はお客さんに健康を聞かない');
  const early = X.handOver(r.state, { tripId: 't1', shop: PARTNER, today: TODAY, at: AT });
  assert.equal(C.status(X.shopPeople(early, 't1', PARTNER)[1], t).missing.includes('today'), true, '便の前に渡しても、当日の欄はそろわない');
  const onDay = X.handOver(r.state, { tripId: 't1', shop: PARTNER, today: t.date, at: AT });
  const later = X.shopPeople(onDay, 't1', PARTNER)[1];
  assert.equal(C.cellText(later, t, 'today', HEALTH_SHORT), `${PARTNER}が確かめた`);
  assert.deepEqual(C.status(later, t).missing, ['address']);
  assert.ok(later.health.answers.every(a => a === null) && later.health.today === '', '答えは持たないまま');
  assert.ok(S.validateState(onDay).ok);
  assert.ok(!r.state.log.some(e => e.demo === true), '見本でなければ印は付けない');
});

test('他のお店の見本（demo）: そのお店が便の日に当日の体調を確かめたことにして入れ、記録に見本の印を付ける。答えは入れない', () => {
  const r = addTwo(withPartner);
  const ichiro = r.state.people.find(p => p.id === r.ids[0]);
  assert.deepEqual([ichiro.health.todayAt, ichiro.health.today, ichiro.health.heldBy], ['2026-10-24', '', PARTNER]);
  assert.ok(ichiro.health.answers.every(a => a === null));
  assert.ok(C.status(ichiro, tripOf(r.state)).done, '13 項目がそろう（健康は「確かめた」）');
  assert.ok(r.state.log.some(e => e.kind === 'person' && e.id === ichiro.id && e.fields.includes('health') && e.demo === true), '見本の印');
  assert.ok(S.validateState(r.state).ok);
});

test('他のお店のお客さん: ガイドが要る。乗り合いに入っていないお店は入れない', () => {
  assert.equal(X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO], guide: ' ', at: AT, newId }).problem, 'guide');
  assert.equal(X.addPartnerPeople(withPartner, { tripId: 't1', shop: '知らない店', people: [ICHIRO], guide: 'x', at: AT, newId }).problem, 'shop');
  const one = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [{ name: 'Lena Fischer' }], guide: '見本 三郎', at: AT, newId });
  const lena = one.state.people.find(p => p.id === one.ids[0]);
  assert.deepEqual([lena.name, lena.health.heldBy, lena.health.historyAt], ['Lena Fischer', PARTNER, '']);
  assert.ok(!C.askGuest(lena, tripOf(one.state)).includes('history'), '健康は、そのお客さんのお店が聞く');
});

test('記録には健康の答えの中身を残さない（他のお店の答えは最初から入れない）', () => {
  const unwell = { ...ICHIRO, health: { answers: ['yes', 'no', 'no', 'no', 'no'], today: 'unwell' } };
  const st = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [unwell], guide: '見本 三郎', demo: true, at: AT, newId }).state;
  const text = JSON.stringify(st);
  assert.ok(!text.includes('"yes"') && !text.includes('unwell'), '答えの中身が名簿にも記録にも無い');
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.fields, e.after.health], [['health'], { answered: 0, today: false, todayAt: '2026-10-24', heldBy: PARTNER, consentVer: '' }],
    '答えた数 0 と、誰が確かめたかだけ');
});

test('前の版で船に渡した他のお店のお客さんの健康の答えは、読み込むときに消して「そのお店が確かめた」印にする', () => {
  const r = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO], guide: '見本 三郎', at: AT, newId });
  const id = r.ids[0];
  /* 前の版の形: 他のお店が同意つきで渡した答え（heldBy が空で、答えと同意の版を持つ） */
  const old = C.editPerson(r.state, { id, who: 'staff', src: 'partner', at: AT, patch: { health: {
    answers: NO5, historyAt: TODAY, today: 'ok', todayAt: '2026-10-24', consentAt: TODAY, consentVer: 'partner-2026-10-21', heldBy: '' } } });
  assert.ok(S.validateState(old).ok, '前の版の形も、形としては正しい');
  const held = X.holdPartnerHealth(old, { at: AT });
  const p = held.people.find(x => x.id === id);
  assert.ok(p.health.answers.every(a => a === null));
  assert.deepEqual([p.health.today, p.health.todayAt, p.health.heldBy, p.health.consentVer], ['', '2026-10-24', PARTNER, ''], '便の日に答えていた人は、その日に確かめた扱いで残す');
  const before = C.editPerson(old, { id, who: 'staff', src: 'partner', at: AT, patch: { health: { todayAt: TODAY } } });
  assert.equal(X.holdPartnerHealth(before, { at: AT }).people.find(x => x.id === id).health.todayAt, '', '便の日より前の答えは、当日の分にしない');
  const own = C.peopleOf(old, 't1', { own: true }).map(x => x.id);
  assert.deepEqual(own.map(x => held.people.find(y => y.id === x)), own.map(x => old.people.find(y => y.id === x)), 'この店のお客さんの健康は変えない');
  const e = held.log[held.log.length - 1];
  assert.deepEqual([e.who, e.fields], ['system', ['health']]);
  assert.ok(S.validateState(held).ok);
  assert.equal(X.holdPartnerHealth(held, { at: AT }), held, '変える人がいなければ同じ state');
  assert.equal(X.holdPartnerHealth(base, { at: AT }), base, '乗り合いが無ければ同じ state');
});

test('他のお店のお客さんに血中酸素が残っていたら、読み込むときに消す。この店のお客さんの数値は合同名簿に出ない', () => {
  const r = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO], guide: '見本 三郎', at: AT, newId });
  const id = r.ids[0];
  const spo2 = [{ pre: 87, post: 88 }, { pre: '', post: '' }, { pre: '', post: '' }];
  const old = C.editPerson(r.state, { id, who: 'staff', src: 'partner', at: AT, patch: { health: { heldBy: '', spo2 } } });
  assert.ok(S.validateState(old).ok, 'heldBy の無い前の版の形');
  assert.throws(() => D.setSpo2(old, { id, dive: 1, side: 'pre', value: 97, at: AT }), /他のお店/, 'heldBy が無くても、他のお店の予約の人には入れない');
  const held = X.holdPartnerHealth(old, { at: AT });
  const p = held.people.find(x => x.id === id);
  assert.deepEqual([p.health.heldBy, p.health.spo2.every(d => d.pre === '' && d.post === '')], [PARTNER, true]);
  assert.ok(S.validateState(held).ok);
  const mine = C.peopleOf(held, 't1', { own: true })[0];
  const withMine = D.setSpo2(held, { id: mine.id, dive: 1, side: 'pre', value: 87, at: AT });
  assert.ok(!JSON.stringify(X.jointRows(withMine, 't1')).includes('87'), '合同名簿の行に数値が出ない');
});

test('健康を渡さない人には、この店の側で健康の答えを入れない（お客さんの入力・当日の体調・パスポート）', () => {
  const r = addTwo(withPartner);
  const id = r.ids[0];
  assert.deepEqual(G.answerToday(r.state, { id, answer: 'unwell', day: '2026-10-24', consent: true, today: TODAY, at: AT }).problems, ['held']);
  const offer = { name: '見本 一郎', items: [{ key: 'history', label: '既往症', patch: { health: { answers: NO5, historyAt: TODAY } } }] };
  /* パスポートは、askGuest が健康を聞かないので健康を選べない（core の守りは、入口が増えたときの多重防御） */
  const fromPass = G.applyPassport(r.state, { id, offer, keys: ['history'], otherName: true, consent: true, today: TODAY, at: AT }).state;
  assert.ok(fromPass.people.find(p => p.id === id).health.answers.every(a => a === null), 'パスポートからも入らない');
  const person = r.state.people.find(p => p.id === id);
  assert.equal(S.validatePerson({ ...person, health: { ...person.health, answers: NO5, historyAt: TODAY } }).ok, false, '形の検査でも、答えを持てない');
});

test('ガイドを替えると、そのお店の全員に入る。空にはできない', () => {
  const st = addTwo(withPartner).state;
  const r = X.setPartnerGuide(st, { tripId: 't1', shop: PARTNER, guide: '見本 四郎', at: AT });
  assert.deepEqual(X.shopPeople(r.state, 't1', PARTNER).map(p => p.guide), ['見本 四郎', '見本 四郎']);
  assert.equal(X.partnerGuide(r.state, 't1', PARTNER), '見本 四郎');
  assert.equal(X.setPartnerGuide(st, { tripId: 't1', shop: PARTNER, guide: '', at: AT }).problem, 'guide');
});

test('札を付けた後にガイドの名前を直しても、札の番号は変わらない', () => {
  const tagged = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const r = X.setPartnerGuide(tagged, { tripId: 't1', shop: PARTNER, guide: '見本 四郎', at: AT });
  const t = tripOf(r.state);
  assert.deepEqual(t.tags.find(x => x.no === 'C-1'), { guide: '見本 四郎', shop: PARTNER, no: 'C-1' });
  assert.equal(t.tags.length, 6, '札は増えない');
  const g = X.boatGroups(r.state, 't1');
  assert.deepEqual([g.groups[1].members[0].tag, g.untagged, g.tagged], ['C-1', 0, 6]);
  assert.ok(S.validateState(r.state).ok);
});

test('自分の店のガイドの名前を直しても、札の番号は変わらない（今日の名簿の画面から）', () => {
  const tagged = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const st = C.editTrip(tagged, { tripId: 't1', patch: { guides: ['見本 ガイド二'] }, at: AT });
  assert.deepEqual(tripOf(st).tags.find(x => x.no === 'B-1'), { guide: '見本 ガイド二', shop: '', no: 'B-1' });
  const g = X.boatGroups(st, 't1');
  assert.deepEqual([g.groups[0].members[0].name, g.groups[0].members[0].tag, g.untagged], ['見本 ガイド二', 'B-1', 0]);
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.act, e.after], ['tags', { renamed: 1, tags: 6 }]);
  const two = C.editTrip(tagged, { tripId: 't1', patch: { guides: ['見本 ガイド', '見本 ガイド三'] }, at: AT });
  assert.equal(tripOf(two).tags.length, 6, 'ガイドを足しただけなら付け替えない');
});

test('予約の一覧: 他のお店が当日の体調を確かめるのを待っている予約は、その印が付く', () => {
  const held = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO, SAKURA], guide: '見本 三郎', at: AT, newId }).state;
  const row = C.bookingRows(held, 't1').find(r => r.booking.source === 'partner');
  assert.deepEqual(row.people.map(p => p.heldToday), [true, true]);
  const onDay = X.handOver(held, { tripId: 't1', shop: PARTNER, today: tripOf(held).date, at: AT });
  assert.ok(C.bookingRows(onDay, 't1').find(r => r.booking.source === 'partner').people.every(p => !p.heldToday), '便の日に「渡す」を押したら待たない');
});

test('名簿の取り込み（自分の店の申込書）は、同じ名前の他のお店のお客さんに入れない', () => {
  const twin = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [{ name: '見本 花子' }], guide: '見本 三郎', at: AT, newId }).state;
  const read = { ...JSON.parse(JSON.stringify(SAMPLE_READINGS.c1.people[0])), name: '見本 花子' };
  const r = C.applyReading(twin, { tripId: 't1', read, src: 'paper', at: AT });
  const own = C.peopleOf(twin, 't1', { own: true }).find(p => p.name === '見本 花子');
  assert.equal(r.personId, own.id);
});

test('出どころ partner の予約は、お店の名前が要る', () => {
  const b = base.bookings[0];
  assert.equal(S.validateBooking({ ...b, source: 'partner', shop: '' }).ok, false);
  assert.equal(S.validateBooking({ ...b, source: 'partner', shop: PARTNER }).ok, true);
});

test('今日の名簿と条例の名簿（P4）は、自分の店のお客さんだけ', () => {
  const st = addTwo(withPartner).state;
  const g = D.dayGroups(st, 't1', TODAY);
  assert.equal(g.count, 2);
  assert.equal(g.check.length + g.morning.length + g.ready.length, 2);
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT, { own: true }).rows.length, 2);
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT).rows.length, 4);
  assert.equal(C.tripSummary(st, 't1').booked, 4, '便の人数は船の全員');
});

test('船に乗る人: この店が先、お店ごとにガイドが先。札の番号はまだ', () => {
  const st = addTwo(withPartner).state;
  const g = X.boatGroups(st, 't1');
  assert.deepEqual(g.groups.map(x => [x.name, x.own, x.owner]), [[OWN, true, true], [PARTNER, false, false]]);
  assert.deepEqual(g.groups[0].members.map(m => [m.kind, m.name]), [['guide', '見本 ガイド'], ['person', '見本 花子'], ['person', '見本 太郎']]);
  assert.deepEqual(g.groups[1].members.map(m => [m.name, m.label]), [['見本 三郎', 'ガイド'], ['見本 一郎', 'ファン'], ['見本 さくら', '体験']]);
  assert.deepEqual([g.aboard, g.tagged, g.untagged], [6, 0, 6]);
});

test('札の番号: お店の頭文字と番号。足した人は続きの番号で、前の番号は変えない', () => {
  const st = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const t = tripOf(st);
  assert.deepEqual(t.tags.map(x => x.no), ['B-1', 'B-2', 'B-3', 'C-1', 'C-2', 'C-3']);
  assert.deepEqual(t.tags[0], { guide: '見本 ガイド', shop: '', no: 'B-1' });
  assert.deepEqual(t.tags[3], { guide: '見本 三郎', shop: PARTNER, no: 'C-1' });
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.act, e.after], ['tags', { added: 6, tags: 6 }]);
  assert.equal(X.assignTags(st, { tripId: 't1', at: AT }), st, '全員に付いていれば何もしない');
  const more = X.addPartnerPeople(st, { tripId: 't1', shop: PARTNER, people: [{ name: 'Lena Fischer' }], guide: '見本 三郎', at: AT, newId }).state;
  const again = X.assignTags(more, { tripId: 't1', at: AT });
  assert.deepEqual(tripOf(again).tags.map(x => x.no), ['B-1', 'B-2', 'B-3', 'C-1', 'C-2', 'C-3', 'C-4']);
  const g = X.boatGroups(again, 't1');
  assert.deepEqual(g.groups[1].members.map(m => m.tag), ['C-1', 'C-2', 'C-3', 'C-4']);
  assert.equal(g.untagged, 0);
  assert.ok(S.validateState(again).ok);
});

test('札の頭文字はお店ごとに重ならない（同じ字で始まるお店）', () => {
  const st = X.addPartner(base, { tripId: 't1', name: 'B ダイブ', at: AT }).state;
  const two = X.addPartnerPeople(st, { tripId: 't1', shop: 'B ダイブ', people: [{ name: 'x' }], guide: 'y', at: AT, newId }).state;
  const tags = tripOf(X.assignTags(two, { tripId: 't1', at: AT })).tags.map(x => x.no);
  assert.deepEqual(tags, ['B-1', 'B-2', 'B-3', 'ダ-1', 'ダ-2']);
});

test('札の形: 番号の重なり・名前の無いガイドの札は合わない', () => {
  const t = tripOf(base);
  assert.equal(S.validateTrip({ ...t, tags: [{ personId: 'a', no: 'B-1' }, { personId: 'b', no: 'B-1' }] }).ok, false);
  assert.equal(S.validateTrip({ ...t, tags: [{ guide: '', shop: '', no: 'B-1' }] }).ok, false);
  assert.equal(S.validateTrip({ ...t, tags: [{ personId: 'a', guide: 'x', no: 'B-1' }] }).ok, false);
  assert.ok(S.validateTrip({ ...t, tags: [{ personId: 'a', no: 'B-1' }, { guide: 'x', shop: '', no: 'B-2' }] }).ok);
});

test('ポイントを離れる前: 押すたびに時刻と札の枚数を足す（消さない）', () => {
  const tagged = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const once = X.recordLeave(tagged, { tripId: 't1', at: '2026-10-24T01:31:00.000Z' }).state;
  const twice = X.recordLeave(once, { tripId: 't1', at: '2026-10-24T03:02:00.000Z' }).state;
  assert.deepEqual(X.leaveChecks(tripOf(twice)).map(c => [c.at, c.tags, c.missing]),
    [['2026-10-24T01:31:00.000Z', 6, []], ['2026-10-24T03:02:00.000Z', 6, []]]);
  const e = twice.log[twice.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.after], ['aboard', 'trip', { stage: 'leave', tags: 6 }]);
  assert.ok(S.validateState(twice).ok);
});

test('ポイントを離れる前: 札の番号が無い人がいる・誰もいないときは残さない', () => {
  const tagged = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const more = X.addPartnerPeople(tagged, { tripId: 't1', shop: PARTNER, people: [{ name: 'Lena Fischer' }], guide: '見本 三郎', at: AT, newId }).state;
  const r = X.recordLeave(more, { tripId: 't1', at: AT });
  assert.deepEqual([r.problem, r.state], ['untagged', more]);
  const empty = X.recordLeave({ ...S.blankState(OWN), trips: [{ ...trip, guides: [] }] }, { tripId: 't1', at: AT });
  assert.equal(empty.problem, 'empty');
});

test('ポイントを離れる前: 前の記録から 10 秒たたずに押したのは 2 回目と数えない', () => {
  const t0 = Date.parse('2026-10-24T01:31:00.000Z');
  assert.equal(X.leaveRepeat(null, t0), false, 'まだ記録が無い');
  assert.equal(X.leaveRepeat(t0, t0 + 9999), true);
  assert.equal(X.leaveRepeat(t0, t0 + 10000), false);
  assert.equal(X.leaveRepeat(t0, t0 - 1), false, '端末の時計が戻っても止めない');
});

test('合同名簿: お店ごとに、札の番号と船の上で要る 5 項目だけ。住所・生年月日と健康の 2 欄は載せない。ガイドは名簿に入れない', () => {
  const st = X.assignTags(addTwo(withPartner).state, { tripId: 't1', at: AT });
  const j = X.jointRows(st, 't1');
  assert.deepEqual([j.people, j.guides, j.owner], [4, 2, OWN]);
  assert.deepEqual(j.items.map(i => i.ja), ['氏名', '店', '種類', 'ガイド', '緊急時の連絡先']);
  assert.deepEqual(j.groups.map(g => g.rows.map(r => r.tag)), [['B-2', 'B-3'], ['C-2', 'C-3']]);
  const ichiro = j.groups[1].rows[0].cells;
  assert.deepEqual(Object.keys(ichiro), X.JOINT_KEYS, '載せる項目のほかは、行にも持たない');
  assert.deepEqual([ichiro.name, ichiro.shop, ichiro.kind, ichiro.guide, ichiro.emergency],
    ['見本 一郎', PARTNER, 'ファン', '見本 三郎', '見本 京子（妻） 090-0000-5566']);
  assert.equal(j.groups[1].rows[0].blank, 0);
  const own = j.groups[0].rows.map(r => r.cells);
  assert.ok(own.every(c => !('history' in c) && !('today' in c)), 'この店のお客さんの健康も載せない');
  assert.deepEqual([j.groups[0].rows[0].cells.guide, j.groups[0].rows[0].cells.shop], ['見本 ガイド', OWN]);
  const snorkel = X.jointRows({ ...st, trips: st.trips.map(t => ({ ...t, kind: 'snorkel' })) }, 't1');
  assert.deepEqual([snorkel.items.length, snorkel.groups[1].rows[0].cells.kind], [5, 'スノーケル']);
});

test('受け取った記録: 人数と、健康の欄は受け取っていないこと', () => {
  const st = X.handOver(addTwo(withPartner).state, { tripId: 't1', shop: PARTNER, today: TODAY, at: AT });
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.after], ['handover', 'booking', { people: 2, health: false }]);
  assert.equal(X.handOver(withPartner, { tripId: 't1', shop: PARTNER, today: TODAY, at: AT }), withPartner, 'まだ誰もいなければ何も残さない');
  assert.ok(S.validateState(st).ok);
});

test('印刷の記録に、合同名簿か札ボードかを残す', () => {
  const st = C.logOutput(withPartner, { tripId: 't1', act: 'print', people: 4, health: false, paper: 'board', at: AT });
  assert.deepEqual(st.log[st.log.length - 1].after, { people: 4, health: false, paper: 'board' });
  const plain = C.logOutput(withPartner, { tripId: 't1', act: 'print', people: 4, paper: 'other', at: AT });
  assert.deepEqual(plain.log[plain.log.length - 1].after, { people: 4, health: true });
});

/* ---------- 便の中止と、相乗りのお店に返す名簿 ---------- */
test('中止: 理由を残し、取り消せる。相乗りのお店は確かめた印を付けられる。どれも記録に残る', () => {
  let st = C.cancelTrip(withPartner, { tripId: 't1', reason: 'wind', at: AT });
  const t = st.trips.find(x => x.id === 't1');
  assert.deepEqual(t.cancel, { at: AT, reason: 'wind', acked: [] });
  assert.ok(S.validateState(st).ok);
  assert.equal(C.cancelTrip(st, { tripId: 't1', reason: 'boat', at: AT }), st, '中止の便をもう一度中止にしない');
  st = C.ackCancel(st, { tripId: 't1', shop: PARTNER, at: AT });
  assert.deepEqual(st.trips.find(x => x.id === 't1').cancel.acked, [PARTNER]);
  assert.equal(C.ackCancel(st, { tripId: 't1', shop: PARTNER, at: AT }), st, '2 回押しても 1 つ');
  assert.equal(C.ackCancel(st, { tripId: 't1', shop: '知らないお店', at: AT }), st, '乗り合いに入っていないお店は付けない');
  assert.throws(() => C.cancelTrip(withPartner, { tripId: 't1', reason: 'typhoon', at: AT }), /便の形/);
  const back = C.reopenTrip(st, { tripId: 't1', at: AT });
  assert.ok(!('cancel' in back.trips.find(x => x.id === 't1')), '取り消したら欄ごと消す（中止していない便と同じ形）');
  assert.deepEqual(back.log.slice(-3).map(e => e.act), ['cancel', 'ack', 'reopen']);
  assert.ok(S.validateState(back).ok);
  const again = C.cancelTrip(back, { tripId: 't1', reason: 'storm', at: AT });
  assert.deepEqual(again.trips.find(x => x.id === 't1').cancel.acked, [], 'もう一度中止にしたら、確かめはやり直し');
});

test('中止の欄は中止した便にだけ付く。前の版の便（欄なし）も読め、中止できる', () => {
  assert.ok(!('cancel' in S.blankTrip()), '新しい便には付けない（前の版の画面が、中止していない便まで読めなくならないように）');
  const old = { ...S.blankTrip(), id: 'old', date: '2026-10-24', createdAt: AT };
  assert.ok(S.validateTrip(old).ok);
  const st = C.cancelTrip({ ...S.blankState(OWN), trips: [old] }, { tripId: 'old', reason: 'wind', at: AT });
  assert.ok(S.validateState(st).ok);
  assert.equal(S.validateTrip({ ...old, cancel: { at: 'きのう', reason: 'wind', acked: [] } }).ok, false, '時刻の形でない');
  assert.equal(S.validateTrip({ ...old, cancel: null }).ok, false, '空の中止は付けない');
});

test('中止中に相乗りのお店を外したら、そのお店の「確かめた」も外す（足し直しても確かめ済みで始めない）', () => {
  let st = C.cancelTrip(withPartner, { tripId: 't1', reason: 'wind', at: AT });
  st = C.ackCancel(st, { tripId: 't1', shop: PARTNER, at: AT });
  st = X.removePartner(st, { tripId: 't1', name: PARTNER, at: AT }).state;
  assert.deepEqual(tripOf(st).cancel.acked, []);
  st = X.addPartner(st, { tripId: 't1', name: PARTNER, at: AT }).state;
  assert.deepEqual(tripOf(st).cancel.acked, []);
  assert.ok(S.validateState(st).ok);
});

test('見本の乗り合い便: 1 隻に 4 店・30 人、ガイド 4 人に札、形も合う', () => {
  const r = X.addBigSample(S.blankState(OWN), { day: TODAY, at: AT, newId });
  const t = r.state.trips.find(x => x.id === r.tripId);
  assert.ok(S.validateState(r.state).ok);
  assert.equal(r.state.people.length, 30);
  assert.deepEqual(t.partners, BIG_SAMPLE.partners.map(p => p.shop));
  assert.equal(t.tags.length, 34, 'お客さん 30 人とガイド 4 人');
  assert.equal(C.rosterRows(r.state, r.tripId, HEALTH_SHORT, { own: true }).rows.length, 9);
  for (const p of BIG_SAMPLE.partners) assert.equal(C.rosterRows(r.state, r.tripId, HEALTH_SHORT, { shop: p.shop }).rows.length, 7, p.shop);
  assert.ok(r.state.people.every(p => p.health.historyAt === '' && p.health.answers.every(a => a === null)), '健康の答えは入れない');
  const full = { ...BIG_SAMPLE, partners: [...BIG_SAMPLE.partners, ...Array.from({ length: 8 }, (_, i) => ({ shop: `見本 ${i}`, guide: '見本 ガイド', people: [] }))] };
  assert.throws(() => X.addBigSample(S.blankState(OWN), { day: TODAY, at: AT, newId, sample: full }), /お店を足せない/, '半分だけの便を作らない');
});

test('相乗りのお店に返す名簿: そのお店のお客さんだけ、潜水日時と場所はこの便の物、健康の 2 欄は「お店が記入」', () => {
  const r = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO], guide: '見本 三郎', at: AT, newId });
  const st = C.editTrip(r.state, { tripId: 't1', patch: { site: '砂辺' }, at: AT });
  const table = C.rosterRows(st, 't1', HEALTH_SHORT, { shop: PARTNER });
  assert.equal(table.rows.length, 1);
  const c = table.rows[0].cells;
  assert.deepEqual([c.name, c.site, c.guide, c.history, c.today], ['見本 一郎', '砂辺', '見本 三郎', 'お店が記入', 'お店が記入']);
  const person = st.people.find(p => p.name === '見本 一郎');
  const trip = st.trips.find(t => t.id === 't1');
  assert.deepEqual(C.status(person, trip).missing, ['today'], '健康以外はそろい、当日の体調はまだ');
  assert.equal(table.rows[0].done, true, '健康の 2 欄はそのお店が書くので、そろったかの数に入れない');
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT, { shop: '知らないお店' }).rows.length, 0);
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT, { shop: '' }).rows.length, 0, 'お店の名前が空なら、便の全員に落とさない');
  const mine = C.rosterRows(st, 't1', HEALTH_SHORT, { own: true });
  assert.ok(mine.rows.every(x => x.cells.name !== '見本 一郎'), 'この店の名簿には入らない');
});

let failed = 0;
for (const t of tests) {
  try {
    t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
