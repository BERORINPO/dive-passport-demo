// 書類の自動化（js/roster-auto.js。plan/auto.md）を確かめる。予約を入れたら予定ができ、時刻が来たら送る連絡ができ、
// 足りない項目が無くなれば飛ばし、送り先が無ければ「送っていない」と残し、当日の朝に名簿の印を付ける。本文に健康の答えを入れない。
// 実行: node test/auto.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
['../js/roster-schema.js', '../js/roster-core.js', '../js/roster-guest.js', '../js/roster-share.js', '../js/data-samples.js', '../js/roster-auto.js'].forEach(load);
const { roster: S, rosterCore: C, rosterAuto: A, SAMPLE_READINGS } = globalThis.REDUX;

const AT = '2026-10-27T01:00:00.000Z';
const NOW = '2026-10-27T10:00';   // 日本の時刻
const ASK = 'https://example.test/#ask=';
const NO5 = ['no', 'no', 'no', 'no', 'no'];
let n = 0;
const newId = () => `id${(n += 1)}`;
const blank = () => S.blankState('B マリン（見本）');
/* 見本メール e1（2 人、10/31 にずらした予約。代表者のメールアドレスあり） */
const reading = (over = {}) => {
  const r = JSON.parse(JSON.stringify(SAMPLE_READINGS.e1));
  r.booking = { ...r.booking, date: '2026-10-31', ...over };
  return r;
};
const jobsOf = (st, kind) => st.jobs.filter(j => j.kind === kind);
/* 名簿の項目をお客さんが全部入れた形にする（当日の体調以外） */
function fillAll(st, bookingId) {
  return st.people.filter(p => p.bookingId === bookingId).reduce((s, p) => C.editPerson(s, { id: p.id, who: 'guest', src: 'guest', at: AT, patch: {
    birthDate: '1990-04-01', address: '沖縄県那覇市見本町 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
    cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '',
    health: { answers: NO5, historyAt: '2026-10-27', consentAt: '2026-10-27', consentVer: 'roster-2026-10-21' } } }), st);
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('予約メールから入れると、便を作り、お願い・2 日前・前日の夜・当日の朝の 4 つの予定ができる', () => {
  const { state, bookingId } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const b = state.bookings.find(x => x.id === bookingId);
  assert.equal(b.leadEmail, 'hanako@mail.example');
  assert.equal(state.trips.length, 1);
  assert.deepEqual(state.jobs.map(j => [j.kind, j.due]), [
    ['request', NOW], ['remind', '2026-10-29T09:00'], ['eve', '2026-10-30T20:00'], ['morning', '2026-10-31T06:00']]);
  assert.ok(S.validateState(state).ok);
});

test('便が近いと、過ぎた予定は作らない。当日なら朝の予定はすぐ動く', () => {
  const tomorrow = A.addFromReading(blank(), { reading: reading({ date: '2026-10-28' }), at: AT, nowJst: NOW, newId }).state;
  assert.deepEqual(tomorrow.jobs.map(j => j.kind), ['request', 'eve', 'morning'], '2 日前の朝は過ぎている');
  const today = A.addFromReading(blank(), { reading: reading({ date: '2026-10-27' }), at: AT, nowJst: NOW, newId }).state;
  assert.deepEqual(today.jobs.map(j => [j.kind, j.due]), [['request', NOW], ['morning', NOW]]);
});

test('時刻が来たら、足りない項目の人にお願いを作る。本文は名前とリンクだけで、健康の答えは入れない', () => {
  const { state, bookingId } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK });
  assert.equal(r.queued.length, 1);
  const o = r.state.outbox[0];
  assert.deepEqual([o.kind, o.to, o.status, o.lang], ['request', 'hanako@mail.example', 'queued', 'ja']);
  assert.ok(o.body.includes(`${ASK}${bookingId}`) && o.body.includes('見本 花子') && o.subject.includes('10/31（土）'));
  assert.ok(!/既往|はい|いいえ|yes|no,/.test(o.body), '健康の答えを入れない');
  assert.equal(jobsOf(r.state, 'request')[0].status, 'done');
  assert.equal(jobsOf(r.state, 'remind')[0].status, 'waiting', 'まだ時刻が来ていない予定は動かさない');
  assert.ok(S.validateState(r.state).ok);
  assert.deepEqual(A.runDue(r.state, { nowJst: NOW, at: AT, newId, askBase: ASK }).queued, [], '同じ予定を 2 回動かさない');
});

