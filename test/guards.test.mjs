// 守りの確かめ。守りを 1 つ外しても誰も落ちなかった物（M05 外からの予約の 7 割・M11 届いたメールの読み止め・M13 画面が受けるリンクの形・M16 「届いていた」は
// maybe-sent だけ・M17 文面の名前の URL・M22 店が 0 の便）と、1 本のテストだけが守っていた物（M02 送る直前の作り直し・M03 送り主の許可・M04 SPF/DKIM・M06 送信中の印・
// M08 予定の足し直し・M09 Access の期限・M19 1 回に印を付ける数・M21 /api/ask の IP の回数・M24 送り元の @）に、別の入口からの 2 本目を足す。
// M12（Turnstile の siteverify が 200 以外）は test/e2e.test.mjs。M14（同意なしに健康を使うボタン）は DOM が要り、純粋な部分が無いので確かめない（core の同意の確かめは test/guest.test.mjs）。
// 実行: node test/guards.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../js/roster-schema.js';
import '../js/pass-schema.js';
import '../js/roster-core.js';
import '../js/roster-guest.js';
import '../js/roster-day.js';
import '../js/roster-share.js';
import '../js/data-samples.js';
import { scheduled, receiveMail, changeRoster } from '../worker/auto.mjs';
import { claimQueued, queuedOf, claimedBy, authPassed, senderAllowed, CLAIM_MAX, MAX_MAIL_BYTES, SENDING, SENDING_STALE_MS } from '../worker/auto-core.mjs';
import { MAX_ROSTER_BYTES } from '../worker/sync-core.mjs';
import { mailReady } from '../worker/mail.mjs';
import { underLimit } from '../worker/site-guard.mjs';
import { verifyAccess } from '../worker/access.mjs';
import { handlePublic } from '../worker/public-handler.mjs';
import { fakeRateLimit } from '../worker/fakes.mjs';
import { setup, siteBooking, staffCall, guestCall, publicEnv, stored, putState, message, MAIL_RAW, MAIL_BODY, READING, GOOD, jwtFor, ASK_ORIGIN, ORIGIN, STAFF, NOW, AT, logs, runTests } from './kit.mjs';

const { roster: S, rosterCore: C, rosterShare: X, rosterAuto: A, SAMPLE_READINGS } = globalThis.REDUX;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ONE = { ...GOOD, people: 1 };
const unreadWhy = (s) => [...s.db.unread.values()].map(u => u.why);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* 予約を 1 件入れて、最初のお願いを送ったところまで進める。返す s.mail.sent は空に戻す */
async function booked(over = {}, body = ONE) {
  const s = setup(over);
  assert.equal((await siteBooking(s, body)).status, 202);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
  s.mail.sent.length = 0;
  return s;
}
const queuedItem = (st, id, over = {}) => ({ v: S.VERSION, id, kind: 'request', bookingId: st.bookings[0].id, tripId: st.trips[0].id, to: st.bookings[0].leadEmail, lang: 'ja',
  subject: '件名', body: '本文 [[ask-link]]', people: [st.people[0].id], status: 'queued', why: '', at: AT, sentAt: '', ...over });

/* ---------- M05: 外からの予約は名簿が上限の 7 割を超えたら入れない ---------- */

/* 名簿を fraction × 上限の大きさにする（送った連絡の記録の本文を足す。名簿として正しい形のまま） */
async function fillRoster(s, fraction) {
  const st = stored(s);
  const pad = (id) => queuedItem(st, id, { status: 'sent', body: 'x'.repeat(3900), sentAt: AT });
  const per = JSON.stringify(pad('pad0000')).length + 1;
  const count = Math.ceil((MAX_ROSTER_BYTES * fraction - JSON.stringify(st).length) / per);
  const done = await changeRoster(s.env, s.io, cur => ({ state: { ...cur, outbox: [...(cur.outbox || []), ...Array.from({ length: count }, (_, i) => pad(`pad${i}`))] } }));
  assert.ok(done.ok, '店自身の書き込みで大きくする');
  const size = new TextEncoder().encode(s.db.rows.get('default').state).byteLength;
  assert.ok(size > MAX_ROSTER_BYTES * (fraction - 0.01) && size < MAX_ROSTER_BYTES, `名簿の大きさ ${size}`);
}

test('M05 サイトの予約: 名簿が上限の 7 割を超えていたら 503（full）で入れない。7 割に届かなければ入る。店自身の書き込みは上限まで通る', async () => {
  const under = setup();
  assert.equal((await siteBooking(under, ONE, { ip: '203.0.113.51' })).status, 202);
  await fillRoster(under, 0.6);
  assert.equal((await siteBooking(under, { ...ONE, email: 'under@mail.example' }, { ip: '203.0.113.52' })).status, 202, '6 割なら入る');
  const s = setup();
  assert.equal((await siteBooking(s, ONE, { ip: '203.0.113.53' })).status, 202);
  await fillRoster(s, 0.75);
  const before = s.db.rows.get('default');
  const res = await siteBooking(s, { ...ONE, email: 'over@mail.example' }, { ip: '203.0.113.54' });
  assert.deepEqual([res.status, (await res.json()).error], [503, 'full']);
  assert.equal(JSON.parse(logs.filter(l => l.includes('"route":"/api/bookings"')).pop()).why, 'add-full');
  assert.deepEqual([s.db.rows.get('default').version, s.db.rows.get('default').state], [before.version, before.state], '名簿は変わらない');
  const own = await changeRoster(s.env, s.io, cur => ({ state: { ...cur, shop: { ...cur.shop, name: 'B マリン（見本）' }, trips: cur.trips.map(t => ({ ...t, boat: 'サンプル丸' })) } }));
  assert.ok(own.ok, '店自身の書き込みの分は残してある');
});

