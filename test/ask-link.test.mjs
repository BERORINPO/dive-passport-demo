// お客さんのリンク（/api/ask・/api/ask-link。worker/ask-route.mjs・ask-core.mjs・ask-db.mjs）を、外との境目を見本に差し替えて確かめる。
// 鍵は 32 バイトで D1 には SHA-256 だけ、鍵が違う・切れた・予約が無いは同じ 404、予約のリンクは健康以外・1 人ずつのリンクは健康だけ、
// 当日の体調は Worker の日付が便の日のときだけ、名簿の中身は見せない、作り直したら古い鍵は止まる、回数の上限。
// 実行: node test/ask-link.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { handle, handlePublic } from '../worker/handler.mjs';
import { askFiles, askHeaders } from '../tools/build-site.mjs';
import { readFileSync } from 'node:fs';
import { resetAccessCache } from '../worker/access.mjs';
import { fakeKv, fakeAccess, fakeD1, fakeTurnstile, fakeRateLimit, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const SITE = 'https://aquagate.example.com';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const REAL_LOG = console.log;
const logs = [];
console.log = (line) => logs.push(String(line));

const access = await fakeAccess(TEAM);
const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600 * 24 * 30, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

function setup() {
  resetAccessCache();
  const db = fakeD1();
  const turnstile = fakeTurnstile();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL, DAILY_LIMIT: '200', MONTHLY_USD: '5',
    BUDGET: fakeKv(), DB: db, ASK_LIMIT: fakeRateLimit(100), SITE_ORIGINS: SITE, TURNSTILE_SECRET: 'turnstile-test-secret', BOOKING_LIMIT: fakeRateLimit(100),
    SHOP_NAME: 'B マリン（見本）'
  };
  const io = {
    clock: NOW,
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      if (url === SITEVERIFY) return turnstile.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  return { db, env, io };
}

const call = (s, path, body, { staff = false, site = 'same-origin', ip = '203.0.113.5' } = {}) => handle(new Request(ORIGIN + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}), 'cf-connecting-ip': ip, ...(staff ? { 'cf-access-jwt-assertion': jwt } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}), s.env, s.io);
const stored = (s) => JSON.parse(s.db.rows.get('default').state);
const keyOf = (url) => url.split('#k=')[1];

/* サイトの予約フォームから 2 人の予約を 1 件入れ、お店がリンクを作る */
async function booked(date = '2026-11-03') {
  const s = setup();
  const r = await handle(new Request(`${ORIGIN}/api/bookings`, { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'cf-turnstile-response': 't', 'cf-connecting-ip': '198.51.100.1' },
    body: JSON.stringify({ tour: 'dive', date, people: 2, name: '見本 花子', email: 'hanako@mail.example', exp: 'first' }) }), s.env, s.io);
  assert.equal(r.status, 202);
  const st = stored(s);
  const booking = st.bookings[0];
  const people = st.people.filter(p => p.bookingId === booking.id);
  const made = await call(s, '/api/ask-link', { bookingId: booking.id }, { staff: true });
  assert.equal(made.status, 200);
  const got = await made.json();
  return { s, booking, people, url: got.url, key: keyOf(got.url) };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('お店がリンクを作る: Access が要る。鍵は 43 字で URL の # の後ろ、D1 には SHA-256 だけ', async () => {
  const { s, booking, url, key } = await booked();
  assert.ok(url.startsWith(`${ORIGIN}/ask#k=`));
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(s.db.links.size, 1);
  const [hash, row] = [...s.db.links.entries()][0];
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, key);
  assert.equal(row.booking_id, booking.id);
  assert.equal(row.expires_on, '2026-11-04', '便の翌日まで');
  assert.equal((await call(s, '/api/ask-link', { bookingId: booking.id })).status, 403, 'Access の無い要求は断る');
  assert.equal((await call(s, '/api/ask-link', { bookingId: 'nope' }, { staff: true })).status, 404);
});

