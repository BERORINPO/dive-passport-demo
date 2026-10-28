// 未確認の印（決定ログ 2026-10-28 unconfirmed-marks）を確かめる。
// AI（メール・申込書・C カード）が読んだまま、お店もお客さんも確かめていない項目を、
//   1. core が数える（js/roster-core.js の unconfirmed・js/roster-day.js の dayGroups）
//   2. 今日の名簿の上の数と、名簿の紙の「▲未確認」・凡例に出す（js/day-roster.js。作り物の DOM で描く。印刷は止めない）
//   3. お客さんのリンクで「この内容で合っていますか」に答えると、した人（guest）・時刻を残して数が減る（js/roster-guest.js の confirmGuest と Worker の action: confirm）
//      健康・名前の書き換え・他の予約の人は受けない
// 実行: node test/unconfirmed.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../js/data-sipe.js';
import '../js/roster-schema.js';
import '../js/pass-schema.js';
import '../js/roster-core.js';
import '../js/roster-guest.js';
import '../js/roster-day.js';
import '../js/data-samples.js';
import { checkAsk, checkApply } from '../worker/ask-input.mjs';
import { setup, siteBooking, staffCall, guestCall, stored, putState, AT, runTests } from './kit.mjs';

const { roster: S, rosterCore: C, rosterGuest: G, rosterDay: D, SAMPLE_READINGS } = globalThis.REDUX;

const TRIP_DAY = '2026-11-03';
const NOW_DAY = '2026-10-27';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = (x) => JSON.parse(JSON.stringify(x));
let seq = 0;
const newId = () => `u${(seq += 1)}`;

/* ---------- core の見本: 1 つの便に、メールから読んだ 2 人（花子と太郎）と、電話で入れた 1 人（職員が打った名前だけ） ---------- */
const trip = { ...S.blankTrip(), id: 't1', date: TRIP_DAY, start: '08:30', kind: 'dive', tour: '体験ダイビング', createdAt: AT };
function seeded() {
  let st = { ...S.blankState('B マリン（見本）'), trips: [trip] };
  const reading = clone(SAMPLE_READINGS.e1);
  st = C.addBooking(st, { trip, booking: { source: 'mail', people: 2 }, reading, src: 'mail', at: AT, newId });
  st = C.addBooking(st, { trip, booking: { source: 'phone', people: 1, leadName: '電話 三郎' }, reading: null, src: 'staff', at: AT, newId });
  st = C.editPerson(st, { id: st.people[2].id, patch: { name: '電話 三郎', birthDate: '1980-02-03' }, who: 'staff', at: AT });
  return st;
}
const peopleOf = (st) => C.peopleOf(st, 't1');
const keysOf = (st, p) => C.unconfirmed(st, p, trip);

test('検出: AI が入れて誰も確かめていない値だけが未確認。職員が打った値・空の項目は数えない', () => {
  const st = seeded();
  const [hanako, taro, saburo] = peopleOf(st);
  assert.deepEqual(keysOf(st, hanako), ['name', 'certDate', 'courses', 'dives']);
  assert.deepEqual(keysOf(st, taro), ['name', 'certDate', 'courses', 'dives']);
  assert.deepEqual(keysOf(st, saburo), [], '職員が打った名前と生年月日は未確認ではない');
  assert.equal(saburo.src.name, 'staff');
});

test('検出: 自信なしの印が残っている項目は、出どころが AI でなくても未確認（片方だけ入れた C カード）', () => {
  let st = seeded();
  const id = peopleOf(st)[2].id;
  st = C.editPerson(st, { id, patch: { cert: { course: 'OW' } }, who: 'guest', src: 'guest', at: AT, markUnsure: ['cert'] });
  const p = st.people.find(x => x.id === id);
  assert.ok(p.unsure.includes('cert'));
  assert.notEqual(p.src.cert, 'mail');
  assert.deepEqual(keysOf(st, p).filter(k => ['certDate', 'courses'].includes(k)), ['courses'], '値の入っている講習だけ');
});

