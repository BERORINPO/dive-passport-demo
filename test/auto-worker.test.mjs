// 書類の自動化の Worker 側（worker/auto.mjs・auto-core.mjs・mail.mjs・site-guard.mjs）を、外との境目を見本に差し替えて確かめる。
// サイトの予約フォーム（POST /api/bookings）の守りの順番、Cron で時刻が来た予定が動いて送られること、届いた予約メールが名簿に入ること。
// 実行: node test/auto-worker.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../worker/handler.mjs';
import { scheduled, receiveMail, changeRoster } from '../worker/auto.mjs';
import { checkBooking, mailText, senderAllowed, senderVerdict, trustedAuth, parseAuthResults, headerList, headerFromDomain, forwarderOf, roomForPublic, TOURS, SWIM, EXP, WORRIES, SWIM_JA, WORRY_JA } from '../worker/auto-core.mjs';
import { MAX_ROSTER_BYTES } from '../worker/sync-core.mjs';
import { fakeKv, fakeAnthropic, fakeD1, fakeMail, fakeTurnstile, fakeRateLimit, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const SITE = 'https://aquagate.example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
const CF_ID = 'mx.cloudflare.net';   // Cloudflare が付ける Authentication-Results の名前（本番に届いた 1 通で見て MAIL_AUTHSERV_ID に入れる）
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const REAL_LOG = console.log;
const logs = [];
console.log = (line) => logs.push(String(line));

function setup(over = {}) {
  const db = fakeD1();
  const mail = fakeMail();
  const turnstile = fakeTurnstile();
  const api = fakeAnthropic();
  const env = {
    SITE_ORIGINS: `${SITE}, https://other.example.com`, TURNSTILE_SECRET: 'turnstile-test-secret', DB: db, BOOKING_LIMIT: fakeRateLimit(5),
    ANTHROPIC_API_KEY: 'sk-test-not-real', DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), SHOP_NAME: 'B マリン（見本）',
    EMAIL: mail, MAIL_FROM: 'yoyaku@shop.example', APP_URL: ORIGIN, MAIL_SENDERS: 'forward@shop.example, @booking.example', MAIL_AUTHSERV_ID: CF_ID, SINGLE_SHOP: 'default', ...over
  };
  const io = {
    clock: NOW,
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === SITEVERIFY) return turnstile.respond(init);
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  return { db, mail, turnstile, api, env, io };
}

const GOOD = { tour: 'dive', date: '2026-11-03', people: 2, name: '見本 花子', email: 'hanako@mail.example', lang: 'ja', swim: 'shallow', exp: 'first',
  dives: '', worries: ['ears'], phone: '090-0000-0000', note: '' };

