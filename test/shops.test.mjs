// 何店でも扱える作り（worker/shop-core.mjs・shop-db.mjs と、それを使う handler・auto・ask-route）を、外との境目を見本に差し替えて確かめる。
// お店の一覧（D1 の shops）があると、スタッフはログインしたメールのお店の名簿だけを見て書き、サイトの予約は送ってきたサイトのお店へ、
// お客さんのリンクは鍵と一緒に置いたお店へ、Cron は名簿があるお店を全部回る。一覧が空（表が無い）なら今までどおり 1 店。
// 実行: node test/shops.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { handle, handlePublic } from '../worker/handler.mjs';
import { scheduled } from '../worker/auto.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { shopForEmail, shopForOrigin, shopForRecipient, shopsFromRows } from '../worker/shop-core.mjs';
import { fakeKv, fakeAccess, fakeD1, fakeTurnstile, fakeRateLimit, fakeMail, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const PUBLIC = 'https://redux-ask.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const A_STAFF = 'a.staff@example.com';
const B_STAFF = 'b.staff@example.com';
const NOBODY = 'nobody@example.com';
const SITE_A = 'https://shop-a.example.com';
const SITE_B = 'https://shop-b.example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const REAL_LOG = console.log;
console.log = () => {};
const access = await fakeAccess(TEAM);
const jwtFor = (email) => access.sign({ iss: `https://${TEAM}`, aud: [AUD], email, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

function setup({ shops = true } = {}) {
  resetAccessCache();
  const db = fakeD1();
  if (shops) {
    db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [A_STAFF], sites: [SITE_A], inbox: 'a@yoyaku.example' });
    db.addShop({ id: 'shop-b', name: 'B マリン', members: [B_STAFF], sites: [SITE_B], inbox: 'b@yoyaku.example' });
  }
  const turnstile = fakeTurnstile();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: [A_STAFF, B_STAFF, NOBODY].join(','),
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, ASK_LIMIT: fakeRateLimit(100), BOOKING_LIMIT: fakeRateLimit(100),
    TURNSTILE_SECRET: 'turnstile-test-secret', SITE_ORIGINS: SITE_A, ASK_ORIGIN: PUBLIC, EMAIL: fakeMail(), MAIL_FROM: 'yoyaku@shop.example', APP_URL: ORIGIN
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

async function staff(s, email, path, method, body) {
  const headers = { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': await jwtFor(email) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return handle(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), s.env, s.io);
}
const siteBooking = (s, site, name) => handlePublic(new Request(`${PUBLIC}/api/bookings`, { method: 'POST',
  headers: { origin: site, 'content-type': 'application/json', 'cf-turnstile-response': 't', 'cf-connecting-ip': '198.51.100.3' },
  body: JSON.stringify({ tour: 'dive', date: '2026-11-03', people: 1, name, email: 'guest@mail.example' }) }), s.env, s.io);
const stored = (s, shop) => JSON.parse(s.db.rows.get(shop).state);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('振り分けの決まり: 一覧が空なら 1 店、あればメール・サイト・宛先で引く。壊れた行は捨てる', () => {
  assert.equal(shopForEmail([], 'x@example.com'), 'default');
  assert.equal(shopForOrigin([], SITE_A, `${SITE_A}, ${SITE_B}`), 'default');
  assert.equal(shopForOrigin([], 'https://evil.example.com', SITE_A), '');
  assert.equal(shopForRecipient([], 'any@x.example'), 'default');
  const shops = shopsFromRows([
    { id: 'shop-a', name: 'A', members: JSON.stringify(['A.Staff@Example.com']), sites: JSON.stringify([SITE_A]), inbox: 'A@Yoyaku.example' },
    { id: 'Bad Id', name: 'x', members: '[]', sites: '[]', inbox: '' },
    { id: 'shop-c', name: 'C', members: 'not json', sites: '[]', inbox: '' }
  ]);
  assert.deepEqual(shops.map(x => x.id), ['shop-a', 'shop-c']);
  assert.equal(shopForEmail(shops, 'a.staff@example.com'), 'shop-a');
  assert.equal(shopForEmail(shops, 'other@example.com'), '');
  assert.equal(shopForOrigin(shops, SITE_A, ''), 'shop-a');
  assert.equal(shopForOrigin(shops, SITE_B, SITE_B), '', '一覧があるときは SITE_ORIGINS を見ない');
  assert.equal(shopForRecipient(shops, 'a@yoyaku.example'), 'shop-a');
});

test('スタッフは自分のお店の名簿だけを読み書きする。どのお店にもいない人は 403。名前は一覧の名前にそろう', async () => {
  const s = setup();
  const blank = { v: 1, shop: { name: '端末の見本' }, trips: [], bookings: [], people: [], log: [] };
  assert.equal((await staff(s, A_STAFF, '/api/roster', 'PUT', { base: 0, state: blank })).status, 200);
  assert.equal(stored(s, 'shop-a').shop.name, 'A ダイブ', 'お店の名前は一覧の名前にそろえる');
  assert.equal((await staff(s, B_STAFF, '/api/roster', 'PUT', { base: 0, state: blank })).status, 200);
  const a = await (await staff(s, A_STAFF, '/api/roster', 'GET')).json();
  const b = await (await staff(s, B_STAFF, '/api/roster', 'GET')).json();
  assert.equal(a.state.shop.name, 'A ダイブ');
  assert.equal(b.state.shop.name, 'B マリン');
  assert.equal((await staff(s, NOBODY, '/api/roster', 'GET')).status, 403);
  assert.deepEqual([...s.db.rows.keys()].sort(), ['shop-a', 'shop-b']);
});

test('サイトの予約は送ってきたサイトのお店へ。一覧に無いサイトは 403。1 日の件数はお店ごと', async () => {
  const s = setup();
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 202);
  s.turnstile.hostname = 'shop-b.example.com';
  assert.equal((await siteBooking(s, SITE_B, '見本 二郎')).status, 202);
  assert.equal((await siteBooking(s, 'https://evil.example.com', '見本 三郎')).status, 403);
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_B, '見本 四郎')).status, 403, 'A のサイトで解いた Turnstile は B の予約に使えない');
  assert.deepEqual(stored(s, 'shop-a').bookings.map(x => x.leadName), ['見本 一郎']);
  assert.deepEqual(stored(s, 'shop-b').bookings.map(x => x.leadName), ['見本 二郎']);
  assert.equal(stored(s, 'shop-a').shop.name, 'A ダイブ');
  assert.equal(s.env.BUDGET.peek('site:shop-a:2026-10-27'), '1');
  assert.equal(s.env.BUDGET.peek('site:shop-b:2026-10-27'), '1');
});