test('お客さんが全部入れたら、2 日前のもう一度と前日の夜の知らせは飛ばす', () => {
  const first = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const filled = fillAll(A.runDue(first.state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state, first.bookingId);
  const later = A.runDue(filled, { nowJst: '2026-10-30T21:00', at: AT, newId, askBase: ASK });
  assert.deepEqual([jobsOf(later.state, 'remind')[0].status, jobsOf(later.state, 'eve')[0].status], ['skipped', 'skipped']);
  assert.equal(later.state.outbox.length, 1, '最初のお願いだけ');
});

test('入れないまま前日の夜になると、2 日前にもう一度送り、前日の夜にお店へ知らせる', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: '2026-10-30T21:00', at: AT, newId, askBase: ASK });
  assert.deepEqual(r.state.outbox.map(o => [o.kind, o.status]), [['request', 'queued'], ['remind', 'queued'], ['staff', 'notice']]);
  assert.ok(r.state.outbox[1].subject.startsWith('【もう一度】'));
  assert.equal(r.state.outbox[2].to, '', 'お店への知らせはメールで送らない');
});

test('送り先が無い予約は「送っていない」と残す（電話の予約など）', () => {
  const { state } = A.addFromReading(blank(), { reading: reading({ leadEmail: '' }), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK });
  assert.deepEqual([r.queued.length, r.state.outbox[0].status, r.state.outbox[0].why], [0, 'unsent', 'no-email']);
});

test('当日の朝: 便に名簿の印を 1 回だけ付け、体調がまだの人に質問を作る', () => {
  const a = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const b = A.addFromReading(a.state, { reading: reading({ leadEmail: 'taro@mail.example' }), at: AT, nowJst: NOW, newId });
  assert.equal(b.state.trips.length, 1, '同じ便に入る');
  const r = A.runDue(b.state, { nowJst: '2026-10-31T06:00', at: '2026-10-30T21:00:00.000Z', newId, askBase: ASK });
  assert.equal(r.state.trips[0].rosterAt, '2026-10-30T21:00:00.000Z');
  const today = r.state.outbox.filter(o => o.kind === 'today');
  assert.deepEqual(today.map(o => o.to), ['hanako@mail.example', 'taro@mail.example']);
  assert.ok(today[0].subject.includes('本日'));
});

test('中止した便の予定は飛ばす', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const cancelled = C.cancelTrip(state, { tripId: state.trips[0].id, reason: 'wind', at: AT });
  const r = A.runDue(cancelled, { nowJst: '2026-10-31T07:00', at: AT, newId, askBase: ASK });
  assert.ok(r.state.jobs.every(j => j.status === 'skipped'));
  assert.equal((r.state.outbox || []).length, 0);
});

test('送った結果: sent・failed・unsent を付ける。送る前の物にだけ付く', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK });
  const id = r.queued[0];
  const sent = A.markSent(r.state, { id, result: 'sent', at: '2026-10-27T01:01:00.000Z' });
  assert.deepEqual([sent.outbox[0].status, sent.outbox[0].sentAt], ['sent', '2026-10-27T01:01:00.000Z']);
  assert.equal(A.markSent(sent, { id, result: 'failed', why: 'x', at: AT }).outbox[0].status, 'sent', '送った物は書き換えない');
  assert.deepEqual(A.markSent(r.state, { id, result: 'unsent', why: 'no-mail-config', at: AT }).outbox[0].why, 'no-mail-config');
  assert.throws(() => A.markSent(r.state, { id, result: 'ok', at: AT }));
});

test('自社の予約フォームから: メールアドレスと言葉を予約に持ち、英語なら英語で送る', () => {
  const tour = { id: 'dive', diving: true, start: '08:30', name: { ja: '体験ダイビング（ボート 2 本）' } };
  const intake = { tour: 'dive', date: '2026-11-03', people: 1, name: 'Sample Noah', lang: 'en', exp: 'first', dives: '', email: 'noah@mail.example' };
  const { state, bookingId } = A.addFromForm(blank(), { intake, tour, at: AT, nowJst: NOW, newId });
  const b = state.bookings.find(x => x.id === bookingId);
  assert.deepEqual([b.source, b.leadEmail, b.lang], ['form', 'noah@mail.example', 'en']);
  const o = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state.outbox[0];
  assert.ok(o.subject.includes('Please fill in') && o.body.startsWith('Dear Sample Noah'));
  const bad = A.addFromForm(blank(), { intake: { ...intake, email: 'not an email' }, tour, at: AT, nowJst: NOW, newId });
  assert.equal(bad.state.bookings[0].leadEmail, undefined, '形の合わないアドレスは持たない');
});

test('次の予定の時刻と、1 件の予約の流れ（起きたことが先、予定が後）', () => {
  const { state, bookingId } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  assert.equal(A.nextDue(r, NOW), '2026-10-29T09:00');
  assert.equal(A.nextDue(r, '2026-10-31T06:00'), '');
  assert.deepEqual(A.timeline(r, bookingId).map(x => x.kind), ['added', 'out', 'plan', 'plan', 'plan']);
});