function booking(body, { origin = SITE, token = 'ok-token', ip = '203.0.113.5', method = 'POST', type = 'application/json' } = {}) {
  const h = {};
  if (origin) h.origin = origin;
  if (token) h['cf-turnstile-response'] = token;
  if (ip) h['cf-connecting-ip'] = ip;
  if (method === 'POST' && type) h['content-type'] = type;
  return new Request(`${ORIGIN}/api/bookings`, { method, headers: h, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
}
const stored = (db) => JSON.parse(db.rows.get('default').state);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('予約を受ける口の項目は、画面の js/data.js とそろっている', () => {
  const ctx = vm.createContext({});
  ctx.window = ctx;
  ctx.REDUX = {};
  vm.runInContext(readFileSync(new URL('../js/data.js', import.meta.url), 'utf8'), ctx);
  const D = ctx.REDUX;
  const plain = (v) => JSON.parse(JSON.stringify(v));   // vm の配列は別の realm なので、形だけで比べる
  assert.deepEqual(TOURS.map(t => [t.id, t.diving, t.start, t.name.ja]), plain(D.TOURS.map(t => [t.id, t.diving, t.start, t.name.ja])));
  assert.deepEqual(SWIM, plain(D.SWIM.map(x => x.id)));
  assert.deepEqual(EXP, plain(D.EXP.map(x => x.id)));
  assert.deepEqual(WORRIES, plain(D.WORRIES.map(x => x.id)));
  assert.deepEqual(SWIM.map(k => SWIM_JA[k]), plain(D.SWIM.map(x => x.ja)));
  assert.deepEqual(WORRIES.map(k => WORRY_JA[k]), plain(D.WORRIES.map(x => x.ja)));
});

test('予約の本文の検査: 足りない・余分・過去の日・メールが無い・電話に文字、を断る。メモの健康のことは外す', () => {
  const today = '2026-10-27';
  assert.equal(checkBooking(GOOD, { today }).ok, true);
  const bad = (patch, want) => {
    const r = checkBooking({ ...GOOD, ...patch }, { today });
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.error.includes(want), `${JSON.stringify(patch)} → ${r.error}`);
  };
  bad({ extra: 1 }, 'keys');
  bad({ date: '2026-10-26' }, 'date');
  bad({ date: '2028-01-01' }, 'date');
  bad({ email: '' }, 'email');
  bad({ email: 'not-mail' }, 'email');
  bad({ people: 0 }, 'people');
  bad({ people: 11 }, 'people');   // サイトからは 1 件 10 人まで（名簿をふくらませない。ザクのレビュー H-1）
  bad({ name: 'Win a prize at https://evil.example' }, 'name');   // メールの 1 行目に入るので、URL・ドメイン・改行は断る（M-2）
  bad({ name: '見本\n花子' }, 'name');
  bad({ name: 'go to evil.example' }, 'name');
  bad({ tour: 'jetski' }, 'tour');
  bad({ phone: 'call me' }, 'phone');
  bad({ worries: ['ears', 'x'] }, 'worries');
  bad({ note: 'x'.repeat(401) }, 'note');
  assert.equal(checkBooking([], { today }).ok, false);
  const withNote = checkBooking({ ...GOOD, note: '2 人で行きます\n持病: 喘息があります' }, { today });
  assert.ok(withNote.ok);
  assert.ok(withNote.booking.note.includes('2 人で行きます'));
  assert.ok(!withNote.booking.note.includes('喘息'), 'メモの健康のことは名簿に入れない');
  assert.ok(checkBooking({ ...GOOD, name: 'J. Smith' }, { today }).ok, 'ふつうの名前の点は通る');
  const told = checkBooking({ ...GOOD, swim: 'shallow', worries: ['seasick', 'ears'], note: '初めてです' }, { today });
  assert.equal(told.booking.note, '泳ぎ: 足のつく所なら泳げる／心配: 船酔いしやすい・耳抜きが心配\n初めてです', '泳ぎと心配なことはメモの頭に残す');
});

test('外からの予約の守り: 名簿が上限の 7 割を超えたら外からは入れない・1 日の件数・Turnstile の hostname と action', async () => {
  assert.ok(roomForPublic('x'.repeat(MAX_ROSTER_BYTES * 0.7)));
  assert.ok(!roomForPublic('x'.repeat(MAX_ROSTER_BYTES * 0.7 + 1)));
  const s = setup();
  s.turnstile.hostname = 'evil.example.com';
  assert.equal((await handle(booking(GOOD), s.env, s.io)).status, 403, '別のサイトで解いた答えは通さない');
  s.turnstile.hostname = 'aquagate.example.com';
  s.turnstile.action = 'login';
  assert.equal((await handle(booking(GOOD), s.env, s.io)).status, 403, 'action が booking でない答えは通さない');
  s.turnstile.action = 'booking';
  s.db.setCount('site', 'default', '2026-10-27', 30);
  const full = await handle(booking(GOOD, { ip: '198.51.100.20' }), s.env, s.io);
  assert.equal(full.status, 429, 'サイトからの予約は 1 日 30 件まで');
  assert.equal(s.db.writes, 0);
});

test('1 日の件数は D1 で正確に数える: 同じ秒に続けて届いても全部受け、30 件目の次で止まる。D1 が答えないときは「上限」でなく 503', async () => {
  const s = setup();
  s.turnstile.hostname = 'aquagate.example.com';
  for (let i = 0; i < 5; i += 1) {
    const r = await handle(booking({ ...GOOD, email: `guest${i}@mail.example`, name: `見本 ${i}` }, { ip: `203.0.113.${i + 40}` }), s.env, s.io);
    assert.equal(r.status, 202, `${i + 1} 件目`);
  }
  assert.equal(s.db.daily.get('site\ndefault\n2026-10-27'), 5);
  assert.equal(s.env.BUDGET.puts.length, 0, 'KV には書かない');
  s.db.setCount('site', 'default', '2026-10-27', 29);
  assert.equal((await handle(booking(GOOD, { ip: '198.51.100.41' }), s.env, s.io)).status, 202, '30 件目は通る');
  assert.equal((await handle(booking(GOOD, { ip: '198.51.100.42' }), s.env, s.io)).status, 429, '31 件目は止まる');
  assert.equal(s.db.daily.get('site\ndefault\n2026-10-27'), 30, '止めた分は数えない');
  const { takeSiteBooking } = await import('../worker/auto.mjs');
  const note = {};
  s.db.failing = true;
  const down = await takeSiteBooking(GOOD, s.env, s.io, note);
  assert.deepEqual([down.status, down.body.error, note.why], [503, 'db', 'limit-db']);
});

test('POST /api/bookings: 許した origin だけ。OPTIONS はその origin にだけ CORS を返す', async () => {
  const s = setup();
  const other = await handle(booking(GOOD, { origin: 'https://evil.example.com' }), s.env, s.io);
  assert.equal(other.status, 403);
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  const none = await handle(booking(GOOD, { origin: '' }), s.env, s.io);
  assert.equal(none.status, 403);
  const pre = await handle(booking(null, { method: 'OPTIONS' }), s.env, s.io);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  assert.match(pre.headers.get('access-control-allow-headers'), /cf-turnstile-response/);
  const get = await handle(booking(null, { method: 'GET' }), s.env, s.io);
  assert.equal(get.status, 405);
  assert.equal(s.db.writes, 0);
});

test('POST /api/bookings: 設定が欠けたら 503、種類が違えば 415、Turnstile が無い・通らなければ 403、本文が大きければ 413', async () => {
  const s = setup({ TURNSTILE_SECRET: '' });
  assert.equal((await handle(booking(GOOD), s.env, s.io)).status, 503);
  const t = setup();
  assert.equal((await handle(booking(GOOD, { type: 'text/plain' }), t.env, t.io)).status, 415);
  assert.equal((await handle(booking(GOOD, { token: '' }), t.env, t.io)).status, 403);
  t.turnstile.success = false;
  assert.equal((await handle(booking(GOOD), t.env, t.io)).status, 403);
  assert.equal(t.turnstile.calls[0].secret, 'turnstile-test-secret');
  assert.equal(t.turnstile.calls[0].remoteip, '203.0.113.5');
  t.turnstile.success = true;
  assert.equal((await handle(booking('x'.repeat(5000)), t.env, t.io)).status, 413);
  assert.equal((await handle(booking('{bad'), t.env, t.io)).status, 400);
  assert.equal((await handle(booking({ ...GOOD, email: '' }), t.env, t.io)).status, 400);
  assert.equal(t.db.writes, 0, '断った予約は名簿に入れない');
});

test('POST /api/bookings: 1 つの IP からは 5 回まで。6 回目は Turnstile も呼ばずに 429', async () => {
  const s = setup();
  for (let i = 0; i < 5; i += 1) assert.equal((await handle(booking({ ...GOOD, name: `見本 ${i}` }), s.env, s.io)).status, 202);
  const calls = s.turnstile.calls.length;
  assert.equal((await handle(booking(GOOD), s.env, s.io)).status, 429);
  assert.equal(s.turnstile.calls.length, calls);
  assert.equal((await handle(booking(GOOD, { ip: '203.0.113.9' }), s.env, s.io)).status, 202, '別の IP は通る');
});

test('POST /api/bookings: 予約が便に入り、予定が作られる。お願いのメールは次の Cron で送る。ログに名前もメールも出ない', async () => {
  const s = setup();
  logs.length = 0;
  const res = await handle(booking({ ...GOOD, note: '2 人とも初めてです' }), s.env, s.io);
  assert.equal(res.status, 202);
  assert.equal(s.mail.sent.length, 0, '外からの入口では送らない（重なって 2 回送らない。ザクのレビュー M-1）');
  assert.equal((stored(s.db).outbox || []).length, 0);
  await scheduled(s.env, s.io);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get('access-control-allow-origin'), SITE);
  const st = stored(s.db);
  const b = st.bookings[0];
  assert.equal(b.leadEmail, 'hanako@mail.example');
  assert.equal(b.leadPhone, '090-0000-0000');
  assert.equal(b.note, '泳ぎ: 足のつく所なら泳げる／心配: 耳抜きが心配\n2 人とも初めてです');
  assert.equal(st.trips[0].date, '2026-11-03');
  assert.deepEqual(st.jobs.map(j => [j.kind, j.status]), [['request', 'done'], ['remind', 'waiting'], ['eve', 'waiting'], ['morning', 'waiting']]);
  assert.equal(st.outbox.length, 1);
  assert.equal(st.outbox[0].status, 'sent');
  assert.equal(s.mail.sent.length, 1);
  assert.equal(s.mail.sent[0].to, 'hanako@mail.example');
  assert.deepEqual(s.mail.sent[0].from, { email: 'yoyaku@shop.example', name: 'B マリン（見本）' });
  const link = s.mail.sent[0].text.match(/https:\/\/\S+\/ask#k=([A-Za-z0-9_-]{43})/);
  assert.ok(link && link[0].startsWith(`${ORIGIN}/ask#k=`), 'お客さんに聞くリンク（予約ごとの鍵）が入る');
  assert.ok(!s.mail.sent[0].text.includes(b.id), 'リンクに予約の id は入れない');
  assert.ok(!JSON.stringify(st).includes(link[1]), '鍵は名簿に残さない（名簿には印だけ）');
  assert.ok(st.outbox[0].body.includes('[[ask-link]]'));
  assert.equal(s.db.links.size, 1, 'D1 には鍵の SHA-256 だけ');
  assert.ok(![...s.db.links.keys()].includes(link[1]));
  const line = logs.find(l => l.includes('"route":"cron"'));
  assert.ok(line && /"sent":1/.test(line), line);
  assert.ok(!logs.join('\n').includes('hanako') && !logs.join('\n').includes('花子'), 'ログに中身を出さない');
});

test('メールの設定がそろわないうちは送らず、unsent（no-mail-config）にする。送れなかったら failed', async () => {
  const s = setup({ MAIL_FROM: '' });
  assert.equal((await handle(booking(GOOD), s.env, s.io)).status, 202);
  await scheduled(s.env, s.io);
  assert.deepEqual(stored(s.db).outbox.map(o => [o.status, o.why]), [['unsent', 'no-mail-config']]);
  assert.equal(s.mail.sent.length, 0);
  const f = setup();
  f.mail.fail = 'E_DELIVERY_FAILED';
  assert.equal((await handle(booking(GOOD), f.env, f.io)).status, 202);
  await scheduled(f.env, f.io);
  assert.deepEqual(stored(f.db).outbox.map(o => [o.status, o.why]), [['failed', 'E_DELIVERY_FAILED']]);
});

test('Cron: 時刻が来た予定（2 日前・前日の夜・当日の朝）が動き、送る物を送る。名簿が無ければ何もしない', async () => {
  const empty = setup();
  await scheduled(empty.env, empty.io);
  assert.equal(empty.db.writes, 0);
  const s = setup();
  await handle(booking(GOOD), s.env, s.io);
  await scheduled(s.env, s.io);
  s.mail.sent.length = 0;
  s.io.clock = Date.parse('2026-11-01T00:00:00Z');   // 日本で 11/1 の 9:00（2 日前）
  await scheduled(s.env, s.io);
  let st = stored(s.db);
  assert.equal(st.jobs.find(j => j.kind === 'remind').status, 'done');
  assert.deepEqual(s.mail.sent.map(m => m.to), ['hanako@mail.example']);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1, '同じ時刻にもう一度動いても、二度は送らない');
  s.io.clock = Date.parse('2026-11-02T11:00:00Z');   // 日本で 11/2 の 20:00（前日の夜）
  await scheduled(s.env, s.io);
  s.io.clock = Date.parse('2026-11-02T21:00:00Z');   // 日本で 11/3 の 6:00（当日の朝）
  await scheduled(s.env, s.io);
  st = stored(s.db);
  assert.ok(st.jobs.every(j => j.status === 'done'));
  assert.ok(st.trips[0].rosterAt, '当日の朝に名簿を作った印');
  assert.ok(st.outbox.some(o => o.kind === 'staff' && o.status === 'notice'), '前日の夜までにそろわなければお店に知らせる');
  assert.ok(s.mail.sent.length >= 2);
});

