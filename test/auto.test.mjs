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

test('中止した便には送らないが、予定は待たせておき、中止を取り消すと動く', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const tripId = state.trips[0].id;
  const cancelled = C.cancelTrip(state, { tripId, reason: 'wind', at: AT });
  const r = A.runDue(cancelled, { nowJst: '2026-10-31T06:00', at: AT, newId, askBase: ASK });
  assert.equal((r.state.outbox || []).length, 0);
  assert.equal(jobsOf(r.state, 'morning')[0].status, 'waiting', '当日の朝は待ったまま');
  const reopened = C.reopenTrip(r.state, { tripId, at: AT });
  const r2 = A.runDue(reopened, { nowJst: '2026-10-31T06:30', at: AT, newId, askBase: ASK });
  assert.equal(jobsOf(r2.state, 'morning')[0].status, 'done');
  assert.ok(r2.state.trips[0].rosterAt, '便に名簿の印が付く');
});

test('Cron が止まって戻っても、便の日を過ぎた予定は送らない（済んだ便に「本日の前に」を出さない）', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: '2026-11-03T10:00', at: AT, newId, askBase: ASK });
  assert.ok(r.state.jobs.every(j => j.status === 'skipped'), '4 つとも飛ばす');
  assert.equal((r.state.outbox || []).length, 0);
  assert.ok(!r.state.trips[0].rosterAt, '後から名簿の印を付けない');
});

test('便の当日に戻ったら、お願いと当日の朝は送り、2 日前と前日の夜は送らない', () => {
  const { state } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const r = A.runDue(state, { nowJst: '2026-10-31T07:00', at: AT, newId, askBase: ASK });
  const st = (k) => jobsOf(r.state, k)[0].status;
  assert.deepEqual([st('request'), st('remind'), st('eve'), st('morning')], ['done', 'skipped', 'skipped', 'done']);
  assert.deepEqual(r.state.outbox.map(o => o.kind).sort(), ['request', 'today']);
});

