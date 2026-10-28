// 通しの確かめ（H2）と、失敗の道（H7）。部品ごとの確かめ（auto-worker・ask-link・shops・sync）を、つなぎ目で 1 本に流す。
// H2: サイトの予約（か届いた予約メール）→ 名簿 → Cron → お願いのメール（見本）→ そのメールのリンクをお客さんが開く → /api/ask で答える
//     → 次の Cron は同じお願いを送らない。リンクの住所（ASK_ORIGIN）と鍵の行がずれると、メールのリンクだけが 404 になる（/api/ask-link で作ったリンクは開けるので他の確かめは通る）ため、
//     この本はメールの本文から取ったリンクだけを使う。
// H7: D1 の不調・版のぶつかり続け・Turnstile の不調・名簿が壊れたお店・KV の不調。送る前に止まったら 1 通も出ず、直ったら 1 回だけ出る。
// 実行: node test/e2e.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { handlePublic } from '../worker/handler.mjs';
import { scheduled, receiveMail } from '../worker/auto.mjs';
import { setup, siteBooking, staffCall, guestCall, keyOfMail, stored, message, MAIL_RAW, MAIL_BODY, READING, GOOD, ASK_ORIGIN, SITE, NOW, logs, runTests } from './kit.mjs';

const keyOf = (url) => url.split('#k=')[1];
const ONE = { ...GOOD, people: 1, name: '見本 花子', email: 'hanako@mail.example' };
/* 2026-11-03 の便。日本時間で 2 日前の朝（9:00）と、前日の夜（20:00） */
const AT_REMIND = Date.parse('2026-11-01T00:00:00Z');
const AT_EVE = Date.parse('2026-11-02T11:00:00Z');
const ANSWERS = { birthDate: '1990-05-01', address: '那覇市 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' }, cert: { course: 'NONE', date: '' }, dives: 0 };
const HEALTH = { answers: Array(5).fill('no'), consent: true };

/* お客さんがメールのリンクを開き、全員の項目と健康の答えを入れる（健康は 1 人ずつのリンク）。返すのは入れた人の数 */
async function guestAnswersAll(s, key) {
  const opened = await guestCall(s, { k: key, action: 'view' });
  assert.equal(opened.status, 200, 'メールのリンクが開ける');
  const view = await opened.json();
  assert.equal(view.kind, 'booking');
  for (const p of view.people) {
    const sent = await (await guestCall(s, { k: key, action: 'send', personId: p.person.id, input: ANSWERS })).json();
    assert.deepEqual(sent.problems, [], '予約のリンクから入れる項目');
    const made = await guestCall(s, { k: key, action: 'person-link', personId: p.person.id });
    assert.equal(made.status, 200);
    const url = (await made.json()).url;
    assert.ok(url.startsWith(`${ASK_ORIGIN}/ask#k=`), '1 人ずつのリンクもお客さんの Worker の住所');
    const health = await (await guestCall(s, { k: keyOf(url), action: 'send', personId: p.person.id, input: HEALTH })).json();
    assert.deepEqual(health.problems, [], '1 人ずつのリンクから入れる健康');
  }
  return view.people.length;
}

/* 1 件の予約が名簿に入ったあとの通し。Cron → メール 1 通 → お客さんが全部答える → 次の Cron も 2 日前の Cron も前日の夜の Cron も送らない */
async function flowAfterBooked(s, to) {
  const before = stored(s);
  assert.equal(before.bookings.length, 1);
  assert.equal(s.mail.sent.length, 0, '外からの入口では送らない');
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.to), [to], '最初のお願いが 1 通');
  const { url, key } = keyOfMail(s.mail.sent[0]);
  assert.ok(url.startsWith(`${ASK_ORIGIN}/ask#k=`), 'メールのリンクはお客さんの Worker の住所');
  assert.equal(await guestAnswersAll(s, key), before.people.length);
  const st = stored(s);
  assert.ok(st.people.every(p => p.birthDate === '1990-05-01' && p.health.answers.every(a => a === 'no') && p.health.consentAt), '答えが名簿に入った');
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1, '同じ時刻の次の Cron は、お願いをもう一度は送らない');
  s.io.clock = AT_REMIND;
  await scheduled(s.env, s.io);
  s.io.clock = AT_EVE;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1, '全部そろったので、2 日前のもう一度も、前日の夜のお店への知らせも出ない');
  const jobs = Object.fromEntries(stored(s).jobs.map(j => [j.kind, j.status]));
  assert.deepEqual(jobs, { request: 'done', remind: 'skipped', eve: 'skipped', morning: 'waiting' });
  assert.ok(stored(s).outbox.every(o => o.kind !== 'staff'));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('H2 通し（サイトの予約）: 予約 → Cron のメール → メールのリンク → お客さんが答える → 次の Cron は送らない', async () => {
  const s = setup();
  const res = await siteBooking(s, ONE);
  assert.equal(res.status, 202);
  await flowAfterBooked(s, 'hanako@mail.example');
});