test('ジンのレビュー MEDIUM 10: 送ったあとに結果を書けなくても、次の回にもう一度は送らない。30 分たっても印が残っていれば「送れたか分からない」にする', async () => {
  const s = setup();
  await handle(booking(GOOD), s.env, s.io);
  /* 送った直後に D1 が止まり、結果を書けない */
  const send = s.mail.send;
  s.mail.send = async (msg) => { const r = await send(msg); s.db.failing = true; return r; };
  await assert.rejects(scheduled(s.env, s.io), /cron failed/, '全部のお店で失敗した回は Cron の履歴にも失敗と残す');
  s.db.failing = false;
  s.mail.send = send;
  assert.equal(s.mail.sent.length, 1);
  let out = stored(s.db).outbox.find(o => o.kind === 'request');
  assert.equal(out.status, 'queued');
  assert.ok(out.why.startsWith('sending:'), '送る前の印が残っている');
  s.io.clock = NOW + 10 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1, '印のある連絡は、もう一度は送らない');
  s.io.clock = NOW + 31 * 60000;
  await scheduled(s.env, s.io);
  out = stored(s.db).outbox.find(o => o.kind === 'request');
  assert.equal(out.status, 'failed');
  assert.equal(out.why, 'maybe-sent');
  assert.equal(s.mail.sent.length, 1);
});

