// お客さんのリンク（/api/ask・/api/ask-link。worker/ask-route.mjs・ask-core.mjs・ask-db.mjs）を、外との境目を見本に差し替えて確かめる。
// Access の無い redux-ask は D1 を持たず、お店の Worker の 7 つの口（worker/shop-service.mjs。Service Binding の SHOP）だけを呼ぶ（SEC-13）。
// 鍵は 32 バイトで D1 には SHA-256 だけ、鍵が違う・切れた・予約が無いは同じ 404、予約のリンクは健康以外・1 人ずつのリンクは健康だけ、
// 当日の体調は Worker の日付が便の日のときだけ、名簿の中身は見せない、作り直したら古い鍵は止まる、回数の上限。
// 実行: node test/ask-link.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { handle } from '../worker/handler.mjs';
import { handlePublic } from '../worker/public-handler.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { SHOP_METHODS } from '../worker/shop-client.mjs';
import { keyHash } from '../worker/ask-key.mjs';
import { askFiles, askHeaders } from '../tools/build-site.mjs';
import { readFileSync } from 'node:fs';
import { resetAccessCache } from '../worker/access.mjs';
import { fakeKv, fakeAccess, fakeD1, fakeTurnstile, fakeRateLimit, fakeShopBinding, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const SITE = 'https://site.example.com';
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
    SHOP_NAME: 'B マリン（見本）', SINGLE_SHOP: 'default'
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
  return { db, env, io, turnstile };
}

const call = (s, path, body, { staff = false, site = 'same-origin', ip = '203.0.113.5' } = {}) => handle(new Request(ORIGIN + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}), 'cf-connecting-ip': ip, ...(staff ? { 'cf-access-jwt-assertion': jwt } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body)
}), s.env, s.io);
const stored = (s) => JSON.parse(s.db.rows.get('default').state);
const keyOf = (url) => url.split('#k=')[1];

/* redux-ask の env: 回数の binding と Turnstile の secret と、お店の Worker への SHOP だけ（D1 は無い）。SHOP の向こうは env を持つ ShopService */
const PUBLIC_ASK = 'https://redux-ask.example.workers.dev';
const publicEnv = (s, extra = {}) => ({ ASK_LIMIT: s.env.ASK_LIMIT, BOOKING_LIMIT: s.env.BOOKING_LIMIT, TURNSTILE_SECRET: s.env.TURNSTILE_SECRET,
  SHOP: fakeShopBinding(new ShopService(s.env, s.io)), ...extra });
const publicAsk = (s, env, body, { method = 'POST', site = 'same-origin', path = '/api/ask', ip = '203.0.113.9' } = {}) => handlePublic(new Request(PUBLIC_ASK + path, { method,
  headers: { 'content-type': 'application/json', 'sec-fetch-site': site, 'cf-connecting-ip': ip }, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }), env, s.io);
const sitePost = (s, env, origin, body = { tour: 'dive', date: '2026-11-03', people: 1, name: '見本 一郎', email: 'ichiro@mail.example' }) => handlePublic(new Request(`${PUBLIC_ASK}/api/bookings`, {
  method: 'POST', headers: { origin, 'content-type': 'application/json', 'cf-turnstile-response': 't', 'cf-connecting-ip': '198.51.100.2' }, body: JSON.stringify(body) }), env, s.io);

/* import をたどって、ファイルの集まりを出す（redux-ask の束に何が入るか） */
function reachable(entry) {
  const seen = new Set();
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
    for (const m of src.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) walk(new URL(m[1], new URL(`file:///${rel}`)).pathname.slice(1));
  };
  walk(entry);
  return [...seen];
}
const jsonc = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

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

/* 同じお店に、もう 1 件の予約（別の人たち）を入れる */
async function bookAnother(s, name) {
  const r = await handle(new Request(`${ORIGIN}/api/bookings`, { method: 'POST',
    headers: { origin: SITE, 'content-type': 'application/json', 'cf-turnstile-response': 't', 'cf-connecting-ip': '198.51.100.7' },
    body: JSON.stringify({ tour: 'dive', date: '2026-11-03', people: 2, name, email: 'other@mail.example', exp: 'first' }) }), s.env, s.io);
  assert.equal(r.status, 202);
  const st = stored(s);
  const booking = st.bookings.find(b => b.leadName === name);
  return st.people.filter(p => p.bookingId === booking.id);
}