test('検出: お店が「確かめた」を押すと消え、その後に AI が別の項目を入れたときは、その項目だけが未確認になる', () => {
  let st = seeded();
  const p0 = peopleOf(st)[0];
  st = C.checkPerson(st, { id: p0.id, at: AT });
  assert.deepEqual(keysOf(st, st.people.find(x => x.id === p0.id)), []);
  const read = { ...clone(SAMPLE_READINGS.f1.people[0]), name: '', cert: { course: '', date: '' }, dives: '', unsure: [] };
  const out = C.applyReadingTo(st, { personId: p0.id, read, src: 'paper', at: AT });
  assert.ok(out.fields.includes('address') && out.fields.includes('birthDate'));
  const now = keysOf(out.state, out.state.people.find(x => x.id === p0.id));
  assert.ok(now.includes('address') && now.includes('birthDate'), '新しく入った項目が未確認');
  assert.deepEqual(now.filter(k => ['name', 'certDate', 'courses', 'dives'].includes(k)), [], '確かめた項目は、また未確認にならない');
});

test('検出: お店が直した項目は未確認ではない（confirmReview は直した項目と残りの両方を確かめ済みにする）', () => {
  const st = seeded();
  const p0 = peopleOf(st)[0];
  const fixed = C.confirmReview(st, { id: p0.id, patch: { dives: 12 }, at: AT });
  assert.deepEqual(keysOf(fixed, fixed.people.find(x => x.id === p0.id)), []);
});

test('数: dayGroups が全員の未確認の項目を足す。人は名簿の並びの順', () => {
  const st = seeded();
  const g = D.dayGroups(st, 't1', NOW_DAY);
  assert.equal(g.unconfirmedCount, 8);
  assert.deepEqual(g.unconfirmedPeople.map(x => x.person.name), ['見本 花子', '見本 太郎']);
  const after = D.dayGroups(C.checkPerson(st, { id: peopleOf(st)[0].id, at: AT }), 't1', NOW_DAY);
  assert.equal(after.unconfirmedCount, 4);
});

test('名簿の行: rosterRows の行が、紙に印を付ける項目（unconfirmed）を持つ。CSV の中身は変わらない', () => {
  const st = seeded();
  const table = C.rosterRows(st, 't1', [], { own: true });
  assert.deepEqual(table.rows.map(r => r.unconfirmed), [['name', 'certDate', 'courses', 'dives'], ['name', 'certDate', 'courses', 'dives'], []]);
  assert.ok(!C.toCsv({ items: table.items, rows: table.rows }).includes('未確認'));
});

/* ---------- お客さんが「合っている」/「直す」（core） ---------- */
const guestAt = '2026-10-27T02:00:00.000Z';

test('お客さんの確認: 見せるのは名簿に載る AI の項目だけ（健康は出さない）。名前は直せない印', () => {
  const st = seeded();
  const bookingId = peopleOf(st)[0].bookingId;
  const entry = G.guestView(st, bookingId).people[0];
  assert.deepEqual(entry.confirm.map(c => c.field), ['name', 'cert', 'dives']);
  assert.deepEqual(entry.confirm.map(c => c.canFix), [false, true, true]);
  assert.ok(entry.confirm.every(c => !['history', 'today', 'health'].includes(c.field)));
});

test('お客さんの確認: 「合っている」は した人 guest・時刻・項目を記録に残し、数を減らす。値は変えない', () => {
  const st = seeded();
  const p0 = peopleOf(st)[0];
  const out = G.confirmGuest(st, { id: p0.id, agree: ['cert', 'dives'], at: guestAt });
  assert.deepEqual(out.problems, []);
  const e = out.state.log[out.state.log.length - 1];
  assert.deepEqual([e.who, e.act, e.kind, e.id, e.at], ['guest', 'check', 'person', p0.id, guestAt]);
  assert.deepEqual(e.fields, ['cert', 'dives']);
  const after = out.state.people.find(x => x.id === p0.id);
  assert.deepEqual([after.cert, after.dives, after.name], [p0.cert, p0.dives, p0.name], '値は変わらない');
  assert.deepEqual(keysOf(out.state, after), ['name'], '合っていると答えなかった名前だけが残る');
  assert.equal(D.dayGroups(out.state, 't1', NOW_DAY).unconfirmedCount, 5, '店員の画面の数が減る（8 → 5）');
  assert.ok(S.validateState(out.state).ok, '名簿の検査を通る');
  assert.equal(G.confirmGuest(out.state, { id: p0.id, agree: ['cert'], at: guestAt }).problems[0], 'field', '確かめ済みの項目はもう受けない');
});