test('H2 通し（届いた予約メール）: メール → AI の読み取り → 名簿 → Cron のメール → メールのリンク → 答える → 次の Cron は送らない', async () => {
  const s = setup();
  s.api.answer = READING({ date: '2026-11-03' });
  const mail = message(MAIL_RAW(MAIL_BODY));
  await receiveMail(mail, s.env, s.io);
  assert.equal(mail.rejected, '');
  assert.equal(s.api.calls.length, 1);
  await flowAfterBooked(s, 'jiro@mail.example');
});

test('H2 通し: 答えたお客さんには 2 日前のもう一度は出ず、答えていないお客さんにだけ出る（その人のリンクは作り直され、前のリンクは止まる）', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE, { ip: '203.0.113.11' })).status, 202);
  assert.equal((await siteBooking(s, { ...ONE, name: '見本 太郎', email: 'taro@mail.example' }, { ip: '203.0.113.12' })).status, 202);
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.to).sort(), ['hanako@mail.example', 'taro@mail.example']);
  const first = keyOfMail(s.mail.sent.find(m => m.to === 'hanako@mail.example'));
  const second = keyOfMail(s.mail.sent.find(m => m.to === 'taro@mail.example'));
  await guestAnswersAll(s, first.key);
  s.io.clock = AT_REMIND;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 3);
  const again = s.mail.sent[2];
  assert.equal(again.to, 'taro@mail.example', 'まだの人にだけ');
  assert.match(again.subject, /もう一度/);
  const fresh = keyOfMail(again);
  assert.notEqual(fresh.key, second.key);
  assert.equal((await guestCall(s, { k: second.key, action: 'view' })).status, 404, '最初のリンクは止まる（作り直した）');
  assert.equal((await guestCall(s, { k: fresh.key, action: 'view' })).status, 200);
  assert.equal((await guestCall(s, { k: first.key, action: 'view' })).status, 200, '答えた人のリンクは作り直さない');
});

/* ---------- H7: 失敗の道 ---------- */

/* D1 の文のうち text が re に合う物を、times 回だけ邪魔する。fail なら例外にする（D1 が落ちた）。bump があれば実行の前に呼ぶ（別の端末が先に書いた、を作る）。戻すには restore() */
function interceptStatements(db, re, { times = Infinity, fail = false, bump } = {}) {
  const prepare = db.prepare.bind(db);
  let left = times;
  const meddle = async () => { if (left <= 0) return; left -= 1; if (bump) bump(); if (fail) throw new Error('d1 down'); };
  db.prepare = (sql) => {
    const real = prepare(sql);
    if (!re.test(sql.replace(/\s+/g, ' ').trim())) return real;
    const wrap = (b, name) => async () => { await meddle(); return b[name](); };
    return { bind: (...a) => { const b = real.bind(...a); return { first: wrap(b, 'first'), run: wrap(b, 'run'), all: wrap(b, 'all') }; }, all: real.all };
  };
  return { restore() { db.prepare = prepare; } };
}
const WRITE_NEXT = /^UPDATE rosters SET version = version \+ 1/;
const failWrites = (db, times) => interceptStatements(db, WRITE_NEXT, { times, fail: true });
/* 名簿の書き込みを毎回ぶつからせる（書く前に版を 1 つ進める） */
const alwaysConflict = (db) => interceptStatements(db, WRITE_NEXT, { bump: () => { for (const r of db.rows.values()) r.version += 1; } });
const cronLine = () => JSON.parse(logs.filter(l => l.includes('"route":"cron"')).pop());
const bookingLine = () => JSON.parse(logs.filter(l => l.includes('"route":"/api/bookings"')).pop());

test('H7 Cron: D1 が落ちている回は 1 通も送らず失敗と残す。死活の口は 503 のまま。直った次の回に 1 通だけ送る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  s.db.failing = true;
  await assert.rejects(scheduled(s.env, s.io), /cron failed/);
  assert.equal(s.mail.sent.length, 0);
  assert.equal(cronLine().down, 1);
  assert.equal(s.env.BUDGET.peek('cron:last'), null, '落ちた回は「最後に動いた時刻」を書かない');
  const health = await handlePublic(new Request(`${ASK_ORIGIN}/api/health`), { BUDGET: s.env.BUDGET }, s.io);
  assert.equal(health.status, 503);
  s.db.failing = false;
  await scheduled(s.env, s.io);
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1, '直ったあとも 1 通だけ');
  assert.equal((await handlePublic(new Request(`${ASK_ORIGIN}/api/health`), { BUDGET: s.env.BUDGET }, s.io)).status, 200);
});