test('同伴者の名前: 予約のリンクで、名前が空の人にだけ入れられる。名前が入っている人・別の予約の人・1 人ずつのリンクでは入れられない', async () => {
  const { s, key, people } = await booked();
  const [lead, guest] = people;
  assert.ok(lead.name && !guest.name, '予約フォームは代表者の名前だけを入れる');
  const view = await (await call(s, '/api/ask', { k: key, action: 'view' })).json();
  assert.ok(!view.people.find(p => p.person.id === lead.id).ask.includes('name'));
  assert.ok(view.people.find(p => p.person.id === guest.id).ask.includes('name'), '名前が空の人には名前を聞く');
  const send = (k, personId, input) => call(s, '/api/ask', { k, action: 'send', personId, input }).then(r => r.json());
  const nameOf = (id) => stored(s).people.find(p => p.id === id).name;
  /* 入っている名前は書き換えられない */
  assert.deepEqual((await send(key, lead.id, { name: '別の人' })).problems, ['nothing']);
  assert.equal(nameOf(lead.id), lead.name);
  /* 悪い名前は断る（予約フォームの名前と同じ決まり）。何も入らない */
  for (const bad of ['', '見本 http://evil.example', 'evil.example.com', '見本\n次郎', 'あ'.repeat(61), 7]) {
    assert.deepEqual((await send(key, guest.id, { name: bad })).problems, ['personName'], String(bad).slice(0, 20));
  }
  assert.equal(nameOf(guest.id), '');
  /* 別の予約の人には、この予約のリンクでは入れられない */
  const [otherLead, otherGuest] = await bookAnother(s, '別 予約');
  assert.ok(!otherGuest.name);
  assert.equal((await call(s, '/api/ask', { k: key, action: 'send', personId: otherGuest.id, input: { name: '見本 次郎' } })).status, 404);
  assert.equal(nameOf(otherGuest.id), '');
  assert.equal(nameOf(otherLead.id), '別 予約');
  /* 1 人ずつのリンク（健康だけ）では入れられない */
  const made = await (await call(s, '/api/ask', { k: key, action: 'person-link', personId: guest.id })).json();
  assert.deepEqual((await send(keyOf(made.url), guest.id, { name: '見本 次郎' })).problems, ['nothing']);
  assert.equal(nameOf(guest.id), '');
  /* 名前だけを送ると入る。ほかの項目は聞いたまま。見せる物に名前以外の中身は増えない */
  const ok = await send(key, guest.id, { name: ' 見本   次郎 ' });
  assert.deepEqual(ok.problems, []);
  assert.equal(nameOf(guest.id), '見本 次郎');
  const after = ok.view.people.find(p => p.person.id === guest.id);
  assert.equal(after.person.name, '見本 次郎');
  assert.ok(!after.ask.includes('name') && after.ask.includes('birthDate'));
  assert.deepEqual(Object.keys(after.person).sort(), ['id', 'name']);
  const saved = stored(s).people.find(p => p.id === guest.id);
  assert.equal(saved.src.name, 'guest');
  assert.ok(saved.health.answers.every(a => a === null), '健康の答えは入らない');
  /* 入れた後は、もう書き換えられない */
  assert.deepEqual((await send(key, guest.id, { name: '見本 三郎' })).problems, ['nothing']);
  assert.equal(nameOf(guest.id), '見本 次郎');
});