test('お客さんの確認: 自信なしの印がある項目は、「合っている」で印が外れる', () => {
  let st = seeded();
  const p0 = peopleOf(st)[0];
  st = { ...st, people: st.people.map(p => (p.id === p0.id ? { ...p, unsure: ['dives'] } : p)) };
  const out = G.confirmGuest(st, { id: p0.id, agree: ['dives'], at: guestAt });
  assert.deepEqual(out.state.people.find(x => x.id === p0.id).unsure, []);
});

test('お客さんの確認: 「直す」は editPerson（した人 guest・前と後が記録に残る）。出どころが guest になり未確認でなくなる。値が同じなら「合っている」として数える', () => {
  const st = seeded();
  const p0 = peopleOf(st)[0];
  const out = G.confirmGuest(st, { id: p0.id, fix: { dives: 30, cert: { course: 'AOW', date: '2020-05' } }, at: guestAt });
  assert.deepEqual(out.problems, []);
  const after = out.state.people.find(x => x.id === p0.id);
  assert.deepEqual([after.dives, after.cert.course, after.src.dives, after.src.cert], [30, 'AOW', 'guest', 'guest']);
  const edit = out.state.log.filter(e => e.act === 'edit' && e.who === 'guest').pop();
  assert.deepEqual([edit.fields, edit.before.dives, edit.after.dives], [['cert', 'dives'], p0.dives, 30]);
  assert.deepEqual(keysOf(out.state, after), ['name']);
  const same = G.confirmGuest(st, { id: p0.id, fix: { dives: p0.dives }, at: guestAt });
  assert.deepEqual(same.problems, []);
  assert.deepEqual(keysOf(same.state, same.state.people.find(x => x.id === p0.id)), ['name', 'certDate', 'courses'], '同じ値を送ったら、その項目だけ確かめ済み');
  assert.equal(same.state.log[same.state.log.length - 1].who, 'guest');
});

test('お客さんの確認: 名前は直せない。健康・見せていない項目・両方に入れた項目・空の答えは受けず、名簿は変わらない', () => {
  const st = seeded();
  const p0 = peopleOf(st)[0];
  const refuse = (args, why) => {
    const out = G.confirmGuest(st, { id: p0.id, at: guestAt, ...args });
    assert.deepEqual(out.problems, [why], JSON.stringify(args));
    assert.equal(out.state, st, '名簿は変わらない');
  };
  refuse({ fix: { name: '書き換え 名前' } }, 'name');
  refuse({ agree: ['history'] }, 'field');
  refuse({ agree: ['today'] }, 'field');
  refuse({ agree: ['health'] }, 'field');
  refuse({ fix: { health: { answers: ['no', 'no', 'no', 'no', 'no'] } } }, 'field');
  refuse({ agree: ['address'] }, 'field');
  refuse({ agree: ['dives'], fix: { dives: 3 } }, 'field');
  refuse({ agree: [] }, 'nothing');
  refuse({ fix: { __proto__: null, dives: -1 } }, 'dives');
  refuse({ fix: { cert: { course: 'ZZ', date: '2020-05' } } }, 'cert');
});

test('お客さんの確認: 職員が打った項目・お客さんが入れた項目は出さず、直せない（AI が入れた値だけ）', () => {
  const st = seeded();
  const saburo = peopleOf(st)[2];
  assert.deepEqual(G.guestView(st, saburo.bookingId).people[0].confirm, []);
  const out = G.confirmGuest(st, { id: saburo.id, fix: { birthDate: '1990-01-01' }, at: guestAt });
  assert.deepEqual(out.problems, ['field']);
});