test('送り直し: 送れたか分からない連絡をお店が送り直すと、次の Cron で 1 通だけ送る。2 回押しても、Cron が重なっても 2 通にならない', async () => {
  const s = setup();
  await handle(booking(GOOD), s.env, s.io);
  const send = s.mail.send;
  s.mail.send = async (msg) => { const r = await send(msg); s.db.failing = true; return r; };
  await assert.rejects(scheduled(s.env, s.io), /cron failed/, '全部のお店で失敗した回は Cron の履歴にも失敗と残す');
  s.db.failing = false;
  s.mail.send = send;
  s.io.clock = NOW + 31 * 60000;
  await scheduled(s.env, s.io);
  const id = stored(s.db).outbox[0].id;
  assert.equal(stored(s.db).outbox[0].why, 'maybe-sent');
  /* 画面の「届いていない・送り直す」（画面の書き込みと同じく、名簿 → 名簿の直しを当てて書く）。2 台から押した形で 2 回 */
  const A = globalThis.REDUX.rosterAuto;
  const press = () => changeRoster(s.env, s.io, st => A.resend(st, { id, nowJst: '2026-10-27T10:31', at: new Date(s.io.clock).toISOString(), newId: () => `re${s.io.clock}`, askBase: '' }));
  assert.ok((await press()).ok);
  assert.ok((await press()).ok);
  let outbox = stored(s.db).outbox;
  assert.deepEqual(outbox.map(o => [o.status, o.why]), [['failed', 'resent'], ['queued', '']], '新しい連絡は 1 つ');
  assert.ok(outbox[1].body.includes(A.LINK_MARK), 'リンクは送るときに作る');
  /* Cron が 2 つ重なって走る */
  s.io.clock = NOW + 45 * 60000;
  await Promise.all([scheduled(s.env, s.io), scheduled(s.env, s.io)]);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 2, '最初の 1 通と、送り直しの 1 通だけ');
  assert.ok(!s.mail.sent[1].text.includes(A.LINK_MARK), '送った文面には印でなくリンクが入る');
  outbox = stored(s.db).outbox;
  assert.deepEqual(outbox.map(o => [o.status, o.why]), [['failed', 'resent'], ['sent', '']]);
});

test('ジンのレビュー 2026-10-28 H2: 名簿に入り込んだ連絡でも、Cron は宛先と本文を今の予約から作り直して送る（書いてある宛先・本文・リンクは使わない）', async () => {
  const s = setup({ ASK_ORIGIN: 'https://ask.example.com' });
  await handle(booking(GOOD), s.env, s.io);
  await scheduled(s.env, s.io);   // 最初のお願いを送る
  s.mail.sent.length = 0;
  const st0 = stored(s.db);
  const b = st0.bookings[0];
  const evil = { ...st0.outbox[0], id: 'evil1', to: 'victim@attacker.example', subject: '差し替えた件名', body: `差し替えた本文 ${ORIGIN}/#ask=${b.id}`, status: 'queued', why: '', sentAt: '' };
  assert.ok((await changeRoster(s.env, s.io, st => ({ state: { ...st, outbox: [...st.outbox, evil] } }))).ok);
  s.io.clock = NOW + 16 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
  const m = s.mail.sent[0];
  assert.equal(m.to, GOOD.email, '宛先は予約のメール');
  assert.ok(!m.text.includes('差し替えた') && !m.subject.includes('差し替えた'), '本文と件名は決まった文面');
  assert.ok(m.text.includes('https://ask.example.com/') && !m.text.includes(ORIGIN), 'リンクはお客さんの住所（Access の中の住所は入れない）');
});

test('ザクのレビュー 2026-10-28 MEDIUM-1: スタッフが書ける名前・ツアーに改行や URL を入れても、Cron が作るメールには入らない', async () => {
  const s = setup({ ASK_ORIGIN: 'https://ask.example.com' });
  await handle(booking(GOOD), s.env, s.io);
  const evil = '見本\n\n【重要】こちらから再入力 https://evil.example/x www.evil.jp evil.com';
  assert.ok((await changeRoster(s.env, s.io, st => ({ state: {
    ...st,
    bookings: st.bookings.map(b => ({ ...b, leadName: evil })),
    people: st.people.map(p => ({ ...p, name: evil })),
    trips: st.trips.map(t => ({ ...t, tour: `${t.tour}\nhttp://evil.example` }))
  } }))).ok);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
  const m = s.mail.sent[0];
  for (const bad of ['evil.example', 'www.evil', 'evil.com', '\n\n【重要】']) {
    assert.ok(!m.text.includes(bad) && !m.subject.includes(bad), `メールに「${bad.trim()}」が入らない`);
  }
  assert.ok(m.text.startsWith('見本 【重要】こちらから再入力 様\n'), '名前は 1 行の文字として残る');
  assert.ok(m.text.includes('https://ask.example.com/'), 'リンクはお店のお願いのリンクだけ');
});

test('ジンのレビュー 2026-10-28 H1: 画面は送り直しを頼むだけ（requestResend）。次の Cron が今の予約から 1 通だけ作って送る。2 回頼んでも 1 通', async () => {
  const s = setup();
  await handle(booking(GOOD), s.env, s.io);
  const send = s.mail.send;
  s.mail.send = async (msg) => { const r = await send(msg); s.db.failing = true; return r; };
  await assert.rejects(scheduled(s.env, s.io), /cron failed/, '全部のお店で失敗した回は Cron の履歴にも失敗と残す');
  s.db.failing = false;
  s.mail.send = send;
  s.io.clock = NOW + 31 * 60000;
  await scheduled(s.env, s.io);
  const id = stored(s.db).outbox[0].id;
  const A = globalThis.REDUX.rosterAuto;
  const ask = () => changeRoster(s.env, s.io, st => ({ state: A.requestResend(st, { id, nowJst: '2026-10-27T10:31' }).state }));
  assert.ok((await ask()).ok);
  assert.ok((await ask()).ok);
  assert.deepEqual(stored(s.db).outbox.map(o => [o.status, o.why]), [['failed', 'resend']], '頼んだ印だけ。連絡はまだ作らない');
  s.io.clock = NOW + 46 * 60000;
  await scheduled(s.env, s.io);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 2, '最初の 1 通と、送り直しの 1 通だけ');
  assert.deepEqual(stored(s.db).outbox.map(o => [o.status, o.why]), [['failed', 'resent'], ['sent', '']]);
});

test('ジンのレビュー: 1 回に印を付けて送るのは 10 件まで。残りは次の回に送る', async () => {
  const s = setup();
  for (let i = 0; i < 12; i += 1) {
    const r = await handle(booking({ ...GOOD, email: `guest${i}@mail.example`, name: `見本 ${i}` }, { ip: `203.0.113.${i + 10}` }), s.env, s.io);
    assert.equal(r.status, 202);
  }
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 10);
  s.io.clock = NOW + 15 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 12);
  assert.equal(new Set(s.mail.sent.map(m => m.to)).size, 12, '同じ人に 2 回は送らない');
});