test('H7 Cron: 送る前の印を書けなかった回は 1 通も送らない（印が無いのに送らない）。次の回に送る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  const broken = failWrites(s.db, 1);
  await assert.rejects(scheduled(s.env, s.io), /cron failed/);
  assert.equal(s.mail.sent.length, 0);
  assert.equal((stored(s).outbox || []).length, 0, '印も連絡も書けていない');
  broken.restore();
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
});

test('H7 版のぶつかり続け: サイトの予約は 5 回当て直して 503（roster）、名簿は変えない。ぶつからなくなれば 1 件だけ入る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE, { ip: '203.0.113.21' })).status, 202);
  const before = s.db.rows.get('default').state;
  const conflict = alwaysConflict(s.db);
  const res = await siteBooking(s, { ...ONE, name: '見本 太郎', email: 'taro@mail.example' }, { ip: '203.0.113.22' });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'roster' });
  assert.equal(bookingLine().why, 'add-conflict');
  assert.equal(s.db.rows.get('default').state, before, '名簿の中身は変わらない');
  conflict.restore();
  assert.equal((await siteBooking(s, { ...ONE, name: '見本 太郎', email: 'taro@mail.example' }, { ip: '203.0.113.23' })).status, 202);
  assert.deepEqual(stored(s).bookings.map(b => b.leadEmail).sort(), ['hanako@mail.example', 'taro@mail.example'], 'お客さんが押し直しても重ならない');
});

test('H7 版のぶつかり続け: Cron は 1 通も送らず失敗と残し、ぶつからなくなった回に 1 通だけ送る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  const conflict = alwaysConflict(s.db);
  await assert.rejects(scheduled(s.env, s.io), /cron failed: .*due-conflict/);
  assert.equal(s.mail.sent.length, 0);
  conflict.restore();
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
});

test('H7 画面の書き込み: D1 が落ちていれば 503（db）で版は進まず、直れば同じ内容がそのまま通る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  const got = await (await staffCall(s, 'GET', '/api/roster')).json();
  const changed = { ...got.state, shop: { ...got.state.shop, name: 'B マリン（見本）' } };
  const broken = failWrites(s.db);
  const down = await staffCall(s, 'PUT', '/api/roster', { base: got.version, state: { ...changed, trips: got.state.trips.map(t => ({ ...t, boat: 'サンプル丸' })) } });
  assert.deepEqual([down.status, (await down.json()).error], [503, 'db']);
  assert.equal(s.db.rows.get('default').version, got.version);
  broken.restore();
  const ok = await staffCall(s, 'PUT', '/api/roster', { base: got.version, state: { ...changed, trips: got.state.trips.map(t => ({ ...t, boat: 'サンプル丸' })) } });
  assert.equal(ok.status, 200);
  assert.equal(s.db.rows.get('default').version, got.version + 1);
});

test('H7 Turnstile の不調: 5xx・3xx・429・届かない・壊れた答え・失敗の答えはどれも 403 で、名簿に入れない。直れば 202', async () => {
  const s = setup();
  const answer = (status, body) => (init) => { s.turnstile.calls.push(JSON.parse(init.body)); return new Response(body, { status }); };
  const ok = JSON.stringify({ success: true, hostname: 'aquagate.example.com', action: 'booking' });
  const cases = [
    ['5xx', answer(500, ok), 'turnstile-500'], ['503', answer(503, ok), 'turnstile-503'], ['429', answer(429, ok), 'turnstile-429'],
    ['3xx', answer(302, ok), 'turnstile-302'], ['network', () => { throw new TypeError('fetch failed'); }, 'turnstile-network'],
    ['not json', answer(200, '<html>maintenance</html>'), 'turnstile-no'], ['empty', answer(200, ''), 'turnstile-no'],
    ['failed', answer(200, JSON.stringify({ success: false })), 'turnstile-no']
  ];
  for (const [name, respond, why] of cases) {
    s.io.turnstileOverride = respond;
    const res = await siteBooking(s, ONE);
    assert.equal(res.status, 403, name);
    assert.equal(res.headers.get('access-control-allow-origin'), SITE, name);
    assert.equal(bookingLine().why, why, name);
  }
  assert.equal(s.db.rows.size, 0, '断った予約は名簿に入れない');
  assert.equal(s.db.writes, 0);
  s.io.turnstileOverride = null;
  assert.equal((await siteBooking(s, ONE)).status, 202);
  assert.equal(stored(s).bookings.length, 1);
});