test('ops: confirmGuest は直しの記録（op log）の表にある', () => {
  assert.ok(C.ops.names.includes('guest.confirmGuest'));
  const st = seeded();
  const p0 = peopleOf(st)[0];
  const out = C.ops.run(st, { op: 'guest.confirmGuest', args: { id: p0.id, agree: ['dives'] }, id: 'op1', at: guestAt });
  assert.deepEqual(out.problems, []);
  assert.equal(out.state.log[out.state.log.length - 1].who, 'guest');
});

/* ---------- 画面（作り物の DOM） ---------- */
class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
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

  querySelector(sel) { return all(this, sel)[0] || null; }

  async click() { for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() {} }); }
}
const kids = (n) => n.children.filter(c => typeof c !== 'string');
function all(root, sel) {
  const hit = [];
  const test1 = (n) => (sel.startsWith('.') ? String(n.className).split(/\s+/).includes(sel.slice(1)) : n.tagName === sel.toUpperCase());
  const walk = (n) => { kids(n).forEach(c => { if (test1(c)) hit.push(c); walk(c); }); };
  walk(root);
  return hit;
}
const buttons = (root, text) => all(root, 'button').filter(b => b.textContent.includes(text));
const SCRIPTS = ['core.js', 'data.js', 'data-sipe.js', 'qr.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-guest.js', 'roster-day.js', 'roster-share.js',
  'roster-auto.js', 'data-samples.js', 'data-big-sample.js', 'photo-mask.js', 'photo-prep.js', 'ai-reader.js', 'roster-sync.js', 'day-roster.js', 'guest-ask.js'];
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

function boot() {
  const nodes = {};
  const document = {
    body: new FNode('body'), documentElement: new FNode('html'), activeElement: null,
    createElement: (tag) => new FNode(tag),
    getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')),
    querySelector: () => null
  };
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://dive-passport-demo.example.workers.dev', pathname: '/', search: '', hash: '' },
    navigator: { language: 'ja' }, localStorage: memory(), sessionStorage: memory(), setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => 0,
    AbortController, TextEncoder, URL, btoa, console, CompressionStream, Blob, Response, listeners: {}, CSS: { escape: (s) => s }, history: { replaceState() {} } });
  ctx.addEventListener = (type, fn) => { ctx.listeners[type] = fn; };
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.rosterStore.synced = () => true;
  R.rosterStore.pending = () => 0;
  return { R, ctx, nodes };
}

/* 画面の部品に渡す ui の作り物。go は呼ばれた先を覚える */
function stubUi(calls) {
  const dock = (...k) => { const d = new FNode('div'); d.className = 'dock'; d.append(...k.filter(Boolean)); return d; };
  return { head: () => [new FNode('div'), new FNode('p'), new FNode('h2'), null], go: (...a) => calls.push(a), md: (d) => d, back: () => new FNode('p'),
    dock, tripLabel: () => '', save: () => ({ error: null, saved: true }), rerender() {} };
}

function dayWith(R) {
  const t = { ...R.roster.blankTrip(), id: 't1', date: '2026-10-28', start: '08:30', kind: 'dive', tour: '体験ダイビング', createdAt: AT };
  let st = { ...R.roster.blankState('B マリン（見本）'), trips: [t] };
  st = R.rosterCore.addBooking(st, { trip: t, booking: { source: 'mail', people: 2 }, reading: clone(SAMPLE_READINGS.e1), src: 'mail', at: AT, newId });
  R.rosterStore.apply('roster.replace', { state: st });
  return st;
}
const wrap = (nodes) => { const root = new FNode('div'); root.append(...nodes.flat(Infinity).filter(Boolean)); return root; };

