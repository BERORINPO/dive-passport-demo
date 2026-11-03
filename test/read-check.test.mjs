// 読み取りの答えの見直し（決定ログ 2026-11-03 read-check）を確かめる。
// 守ること: AI が自信ありと答えても、ありえない値・食い違う値は「確かめる」（unsure）に回す。値は変えない。正しい答えには印を付けない。
// 実行: node test/read-check.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readingFrom, CHECK_MODEL } from '../worker/read-core.mjs';
import { askModel } from '../worker/ask.mjs';
import { fakeKv, fakeAnthropic } from '../worker/fakes.mjs';
import '../js/read-check.js';

const R = globalThis.REDUX;
const C = R.readCheck;
const TODAY = '2026-11-03';
/* AI の読み取り試験の申込書 f1 と同じ中身（正しい答え） */
const OK = {
  name: '見本 一美', birthDate: '1992-07-03', phone: '090-0000-1101', address: '沖縄県那覇市見本町1-2-3',
  emergency: { name: '見本 一郎', relation: '父', phone: '090-0000-1102' }, cert: { course: 'OW', date: '2020-08-10' },
  dives: 15, lastDive: '2025-09', sizes: { height: 158, weight: 50, foot: 23.5 }, unsure: []
};
const with_ = (patch) => ({ ...OK, ...patch });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('正しい答えには印を付けない（申込書・海外の番号・初めての人・年まで・年月まで）', () => {
  assert.deepEqual(C.problems(OK, TODAY), {});
  assert.deepEqual(C.problems(with_({ phone: '+82 10-0000-1702', birthDate: '1975-11-23' }), TODAY), {});
  assert.deepEqual(C.problems(with_({ cert: { course: 'NONE', date: '' }, dives: 0, lastDive: '' }), TODAY), {});
  assert.deepEqual(C.problems(with_({ cert: { course: 'AOW', date: '2015-07' }, lastDive: '2025', dives: 30 }), TODAY), {});
  assert.deepEqual(C.problems(with_({ phone: '', emergency: { name: '', relation: '', phone: '' }, birthDate: '', dives: '' }), TODAY), {});
});

test('電話の桁: 携帯は 11 桁、固定・0120 は 10 桁、海外は 8〜15 桁', () => {
  for (const ok of ['090-0000-1101', '06-0000-1111', '0980-00-1234', '0120-000-000', '0800-000-0000', '050-0000-0000', '+1 415 555 0100', '']) {
    assert.equal(C.phoneOk(ok), true, ok);
  }
  for (const bad of ['090-000-1101', '090-0000-11011', '06-0000-111', '0120-00-000', '+1 23', '12345']) {
    assert.equal(C.phoneOk(bad), false, bad);
  }
  assert.match(C.problems(with_({ phone: '090-000-1101' }), TODAY).phone, /桁/);
  assert.match(C.problems(with_({ emergency: { ...OK.emergency, phone: '090-0000-110' } }), TODAY).emergency, /桁/);
});

test('緊急時の連絡先が本人と同じ（名前か電話）なら確かめる', () => {
  assert.match(C.problems(with_({ emergency: { ...OK.emergency, phone: '09000001101' } }), TODAY).emergency, /本人の電話と同じ/);
  assert.match(C.problems(with_({ emergency: { ...OK.emergency, name: '見本一美' } }), TODAY).emergency, /本人の名前/);
});

test('日付: 今日より後・ありえない年齢・取得日が幼すぎる・最後に潜った日が取得より前', () => {
  assert.match(C.problems(with_({ birthDate: '2027-01-01' }), TODAY).birthDate, /今日より後/);
  assert.match(C.problems(with_({ birthDate: '1915-07-03' }), TODAY).birthDate, /111 歳/);
  assert.match(C.problems(with_({ birthDate: '2024-07-03' }), TODAY).birthDate, /2 歳/);
  assert.match(C.problems(with_({ cert: { course: 'OW', date: '2028-08-10' } }), TODAY).cert, /今日より後/);
  assert.match(C.problems(with_({ cert: { course: 'OW', date: '1995-08-10' } }), TODAY).cert, /8 年より前/);
  assert.match(C.problems(with_({ lastDive: '2026-12' }), TODAY).lastDive, /今日より後/);
  assert.match(C.problems(with_({ lastDive: '2019-09' }), TODAY).lastDive, /取得日より前/);
  assert.deepEqual(C.problems(with_({ lastDive: '2020-08' }), TODAY), {}, '同じ月は前と数えない（短い方にそろえる）');
});

