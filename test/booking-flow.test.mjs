// 予約の流れを通しで確かめる: 見本の予約メール 4 通 → 送る文面の確認 → 見本の読み取り → 便 → 予約と人 → 保存 → 読み直し。
// 画面と同じ順に、ブラウザの道具（保存場所・タイマー）だけを差し替えて動かす。
// 実行: node test/booking-flow.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPTS = ['core.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-share.js', 'data-samples.js', 'photo-mask.js', 'photo-prep.js', 'ai-reader.js'];
const memory = (init) => {
  const m = new Map(Object.entries(init || {}));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, keys: () => [...m.keys()], raw: m
  };
};

/* index.html と同じ順で読む。同じ保存場所でもう一度読めば、開き直したのと同じ */
function boot(local) {
  const ctx = vm.createContext({ localStorage: local, sessionStorage: memory(), setTimeout, clearTimeout, TextEncoder, btoa, console, addEventListener: () => {} });
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  return ctx.REDUX;
}

const AT = '2026-10-21T09:00:00.000Z';

/* 予約の画面（booking.js の commitMail）と同じ順で、core の同じ関数を呼ぶ */
async function importMail(R, id) {
  const { text } = R.SAMPLE_MAILS[id];
  const req = { doc: 'mail', text, sampleId: id };
  const shown = R.aiReader.preview(req);
  const { reading, sent } = await R.aiReader.read(req);
  R.rosterStore.update(s => R.rosterCore.logAi(s, { at: AT, sent }));
  const b = reading.booking;
  const want = { date: b.date, start: b.start, tour: b.tour, kind: '' };
  const sug = R.rosterCore.suggestTrip(R.rosterStore.get(), want);
  const saved = R.rosterStore.update(s => R.rosterCore.addBookingToTrip(s, { tripId: sug.tripId, want: { ...want, kind: sug.kind },
    booking: R.rosterCore.bookingFromReading(reading), reading, src: 'mail', at: AT, newId: R.newId }).state);
  return { shown, saved };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('見本の予約メール 4 通で、予約と人が入り、送る文面はお店に見せた文面と同じ', async () => {
  const local = memory();
  const R = boot(local);
  assert.equal(R.aiReader.mode(), 'sample');
  for (const id of ['e1', 'e2', 'e3', 'e4']) {
    const { shown, saved } = await importMail(R, id);
    assert.equal(saved, true, id);
    assert.equal(shown.redacted, 0, id);
    assert.equal(shown.text, R.SAMPLE_MAILS[id].text.replace(/\r\n?/g, '\n'), id);
  }
  const s = R.rosterStore.get();
  assert.equal(s.trips.length, 1, '時刻の分からない予約も、その日の便が 1 つならそこへ');
  assert.equal(s.bookings.length, 4);
  assert.deepEqual({ ...R.rosterCore.tripSummary(s, s.trips[0].id) }, { booked: 8, listed: 8, done: 0 });
  assert.equal(s.log.filter(e => e.act === 'ai').length, 4, 'AI に送った記録は 4 件');
  assert.ok(s.log.filter(e => e.act === 'ai').every(e => e.sent.mode === 'sample' && !('text' in e.sent)));
});

test('開き直しても同じ名簿が読める', async () => {
  const local = memory();
  const R = boot(local);
  await importMail(R, 'e1');
  const again = boot(local).rosterStore.get();
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(R.rosterStore.get())));
});

test('保存された名簿が壊れていたら、消さずに別の場所へ退避して、空から始める', () => {
  const local = memory({ 'redux-roster-v1': '{"v":1,"trips":"broken"}' });
  const R = boot(local);
  assert.equal(R.rosterStore.get().trips.length, 0);
  const backup = local.keys().find(k => k.startsWith('redux-roster-v1-broken-'));
  assert.ok(backup);
  assert.equal(local.getItem(backup), '{"v":1,"trips":"broken"}');
});

test('壊れた名簿の退避は 1 回だけ。開き直しても増えない', () => {
  const local = memory({ 'redux-roster-v1': 'not json' });
  const first = boot(local).rosterStore;
  first.get();
  assert.equal(first.note(), 'recovered', '1 回目は退避したと知らせる');
  boot(local).rosterStore.get();
  boot(local).rosterStore.get();
  assert.equal(local.keys().filter(k => k.startsWith('redux-roster-v1-broken-')).length, 1);
  const again = boot(local).rosterStore;
  again.get();
  assert.equal(again.note(), null, '2 回目からは、読めた名簿として開く');
});