/* 届いたメールの見本（Email Routing が渡す形） */
const PASS = `${CF_ID}; dkim=pass header.d=booking.example header.s=s1; spf=pass smtp.mailfrom=forward@shop.example; dmarc=pass`;
/* auth は Cloudflare が一番上に付けた Authentication-Results の値。extra は message.headers にだけ入れる値（本物の Worker では同じ名前が「, 」でつながって見える） */
function message(raw, from = 'forward@shop.example', auth = PASS, extra = '') {
  const bytes = new TextEncoder().encode(`Authentication-Results: ${auth}\r\n${raw}`);
  return {
    from, to: 'yoyaku@shop.example', rawSize: bytes.byteLength, rejected: '', headers: new Headers({ 'authentication-results': extra ? `${auth}, ${extra}` : auth }),
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(why) { this.rejected = why; }
  };
}
/* 生のメールは 1 バイト 1 文字（worker/auto.mjs の readRaw と同じ） */
const latin1 = (text) => String.fromCharCode(...new TextEncoder().encode(text));
const MAIL_RAW = (body) => `From: Booking Site <noreply@booking.example>\r\nTo: forward@shop.example\r\nSubject: =?UTF-8?B?5LqI57SE?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

test('届いたメールの本文を取り出す: 平文・multipart の base64・quoted-printable・ISO-2022-JP・HTML だけ', () => {
  assert.equal(mailText(latin1(MAIL_RAW('予約番号 A-1\r\n2 名'))).text, '予約番号 A-1\n2 名');
  const b64 = Buffer.from('ご予約ありがとうございます。11/3 2 名', 'utf8').toString('base64');
  const multi = 'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>html</p>\r\n'
    + `--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n--b1--\r\n`;
  assert.equal(mailText(multi).text, 'ご予約ありがとうございます。11/3 2 名');
  const qp = 'Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=E4=BA=88=E7=B4=84 =\r\nOK';
  assert.equal(mailText(qp).text, '予約 OK');
  const jis = 'Content-Type: text/plain; charset=ISO-2022-JP\r\n\r\n\x1b$BM=Ls\x1b(B';
  assert.equal(mailText(jis).text, '予約');
  const html = 'Content-Type: text/html; charset=utf-8\r\n\r\n<div>日付: 11/3</div><script>x()</script><div>2 名 &amp; 子ども</div>';
  assert.equal(mailText(latin1(html)).text, '日付: 11/3\n2 名 & 子ども');
  const attach = 'Content-Type: multipart/mixed; boundary=z\r\n\r\n--z\r\nContent-Type: text/plain\r\nContent-Disposition: attachment\r\n\r\nsecret\r\n--z--';
  assert.equal(mailText(attach).ok, false, '添付は読まない');
  assert.equal(mailText('').ok, false);
  assert.ok(senderAllowed('Forward@Shop.example', 'a@x.example, forward@shop.example'));
  assert.ok(!senderAllowed('evil@x.example', 'forward@shop.example'));
  assert.ok(!senderAllowed('', ''));
  assert.ok(!senderAllowed('@booking.example', 'a@x.example, @booking.example'), '「@ドメイン」の行は送り主ではない');
});

/* ---------- 送り主の確かめ（ザクのレビュー 2026-10-28 SEC-01・02・04） ---------- */
const BOOKING = '@booking.example';
const eml = ({ ar = [], from = 'Booking Site <noreply@booking.example>', more = '' } = {}) =>
  `${ar.map(v => `Authentication-Results: ${v}\r\n`).join('')}${from === null ? '' : `From: ${from}\r\n`}${more}Subject: x\r\n\r\nbody`;
const cf = (spf, dkim = '') => `${CF_ID}; ${dkim ? `dkim=pass header.d=${dkim}; ` : ''}spf=${spf}; dmarc=pass`;
const verdict = (raw, envelope, senders, authservId = CF_ID) => senderVerdict({ raw, envelope, senders, authservId });
const FWD = 'forward@shop.example';
const SENDERS = `${FWD}, ${BOOKING}`;
const GOOD_AR = cf(`pass smtp.mailfrom=${FWD}`, 'booking.example');

test('SEC-01: 送り主が足した Authentication-Results では通らない。使うのは生の見出しの一番上の、Cloudflare の名前の 1 本だけ', () => {
  assert.deepEqual(verdict(eml({ ar: [GOOD_AR] }), FWD, SENDERS), { ok: true, via: 'relay' }, '本物だけなら通る（対照）');
  const real = cf(`fail smtp.mailfrom=${FWD}`, 'booking.example');
  const fake = `${CF_ID}; spf=pass smtp.mailfrom=${FWD}; dkim=pass header.d=booking.example`;
  assert.equal(verdict(eml({ ar: [real, fake] }), FWD, SENDERS).why, 'dup', '本物（fail）の下に同じ名前の偽の行');
  assert.equal(verdict(eml({ ar: [fake, real] }), FWD, SENDERS).why, 'dup', '偽の行が上でも同じ');
  assert.equal(verdict(eml({ ar: [fake.replace(CF_ID, 'evil.example'), real] }), FWD, SENDERS).why, 'top', '別の名前の偽の行が一番上');
  assert.equal(verdict(eml({ ar: [real, fake.replace(CF_ID, 'evil.example')] }), FWD, SENDERS).why, 'spf', '別の名前の偽の行が下なら読まない。本物は fail');
  assert.equal(verdict(eml({ ar: [fake.replace(CF_ID, 'evil.example')] }), FWD, SENDERS).why, 'top', '偽の行だけ');
  assert.equal(verdict(eml({ ar: [] }), FWD, SENDERS).why, 'no-header');
  assert.equal(verdict(eml({ more: `ARC-Authentication-Results: i=1; ${GOOD_AR}\r\n` }), FWD, SENDERS).why, 'no-header', 'ARC の行は信じない');
  assert.equal(verdict(`From: noreply@booking.example\r\n\r\nAuthentication-Results: ${GOOD_AR}\r\n`, FWD, SENDERS).why, 'no-header', '本文の中の行は見出しではない');
  assert.equal(verdict(eml({ ar: [GOOD_AR] }), FWD, SENDERS, '').why, 'config', '名前の設定が無ければ何も通さない');
  assert.equal(verdict(eml({ ar: [GOOD_AR] }), FWD, SENDERS, 'MX.Cloudflare.NET').ok, true, '名前の大文字小文字は見ない');
});

test('SEC-01: 見出しの折り返し・名前の書き方・続きの行で、Cloudflare の行に継ぎ足させない', () => {
  const real = cf(`fail smtp.mailfrom=${FWD}`, 'booking.example');
  const inject = `; spf=pass smtp.mailfrom=${FWD}`;
  assert.deepEqual(headerList('Subject: hi\r\n Authentication-Results: x; spf=pass\r\n\tmore\r\nFrom : a@b.example\r\nAUTHENTICATION-RESULTS: y\nno colon\r\n  tail\r\n\r\nFrom: body@x.example').map(h => h.name),
    ['subject', 'from', 'authentication-results'], '折り返しは前の見出しの続き。名前の大文字小文字と「:」の前の空白は許す。本文は見ない');
  assert.equal(headerList('Subject: hi\r\n Authentication-Results: x').length, 1);
  assert.equal(verdict(`Authentication-Results: ${real}\r\n ${inject}\r\nFrom: noreply@booking.example\r\n\r\nb`, FWD, SENDERS).why, 'spf', 'Cloudflare の行の直後の、空白で始まる行（元のメールの 1 行目）は続きになる。spf が 2 つになるので断る');
  assert.equal(verdict(`Authentication-Results: ${real}\r\nnot a header\r\n ${inject}\r\nFrom: noreply@booking.example\r\n\r\nb`, FWD, SENDERS).why, 'spf', '見出しの形でない行をはさんでも、続きの行は Cloudflare の行につながない（本物は fail のまま）');
  assert.equal(headerList(`Authentication-Results: ${real}\r\nnot a header\r\n ${inject}\r\n\r\nb`).length, 1);
  assert.equal(verdict(eml({ ar: [real], more: `Subject: a\r\n Authentication-Results: ${CF_ID}; spf=pass smtp.mailfrom=${FWD}\r\n` }), FWD, SENDERS).why, 'spf', '件名の続きに書いた行は見出しではない（dup にもならない）');
  assert.equal(verdict(eml({ ar: [`${CF_ID};\r\n spf=pass smtp.mailfrom=${FWD};\r\n dkim=pass header.d=booking.example`] }).replace(/\r\n/g, '\n'), FWD, SENDERS).ok, true, '折り返しと LF だけの改行');
  assert.equal(verdict(eml({ ar: [GOOD_AR.replace('pass', 'pass\u0000')] }), FWD, SENDERS).why, 'top', '制御文字入りの行は読まない');
  assert.equal(verdict(eml({ ar: [`${GOOD_AR}; x=" open`] }), FWD, SENDERS).why, 'top', '引用符が閉じない行は読まない');
  assert.equal(verdict(eml({ ar: [`${CF_ID}; spf=pass smtp.mailfrom=${FWD}; spf=pass smtp.mailfrom=${FWD}`] }), FWD, SENDERS).why, 'spf', 'SPF の結果が 2 つなら断る');
  assert.equal(verdict(eml({ ar: [`${CF_ID}; spf=pass smtp.mailfrom=${FWD}; bad token; dkim=pass header.d=booking.example`] }), FWD, SENDERS).why, 'top', '形の合わない結果が混じる行は丸ごと読まない');
  const quoted = parseAuthResults(`${CF_ID} (note; spf=pass); spf=pass smtp.mailfrom="x; spf=pass"@evil.example`);
  assert.equal(quoted.results.length, 1, 'コメントと引用符の中の「;」では区切らない');
  assert.equal(quoted.results[0].props['smtp.mailfrom'], '"x; spf=pass"@evil.example');
  assert.equal(parseAuthResults(`${CF_ID} 1; none`).results.length, 0);
  assert.equal(parseAuthResults('; spf=pass'), null);
});