test('サーバーに名簿が無いときの最初の書き込みでは、済んだ予定と送った記録をそのまま受ける', () => {
  const { state, bookingId } = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const ran = A.runDue(state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  const sentId = ran.outbox[0].id;
  const device = A.markSent(ran, { id: sentId, result: 'sent', at: AT });
  const kept = A.serverOwned(S.blankState(''), device, { fresh: true });
  assert.equal(jobsOf(kept, 'request')[0].status, 'done', '済んだお願いを待ちに戻さない');
  assert.equal(kept.outbox.find(o => o.id === sentId).status, 'sent', '送った記録を消さない');
  const queued = A.serverOwned(S.blankState(''), ran, { fresh: true }).outbox[0];
  assert.deepEqual([queued.status, queued.why], ['failed', 'maybe-sent'], '送る途中だった物はもう一度送らない');
  const notFresh = A.serverOwned(S.blankState(''), device);
  assert.equal(notFresh.outbox.length, 0, '名簿がある所への書き込みでは、画面の連絡は受けない（今までどおり）');
  assert.ok(bookingId);
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

/* ---------- 予約を別の便へ移す・取り消す（H4）。待っている予定の作り直しと、取り消した予約に連絡が出ないこと ---------- */
const NOV5 = { date: '2026-11-05', start: '08:30', kind: 'dive', tour: '体験ダイビング' };
const withTrip = (st) => C.addTrip(st, { trip: NOV5, at: AT, newId: () => 'trip-nov5' }).state;
const planOf = (st, bookingId) => st.jobs.filter(j => j.bookingId === bookingId).map(j => [j.kind, j.status, j.due]);
const jsonOf = (x) => JSON.parse(JSON.stringify(x));

test('別の便へ移す: 待っている予定を新しい便の日で作り直す。古い日の予定は残らない', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const st = withTrip(made.state);
  const moved = A.moveBooking(st, { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId });
  assert.equal(moved.tripId, 'trip-nov5');
  assert.equal(moved.state.bookings[0].tripId, 'trip-nov5');
  assert.deepEqual(planOf(moved.state, made.bookingId), [
    ['request', 'waiting', NOW], ['remind', 'waiting', '2026-11-03T09:00'], ['eve', 'waiting', '2026-11-04T20:00'], ['morning', 'waiting', '2026-11-05T06:00']]);
  assert.ok(moved.state.jobs.every(j => j.tripId === 'trip-nov5'), '予定も新しい便に付く');
  assert.equal(new Set(moved.state.jobs.map(j => j.id)).size, moved.state.jobs.length, '予定の id は重ならない');
  assert.ok(S.validateState(moved.state).ok);
  const e = moved.state.log[moved.state.log.length - 1];
  assert.deepEqual([e.who, e.act, e.kind, e.id, e.fields], ['staff', 'edit', 'booking', made.bookingId, ['tripId']]);
  assert.equal(A.moveBooking(moved.state, { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId }).state, moved.state, '同じ便へは何もしない');
});

test('別の便へ移す: 送り済みのお願いは作り直さない（予約と種類ごとに予定は 1 つ）。予定の無い予約には予定を作らない', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const ran = A.runDue(made.state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  assert.equal(jobsOf(ran, 'request')[0].status, 'done');
  const moved = A.moveBooking(withTrip(ran), { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId }).state;
  assert.deepEqual(planOf(moved, made.bookingId).map(x => x.slice(0, 2)), [['request', 'done'], ['remind', 'waiting'], ['eve', 'waiting'], ['morning', 'waiting']]);
  assert.equal(moved.outbox.length, ran.outbox.length, '送った記録はそのまま');
  const none = A.moveBooking(withTrip({ ...made.state, jobs: [] }), { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId }).state;
  assert.equal(none.jobs.length, 0, '予定を作っていなかった予約に、移すだけで予定を作らない');
});

test('別の便へ移す: 便が無ければ want（日付・時刻・ツアー）から作る。直しの記録を JSON に写して当て直しても同じ', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const args = { bookingId: made.bookingId, tripId: 'new', want: { date: '2026-11-07', start: '13:00', tour: 'ファンダイビング', kind: 'dive' }, nowJst: NOW };
  const entry = { op: 'auto.moveBooking', id: 'mv1', at: '2026-10-27T02:00:00.000Z', args };
  const first = C.ops.run(made.state, entry);
  const trip = first.state.trips.find(t => t.id === first.tripId);
  assert.deepEqual([trip.date, trip.start, trip.kind, trip.tour], ['2026-11-07', '13:00', 'dive', 'ファンダイビング']);
  assert.equal(first.state.bookings[0].tripId, trip.id);
  assert.equal(jobsOf(first.state, 'morning')[0].due, '2026-11-07T06:00');
  assert.deepEqual(C.ops.run(made.state, jsonOf(entry)), first, '端末に置いて読み戻した直しも同じ結果');
  assert.throws(() => A.moveBooking(made.state, { bookingId: made.bookingId, tripId: 'ない', at: AT, nowJst: NOW, newId }), /移す先の便が見つからない/);
  assert.throws(() => A.moveBooking(made.state, { bookingId: 'ない', tripId: 'new', want: args.want, at: AT, nowJst: NOW, newId }), /予約が見つからない/);
});

test('別の便へ移すと、Cron は古い日でなく新しい日に動き、お願いの文面も新しい日になる', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const ran = A.runDue(made.state, { nowJst: NOW, at: AT, newId, askBase: ASK }).state;
  const moved = A.moveBooking(withTrip(ran), { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId }).state;
  const old = A.runDue(moved, { nowJst: '2026-10-30T21:00', at: AT, newId, askBase: ASK });
  assert.equal(old.state.outbox.length, ran.outbox.length, '古い日の 2 日前・前日の夜には何も出ない');
  assert.deepEqual(old.state.jobs.filter(j => j.status === 'waiting').map(j => j.kind).sort(), ['eve', 'morning', 'remind']);
  const next = A.runDue(moved, { nowJst: '2026-11-03T09:00', at: AT, newId, askBase: ASK });
  const remind = next.state.outbox.find(o => o.kind === 'remind');
  assert.ok(remind && remind.subject.includes('11/5'), `新しい日のもう一度のお願い: ${remind && remind.subject}`);
  assert.deepEqual(next.queued, [remind.id]);
});