test('保存期間を過ぎた便を消すと、その予定と送る連絡も消える', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  const kept = C.purgeExpired(r, { today: '2027-12-01', at: AT });
  assert.deepEqual([kept.trips.length, kept.jobs.length, kept.outbox.length], [0, 0, 0]);
  assert.ok(S.validateState(kept).ok);
});

test('形の検査: 予定と連絡の形が崩れていたら名簿として通さない。前の版の名簿（予定が無い）は通る', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  assert.ok(S.validateState(blank()).ok);
  assert.equal(S.validateState({ ...state, jobs: [{ ...state.jobs[0], due: '2026-10-27 10:00' }] }).ok, false);
  assert.equal(S.validateState({ ...state, jobs: [{ ...state.jobs[0], extra: 1 }] }).ok, false);
  assert.equal(S.validateState({ ...state, bookings: [{ ...state.bookings[0], leadEmail: 'x@' }] }).ok, false);
  assert.equal(S.validateState({ ...state, bookings: [{ ...state.bookings[0], lang: 'fr' }] }).ok, false);
});

test('日付を時計なしで数える（月・年・うるう年の境目）', () => {
  assert.deepEqual(['2026-11-01', '2027-01-01', '2028-03-01'].map(d => A.dayAdd(d, -1)), ['2026-10-31', '2026-12-31', '2028-02-29']);
  assert.equal(A.dayAdd('2026-12-30', 2), '2027-01-01');
});