test('M05 届いた予約メール: 名簿が 7 割を超えていたら入れず、読めなかったメールとして「full」で残す', async () => {
  const s = await booked();
  await fillRoster(s, 0.75);
  s.api.answer = READING({ date: '2026-11-05' });
  const mail = message(MAIL_RAW(MAIL_BODY));
  await receiveMail(mail, s.env, s.io);
  assert.equal(s.api.calls.length, 1, '読むところまでは進む');
  assert.equal(stored(s).bookings.length, 1, '予約は入らない');
  assert.deepEqual(unreadWhy(s), ['full']);
  assert.equal(mail.rejected, '', '予約サイトには断りを返さない');
});

/* ---------- M11: 届いたメールの生の中身を上限で読み止める ---------- */

/* count 個の n バイトの塊を流す生のメール。pulled は読まれた塊の数 */
function slowRaw(count, n) {
  const out = { pulled: 0 };
  const chunk = new Uint8Array(n).fill(97);
  out.stream = new ReadableStream({ pull(c) { if (out.pulled < count) { out.pulled += 1; c.enqueue(chunk); } else c.close(); } }, { highWaterMark: 0 });
  return out;
}

test('M11 届いたメール: 大きさの申告が小さくても、生の中身を上限で読み止める（全部は読まない・AI を呼ばない）', async () => {
  const s = setup();
  const raw = slowRaw(100, 32 * 1024);   // 約 3.2 MB。上限は 256 KB
  const mail = { ...message('x', 'forward@shop.example', undefined, { rawSize: 1000 }), raw: raw.stream };
  await receiveMail(mail, s.env, s.io);
  assert.ok(raw.pulled < 20, `読み止めた（読んだ塊 ${raw.pulled}）`);
  assert.equal(s.api.calls.length, 0);
  assert.deepEqual(unreadWhy(s), ['size']);
  assert.equal(s.db.rows.size, 0);
  assert.equal(mail.rejected, '');
});

test('M11 届いたメール: 申告が上限を超えていれば中身は読まない。上限ちょうどの中身は読む', async () => {
  const s = setup();
  const honest = slowRaw(100, 32 * 1024);
  const big = { ...message('x', 'forward@shop.example', undefined, { rawSize: MAX_MAIL_BYTES + 1 }), raw: honest.stream };
  await receiveMail(big, s.env, s.io);
  assert.equal(honest.pulled, 0, '申告だけで断る');
  assert.deepEqual(unreadWhy(s), ['size']);
  const head = MAIL_RAW('');
  const exact = new TextEncoder().encode(head + 'a'.repeat(MAX_MAIL_BYTES - head.length));
  assert.equal(exact.byteLength, MAX_MAIL_BYTES);
  await receiveMail(message(exact, 'forward@shop.example', undefined, { rawSize: 1 }), s.env, s.io);
  assert.equal(s.api.calls.length, 1, '上限ちょうどは読んで AI に渡す');
  const over = new Uint8Array(MAX_MAIL_BYTES + 1).fill(97);
  await receiveMail(message(over, 'forward@shop.example', undefined, { rawSize: 1 }), s.env, s.io);
  assert.equal(s.api.calls.length, 1, '1 バイトでも超えたら読み止めて AI を呼ばない');
});

/* ---------- M13: 画面は、Worker が返したお客さんのリンクの形を確かめてから受ける ---------- */

function screenWith(fetchImpl) {
  const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const ctx = vm.createContext({ localStorage: memory(), sessionStorage: memory(), setTimeout, clearTimeout, AbortController, TextEncoder, URL, btoa, console, CompressionStream, Blob, Response,
    addEventListener: () => {}, fetch: fetchImpl });
  ctx.window = ctx;
  ['core.js', 'roster-schema.js', 'roster-sync.js'].forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  return ctx.REDUX;
}

