// 予約の流れを通しで確かめる: 見本の予約メール 4 通 → 送る文面の確認 → 見本の読み取り → 便 → 予約と人 → 保存 → 読み直し。
// 画面と同じ順に、ブラウザの道具（保存場所・タイマー）だけを差し替えて動かす。
// 実行: node test/booking-flow.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPTS = ['core.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'data-samples.js', 'ai-reader.js'];
const memory = (init) => {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), keys: () => [...m.keys()], raw: m };
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
  assert.equal(first.recovered(), true, '1 回目は退避したと知らせる');
  boot(local).rosterStore.get();
  boot(local).rosterStore.get();
  assert.equal(local.keys().filter(k => k.startsWith('redux-roster-v1-broken-')).length, 1);
  const again = boot(local).rosterStore;
  again.get();
  assert.equal(again.recovered(), false, '2 回目からは、読めた名簿として開く');
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