test('名簿の掃除: 終わって 1 週間を過ぎた便だけ、済んだ予定を消し、送った連絡の本文を空にする。宛先と結果は残す', () => {
  const first = A.addFromReading(blank(), { reading: reading(), lang: 'ja', at: AT, nowJst: NOW, newId });
  const due = A.runDue(first.state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  const sent = A.markSent(due, { id: due.outbox[0].id, result: 'sent', why: '', at: AT });
  assert.equal(A.compactPast(sent, { today: '2026-11-07' }), sent, '便（10/31）から 7 日目までは何も変えない');
  const later = A.compactPast(sent, { today: '2026-11-08' });
  assert.ok(later.jobs.every(j => j.status === 'waiting'), '済んだ予定は消える。まだの予定は残す');
  assert.equal(later.jobs.length, sent.jobs.filter(j => j.status === 'waiting').length);
  assert.equal(later.outbox[0].body, '');
  assert.equal(later.outbox[0].to, sent.outbox[0].to);
  assert.equal(later.outbox[0].status, 'sent');
  assert.ok(S.validateState(later).ok);
  assert.equal(A.compactPast(later, { today: '2026-11-09' }), later, '2 回目は何も変えない');
  assert.ok(JSON.stringify(later).length < JSON.stringify(sent).length);
});

/* お願いを送ったが、送れたか分からない（Worker の releaseStale と同じ形）にした名簿 */
function maybeSent() {
  const first = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(first.state, { nowJst: NOW, at: AT, newId, askBase: ASK });
  const id = r.state.outbox[0].id;
  return { state: A.markSent(r.state, { id, result: 'failed', why: 'maybe-sent', at: AT }), id, bookingId: first.bookingId };
}

test('送り直す: 送れたか分からない連絡から、今の予約で新しい連絡を 1 つ作る。2 回押しても・2 台で押しても 1 つだけ', () => {
  const { state, id } = maybeSent();
  const once = A.resend(state, { id, nowJst: NOW, at: AT, newId, askBase: ASK });
  assert.equal(once.problem, '');
  assert.deepEqual(once.state.outbox.map(o => [o.status, o.why]), [['failed', A.RESENT], ['queued', '']]);
  assert.equal(once.state.outbox[1].id, once.id);
  assert.equal(once.state.outbox[1].to, 'hanako@mail.example');
  assert.ok(S.validateState(once.state).ok);
  const twice = A.resend(once.state, { id, nowJst: NOW, at: AT, newId, askBase: ASK });
  assert.equal(twice.problem, 'resent');
  assert.equal(twice.state, once.state, '2 回目は何も変えない（別の端末の書き込みに当て直しても同じ）');
  assert.equal(A.resend(once.state, { id: once.id, nowJst: NOW, at: AT, newId, askBase: ASK }).problem, 'not-failed', '送る準備の物は送り直せない');
});

test('送り直す: 宛先は今の予約から取り直す。メールアドレスが無い・済んだ便・中止の便・もうそろった予約は送り直さない', () => {
  const { state, id, bookingId } = maybeSent();
  const fixed = { ...state, bookings: state.bookings.map(b => (b.id === bookingId ? { ...b, leadEmail: 'hanako2@mail.example' } : b)) };
  assert.equal(A.resend(fixed, { id, nowJst: NOW, at: AT, newId, askBase: ASK }).state.outbox[1].to, 'hanako2@mail.example');
  const noMail = { ...state, bookings: state.bookings.map(b => (b.id === bookingId ? { ...b, leadEmail: '' } : b)) };
  assert.equal(A.resend(noMail, { id, nowJst: NOW, at: AT, newId, askBase: ASK }).problem, 'no-email');
  assert.equal(A.resend(state, { id, nowJst: '2026-11-01T09:00', at: AT, newId, askBase: ASK }).problem, 'past');
  const off = { ...state, trips: state.trips.map(t => ({ ...t, cancel: { why: 'wind', at: AT, by: 'B' } })) };
  assert.equal(A.resend(off, { id, nowJst: NOW, at: AT, newId, askBase: ASK }).problem, 'cancel');
  assert.equal(A.resend(fillAll(state, bookingId), { id, nowJst: NOW, at: AT, newId, askBase: ASK }).problem, 'done');
});

test('届いていた: 送れたか分からない連絡を sent（お店が確かめた）にし、もう送り直せない', () => {
  const { state, id } = maybeSent();
  const r = A.confirmSent(state, { id, at: '2026-10-27T02:00:00.000Z' });
  assert.equal(r.problem, '');
  assert.deepEqual([r.state.outbox[0].status, r.state.outbox[0].why, r.state.outbox[0].sentAt], ['sent', A.CONFIRMED, '2026-10-27T02:00:00.000Z']);
  assert.equal(A.confirmSent(r.state, { id, at: AT }).problem, 'not-maybe');
  assert.equal(A.resend(r.state, { id, nowJst: NOW, at: AT, newId, askBase: ASK }).problem, 'not-failed');
  assert.ok(S.validateState(r.state).ok);
});

test('お店全体の一覧: 送れたか分からない・送れなかった・送る準備・今日・これからに分け、時刻の順。済んだ便は出さない', () => {
  const { state, id } = maybeSent();
  const second = A.addFromReading(state, { reading: reading({ date: '2026-10-28', start: '13:00' }), at: AT, nowJst: NOW, newId });
  const r = A.runDue(second.state, { nowJst: NOW, at: AT, newId, askBase: ASK });
  const failedId = r.state.outbox[1].id;
  const st = A.markSent(r.state, { id: failedId, result: 'failed', why: 'E_DELIVERY_FAILED', at: AT });
  const b = A.board(st, { nowJst: NOW });
  assert.deepEqual(b.maybe.map(x => x.out.id), [id]);
  assert.deepEqual(b.failed.map(x => x.out.id), [failedId]);
  assert.equal(b.failed[0].booking.id, second.bookingId);
  assert.deepEqual(b.ready, []);
  assert.deepEqual(b.today.map(x => [x.job.kind, x.job.status]), [['request', 'done'], ['request', 'done'], ['eve', 'waiting']], '今日の済んだ予定も出す');
  const dues = b.later.map(x => x.job.due);
  assert.deepEqual(dues, [...dues].sort(), '時刻の順');
  assert.ok(b.later.every(x => x.job.status === 'waiting'));
  const resent = A.resend(st, { id, nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  const after = A.board(resent, { nowJst: NOW });
  assert.deepEqual([after.maybe.length, after.ready.length, after.ready[0].sending], [0, 1, false], '送り直すと、送る準備に移る');
  assert.equal(A.board(resent, { nowJst: '2026-11-02T09:00' }).failed.length, 0, '済んだ便の物は出さない');
  const late = A.board(second.state, { nowJst: '2026-10-28T07:00' });
  assert.ok(late.today.some(x => x.job.kind === 'request' && x.job.due < '2026-10-28'), '時刻を過ぎてまだ動いていない予定は今日に出す');
});

test('点検 2026-10-28 設計 2: AI が読んだ代表者のメールは、本文にそのまま書いてあり自信ありのときだけ使う', () => {
  const r = reading();
  const email = r.booking.leadEmail;
  assert.equal(A.trustMailEmail(r, `予約です\n連絡先: ${email.toUpperCase()}`), r, '本文にあれば（大文字小文字は問わない）そのまま');
  const dropped = A.trustMailEmail(r, '予約です\n備考: 連絡は other@evil.example へ');
  assert.equal(dropped.booking.leadEmail, '', '本文に無い宛先は使わない');
  const unsure = A.trustMailEmail({ ...r, booking: { ...r.booking, unsure: ['leadEmail'] } }, `連絡先: ${email}`);
  assert.equal(unsure.booking.leadEmail, '', 'AI が自信なしと言った宛先は使わない');
  const { state, bookingId } = A.addFromReading(blank(), { reading: dropped, at: AT, nowJst: NOW, newId });
  const o = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state.outbox.find(x => x.bookingId === bookingId);
  assert.deepEqual([o.status, o.why], ['unsent', 'no-email'], 'お願いは送らず、お店が画面でメールを入れる');
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