test('前の版で船に渡した他のお店のお客さんの健康の答えは、開いたときに名簿からも退避からも消える', () => {
  const local = memory();
  const R = boot(local);
  const C = R.rosterCore;
  const X = R.rosterShare;
  R.rosterStore.update(s => C.addTrip(s, { trip: { date: '2099-01-10', start: '08:30', kind: 'dive' }, at: AT, newId: R.newId }).state);
  const tripId = R.rosterStore.get().trips[0].id;
  R.rosterStore.update(s => X.addPartner(s, { tripId, name: 'C ダイブ（見本）', at: AT }).state);
  R.rosterStore.update(s => X.addPartnerPeople(s, { tripId, shop: 'C ダイブ（見本）', people: [{ name: '見本 一郎' }], guide: '見本 三郎', at: AT, newId: R.newId }).state);
  const id = R.rosterStore.get().people.find(p => p.name === '見本 一郎').id;
  /* 前の版の形: 他のお店が同意つきで渡した答え */
  const old = C.editPerson(R.rosterStore.get(), { id, who: 'staff', src: 'partner', at: AT, patch: { health: {
    answers: ['yes', 'no', 'no', 'no', 'no'], historyAt: '2026-10-21', today: 'unwell', todayAt: '2099-01-10', consentAt: '2026-10-21', consentVer: 'partner-2026-10-21', heldBy: '' } } });
  const backupKey = `redux-roster-v1-broken-${Date.now()}`;
  local.setItem('redux-roster-v1', JSON.stringify(old));
  local.setItem(backupKey, JSON.stringify({ ...old, v: 'broken' }));
  assert.ok(local.getItem('redux-roster-v1').includes('unwell') && local.getItem(backupKey).includes('unwell'), '前の版の答えが入っている');
  const again = boot(local).rosterStore.get();
  const p = again.people.find(x => x.id === id);
  assert.deepEqual([p.health.heldBy, p.health.todayAt, p.health.answers.every(a => a === null)], ['C ダイブ（見本）', '2099-01-10', true], '便の日の確かめは残す');
  for (const key of ['redux-roster-v1', backupKey]) {
    const text = local.getItem(key);
    assert.ok(!text.includes('"yes"') && !text.includes('unwell'), `${key} に答えの中身が残っていない`);
  }
  assert.equal(JSON.parse(local.getItem(backupKey)).v, 'broken', '退避のほかの中身はそのまま');
});

test('他のお店の健康を消す決まり（roster-share.js）を読まずに名簿を開こうとしたら止まる', () => {
  const ctx = vm.createContext({ localStorage: memory(), sessionStorage: memory(), setTimeout, clearTimeout, TextEncoder, btoa, console, addEventListener: () => {} });
  ctx.window = ctx;
  SCRIPTS.filter(f => f !== 'roster-share.js').forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  assert.throws(() => ctx.REDUX.rosterStore.get(), /roster-share\.js/);
});

test('保存期間を過ぎた便は、開いたときに保存場所からも消える', async () => {
  const local = memory();
  const R = boot(local);
  R.rosterStore.update(s => R.rosterCore.addTrip(s, { trip: { date: '2020-01-01', start: '08:30', kind: 'dive' }, at: AT, newId: R.newId }).state);
  assert.equal(JSON.parse(local.getItem('redux-roster-v1')).trips.length, 1);
  boot(local).rosterStore.get();
  assert.equal(JSON.parse(local.getItem('redux-roster-v1')).trips.length, 0);
});

test('端末に保存できないときは、保存できなかったと返す', () => {
  const local = memory();
  const R = boot(local);
  local.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(R.rosterStore.update(s => R.rosterCore.addTrip(s, { trip: { date: '2026-10-24', kind: 'dive' }, at: AT, newId: R.newId }).state), false);
  assert.equal(R.rosterStore.get().trips.length, 1, '開いている間は画面の中で動く');
});