test('同伴者の名前: 全部の項目と一緒に送っても入る。名前が空のままだと断る', async () => {
  const { s, key, people } = await booked();
  const guest = people[1];
  const input = { birthDate: '1992-03-04', address: '那覇市 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' },
    cert: { course: 'NONE', date: '' }, courses: '', dives: 0, lastDive: '' };
  const miss = await (await call(s, '/api/ask', { k: key, action: 'send', personId: guest.id, input })).json();
  assert.deepEqual(miss.problems, ['personName']);
  assert.equal(stored(s).people.find(p => p.id === guest.id).birthDate, '', '名前が無いと、ほかの項目も入れない');
  const ok = await (await call(s, '/api/ask', { k: key, action: 'send', personId: guest.id, input: { ...input, name: '見本 次郎' } })).json();
  assert.deepEqual(ok.problems, []);
  const p = stored(s).people.find(x => x.id === guest.id);
  assert.equal(p.name, '見本 次郎');
  assert.equal(p.birthDate, '1992-03-04');
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
  /* お客さんの Worker は回数の binding と SHOP だけを持つ（D1・Access・AI・KV の設定は無い） */
  const env = publicEnv(s);
  assert.equal(env.DB, undefined);
  const req = (path, body, method = 'POST', site = 'same-origin') => publicAsk(s, env, body, { method, site, path });
  assert.equal((await req('/api/ask', { k: key, action: 'view' })).status, 200);
  for (const path of ['/api/roster', '/api/ask-link', '/api/read', '/api/healthz']) assert.equal((await req(path, {})).status, 404, path);
  assert.equal((await req('/api/ask', null, 'GET')).status, 405);
  assert.equal((await req('/api/ask', { k: key, action: 'view' }, 'POST', 'cross-site')).status, 403);
  const made = await (await req('/api/ask', { k: key, action: 'person-link', personId: (await (await req('/api/ask', { k: key, action: 'view' })).json()).people[0].person.id })).json();
  assert.ok(made.url.startsWith(`${PUBLIC_ASK}/ask#k=`), '1 人ずつのリンクは、お客さんの Worker の URL で作る');
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
  const env = publicEnv(s);
  assert.equal((await sitePost(s, env, 'https://evil.example.com')).status, 403);
  const ok = await sitePost(s, env, SITE);
  assert.equal(ok.status, 202);
  assert.equal(ok.headers.get('access-control-allow-origin'), SITE);
  assert.equal(stored(s).bookings.length, 1);
  const pre = await handlePublic(new Request(`${PUBLIC_ASK}/api/bookings`, { method: 'OPTIONS', headers: { origin: SITE } }), env, s.io);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  const evilPre = await handlePublic(new Request(`${PUBLIC_ASK}/api/bookings`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } }), env, s.io);
  assert.equal(evilPre.status, 403);
  assert.equal(evilPre.headers.get('access-control-allow-origin'), null, '許していない origin には CORS のヘッダを返さない');
});

test('redux-ask の守りは D1 なしでも同じ: 状態コードと上限（種類・大きさ・IP の回数・鍵ごとの回数・設定・形）', async () => {
  const { s, key } = await booked();
  const env = publicEnv(s);
  const view = { k: key, action: 'view' };
  assert.equal((await publicAsk(s, env, view, { site: 'cross-site' })).status, 403);
  assert.equal((await publicAsk(s, env, view, { site: '' })).status, 403);
  assert.equal((await publicAsk(s, env, 'x'.repeat(9000))).status, 413);
  assert.equal((await publicAsk(s, env, '{not json')).status, 400);
  assert.equal((await publicAsk(s, env, { ...view, extra: 1 })).status, 400);
  assert.equal((await publicAsk(s, env, { k: 'short', action: 'view' })).status, 400);
  assert.equal((await publicAsk(s, env, { k: key, action: 'send', personId: 'x', input: 'no' })).status, 400, 'input がオブジェクトでなければ形で断る');
  const typed = await handlePublic(new Request(`${PUBLIC_ASK}/api/ask`, { method: 'POST', headers: { 'content-type': 'text/plain', 'sec-fetch-site': 'same-origin' }, body: '{}' }), env, s.io);
  assert.equal(typed.status, 415);
  for (let i = 0; i < 30; i += 1) await publicAsk(s, env, view);
  assert.equal((await publicAsk(s, env, view)).status, 429, '鍵 1 つは 1 日 30 回まで');
  s.io.clock += 24 * 3600 * 1000;
  assert.equal((await publicAsk(s, env, view)).status, 200, '次の日はまた開ける');
  const tight = publicEnv(s, { ASK_LIMIT: fakeRateLimit(1) });
  await publicAsk(s, tight, view, { ip: '192.0.2.7' });
  assert.equal((await publicAsk(s, tight, view, { ip: '192.0.2.7' })).status, 429, '1 つの IP の回数');
  assert.equal((await publicAsk(s, publicEnv(s, { ASK_LIMIT: undefined }), view)).status, 503);
  assert.equal((await publicAsk(s, publicEnv(s, { SHOP: undefined }), view)).status, 503, 'お店の Worker への binding が無ければ 503');
  assert.equal((await sitePost(s, publicEnv(s, { SHOP: undefined }), SITE)).status, 503);
  assert.equal((await sitePost(s, publicEnv(s, { TURNSTILE_SECRET: '' }), SITE)).status, 503);
  assert.equal((await sitePost(s, publicEnv(s, { BOOKING_LIMIT: fakeRateLimit(0) }), SITE)).status, 429);
  s.turnstile.success = false;
  assert.equal((await sitePost(s, env, SITE)).status, 403, 'Turnstile を通らなければ入れない');
  s.turnstile.success = true;
  assert.equal((await sitePost(s, env, SITE, { tour: 'dive' })).status, 400, '予約の形が合わなければ 400');
  assert.equal((await handlePublic(new Request(`${PUBLIC_ASK}/api/health`), { BUDGET: fakeKv() }, s.io)).status, 503, 'cron:last が無ければ /api/health は 503');
});