test('M13 画面の askLink: /ask と # の後ろの鍵（43 字）だけを受ける。http は手元だけ。形の違うリンクは受けない', async () => {
  const KEY = 'A1_-'.repeat(10) + 'xyz';
  assert.equal(KEY.length, 43);
  const plain = (v) => JSON.parse(JSON.stringify(v));   // vm の中で作られた物は別の realm なので、形だけで比べる
  const answerWith = async (data, status = 200) => plain(await screenWith(async () => ({ status, type: 'basic', json: async () => data })).rosterSync.askLink('b1'));
  const good = [`https://redux-ask.example.workers.dev/ask#k=${KEY}`, `http://localhost:8787/ask#k=${KEY}`, `http://127.0.0.1/ask#k=${KEY}`];
  for (const url of good) assert.deepEqual(await answerWith({ url, expiresOn: '2026-11-04' }), { ok: true, url, expiresOn: '2026-11-04' }, url);
  const bad = [
    `http://evil.example/ask#k=${KEY}`, `ftp://redux-ask.example.workers.dev/ask#k=${KEY}`, `javascript:alert(1)//ask#k=${KEY}`,
    `https://redux-ask.example.workers.dev/other#k=${KEY}`, `https://redux-ask.example.workers.dev/ask/#k=${KEY}`, `https://redux-ask.example.workers.dev/#k=${KEY}`,
    `https://redux-ask.example.workers.dev/ask?x=1#k=${KEY}`, 'https://redux-ask.example.workers.dev/ask',
    `https://redux-ask.example.workers.dev/ask#${KEY}`, `https://redux-ask.example.workers.dev/ask#k=${KEY.slice(1)}`, `https://redux-ask.example.workers.dev/ask#k=${KEY}x`,
    `https://redux-ask.example.workers.dev/ask#k=${KEY.slice(1)}!`, `https://redux-ask.example.workers.dev/ask#k=${KEY}&a=b`, 'not a url', '', 7, null
  ];
  for (const url of bad) assert.deepEqual(await answerWith({ url, expiresOn: '2026-11-04' }), { ok: false, why: 200 }, String(url));
  assert.deepEqual(await answerWith({ error: 'booking' }, 404), { ok: false, why: 404 });
  assert.deepEqual(plain(await screenWith(async () => { throw new TypeError('Failed to fetch'); }).rosterSync.askLink('b1')), { ok: false, why: 'network' });
});

/* ---------- M16: 「届いていた」にできるのは、送れたか分からない（maybe-sent）連絡だけ ---------- */

test('M16 serverOwned: 画面が「届いていた」と書いても、maybe-sent の連絡だけが sent になる。送れなかった・送る前・送った物は変わらない', () => {
  const o = (id, status, why) => ({ id, bookingId: 'b1', kind: 'request', status, why, sentAt: '' });
  const storedState = { bookings: [{ id: 'b1' }], jobs: [], outbox: [o('maybe', 'failed', 'maybe-sent'), o('failed', 'failed', 'E_DELIVERY_FAILED'), o('unsent', 'unsent', 'no-mail-config'),
    o('queued', 'queued', ''), o('sending', 'queued', 'sending:2026-10-27T01:00:00Z#ab12'), o('sent', 'sent', ''), o('resent', 'failed', 'resent'), o('odd', 'queued', 'maybe-sent')] };
  const incoming = { ...storedState, outbox: storedState.outbox.map(x => ({ ...x, status: 'sent', why: 'confirmed', sentAt: AT })) };
  const got = A.serverOwned(storedState, incoming).outbox;
  assert.deepEqual(got.map(x => [x.id, x.status, x.why]), [['maybe', 'sent', 'confirmed'], ['failed', 'failed', 'E_DELIVERY_FAILED'], ['unsent', 'unsent', 'no-mail-config'],
    ['queued', 'queued', ''], ['sending', 'queued', 'sending:2026-10-27T01:00:00Z#ab12'], ['sent', 'sent', ''], ['resent', 'failed', 'resent'], ['odd', 'queued', 'maybe-sent']]);
});