test('C カードと本数の食い違い', () => {
  assert.match(C.problems(with_({ dives: 0 }), TODAY).dives, /C カードがあるのに/);
  assert.match(C.problems(with_({ cert: { course: 'NONE', date: '' }, dives: 0, lastDive: '2025-09' }), TODAY).dives, /最後に潜った日があるのに/);
  assert.match(C.problems(with_({ cert: { course: 'NONE', date: '2020-08-10' } }), TODAY).cert, /C カードなしなのに/);
});

test('flag: unsure に足すだけで値は変えない。重ねない。今日が無ければ何もしない', () => {
  const reading = { booking: null, healthSeen: false, people: [OK, with_({ phone: '090-000-1101', dives: 0, unsure: ['phone'] })] };
  const got = C.flag(reading, TODAY);
  assert.equal(got.people[0], OK, '問題の無い人はそのまま');
  assert.deepEqual(got.people[1].unsure, ['phone', 'dives']);
  assert.equal(got.people[1].phone, '090-000-1101');
  assert.ok(R.roster.validateReading(got).ok, '印を足しても読み取りの形のまま');
  assert.equal(C.flag(reading, ''), reading);
  assert.equal(C.flag(reading, undefined), reading);
});

test('Worker: AI の答えを受け取る所（readingFrom）で、今日を渡すと印が付く', () => {
  const answer = JSON.stringify({ participants: [{ name: '見本 健二', birth_date: '1975-11-23', phone: '090-000-1111', dive_count: 0, cert_course: 'AOW', unsure: [] }], health_info_visible: false });
  const flagged = readingFrom(answer, 'form', TODAY);
  assert.ok(flagged.ok);
  assert.deepEqual(flagged.reading.people[0].unsure, ['phone', 'dives']);
  assert.deepEqual(readingFrom(answer, 'form').reading.people[0].unsure, [], '今日を渡さなければ今まで通り');
});

/* ---------- 2 つの AI の突き合わせ（決定ログ 2026-11-03 second-reader） ---------- */
const reading = (people, extra = {}) => ({ booking: null, healthSeen: false, people, ...extra });

test('突き合わせ: 割れた項目だけ確かめる。書き方の違いは割れたと数えない。値は 1 つ目のまま', () => {
  const second = with_({ phone: '09000001101', address: '沖縄県那覇市見本町１－２－３', emergency: { ...OK.emergency, phone: '090-0000-1103' }, dives: 16 });
  const got = C.crossCheck(reading([OK]), reading([second]));
  assert.deepEqual(got.people[0].unsure, ['emergency', 'dives']);
  assert.equal(got.people[0].dives, 15);
  assert.deepEqual(C.crossCheck(reading([OK]), reading([OK])).people[0].unsure, [], '同じ答えなら印を足さない');
});

test('突き合わせ: 人は名前で組にする。名前が割れても 1 人どうしなら組にして名前を確かめる。組にならない人は値のある項目を全部確かめる', () => {
  const other = with_({ name: '見本 二郎' });
  const one = C.crossCheck(reading([OK]), reading([with_({ name: '見本 一実' })]));
  assert.deepEqual(one.people[0].unsure, ['name']);
  const two = C.crossCheck(reading([OK, other]), reading([OK]));
  assert.deepEqual(two.people[0].unsure, []);
  assert.deepEqual(two.people[1].unsure, ['name', 'birthDate', 'phone', 'address', 'emergency', 'cert', 'dives', 'lastDive', 'sizes']);
});