test('お客さんのリンク: 作れるのは自分のお店の予約だけ。開くと鍵のお店の名簿に入る', async () => {
  const s = setup();
  s.turnstile.hostname = 'shop-b.example.com';
  await siteBooking(s, SITE_B, '見本 二郎');
  const bId = stored(s, 'shop-b').bookings[0].id;
  assert.equal((await staff(s, A_STAFF, '/api/ask-link', 'POST', { bookingId: bId })).status, 404, '別のお店の予約のリンクは作れない');
  const made = await (await staff(s, B_STAFF, '/api/ask-link', 'POST', { bookingId: bId })).json();
  assert.ok(made.url.startsWith(`${PUBLIC}/ask#k=`));
  assert.equal([...s.db.links.values()][0].shop, 'shop-b');
  const key = made.url.split('#k=')[1];
  const ask = (body) => handlePublic(new Request(`${PUBLIC}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }), s.env, s.io);
  const v = await (await ask({ k: key, action: 'view' })).json();
  assert.equal(v.shop, 'B マリン');
  const pid = v.people[0].person.id;
  const sent = await (await ask({ k: key, action: 'send', personId: pid, input: { birthDate: 'x' } })).json();
  assert.ok(sent.problems.includes('birthDate') && !sent.problems.includes('gone'), 'B のお店の名簿で、その人の項目を確かめた');
  assert.equal(sent.view.shop, 'B マリン');
  assert.equal(s.db.rows.get('shop-a'), undefined, 'A のお店の名簿には触れない');
});

test('Cron は名簿があるお店を全部回る。1 店で失敗してもほかは止まらない', async () => {
  const s = setup();
  s.turnstile.hostname = 'shop-a.example.com';
  await siteBooking(s, SITE_A, '見本 一郎');
  s.turnstile.hostname = 'shop-b.example.com';
  await siteBooking(s, SITE_B, '見本 二郎');
  s.db.rows.set('broken', { version: 1, state: '{not json', updated_at: '' });
  await scheduled(s.env, s.io);
  assert.equal(s.env.EMAIL.sent.length, 2, '2 店のお願いが送られた');
  assert.ok(s.env.EMAIL.sent.every(m => m.text.includes(`${PUBLIC}/ask#k=`)));
  assert.equal(stored(s, 'shop-a').outbox[0].status, 'sent');
  assert.equal(stored(s, 'shop-b').outbox[0].status, 'sent');
  const keys = [...s.db.links.values()].map(l => l.shop).sort();
  assert.deepEqual(keys, ['shop-a', 'shop-b'], 'リンクの鍵はそれぞれのお店に置く');
});

test('一覧が空（表が無い D1）なら、今までどおり 1 店（default）で動く', async () => {
  const s = setup({ shops: false });
  const blank = { v: 1, shop: { name: '見本' }, trips: [], bookings: [], people: [], log: [] };
  assert.equal((await staff(s, NOBODY, '/api/roster', 'PUT', { base: 0, state: blank })).status, 200);
  assert.deepEqual([...s.db.rows.keys()], ['default']);
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 202);
  assert.equal(stored(s, 'default').bookings.length, 1);
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
