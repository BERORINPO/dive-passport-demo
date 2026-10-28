// 乗り合い便の「確認待ち」（決定ログ shared-trip-reminders）を確かめる。
//   1. core が数える（js/roster-share.js の confirmations）: 中止でない便は「名簿を渡した」、中止の便は「中止を確かめた」。いつから待っているかも出す
//   2. 前日の夜（EVE_AT）を過ぎたら、船を出す店に知らせ（outbox の staff / notice）を 1 つ足す（js/roster-auto.js の runDue。Cron も同じ道）。
//      全部確認していれば足さない。お客さんにも相乗りのお店にも送らない。健康とお客さんの名前は入れない
//   3. 確認（渡した・中止を確かめた）は、いつ・どのお店かが記録に残る
//   4. 乗り合いの画面に「確認待ち（〇〇店）」と、いつから・誰が誰を待っているか・連絡してください、が出る（作り物の DOM）
// 実行: node test/shared-trip-reminders.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../js/data-sipe.js';
import '../js/roster-schema.js';
import '../js/pass-schema.js';
import '../js/roster-core.js';
import '../js/roster-guest.js';
import '../js/roster-day.js';
import '../js/roster-share.js';
import '../js/roster-auto.js';
import '../js/data-samples.js';
import { scheduled } from '../worker/auto.mjs';
import { setup, stored, putState, runTests } from './kit.mjs';

const { roster: S, rosterCore: C, rosterShare: X, rosterAuto: A, SAMPLE_READINGS } = globalThis.REDUX;

const OWN = 'B マリン（見本）';
const P1 = 'C ダイブ（見本）';
const P2 = 'D ショップ（見本）';
const TRIP_DAY = '2026-10-30';
const EVE_JST = '2026-10-29T20:00';
const ADDED1 = '2026-10-25T01:00:00.000Z';
const ADDED2 = '2026-10-26T02:00:00.000Z';
const HAND1 = '2026-10-27T03:00:00.000Z';
const CANCEL_AT = '2026-10-28T00:00:00.000Z';
const ACK1 = '2026-10-28T05:30:00.000Z';
const AT = '2026-10-29T11:00:00.000Z';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const newId = () => `s${(seq += 1)}`;

/* 10/30 の便。この店のお客さん 2 人（メールの見本）。相乗りのお店は C ダイブと D ショップ（足した日が違う）。
   C ダイブは名簿を 2 人分入れてあるが、まだ渡していない。健康の答えとお客さんの名前が知らせに出ないことを見るため、名前は目立つ物にする */