test('SEC-01: 見出しの From は 1 本・アドレス 1 つだけ。表示名とコメントの中のアドレスは見ない', () => {
  const dom = (raw) => headerFromDomain(headerList(raw));
  assert.equal(dom('From: Booking Site <Noreply@Booking.Example>'), 'booking.example');
  assert.equal(dom('From: noreply@booking.example'), 'booking.example');
  assert.equal(dom('From: "noreply@booking.example" <attacker@evil.example>'), 'evil.example', '表示名の中のアドレスは見ない');
  assert.equal(dom('From: attacker@evil.example (noreply@booking.example)'), 'evil.example', 'コメントの中も見ない');
  assert.equal(dom('From: noreply@booking.example\r\nFrom: attacker@evil.example'), '', 'From が 2 本');
  assert.equal(dom('From: noreply@booking.example, attacker@evil.example'), '', 'アドレスが 2 つ');
  assert.equal(dom('From: team: noreply@booking.example, attacker@evil.example;'), '', 'グループ');
  assert.equal(dom('From: <noreply@booking.example> <attacker@evil.example>'), '', '山かっこが 2 組');
  assert.equal(dom('From: "unclosed <noreply@booking.example>'), '', '引用符が閉じない');
  assert.equal(dom('From: noreply@localhost'), '', '点の無いドメイン');
  assert.equal(dom('Subject: no from'), '');
});

test('SEC-02: 正しく署名された別のメールを流し直しても通らない（SPF が送り主の封筒と完全に同じで pass のときだけ）', () => {
  const GM = 'owner@gmail.com';
  const replay = (spf) => verdict(eml({ ar: [cf(spf, 'gmail.com')], from: 'Attacker <attacker@gmail.com>' }), GM, GM);
  assert.equal(replay('fail smtp.mailfrom=owner@gmail.com').why, 'spf', 'DKIM は gmail.com で pass でも、SPF が fail');
  assert.equal(replay('softfail smtp.mailfrom=owner@gmail.com').why, 'spf');
  assert.equal(replay('none').why, 'spf');
  assert.equal(replay('pass smtp.mailfrom=attacker@evil.example').why, 'spf', '自分のサーバーの SPF が pass でも、封筒と同じでない');
  assert.equal(replay('pass smtp.mailfrom=gmail.com').why, 'spf', 'ドメインだけの報告は完全一致でない');
  assert.equal(replay('pass smtp.mailfrom=OWNER@gmail.com').ok, true, '大文字小文字は見ない（対照: 送り主が自分で書いたメール）');
  assert.deepEqual(verdict(eml({ ar: [cf('pass smtp.mailfrom=owner@gmail.com')], from: 'Owner <owner@gmail.com>' }), GM, GM), { ok: true, via: 'own' }, '許した送り主が自分で送ったメールは通る');
  assert.equal(verdict(eml({ ar: [cf(`pass smtp.mailfrom=${FWD}`)], from: 'noreply@booking.example' }), FWD, FWD).why, 'origin', 'SPF は pass でも、見出しの From が別のドメインで、DKIM も表の指定も無い');
  assert.equal(verdict(eml({ ar: [cf(`pass smtp.mailfrom=${FWD}`, 'booking.example')], from: 'noreply@booking.example' }), FWD, FWD).why, 'origin', 'DKIM が通っても、表に「@ドメイン」が無ければ受けない');
  assert.equal(verdict(eml({ ar: [cf(`pass smtp.mailfrom=${FWD}`, 'mail.booking.example')], from: 'noreply@booking.example' }), FWD, SENDERS).why, 'origin', 'DKIM のドメインは完全に同じ（親子では合わせない）');
  assert.equal(verdict(eml({ ar: [cf('pass smtp.mailfrom=other@shop.example')] }), FWD, SENDERS).why, 'spf');
  assert.equal(verdict(eml({ ar: [GOOD_AR] }), 'not an address', SENDERS).why, 'sender');
});