test('取り消した予約には、Cron が何も送らない（予約が無い予定は飛ばす。送る準備ができていた連絡も作り直せない）', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const other = A.addFromReading(made.state, { reading: reading({ start: '13:00' }), at: AT, nowJst: NOW, newId });
  const ran = A.runDue(other.state, { nowJst: NOW, at: AT, newId, askBase: '' }).state;   // Worker のように、リンクは印のまま
  const queuedFor = (st, id) => st.outbox.filter(o => o.bookingId === id && o.status === 'queued');
  assert.equal(queuedFor(ran, made.bookingId).length, 1, '取り消す前は送る準備ができている');
  const cancelled = C.cancelBooking(ran, { bookingId: made.bookingId, reason: 'guest', at: AT });
  const cron = A.runDue(cancelled, { nowJst: '2026-10-31T07:00', at: AT, newId, askBase: '' });
  assert.deepEqual(cron.state.outbox.filter(o => o.bookingId === made.bookingId), []);
  assert.deepEqual(planOf(cron.state, made.bookingId), []);
  assert.ok(cron.state.outbox.some(o => o.bookingId === other.bookingId && o.kind === 'today'), 'ほかの予約の連絡は動く');
  /* サーバーに古い名簿（予約を消す前）が残っていても、予約が無ければ予定は飛ばし、連絡は作り直せない */
  const stale = { ...cancelled, jobs: ran.jobs, outbox: ran.outbox };
  const late = A.runDue(stale, { nowJst: '2026-10-31T07:00', at: AT, newId, askBase: '' });
  assert.deepEqual(late.state.jobs.filter(j => j.bookingId === made.bookingId).map(j => j.status), ['done', 'skipped', 'skipped', 'skipped']);
  assert.equal(late.state.outbox.filter(o => o.bookingId === made.bookingId).length, ran.outbox.filter(o => o.bookingId === made.bookingId).length, '新しい連絡は作らない');
  const item = queuedFor(ran, made.bookingId)[0];
  assert.equal(A.rebuildOut(cancelled, item), null, '送る直前に作り直せない = 送らない');
  assert.equal(A.rebuildOut(ran, item) && A.rebuildOut(ran, item).to, 'hanako@mail.example');
});

test('サーバーが受ける名簿: 取り消した予約の予定と連絡は消え、別の便へ移した予約の予定は作り直しを受ける', () => {
  const made = A.addFromReading(blank(), { reading: reading(), at: AT, nowJst: NOW, newId });
  const other = A.addFromReading(made.state, { reading: reading({ start: '13:00' }), at: AT, nowJst: NOW, newId });
  const stored = A.runDue(other.state, { nowJst: NOW, at: AT, newId, askBase: '' }).state;
  /* 取り消し */
  const gone = A.serverOwned(stored, C.cancelBooking(stored, { bookingId: made.bookingId, reason: 'dup', at: AT }));
  assert.deepEqual(gone.bookings.map(b => b.id), [other.bookingId]);
  assert.ok(gone.jobs.every(j => j.bookingId === other.bookingId) && gone.outbox.every(o => o.bookingId === other.bookingId));
  assert.ok(gone.jobs.length > 0 && gone.outbox.length > 0, 'ほかの予約の予定と連絡は残す');
  /* 別の便へ（待っている予定だけ新しい日で受ける。送り済みのお願いは増えない） */
  const moved = A.moveBooking(withTrip(stored), { bookingId: made.bookingId, tripId: 'trip-nov5', at: AT, nowJst: NOW, newId }).state;
  const taken = A.serverOwned(withTrip(stored), moved);
  assert.deepEqual(planOf(taken, made.bookingId).map(x => x.slice(0, 2)), [['request', 'done'], ['remind', 'waiting'], ['eve', 'waiting'], ['morning', 'waiting']]);
  assert.deepEqual(taken.jobs.filter(j => j.bookingId === made.bookingId && j.status === 'waiting').map(j => j.due).sort(),
    ['2026-11-03T09:00', '2026-11-04T20:00', '2026-11-05T06:00']);
  assert.equal(jobsOf(taken, 'request').filter(j => j.bookingId === made.bookingId).length, 1);
  assert.equal(taken.outbox.length, stored.outbox.length, '送る連絡は増やさない');
  /* 守り: 済んだ予定を消して足し直しても受けない。今ある待ちの予定の時刻は、画面の値に書き換えさせない */
  const forged = { ...stored, jobs: [...stored.jobs.filter(j => !(j.bookingId === made.bookingId && j.kind === 'request')),
    { ...jobsOf(stored, 'request').find(j => j.bookingId === made.bookingId), id: 'forged', status: 'waiting', doneAt: '' }] };
  assert.equal(A.serverOwned(stored, forged).jobs.some(j => j.id === 'forged'), false, '済んだお願いを待ちで足し直せない');
  const retimed = { ...stored, jobs: stored.jobs.map(j => (j.status === 'waiting' ? { ...j, due: '2026-10-27T10:01' } : j)) };
  assert.deepEqual(A.serverOwned(stored, retimed).jobs.map(j => j.due), stored.jobs.map(j => j.due));
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