test('口(1) askView(hash): 名前と聞く項目の名前だけを返す。hash の形が違えば 400、鍵の行が無ければ 404、D1 が無ければ 503', async () => {
  const { s, key } = await booked();
  const shop = new ShopService(s.env, s.io);
  const ok = await shop.askView(await keyHash(key));
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.body.people[0].person).sort(), ['id', 'name']);
  assert.ok(!JSON.stringify(ok.body).includes('hanako@mail.example'));
  for (const bad of [undefined, null, 5, {}, key, 'abc', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
    const got = await shop.askView(bad);
    assert.equal(got.status, 400, String(bad));
    assert.deepEqual(got.note, { why: 'input-hash' });
  }
  const none = await shop.askView('0'.repeat(64));
  assert.equal(none.status, 404);
  assert.deepEqual(none.body, { error: 'gone' });
  const noDb = await new ShopService({ ...s.env, DB: undefined }, s.io).askView(await keyHash(key));
  assert.deepEqual([noDb.status, noDb.note], [503, { why: 'config:DB' }]);
});

test('口(2) askApply(hash, req, origin): 答えを入れる・1 人ずつのリンクを作る。鍵を含む本文・view・形の違う本文・変な origin は 400', async () => {
  const { s, key, people } = await booked();
  const shop = new ShopService(s.env, s.io);
  const hash = await keyHash(key);
  const id = people[0].id;
  const input = { birthDate: '1990-05-01', address: '那覇市 1-2-3', emergency: { name: '見本 母', relation: '母', phone: '090-0000-1111' }, answers: Array(5).fill('no'), consent: true };
  const sent = await shop.askApply(hash, { action: 'send', personId: id, input }, PUBLIC_ASK);
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body.problems, []);
  assert.equal(stored(s).people.find(p => p.id === id).birthDate, '1990-05-01');
  const link = await shop.askApply(hash, { action: 'person-link', personId: id }, PUBLIC_ASK);
  assert.equal(link.status, 200);
  assert.ok(link.body.url.startsWith(`${PUBLIC_ASK}/ask#k=`));
  const bad = [{ action: 'send', personId: id, input: {}, k: key }, { action: 'view' }, { action: 'view', personId: id }, { action: 'send', personId: id }, { action: 'send', personId: '../x', input: {} },
    { action: 'today', personId: id, answer: 'maybe' }, { action: 'delete', personId: id }, ['send'], null, 'send', { action: 'send', personId: id, input: {}, extra: 1 }];
  for (const req of bad) assert.equal((await shop.askApply(hash, req, PUBLIC_ASK)).status, 400, JSON.stringify(req));
  for (const origin of [undefined, '', 'javascript:alert(1)', 'https://evil.example/path', 'https://', `https://${'a'.repeat(200)}.example`, 5]) {
    const got = await shop.askApply(hash, { action: 'person-link', personId: id }, origin);
    assert.equal(got.status, 400, String(origin));
    assert.deepEqual(got.note, { why: 'input-origin' });
  }
  assert.equal((await shop.askApply('0'.repeat(64), { action: 'send', personId: id, input: {} }, PUBLIC_ASK)).status, 404);
  assert.equal((await shop.askApply('nope', { action: 'send', personId: id, input: {} }, PUBLIC_ASK)).status, 400);
  assert.equal((await new ShopService({ ...s.env, DB: undefined }, s.io).askApply(hash, { action: 'send', personId: id, input: {} }, PUBLIC_ASK)).status, 503);
});