test('リンクで見る: 名前と聞く項目の名前だけ。予約のリンクは健康を聞かず、当日の体調も聞かない', async () => {
  const { s, key } = await booked();
  const r = await call(s, '/api/ask', { k: key, action: 'view' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const v = await r.json();
  assert.equal(v.kind, 'booking');
  assert.equal(v.shop, 'B マリン（見本）');
  assert.equal(v.trip.date, '2026-11-03');
  assert.equal(v.people.length, 2);
  assert.ok(v.people.every(p => !p.ask.includes('history') && !p.needsToday));
  assert.ok(v.people[0].ask.includes('birthDate'));
  assert.ok(v.people.every(p => p.healthOpen), '健康は 1 人ずつのリンクで聞く印');
  assert.deepEqual(Object.keys(v.people[0].person).sort(), ['id', 'name']);
  const text = JSON.stringify(v);
  assert.ok(!text.includes('hanako@mail.example'), 'メールアドレスは見せない');
});

test('鍵が違う・形が違う・切れた・予約が消えた、はどれも同じ 404', async () => {
  const { s, key } = await booked('2026-10-28');
  const other = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
  const answers = [];
  answers.push(await call(s, '/api/ask', { k: other, action: 'view' }));
  const gone = await booked('2026-10-28');
  const st = stored(gone.s);
  gone.s.db.rows.set('default', { ...gone.s.db.rows.get('default'), state: JSON.stringify({ ...st, bookings: [], people: [] }) });
  answers.push(await call(gone.s, '/api/ask', { k: gone.key, action: 'view' }));
  s.io.clock = Date.parse('2026-10-29T15:30:00Z');   // 日本で 10/30（便の翌日を過ぎた）
  answers.push(await call(s, '/api/ask', { k: key, action: 'view' }));
  for (const r of answers) {
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'gone' });
  }
  assert.equal((await call(s, '/api/ask', { k: 'short', action: 'view' })).status, 400);
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view', extra: 1 })).status, 400);
});

test('予約のリンクで入れる: 健康以外だけを受け、Worker が自分で問題を数える。健康の答えを送っても入らない', async () => {
  const { s, key, people } = await booked();
  const id = people[0].id;
  const bad = await (await call(s, '/api/ask', { k: key, action: 'send', personId: id, input: { birthDate: 'x' } })).json();
  assert.ok(bad.problems.includes('birthDate'));
  const input = { birthDate: '1990-05-01', address: '那覇市 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
    answers: Array(5).fill('no'), consent: true };
  const ok = await (await call(s, '/api/ask', { k: key, action: 'send', personId: id, input })).json();
  assert.deepEqual(ok.problems, []);
  const p = stored(s).people.find(x => x.id === id);
  assert.equal(p.birthDate, '1990-05-01');
  assert.equal(p.address, '那覇市 1-2-3');
  assert.ok(p.health.answers.every(a => a === null) && !p.health.consentAt, '予約のリンクからは健康の答えを入れない');
  assert.ok(!ok.view.people.find(x => x.person.id === id).ask.includes('birthDate'), '入れた所は聞かなくなる');
  assert.ok(!JSON.stringify(ok.view).includes('那覇市'), '入れた中身は返さない');
});

test('1 人ずつのリンク: 予約のリンクから作れる。その人の健康だけを受け、当日の体調は便の日だけ', async () => {
  const { s, key, people } = await booked('2026-10-28');
  const id = people[1].id;
  const made = await (await call(s, '/api/ask', { k: key, action: 'person-link', personId: id })).json();
  const pkey = keyOf(made.url);
  assert.equal(s.db.links.size, 2);
  const v = await (await call(s, '/api/ask', { k: pkey, action: 'view' })).json();
  assert.equal(v.kind, 'person');
  assert.deepEqual(v.people.map(p => p.person.id), [id]);
  assert.deepEqual(v.people[0].ask, ['history']);
  assert.equal(v.people[0].todayOpen, false, '便の前日は当日の体調を受けない');
  const fields = await (await call(s, '/api/ask', { k: pkey, action: 'send', personId: id, input: { birthDate: '1990-01-01', answers: Array(5).fill('no'), consent: true } })).json();
  assert.deepEqual(fields.problems, []);
  const p = stored(s).people.find(x => x.id === id);
  assert.equal(p.birthDate, '', '1 人ずつのリンクからは健康以外を入れない');
  assert.deepEqual(p.health.answers, Array(5).fill('no'));
  assert.ok(p.health.consentVer);
  const early = await (await call(s, '/api/ask', { k: pkey, action: 'today', personId: id, answer: 'ok' })).json();
  assert.deepEqual(early.problems, ['not-today']);
  s.io.clock = Date.parse('2026-10-27T22:00:00Z');   // 日本で 10/28 の 7:00
  const today = await (await call(s, '/api/ask', { k: pkey, action: 'today', personId: id, answer: 'unwell' })).json();
  assert.deepEqual(today.problems, []);
  assert.equal(stored(s).people.find(x => x.id === id).health.today, 'unwell');
  const lighter = await (await call(s, '/api/ask', { k: pkey, action: 'today', personId: id, answer: 'ok' })).json();
  assert.deepEqual(lighter.problems, ['answered'], '答えたあとは軽い方へは書き換えられない（ザクのレビュー M-3）');
  assert.equal(stored(s).people.find(x => x.id === id).health.today, 'unwell');
  assert.equal((await call(s, '/api/ask', { k: pkey, action: 'send', personId: people[0].id, input: {} })).status, 404, '別の人には入れられない');
  assert.equal((await call(s, '/api/ask', { k: pkey, action: 'person-link', personId: id })).status, 404, '1 人ずつのリンクからはリンクを作れない');
  assert.equal((await call(s, '/api/ask', { k: key, action: 'today', personId: id, answer: 'ok' })).status, 200);
  assert.equal(stored(s).people.find(x => x.id === id).health.today, 'unwell', '予約のリンクからは当日の体調を入れない');
});