function seeded({ host = '' } = {}) {
  const trip = { ...S.blankTrip(), id: 't1', date: TRIP_DAY, start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', boat: 'サンプル丸', guides: ['見本 ガイド'], createdAt: ADDED1 };
  let st = { ...S.blankState(OWN), trips: [trip] };
  st = C.addBooking(st, { trip, booking: { source: 'mail', people: 2 }, reading: clone(SAMPLE_READINGS.e1), src: 'mail', at: ADDED1, newId });
  st = X.addPartner(st, { tripId: 't1', name: P1, at: ADDED1 }).state;
  st = X.addPartner(st, { tripId: 't1', name: P2, at: ADDED2 }).state;
  const people = [{ name: 'ヒミツ 太郎' }, { name: 'ヒミツ 花子' }];
  st = X.addPartnerPeople(st, { tripId: 't1', shop: P1, people, guide: '見本 三郎', at: ADDED1, newId }).state;
  return host ? X.setHost(st, { tripId: 't1', host, at: ADDED2 }).state : st;
}
const handOver = (st, shop, at) => X.handOver(st, { tripId: 't1', shop, today: '2026-10-28', at });
/* 2 店とも名簿を渡した便（D ショップにも 1 人入れてから渡す） */
const allHandedOver = () => {
  const withP2 = X.addPartnerPeople(seeded(), { tripId: 't1', shop: P2, people: [{ name: 'ヒミツ 次郎' }], guide: '見本 四郎', at: ADDED2, newId }).state;
  return handOver(handOver(withP2, P1, HAND1), P2, HAND1);
};
const run = (st, nowJst) => A.runDue(st, { nowJst, at: AT, newId, askBase: '' });
const partnerNotices = (st) => (st.outbox || []).filter(o => A.isPartnersNotice(o));
const waitingNames = (st) => X.confirmations(st, 't1').waiting.map(x => x.name);

test('状態: 中止でない便は「名簿を渡した」まで確認待ち。いつから待っているかは、そのお店を足した時刻', () => {
  let st = seeded();
  const c = X.confirmations(st, 't1');
  assert.deepEqual([c.scope, c.owner, c.own], ['join', OWN, true]);
  assert.deepEqual(clone(c.shops.map(x => [x.name, x.confirmed, x.since, x.at])), [[P1, false, ADDED1, ''], [P2, false, ADDED2, '']], '人を入れただけでは確認ではない');
  st = handOver(st, P1, HAND1);
  const after = X.confirmations(st, 't1');
  assert.deepEqual(clone(after.shops.map(x => [x.name, x.confirmed, x.at])), [[P1, true, HAND1], [P2, false, '']]);
  assert.deepEqual(after.waiting.map(x => x.name), [P2], '渡していない D ショップだけが待っている');
  assert.equal(X.confirmations(st, 'nothing'), null);
});

test('状態: 中止の便は「中止を確かめた」まで確認待ち。いつから待っているかは中止の時刻。確かめた時刻は記録から引く', () => {
  let st = handOver(seeded(), P1, HAND1);
  st = C.cancelTrip(st, { tripId: 't1', reason: 'wind', at: CANCEL_AT });
  let c = X.confirmations(st, 't1');
  assert.equal(c.scope, 'cancel');
  assert.deepEqual(clone(c.shops.map(x => [x.name, x.confirmed, x.since])), [[P1, false, CANCEL_AT], [P2, false, CANCEL_AT]], '前に名簿を渡していても、中止の知らせは別に確かめる');
  st = C.ackCancel(st, { tripId: 't1', shop: P2, at: ACK1 });
  c = X.confirmations(st, 't1');
  assert.deepEqual(clone(c.shops.map(x => [x.name, x.confirmed, x.at])), [[P1, false, ''], [P2, true, ACK1]]);
  assert.deepEqual(c.waiting.map(x => x.name), [P1]);
});

test('状態: 船を出す店が相乗りのお店のとき、この店は待つ側でない（own: false）。そのお店は待たれる側に入らない', () => {
  const st = seeded({ host: P1 });
  const c = X.confirmations(st, 't1');
  assert.equal(c.own, false);
  assert.deepEqual(c.shops.map(x => x.name), [P2], '船を出すお店自身は確認する側でない');
});

test('記録: 渡した・中止を確かめたは、どのお店が・いつを記録に残す', () => {
  let st = handOver(seeded(), P1, HAND1);
  const h = st.log[st.log.length - 1];
  const booking = st.bookings.find(b => b.id === h.id);
  assert.deepEqual([h.who, h.act, h.kind, h.at, booking.shop, h.after.people], ['staff', 'handover', 'booking', HAND1, P1, 2]);
  st = C.cancelTrip(st, { tripId: 't1', reason: 'wind', at: CANCEL_AT });
  st = C.ackCancel(st, { tripId: 't1', shop: P2, at: ACK1 });
  const a = st.log[st.log.length - 1];
  assert.deepEqual([a.who, a.act, a.kind, a.id, a.at, a.after.shop], ['staff', 'ack', 'trip', 't1', ACK1, P2]);
  const n = st.log.length;
  assert.equal(C.ackCancel(st, { tripId: 't1', shop: P2, at: AT }).log.length, n, '2 回押しても記録は増えない');
  assert.ok(S.validateState(st).ok);
});

test('知らせ: 前日の夜（20:00）より前は何も足さない。その時刻になったら、確認していないお店だけを挙げた知らせを 1 つ足す', () => {
  let st = handOver(seeded(), P1, HAND1);
  assert.equal(partnerNotices(run(st, '2026-10-29T19:59').state).length, 0);
  const r = run(st, EVE_JST);
  const [o] = partnerNotices(r.state);
  assert.equal(partnerNotices(r.state).length, 1);
  assert.deepEqual([o.kind, o.status, o.to, o.why, o.tripId, o.at], ['staff', 'notice', '', 'partners:join', 't1', AT]);
  assert.deepEqual(r.queued, [], '送る連絡ではない');
  assert.ok(o.body.includes(`${P2}に連絡してください`));
  assert.ok(!o.body.includes(P1), '名簿を渡したお店は挙げない');
  assert.ok(o.subject.includes('確認待ち 1 店') && o.subject.includes('10/30'));
  assert.ok(S.validateState(r.state).ok, '名簿の形の検査を通る');
  st = r.state;
  assert.equal(partnerNotices(run(st, '2026-10-29T21:00').state).length, 1, '動かし直しても 2 つ目は足さない');
  assert.equal(run(st, '2026-10-29T21:00').state, st, '足す物が無ければ同じ state');
});

test('知らせ: 全部のお店が確認していれば足さない（中止でない便・中止の便とも）', () => {
  const st = allHandedOver();
  assert.deepEqual(waitingNames(st), []);
  assert.equal(partnerNotices(run(st, EVE_JST).state).length, 0);
  const cancelled = C.ackCancel(C.ackCancel(C.cancelTrip(seeded(), { tripId: 't1', reason: 'storm', at: CANCEL_AT }), { tripId: 't1', shop: P1, at: ACK1 }),
    { tripId: 't1', shop: P2, at: ACK1 });
  assert.equal(partnerNotices(run(cancelled, EVE_JST).state).length, 0);
});

test('知らせ: 相乗りのお店のいない便・予約の無い便・船を出す店が相乗りのお店の便・日にちの無い便には足さない。前日までで、当日は足さない', () => {
  const lone = { ...S.blankState(OWN), trips: [{ ...S.blankTrip(), id: 't1', date: TRIP_DAY, createdAt: ADDED1 }] };
  assert.equal(partnerNotices(run(lone, EVE_JST).state).length, 0);
  const noBooking = X.addPartner(lone, { tripId: 't1', name: P1, at: ADDED1 }).state;
  assert.equal(run(noBooking, EVE_JST).state, noBooking, '知らせを付ける予約が無い便は何もしない（画面には出る）');
  assert.equal(partnerNotices(run(seeded({ host: P1 }), EVE_JST).state).length, 0, '船を出すのは相乗りのお店。この店は待たない');
  assert.equal(partnerNotices(run(seeded(), `${TRIP_DAY}T07:00`).state).length, 0, '当日は eve の予定と同じく足さない');
  const undated = { ...seeded(), trips: [{ ...seeded().trips[0], date: '' }] };
  assert.equal(partnerNotices(run(undated, EVE_JST).state).length, 0);
});

test('知らせ: 中止の便は、中止の知らせを確かめていないお店を同じ時刻に知らせる。当日も足す。確かめたお店は挙げない', () => {
  let st = C.cancelTrip(handOver(seeded(), P1, HAND1), { tripId: 't1', reason: 'wind', at: CANCEL_AT });
  st = C.ackCancel(st, { tripId: 't1', shop: P1, at: ACK1 });
  assert.equal(partnerNotices(run(st, '2026-10-29T19:59').state).length, 0);
  const r = run(st, EVE_JST);
  const [o] = partnerNotices(r.state);
  assert.deepEqual([o.status, o.to, o.why], ['notice', '', 'partners:cancel:2026-10-28T00:00']);
  assert.ok(o.body.includes(`${P2}に連絡してください`) && !o.body.includes(P1));
  assert.ok(o.body.includes('中止の知らせをまだ確かめていない'));
  assert.equal(partnerNotices(run(r.state, '2026-10-29T22:00').state).length, 1, '二度は足さない');
  assert.equal(partnerNotices(run(st, `${TRIP_DAY}T07:00`).state).length, 1, '中止は当日の朝まで気付いていなければ足す');
  assert.equal(partnerNotices(run(st, '2026-10-31T07:00').state).length, 0, '便の日を過ぎたら足さない');
  const ack2 = C.ackCancel(r.state, { tripId: 't1', shop: P2, at: AT });
  assert.deepEqual(waitingNames(ack2), [], '知らせた後に確かめられたら、画面の確認待ちは消える');
  const again = C.cancelTrip(C.reopenTrip(r.state, { tripId: 't1', at: AT }), { tripId: 't1', reason: 'boat', at: '2026-10-29T12:00:00.000Z' });
  assert.equal(partnerNotices(run(again, '2026-10-29T21:30').state).length, 2, '取り消して中止し直したら、確認はやり直しなので、新しい知らせを足す');
});

test('知らせ: 宛先を持たず、お客さんの名前・健康・相乗りのお店への文は入れない', () => {
  const r = run(seeded(), EVE_JST);
  const [o] = partnerNotices(r.state);
  assert.equal(o.to, '');
  assert.deepEqual(o.people, []);
  const text = `${o.subject}\n${o.body}`;
  ['ヒミツ', '見本 花子', '既往', '体調', '健康', 'hanako', '@'].forEach(w => assert.ok(!text.includes(w), `知らせに「${w}」を入れない`));
  assert.ok(text.includes(P1) && text.includes(P2) && text.includes('10/30'));
});

test('Cron: 前日の夜を過ぎると、船を出す店への知らせが名簿に付く。メールは 1 通も送らない。確認していれば付かない', async () => {
  const s = setup();
  putState(s, seeded());
  s.io.clock = Date.parse('2026-10-29T10:59:00Z');   // 日本で 19:59
  await scheduled(s.env, s.io);
  assert.equal(partnerNotices(stored(s)).length, 0);
  s.io.clock = Date.parse('2026-10-29T11:00:00Z');   // 日本で 20:00
  await scheduled(s.env, s.io);
  const [o] = partnerNotices(stored(s));
  assert.deepEqual([o.kind, o.status, o.to, o.why], ['staff', 'notice', '', 'partners:join']);
  assert.ok(o.body.includes(`${P1}に連絡してください`) && o.body.includes(`${P2}に連絡してください`));
  await scheduled(s.env, s.io);
  assert.equal(partnerNotices(stored(s)).length, 1, 'Cron が重なっても 1 つ');
  assert.equal(s.mail.sent.length, 0, '相乗りのお店にも、お客さんにも送らない（宛先を持たない）');
  const done = setup();
  putState(done, allHandedOver());
  done.io.clock = Date.parse('2026-10-29T11:00:00Z');
  await scheduled(done.env, done.io);
  assert.equal(partnerNotices(stored(done)).length, 0, '2 店とも渡していれば知らせない');
});

test('Cron: 中止の便で、中止の知らせを確かめていないお店だけが知らせに挙がる', async () => {
  const s = setup();
  const cancelled = C.ackCancel(C.cancelTrip(seeded(), { tripId: 't1', reason: 'wind', at: CANCEL_AT }), { tripId: 't1', shop: P1, at: ACK1 });
  putState(s, cancelled);
  s.io.clock = Date.parse('2026-10-29T11:00:00Z');
  await scheduled(s.env, s.io);
  const [o] = partnerNotices(stored(s));
  assert.equal(o.why, 'partners:cancel:2026-10-28T00:00');
  assert.ok(o.body.includes(`${P2}に連絡してください`) && !o.body.includes(P1));
  assert.equal(s.mail.sent.length, 0);
});

/* ---------- 画面（作り物の DOM） ---------- */
class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.dataset = {};
    this.own = '';
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  append(...kids) { this.children.push(...kids); }

  replaceChildren(...kids) { this.children = kids; }

  set textContent(v) { this.children = []; this.own = String(v); }

  get textContent() { return this.own + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }

  closest() { return null; }
}
const SCRIPTS = ['core.js', 'data.js', 'data-sipe.js', 'qr.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-guest.js', 'roster-day.js', 'roster-share.js',
  'roster-auto.js', 'data-samples.js', 'data-big-sample.js', 'photo-mask.js', 'photo-prep.js', 'ai-reader.js', 'roster-sync.js', 'day-roster.js', 'share-roster.js', 'partner-photo.js', 'auto-flow.js'];
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