test('口(3) siteHosts(origin): お店の一覧にあるサイトならホスト名を返す。無ければ 403、一覧が使えなければ 503（開いた側に倒さない）', async () => {
  const s = setup();
  const shop = new ShopService(s.env, s.io);
  assert.deepEqual(await shop.siteHosts(SITE), { ok: true, hosts: ['site.example.com'], note: { shop: 'default' } });
  for (const origin of ['https://evil.example.com', '', undefined, null, 5, {}, `https://${'a'.repeat(200)}.example`, 'ftp://site.example.com', `${SITE}/`]) {
    const got = await shop.siteHosts(origin);
    assert.equal(got.ok, false, String(origin));
    assert.equal(got.status, 403);
    assert.deepEqual(got.body, { error: 'origin' });
  }
  const down = await new ShopService({ ...s.env, SINGLE_SHOP: undefined }, s.io).siteHosts(SITE);
  assert.deepEqual([down.ok, down.status, down.body, down.note], [false, 503, { error: 'shops' }, { why: 'shops-no-table' }]);
  const noDb = await new ShopService({ ...s.env, DB: undefined }, s.io).siteHosts(SITE);
  assert.deepEqual([noDb.ok, noDb.status, noDb.note], [false, 503, { why: 'config:DB' }]);
});

test('口(4) siteBooking(origin, given): origin のお店の名簿に入れる。知らない origin は何も書かず 403、形が違えば 400', async () => {
  const s = setup();
  const shop = new ShopService(s.env, s.io);
  const body = { tour: 'dive', date: '2026-11-03', people: 1, name: '見本 一郎', email: 'ichiro@mail.example' };
  const ok = await shop.siteBooking(SITE, body);
  assert.deepEqual([ok.status, ok.body, ok.note], [202, { ok: true }, { shop: 'default', added: 1 }]);
  assert.equal(stored(s).bookings.length, 1);
  const before = JSON.stringify(stored(s));
  const evil = await shop.siteBooking('https://evil.example.com', body);
  assert.deepEqual([evil.status, evil.body], [403, { error: 'origin' }]);
  const shaped = await shop.siteBooking(SITE, { tour: 'dive' });
  assert.equal(shaped.status, 400);
  assert.match(shaped.note.why, /^input-/);
  assert.equal((await shop.siteBooking(SITE, 'x')).status, 400);
  assert.equal((await shop.siteBooking(SITE, null)).status, 400);
  assert.equal(JSON.stringify(stored(s)), before, '断った要求は名簿を変えない');
  assert.equal((await new ShopService({ ...s.env, DB: undefined }, s.io).siteBooking(SITE, body)).status, 503);
});

test('Service Binding の口は 7 つだけ: SHOP_METHODS・fakeShopBinding・ShopRpc のメソッドが一致し、D1 や名簿の口は無い', async () => {
  const s = setup();
  const binding = fakeShopBinding(new ShopService(s.env, s.io));
  assert.deepEqual(SHOP_METHODS, ['askView', 'askApply', 'siteHosts', 'siteBooking', 'walkinView', 'walkinSubmit', 'intakeBooking']);
  assert.deepEqual(Object.keys(binding).filter(k => typeof binding[k] === 'function').sort(), [...SHOP_METHODS].sort());
  for (const leak of ['env', 'io', 'DB', 'prepare', 'getRoster', 'listShops', 'makeAskLink']) assert.equal(binding[leak], undefined, leak);
  /* shop-rpc.mjs は cloudflare:workers を読むので Node では開けない。メソッド名だけ文字で突き合わせる */
  const rpc = readFileSync(new URL('../worker/shop-rpc.mjs', import.meta.url), 'utf8');
  assert.match(rpc, /class ShopRpc extends WorkerEntrypoint/);
  assert.deepEqual([...rpc.matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1]).sort(), [...SHOP_METHODS].sort(), '公開するメソッドは SHOP_METHODS だけ');
  assert.match(readFileSync(new URL('../worker/index.mjs', import.meta.url), 'utf8'), /export \{ ShopRpc \} from '\.\/shop-rpc\.mjs'/);
  /* RPC は素の値だけを渡す: 答えは structuredClone を通っても同じ */
  const got = await binding.siteHosts(SITE);
  assert.deepEqual(got, { ok: true, hosts: ['site.example.com'], note: { shop: 'default' } });
  assert.deepEqual(binding.calls, ['siteHosts']);
});