test('1 人ずつのリンクは、作り直しても前の物を止めない。1 人 3 本まで', async () => {
  const { s, key, people } = await booked();
  const id = people[1].id;
  const urls = [];
  for (let i = 0; i < 3; i += 1) urls.push((await (await call(s, '/api/ask', { k: key, action: 'person-link', personId: id })).json()).url);
  for (const u of urls) assert.equal((await call(s, '/api/ask', { k: keyOf(u), action: 'view' })).status, 200);
  assert.equal((await call(s, '/api/ask', { k: key, action: 'person-link', personId: id })).status, 429);
  assert.equal((await call(s, '/api/ask', { k: key, action: 'person-link', personId: people[0].id })).status, 200, '別の人は別に数える');
  /* 前の予約のリンクから作った 3 本が期限切れになったら（Cron が消す前でも）、また作れる（Codex のレビュー 2026-10-28） */
  for (const l of s.db.links.values()) if (l.person_id === id) l.expires_on = '2000-01-01';
  assert.equal((await call(s, '/api/ask', { k: key, action: 'person-link', personId: id })).status, 200, '期限切れのリンクは数えない');
});

test('リンクを作り直したら古い鍵は開けない', async () => {
  const { s, key, booking } = await booked();
  const again = await (await call(s, '/api/ask-link', { bookingId: booking.id }, { staff: true })).json();
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' })).status, 404);
  assert.equal((await call(s, '/api/ask', { k: keyOf(again.url), action: 'view' })).status, 200);
  assert.equal(s.db.links.size, 1);
});

test('守り: 同じ場所からだけ・JSON だけ・大きさ・IP の回数・鍵 1 つの 1 日の回数・設定が無ければ 503', async () => {
  const { s, key } = await booked();
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' }, { site: 'cross-site' })).status, 403);
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' }, { site: '' })).status, 403);
  assert.equal((await call(s, '/api/ask', 'x'.repeat(9000))).status, 413);
  const typed = await handle(new Request(`${ORIGIN}/api/ask`, { method: 'POST', headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, body: '{}' }), s.env, s.io);
  assert.equal(typed.status, 415);
  for (let i = 0; i < 30; i += 1) await call(s, '/api/ask', { k: key, action: 'view' });
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' })).status, 429, '鍵 1 つは 1 日 30 回まで');
  s.io.clock += 24 * 3600 * 1000;
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' })).status, 200, '次の日はまた開ける');
  s.env.ASK_LIMIT = fakeRateLimit(1);
  await call(s, '/api/ask', { k: key, action: 'view' }, { ip: '192.0.2.7' });
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' }, { ip: '192.0.2.7' })).status, 429);
  delete s.env.ASK_LIMIT;
  assert.equal((await call(s, '/api/ask', { k: key, action: 'view' })).status, 503);
});

test('中止になった便: 見られるが、入れられない', async () => {
  const { s, key, people } = await booked();
  const st = stored(s);
  st.trips[0].cancel = { at: '2026-10-27T01:00:00.000Z', reason: 'wind', acked: [] };
  s.db.rows.set('default', { ...s.db.rows.get('default'), state: JSON.stringify(st) });
  const v = await (await call(s, '/api/ask', { k: key, action: 'view' })).json();
  assert.deepEqual(v.trip.cancel, { reason: 'wind' });
  const r = await (await call(s, '/api/ask', { k: key, action: 'send', personId: people[0].id, input: { birthDate: '1990-05-01' } })).json();
  assert.deepEqual(r.problems, ['cancelled']);
});