test('SEC-04: Gmail・Microsoft 365 の転送は、転送した人の SPF（書き換わった封筒と完全一致）と、元の予約サイトの DKIM の両方がそろったときだけ通る', () => {
  const GM = 'owner+caf_=inbox=reduxdive.com@gmail.com';
  const S = `owner@gmail.com, ${BOOKING}`;
  const raw = (ar, from = 'Booking Site <noreply@booking.example>') => eml({ ar: [ar], from });
  assert.deepEqual(forwarderOf(GM), { forwarder: 'owner@gmail.com', rewritten: true });
  assert.deepEqual(forwarderOf('Owner@Gmail.com'), { forwarder: 'owner@gmail.com', rewritten: false });
  assert.deepEqual(forwarderOf('owner+caf_=x@evil.example'), { forwarder: 'owner+caf_=x@evil.example', rewritten: false }, 'gmail.com 以外の +caf_ は書き換えとして戻さない');
  assert.deepEqual(forwarderOf('attacker+owner+caf_=x=y@gmail.com'), { forwarder: 'attacker+owner@gmail.com', rewritten: true }, '最初の +caf_ より前を見る');
  assert.deepEqual(verdict(raw(cf(`pass smtp.mailfrom=${GM}`, 'booking.example')), GM, S), { ok: true, via: 'relay' }, '両方そろえば通る');
  assert.equal(verdict(raw(cf(`pass smtp.mailfrom=${GM}`, 'gmail.com')), GM, S).why, 'origin', 'DKIM が予約サイトでなく gmail.com');
  assert.equal(verdict(raw(cf(`pass smtp.mailfrom=${GM}`)), GM, S).why, 'origin', 'DKIM が無い');
  assert.equal(verdict(raw(cf(`fail smtp.mailfrom=${GM}`, 'booking.example')), GM, S).why, 'spf', '転送した人の SPF が fail');
  assert.equal(verdict(raw(cf('pass smtp.mailfrom=owner@gmail.com', 'booking.example')), GM, S).why, 'spf', 'SPF の対象が書き換わった封筒と違う');
  assert.equal(verdict(raw(cf(`pass smtp.mailfrom=${GM}`, 'evil.example'), 'x@evil.example'), GM, S).why, 'origin', '予約サイト以外の DKIM は、転送されてきても受けない');
  assert.equal(verdict(raw(cf(`pass smtp.mailfrom=${GM}`, 'gmail.com'), 'friend@gmail.com'), GM, S).why, 'origin', '転送された Gmail の誰かのメール。書き換えた封筒は「自分で書いた」にならない');
  assert.equal(verdict(raw(cf(`pass smtp.mailfrom=${GM}`, 'booking.example')), GM, 'owner@gmail.com').why, 'origin', '表に予約サイトの指定が無ければ、転送は受けない');
  assert.equal(verdict(raw(cf('pass smtp.mailfrom=other+caf_=inbox=reduxdive.com@gmail.com', 'booking.example')), 'other+caf_=inbox=reduxdive.com@gmail.com', S).why, 'sender', '転送した人が表に無い');
  const MS = 'john.work+SRS=44ldt=IX=fabrikam.com=bob@contoso.com';
  assert.deepEqual(forwarderOf(MS), { forwarder: 'john.work@contoso.com', rewritten: true });
  assert.deepEqual(verdict(raw(cf(`pass smtp.mailfrom=${MS}`, 'fabrikam.com'), 'bob@fabrikam.com'), MS, 'john.work@contoso.com, @fabrikam.com'), { ok: true, via: 'relay' });
  assert.equal(verdict(raw(cf('pass smtp.mailfrom=bounces+SRS=abc=IX@contoso.com', 'fabrikam.com'), 'bob@fabrikam.com'), 'bounces+SRS=abc=IX@contoso.com', 'john.work@contoso.com, @fabrikam.com').why, 'sender', '転送した人が分からない長い形は受けない');
});

test('届いた予約メール: 許した送り主だけを読み、日付が読めたら便に入れてお願いを送る。それ以外の送り主は断り、AI を呼ばない', async () => {
  const s = setup();
  const evil = message(MAIL_RAW('予約です'), 'evil@x.example');
  await receiveMail(evil, s.env, s.io);
  assert.ok(evil.rejected);
  assert.equal(s.api.calls.length, 0);
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 次郎' }], booking: { site: '予約サイト', date: '2026-11-05', start: '08:30', tour: '体験ダイビング', people: 1, lead_name: '見本 次郎', lead_email: 'jiro@mail.example' }, health_info_visible: false });
  const spoofed = message(MAIL_RAW('予約です'), 'forward@shop.example', `${CF_ID}; spf=fail smtp.mailfrom=forward@shop.example; dkim=none`);
  await receiveMail(spoofed, s.env, s.io);
  assert.ok(spoofed.rejected, '封筒の From だけで SPF も DKIM も通らないメールは断る（ザクのレビュー M-5）');
  assert.equal(s.api.calls.length, 0);
  const ok = message(MAIL_RAW('予約サイトからのお知らせ\r\n11/5 体験ダイビング 1 名\r\n見本 次郎 様\r\n連絡先: jiro@mail.example'));
  await receiveMail(ok, s.env, s.io);
  assert.equal(ok.rejected, '');
  assert.equal(s.api.calls.length, 1);
  assert.equal(s.mail.sent.length, 0, '送るのは次の Cron');
  await scheduled(s.env, s.io);
  const st = stored(s.db);
  assert.equal(st.bookings.length, 1);
  assert.equal(st.bookings[0].leadEmail, 'jiro@mail.example');
  assert.equal(st.trips[0].date, '2026-11-05');
  assert.deepEqual(s.mail.sent.map(m => m.to), ['jiro@mail.example']);
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 四郎' }], booking: { site: '予約サイト', date: '2026-11-06', people: 1, lead_name: '見本 四郎', lead_email: 'other@evil.example' }, health_info_visible: false });
  await receiveMail(message(MAIL_RAW('11/6 体験ダイビング 1 名 見本 四郎 様')), s.env, s.io);
  assert.equal(stored(s.db).bookings[1].leadEmail, '', '本文に無い宛先を AI が読んでも使わない（設計 2）');
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 三郎' }], booking: { people: 1 }, health_info_visible: false });
  await receiveMail(message(MAIL_RAW('日付の無いメール')), s.env, s.io);
  assert.equal(stored(s.db).bookings.length, 2, '日付が読めないメールは自動では入れない（お店が画面で入れる）');
  s.db.setCount('mail', 'default', '2026-10-27', 30);
  const calls = s.api.calls.length;
  await receiveMail(message(MAIL_RAW('31 通目')), s.env, s.io);
  assert.equal(s.api.calls.length, calls, 'メールからの予約は 1 日 30 件まで。超えたら AI を呼ばない');
});

