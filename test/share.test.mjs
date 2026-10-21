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
const { roster: S, rosterCore: C, rosterDay: D, rosterShare: X, SAMPLE_READINGS } = globalThis.REDUX;

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

/* 他のお店の見本の 2 人（架空）。健康の答えと当日の体調つき */
const ICHIRO = { name: '見本 一郎', birthDate: '1985-09-09', address: '大阪府大阪市見本区 4-4', emergency: { name: '見本 京子', relation: '妻', phone: '090-5555-6666' },
  cert: { course: 'AOW', date: '2015-08' }, dives: 120, lastDive: '2026-09', health: { answers: NO5, today: 'ok' } };
const SAKURA = { name: '見本 さくら', birthDate: '2001-03-03', emergency: { name: '見本 陸', relation: '兄', phone: '090-7777-8888' },
  cert: { course: 'NONE', date: '' }, dives: 0, lastDive: '', health: { answers: NO5, today: 'ok' } };
const addTwo = (st, share) => X.addPartnerPeople(st, { tripId: 't1', shop: PARTNER, people: [ICHIRO, SAKURA], guide: '見本 三郎', share, today: TODAY, demo: true, at: AT, newId });

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
  const st = addTwo(withPartner, true).state;
  assert.equal(X.removePartner(st, { tripId: 't1', name: PARTNER, at: AT }).problem, 'people');
});

test('他のお店のお客さん（同意あり）: 出どころ partner の予約に入り、健康の答えは他店の同意の版で残る', () => {
  const r = addTwo(withPartner, true);
  assert.equal(r.problem, null);
  assert.equal(r.ids.length, 2);
  const b = r.state.bookings.find(x => x.source === 'partner');
  assert.deepEqual([b.shop, b.people, b.tripId], [PARTNER, 2, 't1']);
  const ichiro = r.state.people.find(p => p.id === r.ids[0]);
  assert.deepEqual([ichiro.name, ichiro.guide, ichiro.src.name, ichiro.src.guide], ['見本 一郎', '見本 三郎', 'partner', 'partner']);
  assert.deepEqual([ichiro.health.consentVer, ichiro.health.consentAt, ichiro.health.todayAt, ichiro.health.heldBy], [X.PARTNER_CONSENT_VER, TODAY, '2026-10-24', '']);
  assert.ok(C.status(ichiro, tripOf(r.state)).done, '13 項目がそろう');
  assert.ok(r.state.log.some(e => e.kind === 'person' && e.id === ichiro.id && e.fields.includes('health') && e.demo === true), '当日の体調を見本で入れた印');
  assert.ok(X.partnerShares(r.state, 't1', PARTNER));
  assert.ok(S.validateState(r.state).ok);
});

test('他のお店のお客さん（同意なし）: 健康の答えは入れず、名簿の 2 欄は「そのお店が確かめた」', () => {
  const r = addTwo(withPartner, false);
  const sakura = r.state.people.find(p => p.id === r.ids[1]);
  assert.ok(sakura.health.answers.every(a => a === null));
  assert.deepEqual([sakura.health.today, sakura.health.heldBy, sakura.health.consentVer], ['', PARTNER, '']);
  const t = tripOf(r.state);
  assert.equal(C.cellText(sakura, t, 'history', HEALTH_SHORT), `${PARTNER}が確かめた`);
  assert.equal(C.cellText(sakura, t, 'today', HEALTH_SHORT), `${PARTNER}が確かめた`);
  assert.deepEqual(C.status(sakura, t).missing, ['address'], '健康の 2 欄はそろった扱い。住所だけまだ');
  assert.deepEqual(C.askGuest(sakura, t), ['address'], 'お客さんに健康を聞かない');
  assert.equal(X.partnerShares(r.state, 't1', PARTNER), false);
  assert.ok(!r.state.log.some(e => e.demo === true), '健康を入れていないので、見本の印も無い');
});