function boot(state) {
  const nodes = {};
  const document = { body: new FNode('body'), documentElement: new FNode('html'), activeElement: null, createElement: (tag) => new FNode(tag),
    getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')), querySelector: () => null };
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://dive-passport-demo.example.workers.dev', pathname: '/', search: '', hash: '' },
    navigator: { language: 'ja' }, localStorage: memory(), sessionStorage: memory(), setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => 0,
    AbortController, TextEncoder, URL, btoa, console, CompressionStream, Blob, Response, listeners: {}, CSS: { escape: (s) => s }, history: { replaceState() {} } });
  ctx.addEventListener = (type, fn) => { ctx.listeners[type] = fn; };
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.rosterStore.synced = () => true;
  R.rosterStore.pending = () => 0;
  R.rosterStore.apply('roster.replace', { state: clone(state) });
  return R;
}
const stubUi = () => ({ head: () => [new FNode('div'), new FNode('p'), new FNode('h2'), null], go() {}, md: (d) => d, back: () => new FNode('p'), tripLabel: () => '体験ダイビング',
  dock: (...k) => { const d = new FNode('div'); d.append(...k.filter(Boolean)); return d; }, save: () => ({ error: null, saved: true }), rerender() {} });
const wrap = (nodes) => { const root = new FNode('div'); root.append(...nodes.flat(Infinity).filter(Boolean)); return root; };
const textOf = (nodes) => wrap(nodes).textContent;