test('M16 画面の書き込み: 送れなかった連絡を「届いていた」にして PUT しても変わらない（お願いが届いていないのに画面から消えない）。maybe-sent なら変わる', async () => {
  const s = await booked();
  s.mail.fail = 'E_DELIVERY_FAILED';
  const st0 = stored(s);
  putState(s, { ...st0, outbox: [queuedItem(st0, 'o1')] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.deepEqual(stored(s).outbox.map(x => [x.status, x.why]), [['failed', 'E_DELIVERY_FAILED']]);
  const confirm = async (got) => staffCall(s, 'PUT', '/api/roster', { base: got.version, state: { ...got.state, outbox: got.state.outbox.map(x => ({ ...x, status: 'sent', why: 'confirmed', sentAt: AT })) } });
  let got = await (await staffCall(s, 'GET', '/api/roster')).json();
  const refused = await confirm(got);
  assert.equal(refused.status, 200);
  assert.deepEqual(stored(s).outbox.map(x => [x.status, x.why, x.sentAt]), [['failed', 'E_DELIVERY_FAILED', '']], '送れなかった連絡は「届いていた」にならない');
  const st1 = stored(s);
  putState(s, { ...st1, outbox: st1.outbox.map(x => ({ ...x, why: 'maybe-sent' })) }, { version: s.db.rows.get('default').version + 1 });
  got = await (await staffCall(s, 'GET', '/api/roster')).json();
  assert.equal((await confirm(got)).status, 200);
  assert.deepEqual(stored(s).outbox.map(x => [x.status, x.why]), [['sent', 'confirmed']], '送れたか分からない連絡は、お店が確かめれば sent になる');
});

/* ---------- M17: 文面の名前から、URL・www.・ドメインらしい並びを外す ---------- */

const msg = (lang, over) => A.message('request', { shop: 'B マリン', booking: { id: 'b1', lang, leadName: '見本 花子' }, trip: { date: '2026-11-03', start: '08:30', tour: '体験ダイビング' },
  people: [{ name: '見本 花子' }], link: A.LINK_MARK, ...over });

test('M17 文面の名前・ツアー・お店の名前: IP の URL・スキームだけの語・www. の語は外す（ドメインらしい並びの検査では拾えない物）', () => {
  const evil = ['http://203.0.113.5/pay', 'ftp://10.0.0.1/x', 'HTTPS://192.0.2.1', 'www.123', 'file:///etc/passwd', 'x://y'];
  for (const lang of ['ja', 'en']) {
    for (const bad of evil) {
      for (const where of ['lead', 'person', 'tour', 'shop']) {
        const m = msg(lang, {
          ...(where === 'lead' ? { booking: { id: 'b1', lang, leadName: `見本 ${bad} 花子` } } : {}),
          ...(where === 'person' ? { people: [{ name: `見本 ${bad} 花子` }] } : {}),
          ...(where === 'tour' ? { trip: { date: '2026-11-03', start: '08:30', tour: `体験 ${bad} ダイビング` } } : {}),
          ...(where === 'shop' ? { shop: `B ${bad} マリン` } : {})
        });
        const text = `${m.subject}\n${m.body}`;
        assert.ok(!text.includes('://') && !/www\./i.test(text), `${lang} ${where} ${bad}: ${text.slice(0, 80)}`);
        for (const piece of ['203.0.113.5', '10.0.0.1', '192.0.2.1', 'www.123', 'etc/passwd']) assert.ok(!text.includes(piece), `${where} ${bad} → ${piece}`);
        assert.ok(text.includes('見本') || where === 'shop' || where === 'tour' || lang === 'en', '名前の残りは残る');
      }
    }
  }
  const fine = msg('ja', { people: [{ name: 'J. Smith' }, { name: '見本 花子' }] });
  assert.ok(fine.body.includes('J. Smith') && fine.body.includes('見本 花子'), 'ふつうの名前は残る');
});

test('M17 Cron のメール: スタッフが書ける名前に IP の URL を入れても、送るメールには入らない', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  const evil = '見本 http://203.0.113.5/pay ftp://10.0.0.1/x www.123 花子';
  const done = await changeRoster(s.env, s.io, st => ({ state: { ...st, bookings: st.bookings.map(b => ({ ...b, leadName: evil })), people: st.people.map(p => ({ ...p, name: evil })) } }));
  assert.ok(done.ok);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
  const text = `${s.mail.sent[0].subject}\n${s.mail.sent[0].text}`;
  for (const piece of ['203.0.113.5', '10.0.0.1', 'www.123', 'ftp:']) assert.ok(!text.includes(piece), piece);
  assert.ok(text.startsWith('見本 花子 様') || text.includes('見本 花子 様'), '名前の残りは 1 行の文字で残る');
});

/* ---------- M22: 乗り合いの便で、お客さんのいる店が 0 のとき「全員戻った」にしない ---------- */

test('M22 乗り合い: お客さんのいる店が 0 の便（ガイドだけ・乗り合いのお店を足しただけ）は「全員戻った」でなく、ポイントを離れる記録も残せない', () => {
  const OWN = 'B マリン（見本）';
  const PARTNER = 'C ダイブ（見本）';
  const trip = { ...S.blankTrip(), id: 't1', date: '2026-10-24', start: '08:30', kind: 'dive', tour: '体験ダイビング（ボート2本）', boat: 'サンプル丸', site: '北の根',
    guides: ['見本 ガイド'], createdAt: AT };
  let n = 0;
  const newId = () => `id${(n += 1)}`;
  const empty = { ...S.blankState(OWN), trips: [trip] };
  const shared = X.addPartner(empty, { tripId: 't1', name: PARTNER, at: AT }).state;
  for (const state of [empty, shared]) {
    const r = X.returns(state, 't1');
    assert.deepEqual([r.shops.length, r.waiting.length, r.people], [0, 0, 0]);
    assert.equal(r.allBack, false, 'お客さんのいる店が 0 なら、全員戻ったとは言わない');
    const left = X.recordLeave(state, { tripId: 't1', at: AT });
    assert.deepEqual([left.problem, left.state], ['empty', state]);
  }
  const withGuests = C.addBooking(shared, { trip, booking: { source: 'mail', people: 2 }, reading: JSON.parse(JSON.stringify(SAMPLE_READINGS.e1)), src: 'mail', at: AT, newId });
  assert.deepEqual([X.returns(withGuests, 't1').shops.length, X.returns(withGuests, 't1').allBack], [1, false], 'お客さんがいて、まだ戻っていない');
  const back = X.recordReturn(withGuests, { tripId: 't1', shop: '', at: AT }).state;
  assert.equal(X.returns(back, 't1').allBack, true, '1 店でも、お客さんのいる店が全部戻れば true');
});

/* ---------- M02: 送る直前に、宛先と本文を今の予約から作り直す（名簿に書いてある物は使わない） ---------- */

test('M02 Cron: 名簿の行に直接書き込まれた「お店への知らせ」の形の連絡（宛先が外の人）は、送らずに failed（gone）にする', async () => {
  const s = await booked();
  const st = stored(s);
  putState(s, { ...st, outbox: [queuedItem(st, 'evil-staff', { kind: 'staff', to: 'victim@attacker.example', subject: '差し替え', body: '振込先はこちら' }),
    queuedItem(st, 'evil-kind', { kind: 'remind', to: 'victim@attacker.example', subject: '差し替え', body: '振込先はこちら' })] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.ok(s.mail.sent.every(m => m.to === 'hanako@mail.example'), `宛先は予約のメールだけ: ${s.mail.sent.map(m => m.to)}`);
  assert.ok(s.mail.sent.every(m => !m.text.includes('振込先') && !m.subject.includes('差し替え')), '文面は決まった物');
  const rows = Object.fromEntries(stored(s).outbox.map(o => [o.id, [o.status, o.why]]));
  assert.deepEqual(rows['evil-staff'], ['failed', 'gone'], '知らせの形の連絡は Cron では送らない');
});

test('M02 Cron: 連絡を作ったあとで予約のメールを消した・便が中止になった・お願いする人がいなくなったときは、古い宛先へ送らない', async () => {
  const s = await booked({}, ONE);
  const st = stored(s);
  const noEmail = { ...st, bookings: st.bookings.map(b => ({ ...b, leadEmail: '' })) };
  putState(s, { ...noEmail, outbox: [queuedItem(st, 'q1', { to: 'hanako@mail.example' })] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, 'メールを消した予約には送らない');
  assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['failed', 'gone']]);
  putState(s, { ...st, trips: st.trips.map(t => ({ ...t, cancel: { at: AT, reason: 'wind', acked: [] } })), outbox: [queuedItem(st, 'q2')] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, '中止の便には送らない');
  putState(s, { ...st, outbox: [queuedItem(st, 'q3', { people: ['nobody'] })] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, 'お願いする人がいなければ送らない');
  putState(s, { ...st, outbox: [queuedItem(st, 'q4', { to: 'old@attacker.example', subject: '古い件名' })] }, { version: s.db.rows.get('default').version + 1 });
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.to), ['hanako@mail.example'], '連絡に書いてある宛先でなく、今の予約の宛先');
});

/* ---------- M03: 届いたメールの送り主の許可リスト（認証が通っても、許可の無い送り主は断る） ---------- */

const inbound = async (s, msg) => {
  s.api.answer = READING({ date: '2026-11-05' });
  await receiveMail(msg, s.env, s.io);
  return msg;
};

test('M03 送り主の許可: 同じドメインで SPF / DKIM が通っても、許可の表に無い送り主は断る（AI を呼ばない・名簿に入れない）', async () => {
  const s = setup();
  const stranger = await inbound(s, message(MAIL_RAW(MAIL_BODY), 'stranger@shop.example'));
  assert.match(stranger.rejected, /Sender not accepted/);
  assert.equal(s.api.calls.length, 0);
  assert.equal(s.db.rows.size, 0);
  assert.deepEqual(unreadWhy(s), [], '送り主が違うメールは「読めなかったメール」にも残さない');
  const allowed = await inbound(s, message(MAIL_RAW(MAIL_BODY), 'Forward@Shop.example'));
  assert.equal(allowed.rejected, '', '許可の表の送り主は（大文字小文字を問わず）通る');
  assert.equal(s.api.calls.length, 1);
  assert.ok(!senderAllowed('stranger@shop.example', 'forward@shop.example') && !senderAllowed('forward@shop.example.evil.example', 'forward@shop.example'));
});

test('M03 送り主の許可（お店が複数）: 別のお店の送り主は、このお店の受け口に予約を入れられない', async () => {
  const s = setup({ SINGLE_SHOP: undefined, MAIL_SENDERS: undefined });
  s.db.addShop({ id: 'shop-a', name: 'A ダイブ', inbox: 'a@yoyaku.example', senders: ['fwd-a@shop.example'] });
  s.db.addShop({ id: 'shop-b', name: 'B マリン', inbox: 'b@yoyaku.example', senders: ['fwd-b@shop.example'] });
  const crossed = await inbound(s, message(MAIL_RAW(MAIL_BODY), 'fwd-a@shop.example', undefined, { to: 'b@yoyaku.example' }));
  assert.match(crossed.rejected, /Sender not accepted/);
  assert.equal(s.api.calls.length, 0);
  assert.equal(s.db.rows.size, 0);
  const own = await inbound(s, message(MAIL_RAW(MAIL_BODY), 'fwd-b@shop.example', undefined, { to: 'b@yoyaku.example' }));
  assert.equal(own.rejected, '');
  assert.deepEqual([...s.db.rows.keys()], ['shop-b']);
});

/* ---------- M04: 届いたメールの SPF / DKIM（送り主のドメインと合う物が 1 つも通っていなければ断る） ---------- */

test('M04 SPF / DKIM: 許可の表の送り主でも、認証の見出しが無い・別のドメイン・失敗・親子の取り違えなら断る。ARC の見出しだけでも通ったら受ける', async () => {
  const cases = [
    ['見出しなし', null], ['空', ''], ['dkim が別のドメイン', 'mx; dkim=pass header.d=evil.example'], ['spf が別のドメイン', 'mx; spf=pass smtp.mailfrom=bounce@evil.example'],
    ['どちらも失敗', 'mx; dkim=fail header.d=shop.example; spf=softfail smtp.mailfrom=forward@shop.example'], ['none', 'mx; dkim=none; spf=none'],
    ['ドメインの途中だけ一致', 'mx; dkim=pass header.d=hop.example'], ['子のドメイン', 'mx; dkim=pass header.d=mail.shop.example']
  ];
  for (const [name, auth] of cases) {
    const s = setup();
    const m = await inbound(s, message(MAIL_RAW(MAIL_BODY), 'forward@shop.example', auth));
    assert.match(m.rejected, /not authenticated/, name);
    assert.equal(s.api.calls.length, 0, name);
    assert.equal(s.db.rows.size, 0, name);
  }
  const arc = setup();
  const viaArc = message(MAIL_RAW(MAIL_BODY));
  viaArc.headers.delete('authentication-results');
  viaArc.headers.set('arc-authentication-results', 'i=1; mx; dkim=pass header.d=shop.example');
  await inbound(arc, viaArc);
  assert.equal(viaArc.rejected, '');
  assert.equal(arc.api.calls.length, 1);
  assert.equal(authPassed(undefined, 'forward@shop.example'), false);
  assert.equal(authPassed('mx; dkim=pass header.d=shop.example', 'forward@'), false, '送り主にドメインが無い');
  assert.equal(authPassed('mx; spf=pass smtp.mailfrom=shop.example', 'forward@shop.example'), true, 'mailfrom がドメインだけでも合えば通る');
});

/* ---------- M06: 送る前の印のある連絡は、もう一度は選ばない（二重送信よけ） ---------- */

test('M06 送信中の印: 印のある連絡は Cron が選ばず、30 分たつと「送れたか分からない」にする（印を外して送り直したりしない）', async () => {
  const s = await booked();
  const st = stored(s);
  const mark = `${SENDING}2026-10-27T00:55:00Z#ab12`;
  putState(s, { ...st, outbox: [queuedItem(st, 'sending1', { why: mark })] }, { version: s.db.rows.get('default').version + 1 });
  assert.deepEqual(queuedOf(stored(s)), [], '選ばれる連絡に入らない');
  await scheduled(s.env, s.io);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0);
  assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['queued', mark]]);
  s.io.clock = NOW + SENDING_STALE_MS + 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0);
  assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['failed', 'maybe-sent']]);
});