test('他のお店のお客さん: ガイドが要る。乗り合いに入っていないお店は入れない', () => {
  assert.equal(X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [ICHIRO], guide: ' ', share: true, today: TODAY, at: AT, newId }).problem, 'guide');
  assert.equal(X.addPartnerPeople(withPartner, { tripId: 't1', shop: '知らない店', people: [ICHIRO], guide: 'x', share: true, today: TODAY, at: AT, newId }).problem, 'shop');
  const one = X.addPartnerPeople(withPartner, { tripId: 't1', shop: PARTNER, people: [{ name: 'Lena Fischer' }], guide: '見本 三郎', share: true, today: TODAY, at: AT, newId });
  const lena = one.state.people.find(p => p.id === one.ids[0]);
  assert.deepEqual([lena.name, lena.health.consentVer, lena.health.historyAt], ['Lena Fischer', X.PARTNER_CONSENT_VER, ''], '名前だけ。健康は後でお客さんに聞く');
  assert.ok(C.askGuest(lena, tripOf(one.state)).includes('history'));
});

test('健康の 2 欄を渡すのをやめると、入っていた答えと同意を消す。渡すにすると同意の版を付ける', () => {
  const st = addTwo(withPartner, true).state;
  const off = X.setPartnerShare(st, { tripId: 't1', shop: PARTNER, share: false, today: TODAY, at: AT });
  X.shopPeople(off, 't1', PARTNER).forEach(p => {
    assert.ok(p.health.answers.every(a => a === null));
    assert.deepEqual([p.health.today, p.health.consentVer, p.health.heldBy], ['', '', PARTNER]);
  });
  const on = X.setPartnerShare(off, { tripId: 't1', shop: PARTNER, share: true, today: TODAY, at: AT });
  X.shopPeople(on, 't1', PARTNER).forEach(p => assert.deepEqual([p.health.heldBy, p.health.consentVer], ['', X.PARTNER_CONSENT_VER]));
  assert.ok(S.validateState(on).ok);
});

test('ガイドを替えると、そのお店の全員に入る。空にはできない', () => {
  const st = addTwo(withPartner, true).state;
  const r = X.setPartnerGuide(st, { tripId: 't1', shop: PARTNER, guide: '見本 四郎', at: AT });
  assert.deepEqual(X.shopPeople(r.state, 't1', PARTNER).map(p => p.guide), ['見本 四郎', '見本 四郎']);
  assert.equal(X.partnerGuide(r.state, 't1', PARTNER), '見本 四郎');
  assert.equal(X.setPartnerGuide(st, { tripId: 't1', shop: PARTNER, guide: '', at: AT }).problem, 'guide');
});

test('今日の名簿と条例の名簿（P4）は、自分の店のお客さんだけ', () => {
  const st = addTwo(withPartner, true).state;
  const g = D.dayGroups(st, 't1', TODAY);
  assert.equal(g.count, 2);
  assert.equal(g.check.length + g.morning.length + g.ready.length, 2);
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT, { own: true }).rows.length, 2);
  assert.equal(C.rosterRows(st, 't1', HEALTH_SHORT).rows.length, 4);
  assert.equal(C.tripSummary(st, 't1').booked, 4, '便の人数は船の全員');
});

test('船に乗る人: この店が先、お店ごとにガイドが先。札の番号はまだ', () => {
  const st = addTwo(withPartner, true).state;
  const g = X.boatGroups(st, 't1');
  assert.deepEqual(g.groups.map(x => [x.name, x.own, x.owner]), [[OWN, true, true], [PARTNER, false, false]]);
  assert.deepEqual(g.groups[0].members.map(m => [m.kind, m.name]), [['guide', '見本 ガイド'], ['person', '見本 花子'], ['person', '見本 太郎']]);
  assert.deepEqual(g.groups[1].members.map(m => [m.name, m.label]), [['見本 三郎', 'ガイド'], ['見本 一郎', 'ファン'], ['見本 さくら', '体験']]);
  assert.deepEqual([g.aboard, g.tagged, g.untagged], [6, 0, 6]);
});