test('画面: 乗り合いの画面に、お店ごとに「確認待ち（〇〇店）」・いつから・誰が誰を待っているか・連絡してください、が出る', () => {
  const R = boot(handOver(seeded(), P1, HAND1));
  const text = textOf(R.shareRoster.renderShare({ tripId: 't1', ui: stubUi() }));
  assert.match(text, /! 確認待ち 1 店/);
  assert.ok(text.includes(`! 確認待ち（${P2}）`));
  assert.ok(!text.includes(`! 確認待ち（${P1}）`), '渡したお店は待たれていない');
  assert.ok(text.includes(`${OWN}が${P2}を待っています`) && text.includes(`${P2}に連絡してください`));
  assert.match(text, /\d+\/\d+ \d+:\d{2} から/, 'いつから待っているか');
  assert.match(text, /名簿を渡した/, '渡したお店には渡した時刻が出る');
  assert.ok(text.includes('前日の夜（20:00）になっても確認が無ければ、知らせが出ます'));
});

test('画面: 知らせが出たあとは、出した時刻を見せる。全部確認したら「確認待ち」は消えて ✓ が出る', () => {
  const noticed = run(seeded(), EVE_JST).state;
  const R = boot(noticed);
  const text = textOf(R.shareRoster.renderShare({ tripId: 't1', ui: stubUi() }));
  assert.match(text, /前日の夜の知らせは \d+\/\d+ \d+:\d{2} に出しました/);
  assert.ok(text.includes(`! 確認待ち（${P1}）`) && text.includes(`! 確認待ち（${P2}）`));
  const ok = textOf(boot(allHandedOver()).shareRoster.renderShare({ tripId: 't1', ui: stubUi() }));
  assert.match(ok, /✓ 2 店とも名簿を渡しました/);
  assert.ok(!ok.includes('確認待ち（'));
});