test('M06 送信中の印: Cron が重なり、メールの送りが遅くても、同じ連絡は 1 通ずつしか出ない', async () => {
  const s = setup();
  for (let i = 0; i < 3; i += 1) assert.equal((await siteBooking(s, { ...ONE, email: `guest${i}@mail.example`, name: `見本 ${i}` }, { ip: `203.0.113.${60 + i}` })).status, 202);
  const send = s.mail.send;
  s.mail.send = async (m) => { await sleep(60); return send(m); };
  await Promise.all([scheduled(s.env, s.io), scheduled(s.env, s.io)]);
  assert.equal(s.mail.sent.length, 3, `3 件の予約に 1 通ずつ（出た通数 ${s.mail.sent.length}）`);
  assert.equal(new Set(s.mail.sent.map(m => m.to)).size, 3);
  assert.deepEqual(stored(s).outbox.map(o => o.status), ['sent', 'sent', 'sent']);
});

/* ---------- M08: 同じ予約・同じ種類の予定を、画面が足し直しても受けない ---------- */

test('M08 画面の書き込み: 済んだ予定を消して「待つ」で足し直しても、サーバーは受けない（お願いを何度でも送らせない）。新しい予約の予定は受ける', async () => {
  const s = await booked();
  const got = await (await staffCall(s, 'GET', '/api/roster')).json();
  const done = got.state.jobs.find(j => j.kind === 'request');
  assert.equal(done.status, 'done');
  const readded = { ...done, id: 'readded1', status: 'waiting', doneAt: '' };
  const put = await staffCall(s, 'PUT', '/api/roster', { base: got.version, state: { ...got.state, jobs: [...got.state.jobs.filter(j => j.id !== done.id), readded] } });
  assert.equal(put.status, 200);
  const after = stored(s).jobs;
  assert.ok(!after.some(j => j.id === 'readded1'), '足し直した予定は置かない');
  assert.ok(!after.some(j => j.kind === 'request' && j.status === 'waiting'));
  s.io.clock = NOW + 15 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, '2 回目のお願いは出ない');
  /* 新しい予約を画面が入れた（その予約の予定はサーバーに無い）ときは、待ちで受ける */
  const again = await (await staffCall(s, 'GET', '/api/roster')).json();
  const b = again.state.bookings[0];
  const newBooking = { ...b, id: 'bk-new1' };
  const person = { ...again.state.people[0], id: 'pe-new1', bookingId: 'bk-new1' };
  const job = { ...done, id: 'jb-new1', bookingId: 'bk-new1', status: 'waiting', doneAt: '' };
  const fresh = await staffCall(s, 'PUT', '/api/roster', { base: again.version, state: { ...again.state, bookings: [...again.state.bookings, newBooking], people: [...again.state.people, person],
    jobs: [...again.state.jobs, job] } });
  assert.equal(fresh.status, 200);
  assert.deepEqual(stored(s).jobs.filter(j => j.bookingId === 'bk-new1').map(j => [j.kind, j.status]), [['request', 'waiting']], '新しい予約の予定は受ける');
});

