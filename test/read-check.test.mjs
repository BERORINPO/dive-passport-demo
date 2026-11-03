// 読み取りの答えの見直し（決定ログ 2026-11-03 read-check）を確かめる。
// 守ること: AI が自信ありと答えても、ありえない値・食い違う値は「確かめる」（unsure）に回す。値は変えない。正しい答えには印を付けない。
// 実行: node test/read-check.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readingFrom } from '../worker/read-core.mjs';
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

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