test('H7 お客さんのリンク: D1 が落ちていれば 5xx で名簿は変わらず、直ればそのまま開ける', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  await scheduled(s.env, s.io);
  const { key } = keyOfMail(s.mail.sent[0]);
  const person = stored(s).people[0].id;
  const before = s.db.rows.get('default').state;
  s.db.failing = true;
  for (const body of [{ k: key, action: 'view' }, { k: key, action: 'send', personId: person, input: ANSWERS }]) {
    const res = await guestCall(s, body);
    assert.ok(res.status >= 500, `${body.action} → ${res.status}`);
  }
  s.db.failing = false;
  assert.equal(s.db.rows.get('default').state, before);
  assert.equal((await guestCall(s, { k: key, action: 'view' })).status, 200);
  const sent = await guestCall(s, { k: key, action: 'send', personId: person, input: ANSWERS });
  assert.deepEqual((await sent.json()).problems, []);
});

test('H7 お客さんの答えを書くときに版がぶつかり続けたら 503（save）で、名簿は変わらない', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  await scheduled(s.env, s.io);
  const { key } = keyOfMail(s.mail.sent[0]);
  const before = stored(s).people[0];
  const conflict = alwaysConflict(s.db);
  const res = await guestCall(s, { k: key, action: 'send', personId: before.id, input: ANSWERS });
  assert.deepEqual([res.status, (await res.json()).error], [503, 'save']);
  conflict.restore();
  assert.equal(stored(s).people[0].birthDate, before.birthDate, '書けなかった答えは入っていない');
});

test('H7 1 店の名簿が壊れていても、ほかのお店の Cron は送る。壊れたお店は失敗として数える', async () => {
  const SITE_A = 'https://shop-a.example.com';
  const SITE_B = 'https://shop-b.example.com';
  const s = setup({ SINGLE_SHOP: undefined, SITE_ORIGINS: undefined });
  s.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [], sites: [SITE_A], inbox: 'a@yoyaku.example' });
  s.db.addShop({ id: 'shop-b', name: 'B マリン', members: [], sites: [SITE_B], inbox: 'b@yoyaku.example' });
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, { ...ONE, email: 'a-guest@mail.example' }, { origin: SITE_A, ip: '203.0.113.31' })).status, 202);
  s.turnstile.hostname = 'shop-b.example.com';
  assert.equal((await siteBooking(s, { ...ONE, email: 'b-guest@mail.example' }, { origin: SITE_B, ip: '203.0.113.32' })).status, 202);
  s.db.rows.set('shop-a', { ...s.db.rows.get('shop-a'), state: '{broken' });
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.to), ['b-guest@mail.example']);
  const line = cronLine();
  assert.deepEqual([line.shops, line.failed, line.sent], [2, 1, 1]);
  assert.match(line.why, /shop-a:due-stored/);
  assert.equal(s.db.rows.get('shop-a').state, '{broken', '壊れた名簿は書き換えない');
});

test('H7 KV が落ちていても Cron は送る（最後に動いた時刻を書けないだけ）。死活の口は古くなって 503 になる', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  s.env.BUDGET.failing = true;
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 1);
  assert.equal(cronLine().cronMark, 'kv');
  s.env.BUDGET.failing = false;
  assert.equal((await handlePublic(new Request(`${ASK_ORIGIN}/api/health`), { BUDGET: s.env.BUDGET }, s.io)).status, 503);
  s.io.clock = NOW + 15 * 60000;
  await scheduled(s.env, s.io);
  assert.equal((await handlePublic(new Request(`${ASK_ORIGIN}/api/health`), { BUDGET: s.env.BUDGET }, s.io)).status, 200);
});

test('H7 送るメールが落ちている回: failed と理由を残し、直ってから「送り直し」を頼むと 1 通だけ出る', async () => {
  const s = setup();
  assert.equal((await siteBooking(s, ONE)).status, 202);
  s.mail.fail = 'E_DELIVERY_FAILED';
  await scheduled(s.env, s.io);
  assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['failed', 'E_DELIVERY_FAILED']]);
  s.mail.fail = '';
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, '失敗した連絡は自動では送り直さない（お店が確かめる）');
  const got = await (await staffCall(s, 'GET', '/api/roster')).json();
  const id = got.state.outbox[0].id;
  const asked = { ...got.state, outbox: got.state.outbox.map(o => (o.id === id ? { ...o, why: 'resend' } : o)) };
  const put = await staffCall(s, 'PUT', '/api/roster', { base: got.version, state: asked });
  assert.equal(put.status, 200);
  s.io.clock = NOW + 15 * 60000;
  await scheduled(s.env, s.io);
  await scheduled(s.env, s.io);
  assert.deepEqual(s.mail.sent.map(m => m.to), ['hanako@mail.example']);
  assert.deepEqual(stored(s).outbox.map(o => [o.status, o.why]), [['failed', 'resent'], ['sent', '']]);
});

await runTests(tests);