test('M08 serverOwned: 同じ予約・同じ種類の予定は、サーバーにあれば画面の物を使わない。同じ予約でも種類が違えば受ける', () => {
  const job = (id, kind, status, bookingId = 'b1') => ({ id, kind, bookingId, status, due: '2026-10-27T10:00', doneAt: '' });
  const storedState = { bookings: [{ id: 'b1' }], jobs: [job('j1', 'request', 'done'), job('j2', 'remind', 'waiting')], outbox: [] };
  const incoming = { bookings: [{ id: 'b1' }], jobs: [job('x1', 'request', 'waiting'), job('j2', 'remind', 'skipped'), job('x2', 'eve', 'waiting'), job('x3', 'eve', 'waiting')], outbox: [] };
  const got = A.serverOwned(storedState, incoming).jobs;
  assert.deepEqual(got.map(j => [j.id, j.kind, j.status]), [['j2', 'remind', 'waiting'], ['x2', 'eve', 'waiting']], '今ある予定はサーバーの物、足し直しは落とす、新しい種類は 1 つだけ');
});

/* ---------- M09: Access の JWT の期限切れを断る ---------- */

test('M09 Access の期限: 期限切れの JWT は、名簿・リンク作り・読めなかったメールの道のどれでも 403（access-exp）。時計のずれ 60 秒までは許す', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  const nowS = NOW / 1000;
  const expired = await jwtFor(STAFF, { exp: nowS - 3600 });
  for (const [method, path, body] of [['GET', '/api/roster'], ['POST', '/api/ask-link', { bookingId: stored(s).bookings[0].id }], ['GET', '/api/mail-unread'], ['GET', '/api/roster/past?from=2026-01-01&to=2026-01-31']]) {
    logs.length = 0;
    const res = await staffCall(s, method, path, body, { jwt: expired });
    assert.equal(res.status, 403, path);
    assert.ok(logs.some(l => l.includes('"why":"access-exp"')), `${path} の理由は exp`);
  }
  const check = async (exp) => verifyAccess(new Request(`${ORIGIN}/api/roster`, { headers: { 'cf-access-jwt-assertion': await jwtFor(STAFF, { exp }) } }), s.env, s.io);
  assert.deepEqual(await check(nowS - 61), { ok: false, why: 'exp' });
  assert.deepEqual(await check(nowS - 1000000), { ok: false, why: 'exp' });
  assert.deepEqual(await check('later'), { ok: false, why: 'exp' });
  assert.deepEqual(await check(undefined), { ok: false, why: 'exp' });
  assert.deepEqual(await check(nowS - 30), { ok: true, email: STAFF }, '30 秒前に切れた物は時計のずれとして通す');
  assert.equal((await staffCall(s, 'GET', '/api/roster')).status, 200, '期限内の JWT は通る');
});