test('画面: 中止の便は、中止の知らせを確かめていないお店が「確認待ち」。今日の名簿の中止の帯にも「まだ」が出る', () => {
  const st = C.cancelTrip(seeded(), { tripId: 't1', reason: 'wind', at: CANCEL_AT });
  const R = boot(C.ackCancel(st, { tripId: 't1', shop: P1, at: ACK1 }));
  const text = textOf(R.shareRoster.renderShare({ tripId: 't1', ui: stubUi() }));
  assert.ok(text.includes(`! 確認待ち（${P2}）`) && text.includes(`${P2}に連絡してください`) && text.includes('中止の知らせ'));
  assert.ok(text.includes('✓ 中止を確かめた') && !text.includes(`! 確認待ち（${P1}）`));
  const day = textOf(R.dayRoster.renderDay({ tripId: 't1', ui: stubUi() }));
  assert.ok(day.includes('相乗りのお店 1/2 が確かめた') && day.includes(`まだ: ${P2}`));
});

test('画面: 知らせは予約の流れ・一覧の一行に「名簿の項目が届いていない」とは出ない（相乗りのお店の確認待ちの知らせは別の言い方）', () => {
  const noticed = run(seeded(), EVE_JST).state;
  const R = boot(noticed);
  const bookingId = partnerNotices(noticed)[0].bookingId;
  assert.equal(R.autoFlow.rowNote(R.rosterStore.get(), bookingId), null, '予約の一覧の一行に、名簿の項目が届かなかったとは出さない');
  assert.ok(A.isPartnersNotice(partnerNotices(noticed)[0]));
  const legacy = { ...partnerNotices(noticed)[0], why: '' };
  assert.equal(A.isPartnersNotice(legacy), false, '前からある知らせ（名簿の項目が届かない）は別物');
});

runTests(tests);