test('ザクのレビュー 2026-10-28 SEC-01・02・04（通しで）: 足された行・流し直し・転送を、receiveMail が見出しの生の中身で判定し、断ったら AI を呼ばない', async () => {
  const s = setup({ MAIL_SENDERS: 'owner@gmail.com, @booking.example' });
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 次郎' }], booking: { site: '予約サイト', date: '2026-11-05', people: 1, lead_name: '見本 次郎' }, health_info_visible: false });
  const GM = 'owner+caf_=inbox=reduxdive.com@gmail.com';
  const body = MAIL_RAW('11/5 体験ダイビング 1 名 見本 次郎 様');
  const FAKE = `${CF_ID}; spf=pass smtp.mailfrom=${GM}; dkim=pass header.d=booking.example`;
  const real = `${CF_ID}; spf=fail smtp.mailfrom=${GM}; dkim=pass header.d=booking.example`;
  const spoof = message(body, GM, real, FAKE);   // message.headers.get() では「本物, 偽」とつながって見える
  assert.ok(spoof.headers.get('authentication-results').includes('spf=fail') && spoof.headers.get('authentication-results').includes('spf=pass'));
  const raw2 = new TextEncoder().encode(`Authentication-Results: ${real}\r\nAuthentication-Results: ${FAKE}\r\n${body}`);
  spoof.raw = new ReadableStream({ start(c) { c.enqueue(raw2); c.close(); } });
  spoof.rawSize = raw2.byteLength;
  await receiveMail(spoof, s.env, s.io);
  assert.equal(spoof.rejected, 'Sender not authenticated', '送り主が足した 2 本目の行では通らない');
  const replay = message(body, 'owner@gmail.com', `${CF_ID}; spf=fail smtp.mailfrom=owner@gmail.com; dkim=pass header.d=booking.example`);
  await receiveMail(replay, s.env, s.io);
  assert.equal(replay.rejected, 'Sender not authenticated', '正しく署名されたメールを別のサーバーから流し直しても通らない');
  const headersOnly = message(body, GM, real);
  headersOnly.headers = new Headers({ 'authentication-results': FAKE });   // message.headers だけが pass と言っても、生の見出しの本物（fail）を見る
  await receiveMail(headersOnly, s.env, s.io);
  assert.equal(headersOnly.rejected, 'Sender not authenticated');
  assert.equal(s.api.calls.length, 0);
  const noId = setup({ MAIL_SENDERS: 'owner@gmail.com, @booking.example', MAIL_AUTHSERV_ID: '' });
  const unset = message(body, GM, FAKE);
  await receiveMail(unset, noId.env, noId.io);
  assert.equal(unset.rejected, 'Temporarily unavailable, please try again later', 'Cloudflare の名前が設定されていなければ、確かめられないので受けない');
  assert.equal(noId.api.calls.length, 0);
  logs.length = 0;
  const forwarded = message(body, GM, `${CF_ID}; spf=pass smtp.mailfrom=${GM}; dkim=pass header.d=booking.example`);
  await receiveMail(forwarded, s.env, s.io);
  assert.equal(forwarded.rejected, '', 'Gmail の転送（転送した人の SPF と予約サイトの DKIM がそろう）は通る');
  assert.equal(s.api.calls.length, 1);
  const note = JSON.parse(logs[logs.length - 1]);
  assert.equal(note.via, 'relay');
  assert.ok(!logs.join('').includes('gmail.com'), 'ログに送り主は出さない');
  const noDkim = message(body, GM, `${CF_ID}; spf=pass smtp.mailfrom=${GM}; dkim=none`);
  await receiveMail(noDkim, s.env, s.io);
  assert.equal(noDkim.rejected, 'Sender not authenticated', '予約サイトの DKIM が無い転送は断る');
  assert.equal(JSON.parse(logs[logs.length - 1]).authWhy, 'origin', 'ログには理由の分類だけ残る');
  assert.equal(s.api.calls.length, 1);
});

test('点検 2026-10-28 運用 C4: 設定が欠けていて読めない予約メールは、黙って捨てずに断る（送り元に返る）', async () => {
  const s = setup();
  delete s.env.ANTHROPIC_API_KEY;
  const m = message(MAIL_RAW('予約です'));
  await receiveMail(m, s.env, s.io);
  assert.ok(m.rejected, '断る');
  assert.equal(s.api.calls.length, 0);
});

test('点検 2026-10-28 設計 20: REPLY_TO があれば、お客さんへの連絡に Reply-To を付ける（返信が受け口の無い送り元に行かない）。形が合わなければ付けない', async () => {
  const s = setup();
  s.env.REPLY_TO = 'shop@mail.example';
  await handle(booking(GOOD), s.env, s.io);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent[0].replyTo, 'shop@mail.example');
  const t = setup();
  t.env.REPLY_TO = 'not an address';
  await handle(booking(GOOD), t.env, t.io);
  await scheduled(t.env, t.io);
  assert.equal(t.mail.sent[0].replyTo, undefined);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    REAL_LOG(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    REAL_LOG(`FAIL ${t.name}\n     ${e.stack || e.message}`);
  }
}
REAL_LOG(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