/* ---------- M19: 1 回に印を付けて送る数は 10 件まで ---------- */

test('M19 claimQueued: 1 回に印を付けるのは 10 件。残りは次の回', () => {
  assert.equal(CLAIM_MAX, 10);
  const outbox = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}`, to: 'a@mail.example', status: 'queued', why: '' }));
  const first = claimQueued({ outbox }, { token: 't1' });
  assert.deepEqual(claimedBy(first, 't1').map(o => o.id), outbox.slice(0, 10).map(o => o.id));
  assert.equal(first.outbox.filter(o => o.why.startsWith(SENDING)).length, 10);
  const second = claimQueued(first, { token: 't2' });
  assert.deepEqual(claimedBy(second, 't2').map(o => o.id), outbox.slice(10, 20).map(o => o.id), '印のある物は飛ばして次の 10 件');
  assert.deepEqual(claimQueued({ outbox: [] }, { token: 't' }), { outbox: [] });
});

test('M19 Cron: 25 通たまっていても 1 回の Cron が出すのは 10 通。10・10・5 の 3 回で全部出て、重ならない', async () => {
  const s = await booked();
  const st = stored(s);
  putState(s, { ...st, outbox: Array.from({ length: 25 }, (_, i) => queuedItem(st, `q${String(i).padStart(2, '0')}`)) }, { version: s.db.rows.get('default').version + 1 });
  const counts = [];
  for (let i = 0; i < 4; i += 1) {
    const before = s.mail.sent.length;
    await scheduled(s.env, s.io);
    counts.push(s.mail.sent.length - before);
  }
  assert.deepEqual(counts, [10, 10, 5, 0]);
  assert.ok(stored(s).outbox.every(o => o.status === 'sent'));
});

/* ---------- M21: /api/ask の 1 つの IP からの回数 ---------- */

test('M21 お客さんの Worker: 1 つの IP からの回数を超えたら 429（鍵の回数も DB も使わない）。別の IP は通る。回数の binding が壊れていれば受けない側に倒す', async () => {
  const s = await booked();
  const bookingId = stored(s).bookings[0].id;
  const made = await (await staffCall(s, 'POST', '/api/ask-link', { bookingId })).json();
  const key = made.url.split('#k=')[1];
  const env = { ...publicEnv(s), ASK_LIMIT: fakeRateLimit(3) };
  const view = (ip) => guestCall(s, { k: key, action: 'view' }, { ip, env });
  for (let i = 0; i < 3; i += 1) assert.equal((await view('192.0.2.7')).status, 200, `${i + 1} 回目`);
  const uses = () => [...s.db.links.values()].find(l => l.booking_id === bookingId).uses;
  const used = uses();
  const blocked = await view('192.0.2.7');
  assert.deepEqual([blocked.status, await blocked.json()], [429, { error: 'limit' }]);
  assert.equal(uses(), used, '止めた分は鍵の回数にも数えない');
  assert.equal((await view('192.0.2.8')).status, 200, '別の IP は通る');
  const noIp = (limiter) => handlePublic(new Request(`${ASK_ORIGIN}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ k: key, action: 'view' }) }), { ...publicEnv(s), ASK_LIMIT: limiter }, s.io);
  const shared = fakeRateLimit(2);
  assert.deepEqual([(await noIp(shared)).status, (await noIp(shared)).status, (await noIp(shared)).status], [200, 200, 429], 'IP の分からない要求はまとめて数える');
  for (const broken of [{ limit: async () => { throw new Error('binding down'); } }, { limit: async () => undefined }, { limit: async () => ({ success: false }) }]) {
    assert.equal((await noIp(broken)).status, 429);
  }
  assert.equal(await underLimit(env.ASK_LIMIT, '198.51.100.9'), true);
});