test('お客さん用の Worker（Access なし）: /api/ask だけを受け、お店の道は無い。置くのは ask.html と、それが読むファイルだけ', async () => {
  const { s, key } = await booked();
  /* お客さんの Worker は D1 と回数の binding だけを持つ（Access・AI・KV の設定は無い） */
  const env = { DB: s.env.DB, ASK_LIMIT: s.env.ASK_LIMIT };
  const ASK_ORIGIN = 'https://redux-ask.example.workers.dev';
  const req = (path, body, method = 'POST', site = 'same-origin') => handlePublic(new Request(ASK_ORIGIN + path, { method,
    headers: { 'content-type': 'application/json', 'sec-fetch-site': site }, body: method === 'POST' ? JSON.stringify(body) : undefined }), env, s.io);
  assert.equal((await req('/api/ask', { k: key, action: 'view' })).status, 200);
  for (const path of ['/api/roster', '/api/ask-link', '/api/read', '/api/healthz']) assert.equal((await req(path, {})).status, 404, path);
  assert.equal((await req('/api/ask', null, 'GET')).status, 405);
  assert.equal((await req('/api/ask', { k: key, action: 'view' }, 'POST', 'cross-site')).status, 403);
  const made = await (await req('/api/ask', { k: key, action: 'person-link', personId: (await (await req('/api/ask', { k: key, action: 'view' })).json()).people[0].person.id })).json();
  assert.ok(made.url.startsWith(`${ASK_ORIGIN}/ask#k=`), '1 人ずつのリンクは、お客さんの Worker の URL で作る');
  const files = askFiles();
  assert.equal(files[0], 'ask.html');
  assert.ok(files.includes('js/ask-page.js') && files.includes('css/app.css'));
  for (const shopOnly of ['index.html', 'js/booking.js', 'js/roster-sync.js', 'js/ai-reader.js', 'js/app.js', 'css/fonts.css']) assert.ok(!files.includes(shopOnly), shopOnly);
  const h = askHeaders(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  assert.ok(h.includes("/ask\n  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'"));
  assert.ok(!h.includes('cdn.jsdelivr.net') && !/^\/index/m.test(h), 'お店の画面のヘッダは写さない');
});

test('Access の無い Worker は、お店のサイトの予約フォームも受ける（許した origin・Turnstile・回数の守りは同じ）', async () => {
  const s = setup();
  const env = { DB: s.env.DB, ASK_LIMIT: s.env.ASK_LIMIT, BOOKING_LIMIT: s.env.BOOKING_LIMIT, BUDGET: s.env.BUDGET, SITE_ORIGINS: SITE, TURNSTILE_SECRET: 'turnstile-test-secret' };
  const post = (origin) => handlePublic(new Request('https://redux-ask.example.workers.dev/api/bookings', { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-turnstile-response': 't', 'cf-connecting-ip': '198.51.100.2' },
    body: JSON.stringify({ tour: 'dive', date: '2026-11-03', people: 1, name: '見本 一郎', email: 'ichiro@mail.example' }) }), env, s.io);
  assert.equal((await post('https://evil.example.com')).status, 403);
  const ok = await post(SITE);
  assert.equal(ok.status, 202);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.equal(stored(s).bookings.length, 1);
  const pre = await handlePublic(new Request('https://redux-ask.example.workers.dev/api/bookings', { method: 'OPTIONS', headers: { origin: SITE } }), env, s.io);
  assert.equal(pre.status, 204);
});

test('お店の Worker がリンクを作るとき、ASK_ORIGIN があればお客さんの Worker の URL にする', async () => {
  const { s, booking } = await booked();
  s.env.ASK_ORIGIN = 'https://redux-ask.example.workers.dev';
  const got = await (await call(s, '/api/ask-link', { bookingId: booking.id }, { staff: true })).json();
  assert.ok(got.url.startsWith('https://redux-ask.example.workers.dev/ask#k='));
});

test('ログに鍵も名前も出ない', async () => {
  logs.length = 0;
  const { s, key, people } = await booked();
  await call(s, '/api/ask', { k: key, action: 'view' });
  await call(s, '/api/ask', { k: key, action: 'send', personId: people[0].id, input: { birthDate: '1990-05-01' } });
  const all = logs.join('\n');
  assert.ok(!all.includes(key));
  assert.ok(!all.includes('花子') && !all.includes('1990-05-01'));
  assert.ok(logs.some(l => l.includes('"route":"/api/ask"') && l.includes('"action":"send"')));
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