test('今日の名簿の上: 「まだ確かめていない項目 N（タップで確かめる）」が出て、押すと確かめる画面へ。そろえば出ない', async () => {
  const { R } = boot();
  const st = dayWith(R);
  const calls = [];
  const root = wrap(R.dayRoster.renderDay({ tripId: 't1', ui: stubUi(calls) }));
  const band = buttons(root, 'まだ確かめていない項目');
  assert.equal(band.length, 1);
  assert.equal(band[0].textContent, 'まだ確かめていない項目 8（タップで確かめる）');
  await band[0].click();
  assert.deepEqual(clone(calls), [['review', { personId: st.people[0].id, tripId: 't1' }]]);
  assert.ok(buttons(root, '名簿を印刷').length === 1 && !buttons(root, '名簿を印刷')[0].disabled, '印刷は止めない');
  R.rosterStore.apply('core.confirmReview', { id: st.people[0].id, patch: {}, at: AT });
  R.rosterStore.apply('core.confirmReview', { id: st.people[1].id, patch: {}, at: AT });
  const clear = wrap(R.dayRoster.renderDay({ tripId: 't1', ui: stubUi([]) }));
  assert.equal(buttons(clear, 'まだ確かめていない項目').length, 0);
  assert.match(clear.textContent, /まだ確かめていない項目はありません/);
});

test('今日の名簿: 全部そろった人にも、AI が読んだまま確かめていない項目があれば「! 未確認 n」と確かめるボタンが出る（「✓ そろった」と書かない）', () => {
  const { R } = boot();
  const st = dayWith(R);
  const id = st.people[0].id;
  const input = { birthDate: '1990-04-01', address: '沖縄県那覇市見本町', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' }, lastDive: '2025-08',
    answers: ['no', 'no', 'no', 'no', 'no'], consent: true };
  R.rosterStore.apply('guest.applyGuest', { id, input, today: '2026-10-27', at: AT });
  R.rosterStore.apply('guest.answerToday', { id, answer: 'ok', day: '2026-10-28', consent: true, today: '2026-10-27', at: AT });
  const g = R.rosterDay.dayGroups(R.rosterStore.get(), 't1', '2026-10-28');
  assert.deepEqual(clone(g.ready.map(x => x.person.id)), [id], '健康までそろった人');
  const root = wrap(R.dayRoster.renderDay({ tripId: 't1', ui: stubUi([]) }));
  assert.match(root.textContent, /! 未確認 4/);
  assert.ok(!root.textContent.includes('✓ そろった'));
});

test('名簿の紙: 未確認のマスに「▲未確認」と破線の枠、紙の上に件数、紙の下に凡例。印刷のボタンは使える', () => {
  const { R } = boot();
  dayWith(R);
  const root = wrap(R.dayRoster.renderPrint({ tripId: 't1', ui: stubUi([]) }));
  const paper = all(root, '.paper')[0];
  assert.ok(paper);
  const marked = all(paper, '.paper__cell--unconf');
  assert.equal(marked.length, 8);
  assert.ok(marked.every(td => td.textContent.includes('▲未確認')), '色だけでなく字で示す');
  assert.equal(all(paper, '.paper__unconf').length, 8);
  assert.match(all(paper, '.paper__warn').map(p => p.textContent).join(' '), /確かめていない項目が 8 件/);
  const legend = all(paper, '.paper__legend')[0];
  assert.match(legend.textContent, /^▲未確認 = AI（予約メール・申込書・C カード）が読んだまま/);
  assert.equal(buttons(root, '印刷する').length, 1);
  assert.equal(buttons(root, 'まだ確かめていない項目').length, 1, '画面の上の数（紙の外。印刷には出ない）');
});

test('名簿の紙: 全部確かめ済みなら印は付かず、凡例は「なし」と言う', () => {
  const { R } = boot();
  const st = dayWith(R);
  R.rosterStore.apply('core.confirmReview', { id: st.people[0].id, patch: {}, at: AT });
  R.rosterStore.apply('core.confirmReview', { id: st.people[1].id, patch: {}, at: AT });
  const paper = all(wrap(R.dayRoster.renderPrint({ tripId: 't1', ui: stubUi([]) })), '.paper')[0];
  assert.equal(all(paper, '.paper__cell--unconf').length, 0);
  assert.equal(all(paper, '.paper__unconf').length, 0);
  assert.match(all(paper, '.paper__legend')[0].textContent, /: なし$/);
});

