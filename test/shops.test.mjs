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

/* 届いたメールの見本（Email Routing が渡す形）。SPF も DKIM も送り主のドメインで通った印つき */
function mail(from, to) {
  const bytes = new TextEncoder().encode('Content-Type: text/plain; charset=utf-8\r\n\r\n11/5 体験ダイビング 1 名 見本 次郎 様');
  const domain = from.split('@')[1];
  return { from, to, rawSize: bytes.byteLength, rejected: '', headers: new Headers({ 'authentication-results': `mx; dkim=pass header.d=${domain}; spf=pass smtp.mailfrom=${from}` }),
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), setReject(why) { this.rejected = why; } };
}

test('ザクのレビュー: 一覧の行が 1 つでも壊れていたら止める（全員が 1 つの名簿を共有しない）', async () => {
  const s = setup();
  s.db.shops.set('Bad_Id', { id: 'Bad_Id', name: 'x', members: '[]', sites: '[]', inbox: '', senders: '[]' });
  assert.equal((await staff(s, A_STAFF, '/api/roster', 'GET')).status, 503);
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 503);
  assert.equal(s.db.rows.size, 0);
});

test('ザクのレビュー: 届いたメールは、宛先のお店の送り主だけ。全店あわせた 1 日の上限も数える', async () => {
  const { receiveMail } = await import('../worker/auto.mjs');
  const { fakeAnthropic } = await import('../worker/fakes.mjs');
  const s = setup();
  s.db.shops.clear();
  s.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [A_STAFF], sites: [SITE_A], inbox: 'a@yoyaku.example', senders: ['fwd@shop-a.example'] });
  s.db.addShop({ id: 'shop-b', name: 'B マリン', members: [B_STAFF], sites: [SITE_B], inbox: 'b@yoyaku.example', senders: ['fwd@shop-b.example'] });
  const api = fakeAnthropic();
  api.answer = JSON.stringify({ participants: [{ name: '見本 次郎' }], booking: { date: '2026-11-05', start: '08:30', tour: '体験ダイビング', people: 1, lead_name: '見本 次郎', lead_email: 'jiro@mail.example' }, health_info_visible: false });
  const realFetch = s.io.fetch;
  s.io.fetch = (url, init) => (url === 'https://api.anthropic.com/v1/messages' ? api.respond(init) : realFetch(url, init));
  const cross = mail('fwd@shop-a.example', 'b@yoyaku.example');
  await receiveMail(cross, s.env, s.io);
  assert.ok(cross.rejected, 'A の転送元から B の受け口へは入れない');
  assert.equal(api.calls.length, 0);
  const ok = mail('fwd@shop-b.example', 'b@yoyaku.example');
  await receiveMail(ok, s.env, s.io);
  assert.equal(ok.rejected, '');
  assert.equal(stored(s, 'shop-b').bookings.length, 1);
  s.env.BUDGET.put('mail:2026-10-27', '60');
  await receiveMail(mail('fwd@shop-a.example', 'a@yoyaku.example'), s.env, s.io);
  assert.equal(api.calls.length, 1, '全店あわせて 60 件を超えたら AI を呼ばない');
});

test('ザクのレビュー: 一覧から消したお店は、Cron もリンクも動かさない', async () => {
  const s = setup();
  s.turnstile.hostname = 'shop-b.example.com';
  await siteBooking(s, SITE_B, '見本 二郎');
  const bId = stored(s, 'shop-b').bookings[0].id;
  const made = await (await staff(s, B_STAFF, '/api/ask-link', 'POST', { bookingId: bId })).json();
  s.db.shops.delete('shop-b');
  await scheduled(s.env, s.io);
  assert.equal(s.env.EMAIL.sent.length, 0, '消したお店には送らない');
  const r = await handlePublic(new Request(`${PUBLIC}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ k: made.url.split('#k=')[1], action: 'view' }) }), s.env, s.io);
  assert.equal(r.status, 404);
});

test('お店を足す道具（tools/shop.mjs）: 作る値を Worker がそのまま読める。合わない値は止める', async () => {
  const { shopSql, parseArgs } = await import('../tools/shop.mjs');
  const sql = shopSql(parseArgs(['add', '--id', 'shop-a', '--name', "A's ダイブ", '--member', 'Staff@Example.com', '--site', 'https://shop-a.example.com', '--inbox', 'A@reduxdive.com', '--sender', 'fwd@shop-a.example.com']));
  const m = sql.match(/VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/);
  const [id, name, members, sites, inbox, senders] = m.slice(1).map(x => x.replace(/''/g, "'"));
  const read = shopsFromRows([{ id, name, members, sites, inbox, senders }]);
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], { id: 'shop-a', name: "A's ダイブ", members: ['staff@example.com'], sites: ['https://shop-a.example.com'], inbox: 'a@reduxdive.com', senders: ['fwd@shop-a.example.com'] });
  for (const bad of [['add', '--id', 'Bad Id', '--name', 'x', '--member', 'a@b.co'], ['add', '--id', 'x', '--name', 'x'], ['add', '--id', 'x', '--name', 'x', '--member', 'a@b.co', '--site', 'http://evil.example.com'],
    ['add', '--id', 'x', '--name', 'x', '--member', "a'@b.co"], ['drop', '--id', 'x']]) {
    assert.throws(() => shopSql(parseArgs(bad)), undefined, bad.join(' '));
  }
  assert.match(shopSql(parseArgs(['keep-sample', '--member', 'a@b.co'])), /VALUES \('default'/);
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