/* ---------- M24: 送り元に @ が無ければ送らない ---------- */

test('M24 mailReady: 送り元に @ が無い・文字でない・binding が無い・リンクの先が https でないときは送れる設定とは言わない', () => {
  const ok = { EMAIL: { send: async () => ({}) }, MAIL_FROM: 'yoyaku@shop.example', APP_URL: 'https://app.example.workers.dev' };
  assert.equal(mailReady(ok), true);
  assert.equal(mailReady({ ...ok, APP_URL: 'http://localhost:8787' }), true, '手元の確かめだけ http');
  for (const [name, patch] of [['@ なし', { MAIL_FROM: 'yoyaku.shop.example' }], ['空', { MAIL_FROM: '' }], ['名前だけ', { MAIL_FROM: 'yoyaku' }], ['数', { MAIL_FROM: 12345 }],
    ['無い', { MAIL_FROM: undefined }], ['binding なし', { EMAIL: undefined }], ['send が関数でない', { EMAIL: { send: 'x' } }], ['http の先', { APP_URL: 'http://app.example.com' }],
    ['URL でない', { APP_URL: 'app.example.com' }], ['先が無い', { APP_URL: undefined }]]) {
    assert.equal(mailReady({ ...ok, ...patch }), false, name);
  }
});

test('M24 Cron: 送り元に @ が無い設定では 1 通も送らず、unsent（no-mail-config）にする。設定を直して送り直しを頼めば出る', async () => {
  for (const [name, patch] of [['@ なし', { MAIL_FROM: 'yoyaku.shop.example' }], ['名前だけ', { MAIL_FROM: 'yoyaku' }], ['binding なし', { EMAIL: undefined }]]) {
    const s = setup(patch);
    assert.equal((await siteBooking(s, ONE)).status, 202);
    await scheduled(s.env, s.io);
    assert.equal(s.mail.sent.length, 0, name);
    assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['unsent', 'no-mail-config']], name);
  }
  const s = setup({ MAIL_FROM: 'yoyaku.shop.example' });
  assert.equal((await siteBooking(s, ONE)).status, 202);
  await scheduled(s.env, s.io);
  s.env.MAIL_FROM = 'yoyaku@shop.example';
  const got = await (await staffCall(s, 'GET', '/api/roster')).json();
  const asked = { ...got.state, outbox: got.state.outbox.map(o => ({ ...o, why: 'resend' })) };
  assert.equal((await staffCall(s, 'PUT', '/api/roster', { base: got.version, state: asked })).status, 200);
  s.io.clock = NOW + 15 * 60000;
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.from.email), ['yoyaku@shop.example']);
});

await runTests(tests);