test('お客さんのリンクの画面: 「この内容で合っていますか」に未確認の値を出す。名前に「直す」は無い。押すと Worker に action: confirm を送り、直す欄を開いて送れる', async () => {
  const { R, nodes } = boot();
  const sent = [];
  const view = {
    shop: 'B マリン', kind: 'booking', isDay: false, trip: { date: TRIP_DAY, start: '08:30', tour: '体験', kind: 'dive', cancel: null },
    people: [{ person: { id: 'p1', name: '見本 花子' }, ask: [], needsToday: false, todayOpen: false, healthOpen: false, known: ['name'], consented: false,
      parts: { emergency: [], cert: [], course: '', date: '', hasDate: false },
      confirm: [{ field: 'name', value: '見本 花子', canFix: false }, { field: 'birthDate', value: '1990-04-01', canFix: true },
        { field: 'emergency', value: { name: '母', relation: '母', phone: '090-1' }, canFix: true }] }]
  };
  const source = { view: () => view, send: async () => ({ problems: [] }), today: async () => ({ problems: [] }), personLink: async () => ({ why: 'gone' }),
    confirm: async (id, agree, fix) => {
      sent.push([id, agree, fix]);
      view.people[0].confirm = view.people[0].confirm.filter(c => !agree.includes(c.field) && !(fix && Object.keys(fix).includes(c.field)));
      return { problems: [] };
    } };
  R.guestAsk.remote(source);
  const root = nodes.ask;
  assert.match(root.textContent, /この内容で合っていますか/);
  assert.match(root.textContent, /1990-04-01/);
  assert.match(root.textContent, /母 \(母\) 090-1/);
  assert.equal(buttons(root, '合っている').filter(b => b.textContent === '合っている').length, 3);
  assert.equal(buttons(root, '直す').length, 2, '名前には「直す」が無い');
  assert.ok(!/既往症|健康の質問/.test(all(root, '.confirm')[0].textContent), '健康は出さない');
  await buttons(root, '全部合っている')[0].click();
  assert.deepEqual(clone(sent.map(x => x.slice(0, 2))), [['p1', ['name', 'birthDate', 'emergency']]]);
  assert.equal(sent[0][2], undefined, '直した値は送らない');
  assert.equal(all(root, '.confirm').length, 0, '確かめたら一覧から消える');
});

test('お客さんのリンクの画面: 「直す」で入力欄を開き、直した値だけを fix で送る（合っている項目とは別）', async () => {
  const { R, nodes } = boot();
  const sent = [];
  const view = {
    shop: 'B マリン', kind: 'booking', isDay: false, trip: { date: TRIP_DAY, start: '08:30', tour: '体験', kind: 'dive', cancel: null },
    people: [{ person: { id: 'p1', name: '見本 花子' }, ask: [], needsToday: false, todayOpen: false, healthOpen: false, known: [], consented: false,
      parts: { emergency: [], cert: [], course: '', date: '', hasDate: false }, confirm: [{ field: 'dives', value: 12, canFix: true }] }]
  };
  R.guestAsk.remote({ view: () => view, send: async () => ({ problems: [] }), today: async () => ({ problems: [] }), personLink: async () => ({ why: 'gone' }),
    confirm: async (id, agree, fix) => { sent.push([id, agree, fix]); return { problems: ['dives'] }; } });
  const root = nodes.ask;
  await buttons(root, '直す')[0].click();
  const input = all(root, 'input')[0];
  assert.equal(input.attrs.value, '12');
  input.listeners.input[0]({ target: { value: '30' } });
  await buttons(root, '直した内容を送る')[0].click();
  assert.deepEqual(clone(sent), [['p1', [], { dives: 30 }]]);
  assert.match(root.textContent, /確かめてください/, 'Worker が断ったら、問題を出して入力欄は閉じない');
  assert.equal(buttons(root, '直した内容を送る').length, 1);
});