test('向こうの答えは信用しない: 形が合わない答えは 500（crash）にし、ログに足す note は決まった名前の短い値だけ', async () => {
  const { s, key } = await booked();
  const view = { k: key, action: 'view' };
  const wrap = (fake) => ({ ...publicEnv(s), SHOP: { ...fakeShopBinding(new ShopService(s.env, s.io)), ...fake } });
  for (const askView of [async () => ({ status: '200', body: {}, note: {} }), async () => ({ status: 200, body: 'x', note: {} }), async () => ({ status: 200, body: {} }), async () => null,
    async () => ({ status: 99, body: {}, note: {} })]) {
    assert.equal((await publicAsk(s, wrap({ askView }), view)).status, 500);
  }
  assert.equal((await sitePost(s, wrap({ siteHosts: async () => ({ ok: true, hosts: [1], note: {} }) }), SITE)).status, 500);
  assert.equal((await sitePost(s, wrap({ siteHosts: async () => ({ ok: 'yes', note: {} }) }), SITE)).status, 500);
  logs.length = 0;
  const sly = await publicAsk(s, wrap({ askView: async () => ({ status: 200, body: { ok: true }, note: { why: 'x'.repeat(200), route: '/evil', status: 1, ms: -1, shop: 'a-shop', problems: 2, extra: 'y' } }) }), view);
  assert.equal(sly.status, 200);
  const line = JSON.parse(logs[logs.length - 1]);
  assert.equal(line.route, '/api/ask');
  assert.equal(line.status, 200);
  assert.ok(line.ms >= 0);
  assert.deepEqual([line.why.length, line.shop, line.problems, line.extra], [60, 'a-shop', 2, undefined]);
});

test('redux-ask の束: D1 の binding も、名簿・お店の一覧・鍵の行・お店の道を読むファイルも入らない。口は 7 つの RPC だけ', () => {
  const files = reachable('worker/ask-index.mjs').filter(f => f.startsWith('worker/')).sort();
  assert.deepEqual(files, ['worker/api-http.mjs', 'worker/ask-index.mjs', 'worker/ask-input.mjs', 'worker/ask-key.mjs', 'worker/auto-core.mjs', 'worker/past-core.mjs',
    'worker/public-handler.mjs', 'worker/shop-client.mjs', 'worker/site-guard.mjs', 'worker/sync-core.mjs'], '足すときは、ここに増えるファイルが D1・名簿・お店の道に触れないことを確かめてから');
  for (const f of files) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bDB\b|\bprepare\s*\(|roster-db|shop-db|ask-db|limit-db|unread-db/.test(src), `${f} が D1 に触れている`);
  }
  const ask = jsonc('wrangler.ask.jsonc');
  assert.equal(ask.main, 'worker/ask-index.mjs');
  assert.equal(ask.d1_databases, undefined, 'redux-ask は D1 の binding を持たない');
  assert.deepEqual(ask.services, [{ binding: 'SHOP', service: jsonc('wrangler.jsonc').name, entrypoint: 'ShopRpc' }]);
  assert.deepEqual(ask.kv_namespaces.map(k => k.binding), ['BUDGET'], 'KV は /api/health の cron:last を読む BUDGET だけ');
  assert.deepEqual(ask.ratelimits.map(r => r.name).sort(), ['ASK_LIMIT', 'BOOKING_LIMIT', 'INTAKE_LIMIT']);
  assert.equal(jsonc('wrangler.jsonc').d1_databases[0].binding, 'DB', 'D1 を持つのはお店の Worker だけ');
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
  await call(s, '/api/ask', { k: key, action: 'send', personId: people[1].id, input: { name: '見本 次郎' } });
  assert.equal(stored(s).people.find(p => p.id === people[1].id).name, '見本 次郎');
  const all = logs.join('\n');
  assert.ok(!all.includes(key));
  assert.ok(!all.includes('花子') && !all.includes('1990-05-01') && !all.includes('次郎'));
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