test('読めない名簿を退避できないときは、元の名簿を消さず、この画面では保存しない', () => {
  const local = memory({ 'redux-roster-v1': 'not json' });
  const set = local.setItem;
  local.setItem = (k, v) => { if (k.startsWith('redux-roster-v1-broken-')) throw new Error('QuotaExceededError'); set(k, v); };
  const R = boot(local);
  R.rosterStore.get();
  assert.equal(R.rosterStore.note(), 'unreadable');
  assert.equal(R.rosterStore.update(s => R.rosterCore.addTrip(s, { trip: { date: '2026-10-24', kind: 'dive' }, at: AT, newId: R.newId }).state), false);
  assert.equal(local.getItem('redux-roster-v1'), 'not json', '元の名簿は残っている');
});

test('退避した名簿は、退避した日から 1 年で消える', () => {
  const old = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const recent = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const local = memory({ [`redux-roster-v1-broken-${old}`]: 'x', [`redux-roster-v1-broken-${recent}`]: 'y' });
  boot(local).rosterStore.get();
  assert.deepEqual(local.keys().filter(k => k.startsWith('redux-roster-v1-broken-')), [`redux-roster-v1-broken-${recent}`]);
});

test('写真の読み取りを名簿に入れ、確かめると自信なしが外れる（intake-photo.js と同じ順）', async () => {
  const R = boot(memory());
  await importMail(R, 'e1');
  /* canvas は Node に無いので、photo-prep.js が作った印だけを差し替える */
  const marks = new WeakSet();
  R.photoPrep = { isPrepared: (r) => marks.has(r) };
  const photo = (doc, sampleId) => { const r = { doc, image: 'QUJD', masked: doc === 'paper', sampleId }; marks.add(r); return r; };
  const C = R.rosterCore;
  const tripId = R.rosterStore.get().trips[0].id;

  const card = (await R.aiReader.read(photo('ccard', 'c1'))).reading.people[0];
  const hanako = C.findByName(C.peopleOf(R.rosterStore.get(), tripId), card.name);
  assert.ok(hanako, 'C カードの見本 花子は、予約の見本 花子に当たる');
  R.rosterStore.update(s => C.applyReadingTo(s, { personId: hanako.id, read: card, src: 'ccard', at: AT }).state);
  assert.equal(R.rosterStore.get().people.find(p => p.id === hanako.id).birthDate, '1998-04-12');

  const trip = R.rosterStore.get().trips[0];
  R.rosterStore.update(s => C.addBookingToTrip(s, { tripId, want: { date: trip.date, start: trip.start, tour: trip.tour, kind: trip.kind },
    booking: { source: 'phone', people: 1 }, reading: null, src: 'staff', at: AT, newId: R.newId }).state);
  const blank = C.peopleOf(R.rosterStore.get(), tripId).find(p => !p.name);
  const form = (await R.aiReader.read(photo('paper', 'f6'))).reading.people[0];
  assert.equal(C.findByName(C.peopleOf(R.rosterStore.get(), tripId), form.name), null, '見本 和子は予約にいないので、お店が選ぶ');
  R.rosterStore.update(s => C.applyReadingTo(s, { personId: blank.id, read: form, src: 'paper', at: AT }).state);
  const kazuko = R.rosterStore.get().people.find(p => p.id === blank.id);
  assert.deepEqual([kazuko.name, kazuko.src.name, [...kazuko.unsure]], ['見本 和子', 'paper', ['lastDive']]);
  assert.deepEqual([...C.toCheck(R.rosterStore.get(), tripId).map(p => p.id)], [blank.id]);
  const row = C.reviewRows(kazuko, trip).find(r => r.unsure);
  assert.deepEqual([row.key, row.text, row.src], ['lastDive', '2025', 'paper']);

  R.rosterStore.update(s => C.checkPerson(C.editPerson(s, { id: blank.id, patch: { lastDive: '2025-08' }, who: 'staff', at: AT }), { id: blank.id, at: AT }));
  assert.equal(C.toCheck(R.rosterStore.get(), tripId).length, 0);
});

test('形の合わない state は保存しない', () => {
  const R = boot(memory());
  assert.throws(() => R.rosterStore.update(s => ({ ...s, trips: 'x' })), /形が合わない/);
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