test('札の番号: お店の頭文字と番号。足した人は続きの番号で、前の番号は変えない', () => {
  const st = X.assignTags(addTwo(withPartner, true).state, { tripId: 't1', at: AT });
  const t = tripOf(st);
  assert.deepEqual(t.tags.map(x => x.no), ['B-1', 'B-2', 'B-3', 'C-1', 'C-2', 'C-3']);
  assert.deepEqual(t.tags[0], { guide: '見本 ガイド', shop: '', no: 'B-1' });
  assert.deepEqual(t.tags[3], { guide: '見本 三郎', shop: PARTNER, no: 'C-1' });
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.act, e.after], ['tags', { added: 6, tags: 6 }]);
  assert.equal(X.assignTags(st, { tripId: 't1', at: AT }), st, '全員に付いていれば何もしない');
  const more = X.addPartnerPeople(st, { tripId: 't1', shop: PARTNER, people: [{ name: 'Lena Fischer' }], guide: '見本 三郎', share: true, today: TODAY, at: AT, newId }).state;
  const again = X.assignTags(more, { tripId: 't1', at: AT });
  assert.deepEqual(tripOf(again).tags.map(x => x.no), ['B-1', 'B-2', 'B-3', 'C-1', 'C-2', 'C-3', 'C-4']);
  const g = X.boatGroups(again, 't1');
  assert.deepEqual(g.groups[1].members.map(m => m.tag), ['C-1', 'C-2', 'C-3', 'C-4']);
  assert.equal(g.untagged, 0);
  assert.ok(S.validateState(again).ok);
});

test('札の頭文字はお店ごとに重ならない（同じ字で始まるお店）', () => {
  const st = X.addPartner(base, { tripId: 't1', name: 'B ダイブ', at: AT }).state;
  const two = X.addPartnerPeople(st, { tripId: 't1', shop: 'B ダイブ', people: [{ name: 'x' }], guide: 'y', share: true, today: TODAY, at: AT, newId }).state;
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
  const tagged = X.assignTags(addTwo(withPartner, true).state, { tripId: 't1', at: AT });
  const once = X.recordLeave(tagged, { tripId: 't1', at: '2026-10-24T01:31:00.000Z' });
  const twice = X.recordLeave(once, { tripId: 't1', at: '2026-10-24T03:02:00.000Z' });
  assert.deepEqual(X.leaveChecks(tripOf(twice)).map(c => [c.at, c.tags, c.missing]),
    [['2026-10-24T01:31:00.000Z', 6, []], ['2026-10-24T03:02:00.000Z', 6, []]]);
  const e = twice.log[twice.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.after], ['aboard', 'trip', { stage: 'leave', tags: 6 }]);
  assert.ok(S.validateState(twice).ok);
});

test('合同名簿: お店ごとに、札の番号と条例の項目。ガイドは名簿に入れず、他店のお客さんのガイドはそのお店のガイド', () => {
  const st = X.assignTags(addTwo(withPartner, false).state, { tripId: 't1', at: AT });
  const j = X.jointRows(st, 't1', HEALTH_SHORT);
  assert.deepEqual([j.people, j.guides, j.owner], [4, 2, OWN]);
  assert.deepEqual(j.groups.map(g => g.rows.map(r => r.tag)), [['B-2', 'B-3'], ['C-2', 'C-3']]);
  const ichiro = j.groups[1].rows[0].cells;
  assert.deepEqual([ichiro.name, ichiro.guide, ichiro.history, ichiro.site], ['見本 一郎', '見本 三郎', `${PARTNER}が確かめた`, '北の根']);
  assert.equal(j.groups[0].rows[0].cells.guide, '見本 ガイド');
});

test('受け取った記録: 人数と、健康の欄を受け取ったかだけ', () => {
  const shared = X.handOver(addTwo(withPartner, true).state, { tripId: 't1', shop: PARTNER, at: AT });
  const e = shared.log[shared.log.length - 1];
  assert.deepEqual([e.act, e.kind, e.after], ['handover', 'booking', { people: 2, health: true }]);
  const held = X.handOver(addTwo(withPartner, false).state, { tripId: 't1', shop: PARTNER, at: AT });
  assert.equal(held.log[held.log.length - 1].after.health, false);
  assert.equal(X.handOver(withPartner, { tripId: 't1', shop: PARTNER, at: AT }), withPartner, 'まだ誰もいなければ何も残さない');
  assert.ok(S.validateState(shared).ok);
});

test('印刷の記録に、合同名簿か札ボードかを残す', () => {
  const st = C.logOutput(withPartner, { tripId: 't1', act: 'print', people: 4, health: false, paper: 'board', at: AT });
  assert.deepEqual(st.log[st.log.length - 1].after, { people: 4, health: false, paper: 'board' });
  const plain = C.logOutput(withPartner, { tripId: 't1', act: 'print', people: 4, paper: 'other', at: AT });
  assert.deepEqual(plain.log[plain.log.length - 1].after, { people: 4, health: true });
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