test('突き合わせ: 確かめ役の答えが無ければ値のある項目を全部確かめる。予約の項目も割れたら確かめる', () => {
  const blankish = with_({ address: '', sizes: { height: '', weight: '', foot: '' } });
  assert.deepEqual(C.crossCheck(reading([blankish]), null).people[0].unsure, ['name', 'birthDate', 'phone', 'emergency', 'cert', 'dives', 'lastDive']);
  const b = { site: '見本', ref: 'A1', date: '2026-11-20', start: '09:00', tour: '体験', people: 2, leadName: '見本 太郎', leadPhone: '090-0000-1101', leadEmail: '', unsure: [] };
  const got = C.crossCheck(reading([], { booking: b }), reading([], { booking: { ...b, date: '2026-11-21', leadPhone: '09000001101' } }));
  assert.deepEqual(got.booking.unsure, ['date']);
  assert.deepEqual(C.crossCheck(reading([], { booking: b }), reading([], { booking: null })).booking.unsure, ['site', 'ref', 'date', 'start', 'tour', 'people', 'leadName', 'leadPhone']);
  assert.ok(R.roster.validateReading(got).ok);
});

/* Worker の askModel を、見本の Claude API と KV でつなぐ */
const NOW = Date.parse('2026-11-03T01:00:00Z');
function ask(api) {
  const env = { BUDGET: fakeKv(), DAILY_LIMIT: '200', MONTHLY_USD: '5', ANTHROPIC_API_KEY: 'sk-test-not-real' };
  const io = { fetch: async (url, init) => api.respond(init), now: () => NOW };
  const note = {};
  const req = { doc: 'form', prompt: 'p', image: 'aGVsbG8=', mediaType: 'image/jpeg', size: 8, redacted: 0 };
  return { run: (opts) => askModel(req, env, io, note, 'default', opts), note, env };
}
const ANSWER = (o = {}) => JSON.stringify({ participants: [{ name: '見本 一美', birth_date: '1992-07-03', phone: '090-0000-1101', cert_course: 'OW', dive_count: 15, unsure: [], ...o }], health_info_visible: false });

test('Worker: 書類の読み取りは 2 つの AI を呼び、割れた項目を確かめる。名簿の値は 1 つ目の AI の答え', async () => {
  const api = fakeAnthropic();
  api.answer = ANSWER();
  api.checkAnswer = ANSWER({ phone: '090-0000-7101' });
  const a = ask(api);
  const got = await a.run();
  assert.ok(got.ok);
  assert.equal(api.calls.length, 1);
  assert.equal(api.checks.length, 1);
  assert.equal(api.checks[0].body.model, CHECK_MODEL);
  assert.deepEqual(got.reading.people[0].unsure, ['phone']);
  assert.equal(got.reading.people[0].phone, '090-0000-1101');
  assert.equal(a.note.check, 'ok');
});

test('Worker: 確かめ役が失敗・答えの形が合わない → 読み取りは返し、値のある項目を全部確かめる', async () => {
  for (const [patch, why] of [[{ checkStatus: 529 }, 'upstream-http-529'], [{ checkAnswer: 'わかりません' }, 'answer-no-json']]) {
    const api = Object.assign(fakeAnthropic(), { answer: ANSWER() }, patch);
    const a = ask(api);
    const got = await a.run();
    assert.ok(got.ok, why);
    assert.deepEqual(got.reading.people[0].unsure, ['name', 'birthDate', 'phone', 'cert', 'dives'], why);
    assert.equal(a.note.check, why);
  }
});

test('Worker: 確かめ役だけが健康の情報が見えたと言えば、見えた側に倒す（1 つ目の答えが壊れていても）', async () => {
  const seen = JSON.stringify({ participants: [], health_info_visible: true });
  const api = Object.assign(fakeAnthropic(), { answer: ANSWER(), checkAnswer: seen });
  assert.equal((await ask(api).run()).reading.healthSeen, true);
  const broken = Object.assign(fakeAnthropic(), { answer: 'わかりません', checkAnswer: seen });
  const got = await ask(broken).run();
  assert.deepEqual([got.ok, got.healthSeen], [false, true]);
});

test('Worker: お客さま画面の AI（答えの読み方を替える呼び出し）は確かめ役を呼ばない', async () => {
  const api = Object.assign(fakeAnthropic(), { answer: '{"x": 1}' });
  const got = await ask(api).run({ parse: (t) => ({ ok: true, reading: JSON.parse(t) }) });
  assert.ok(got.ok);
  assert.deepEqual([api.calls.length, api.checks.length], [1, 0]);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