/* ---------- Worker（お客さんのリンク） ---------- */
async function linked() {
  const s = setup();
  assert.equal((await siteBooking(s)).status, 202);
  let st = stored(s);
  const [lead, mate] = st.people.filter(p => p.bookingId === st.bookings[0].id);
  const read = clone(SAMPLE_READINGS.f1.people[0]);
  st = C.applyReadingTo(st, { personId: lead.id, read, src: 'mail', at: AT }).state;
  st = C.applyReadingTo(st, { personId: mate.id, read: { ...read, name: '見本 一美' }, src: 'mail', at: AT }).state;
  putState(s, st, { version: s.db.rows.get('default').version + 1 });
  const made = await staffCall(s, 'POST', '/api/ask-link', { bookingId: st.bookings[0].id });
  assert.equal(made.status, 200);
  const url = (await made.json()).url;
  const key = url.split('#k=')[1];
  return { s, key, st, lead, mate, booking: st.bookings[0] };
}
const ask = async (x, body) => {
  const res = await guestCall(x.s, { k: x.key, ...body });
  return { status: res.status, body: await res.json() };
};
const tripOf = (st) => st.trips[0];
const countNow = (x) => D.dayGroups(stored(x.s), tripOf(stored(x.s)).id, NOW_DAY).unconfirmedCount;

test('Worker: 予約のリンクを開くと、その予約の人の未確認の値が見える（健康は無い）。1 人ずつの健康のリンクには出ない', async () => {
  const x = await linked();
  const v = await ask(x, { action: 'view' });
  assert.equal(v.status, 200);
  const lead = v.body.people.find(p => p.person.id === x.lead.id);
  const fields = lead.confirm.map(c => c.field);
  assert.ok(['birthDate', 'address', 'emergency', 'lastDive'].every(f => fields.includes(f)), fields.join());
  assert.ok(!fields.includes('name'), '名前はお客さんが打った（AI が読んでいない）');
  assert.ok(fields.every(f => ['name', 'birthDate', 'address', 'emergency', 'cert', 'dives', 'lastDive'].includes(f)));
  assert.equal(lead.confirm.find(c => c.field === 'birthDate').value, SAMPLE_READINGS.f1.people[0].birthDate);
  const mate = v.body.people.find(p => p.person.id === x.mate.id);
  assert.equal(mate.confirm.find(c => c.field === 'name').canFix, false);
  const own = await ask(x, { action: 'person-link', personId: x.lead.id });
  assert.equal(own.status, 200);
  const pk = own.body.url.split('#k=')[1];
  const pv = await (await guestCall(x.s, { k: pk, action: 'view' })).json();
  assert.deepEqual(pv.people.map(p => p.confirm), [[]], '健康のリンクには名簿の値を出さない');
  const denied = await (await guestCall(x.s, { k: pk, action: 'confirm', personId: x.lead.id, agree: ['dives'] })).json();
  assert.deepEqual(denied.problems, ['not-allowed']);
});

test('Worker: 「合っている」は した人 guest と時刻を名簿の記録に残し、店員の画面の数が減る', async () => {
  const x = await linked();
  const before = countNow(x);
  const r = await ask(x, { action: 'confirm', personId: x.lead.id, agree: ['birthDate', 'address'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.problems, []);
  assert.ok(!r.body.view.people.find(p => p.person.id === x.lead.id).confirm.some(c => ['birthDate', 'address'].includes(c.field)), '返す一覧から消える');
  const st = stored(x.s);
  const e = st.log[st.log.length - 1];
  assert.deepEqual([e.who, e.act, e.kind, e.id, e.fields], ['guest', 'check', 'person', x.lead.id, ['birthDate', 'address']]);
  assert.equal(e.at, AT);
  assert.equal(countNow(x), before - 2);
  assert.deepEqual(S.validateState(st).errors, [], 'Worker の名簿の検査を通る（形は変えていない）');
});

test('Worker: 直す。出どころが guest になり、前と後が記録に残る。形が違う直しは断り、名簿は変えない', async () => {
  const x = await linked();
  const bad = await ask(x, { action: 'confirm', personId: x.lead.id, agree: [], fix: { birthDate: '2026-13-45' } });
  assert.deepEqual(bad.body.problems, ['birthDate']);
  assert.equal(stored(x.s).log.length, x.st.log.length, '名簿は変わらない');
  const before = countNow(x);
  const r = await ask(x, { action: 'confirm', personId: x.lead.id, agree: ['address'], fix: { birthDate: '1991-05-06' } });
  assert.deepEqual(r.body.problems, []);
  const st = stored(x.s);
  const lead = st.people.find(p => p.id === x.lead.id);
  assert.deepEqual([lead.birthDate, lead.src.birthDate, lead.src.address], ['1991-05-06', 'guest', 'mail'], '直した項目は guest、合っている項目の出どころは AI のまま');
  const edit = st.log.filter(e => e.act === 'edit' && e.who === 'guest' && e.id === x.lead.id).pop();
  assert.deepEqual([edit.fields, edit.before.birthDate, edit.after.birthDate], [['birthDate'], SAMPLE_READINGS.f1.people[0].birthDate, '1991-05-06']);
  assert.equal(countNow(x), before - 2, '直した 1 項目と合っている 1 項目が数から減る');
});

test('Worker: 健康・名前の書き換え・他の予約の人・見せていない項目は受けない', async () => {
  const x = await linked();
  const logLen = x.st.log.length;
  for (const [body, why] of [
    [{ agree: ['history'] }, 'field'], [{ agree: ['today'] }, 'field'], [{ agree: [], fix: { health: { answers: ['no', 'no', 'no', 'no', 'no'] } } }, 'field'],
    [{ agree: [], fix: { name: '書き換え 名前' }, personId: x.mate.id }, 'name'],
    [{ agree: [], fix: { name: '書き換え 名前' } }, 'name']
  ]) {
    const r = await ask(x, { action: 'confirm', personId: x.lead.id, ...body });
    assert.deepEqual(r.body.problems, [why], JSON.stringify(body));
  }
  assert.equal(stored(x.s).log.length, logLen, '名簿は変わらない');
  /* 別の予約の人 */
  assert.equal((await siteBooking(x.s, { tour: 'dive', date: TRIP_DAY, people: 1, name: '別の 予約', email: 'other@mail.example', exp: 'first' }, { ip: '203.0.113.77' })).status, 202);
  const other = stored(x.s).people.find(p => p.bookingId !== x.booking.id);
  assert.ok(other);
  const r = await ask(x, { action: 'confirm', personId: other.id, agree: ['dives'] });
  assert.equal(r.status, 404);
  assert.equal(stored(x.s).log.some(e => e.who === 'guest' && e.act === 'check'), false);
});

test('Worker の入口: confirm の本文の形（agree は項目の名前の並び、fix は組）。知らない項目の名前・大きすぎる並びは断る', () => {
  const k = 'a'.repeat(43);
  const good = { k, action: 'confirm', personId: 'p1', agree: ['dives'] };
  assert.equal(checkAsk(good).ok, true);
  assert.equal(checkAsk({ ...good, fix: { dives: 3 } }).ok, true);
  for (const bad of [{ ...good, agree: undefined }, { ...good, agree: 'dives' }, { ...good, agree: [1] }, { ...good, agree: Array(11).fill('a') }, { ...good, fix: [] }, { ...good, fix: 'x' },
    { ...good, personId: undefined }, { ...good, extra: 1 }]) {
    assert.equal(checkAsk(bad).ok, false, JSON.stringify(bad));
  }
  assert.equal(checkApply({ action: 'confirm', personId: 'p1', agree: [] }).ok, true);
  assert.equal(checkApply({ action: 'send', personId: 'p1', input: {}, agree: [] }).ok, true, 'send にも agree の欄は許すが、中身は使わない');
});

runTests(tests);
