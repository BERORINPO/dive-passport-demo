// 何店でも扱える作り（worker/shop-core.mjs・shop-db.mjs と、それを使う handler・auto・ask-route）を、外との境目を見本に差し替えて確かめる。
// お店の一覧（D1 の shops）があると、スタッフはログインしたメールのお店の名簿だけを見て書き、サイトの予約は送ってきたサイトのお店へ、
// お客さんのリンクは鍵と一緒に置いたお店へ、Cron は名簿があるお店を全部回る。
// 一覧が空・表が無いときは、env の SINGLE_SHOP を書いたときだけ 1 店で動く。書いていなければ 503（開いた側に倒さない）。
// 2 店が同じ受け口・メール・サイトを持つ一覧も、形の壊れた行と同じく 503。1 日の件数（サイトの予約・メール）はお店ごとに D1 で正確に数える。
// 実行: node test/shops.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { handle } from '../worker/handler.mjs';
import { handlePublic as servePublic } from '../worker/public-handler.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { scheduled } from '../worker/auto.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { shopForEmail, shopForOrigin, shopForRecipient, shopsFromRows, shopsProblem, singleShop, knownShop, replyToFor, replyAddress } from '../worker/shop-core.mjs';
import { listShops, shopsWhy } from '../worker/shop-db.mjs';
import { fakeKv, fakeAccess, fakeD1, fakeTurnstile, fakeRateLimit, fakeMail, fakeShopBinding, checkRedirect } from '../worker/fakes.mjs';

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
const logs = [];
console.log = (line) => logs.push(String(line));
const access = await fakeAccess(TEAM);
const jwtFor = (email) => access.sign({ iss: `https://${TEAM}`, aud: [AUD], email, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

function setup({ shops = true, single = '' } = {}) {
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
    TURNSTILE_SECRET: 'turnstile-test-secret', SITE_ORIGINS: SITE_A, ASK_ORIGIN: PUBLIC, EMAIL: fakeMail(), MAIL_FROM: 'yoyaku@shop.example', APP_URL: ORIGIN, MAIL_AUTHSERV_ID: 'mx.cloudflare.net',
    ...(single ? { SINGLE_SHOP: single } : {})
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

/* redux-ask（Access なし）は D1 を持たず、お店の Worker（env を持つ ShopService）を Service Binding で呼ぶ */
const handlePublic = (request, env, io) => servePublic(request, { ASK_LIMIT: env.ASK_LIMIT, BOOKING_LIMIT: env.BOOKING_LIMIT, TURNSTILE_SECRET: env.TURNSTILE_SECRET,
  BUDGET: env.BUDGET, SHOP: fakeShopBinding(new ShopService(env, io)) }, io);

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

test('振り分けの決まり: 一覧が空ならどこにも振り分けない。あればメール・サイト・宛先で引く。壊れた行は捨てる', () => {
  assert.equal(shopForEmail([], 'x@example.com'), '', '空の一覧で 1 店に倒さない');
  assert.equal(shopForOrigin([], SITE_A), '');
  assert.equal(shopForRecipient([], 'any@x.example'), '');
  assert.equal(knownShop([], 'default'), false);
  const shops = shopsFromRows([
    { id: 'shop-a', name: 'A', members: JSON.stringify(['A.Staff@Example.com']), sites: JSON.stringify([SITE_A]), inbox: 'A@Yoyaku.example' },
    { id: 'Bad Id', name: 'x', members: '[]', sites: '[]', inbox: '' },
    { id: 'shop-c', name: 'C', members: 'not json', sites: '[]', inbox: '' }
  ]);
  assert.deepEqual(shops.map(x => x.id), ['shop-a', 'shop-c']);
  assert.equal(shopForEmail(shops, 'a.staff@example.com'), 'shop-a');
  assert.equal(shopForEmail(shops, 'other@example.com'), '');
  assert.equal(shopForOrigin(shops, SITE_A), 'shop-a');
  assert.equal(shopForOrigin(shops, SITE_B), '');
  assert.equal(shopForRecipient(shops, 'a@yoyaku.example'), 'shop-a');
});

test('1 店の動き（singleShop）: 明示した id の形が合うときだけ。誰がログインしても・どの宛先でも・SITE_ORIGINS のサイトだけ、その 1 店', () => {
  for (const bad of [undefined, '', '  ', 'Bad Id', 'x'.repeat(41)]) assert.equal(singleShop(bad, {}), null, String(bad));
  const one = [singleShop(' default ', { siteOrigins: `${SITE_A}, ${SITE_B}`, mailSenders: 'fwd@shop.example' })];
  assert.equal(shopForEmail(one, 'anyone@example.com'), 'default');
  assert.equal(shopForRecipient(one, 'any@x.example'), 'default');
  assert.equal(shopForOrigin(one, SITE_B), 'default');
  assert.equal(shopForOrigin(one, 'https://evil.example.com'), '');
  assert.equal(knownShop(one, 'default'), true);
  assert.equal(knownShop(one, 'shop-a'), false);
});

test('一覧の重なり（shopsProblem）: 同じ受け口・メール・サイトを 2 店が持つと理由を返す。空の受け口と、1 店の中の重複は重なりでない', () => {
  const row = (id, over) => ({ id, name: id, members: '[]', sites: '[]', inbox: '', senders: '[]', ...over });
  const check = (...rows) => shopsProblem(shopsFromRows(rows));
  assert.equal(check(row('a'), row('b')), '', '空の受け口は何店でもよい');
  assert.equal(check(row('a', { members: '["x@e.com","X@e.com"]' }), row('b', { members: '["y@e.com"]' })), '', '1 店の中の重複は重なりでない');
  assert.equal(check(row('a', { inbox: 'in@y.example' }), row('b', { inbox: ' IN@Y.example ' })), 'inbox', '大文字小文字・前後の空白は同じ受け口');
  assert.equal(check(row('a', { members: '["Staff@E.com"]' }), row('b', { members: '["staff@e.com"]' })), 'member');
  assert.equal(check(row('a', { sites: `["${SITE_A}"]` }), row('b', { sites: `["${SITE_A}"]` })), 'site');
});

test('スタッフは自分のお店の名簿だけを読み書きする。どのお店にもいない人は 403。名前は一覧の名前にそろう', async () => {
  const s = setup();
  const blank = { v: globalThis.REDUX.roster.VERSION, shop: { name: '端末の見本' }, trips: [], bookings: [], people: [], log: [] };
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
  assert.equal(s.db.daily.get('site\nshop-a\n2026-10-27'), 1);
  assert.equal(s.db.daily.get('site\nshop-b\n2026-10-27'), 1);
  assert.equal(s.db.daily.get('site\n*\n2026-10-27'), 2, '全店あわせた数も数える');
});

test('1 日の件数はお店ごと: 1 店が上限に届いても、ほかのお店は受ける。上限に届いたお店は全店の枠を使わない', async () => {
  const s = setup();
  s.db.setCount('site', 'shop-a', '2026-10-27', 30);
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 429, 'A は 1 日 30 件まで');
  s.turnstile.hostname = 'shop-b.example.com';
  assert.equal((await siteBooking(s, SITE_B, '見本 二郎')).status, 202, 'B は A の上限に巻き込まれない');
  assert.equal(s.db.daily.get('site\n*\n2026-10-27'), 1, '断られた A の分は全店の枠を使わない');
  assert.equal(s.env.BUDGET.puts.length, 0, '外からの件数は KV に書かない');
});

test('AI の上限はお店ごと: キーにお店の id が入り、A が使い切っても B は読める。どのお店にもいない人は AI も使えない', async () => {
  const { readFileSync } = await import('node:fs');
  const { fakeAnthropic } = await import('../worker/fakes.mjs');
  const s = setup();
  s.env.DAILY_LIMIT = '1';
  const api = fakeAnthropic();
  const realFetch = s.io.fetch;
  s.io.fetch = (url, init) => (url === 'https://api.anthropic.com/v1/messages' ? api.respond(init) : realFetch(url, init));
  const text = readFileSync(new URL('../assets/samples/e1.txt', import.meta.url), 'utf8');
  assert.equal((await staff(s, A_STAFF, '/api/read', 'POST', { doc: 'mail', text })).status, 200);
  assert.equal((await staff(s, A_STAFF, '/api/read', 'POST', { doc: 'mail', text })).status, 429, 'A は 1 日 1 回まで');
  assert.equal((await staff(s, B_STAFF, '/api/read', 'POST', { doc: 'mail', text })).status, 200, 'B は A の上限に巻き込まれない');
  assert.equal(s.env.BUDGET.peek('day:shop-a:2026-10-27'), '1');
  assert.equal(s.env.BUDGET.peek('day:shop-b:2026-10-27'), '1');
  assert.equal(s.env.BUDGET.peek('day:2026-10-27'), null, 'お店の無いキーは作らない');
  const h = await (await staff(s, B_STAFF, '/api/healthz', 'GET')).json();
  assert.equal(h.left.today, 0, 'healthz はログインしたお店の残り');
  assert.equal((await staff(s, NOBODY, '/api/read', 'POST', { doc: 'mail', text })).status, 403);
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

test('一覧が空・表が無いとき、SINGLE_SHOP が無ければ 503（開いた側に倒さない）。理由の名前だけをログに出し、何も書かない', async () => {
  const blank = { v: globalThis.REDUX.roster.VERSION, shop: { name: '見本' }, trips: [], bookings: [], people: [], log: [] };
  for (const [label, why, prep] of [['表が無い', 'shops-no-table', () => {}], ['表はあるが空', 'shops-empty', (s) => { s.db.shopsTable = true; }]]) {
    const s = setup({ shops: false });
    prep(s);
    logs.length = 0;
    const r = await staff(s, NOBODY, '/api/roster', 'PUT', { base: 0, state: blank });
    assert.deepEqual([r.status, (await r.json()).error], [503, 'shops'], label);
    s.turnstile.hostname = 'shop-a.example.com';
    assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 503, label);
    assert.equal((await staff(s, NOBODY, '/api/read', 'POST', { doc: 'mail', text: 'x' })).status, 503, label);
    assert.deepEqual(logs.map(l => JSON.parse(l).why), [why, why, why], `${label}: ログには理由の名前だけ`);
    assert.ok(logs.every(l => !l.includes(NOBODY) && !l.includes('見本')), 'ログに中身を出さない');
    assert.equal(s.db.rows.size, 0, `${label}: 名簿は書かれない`);
    assert.equal(s.db.daily.size, 0, `${label}: 件数も数えない`);
    logs.length = 0;
    await assert.rejects(scheduled(s.env, s.io), /cron failed/, `${label}: Cron は Cloudflare の履歴にも失敗と残す`);
    assert.equal(JSON.parse(logs[0]).why, why, `${label}: Cron も理由を残して何もしない`);
  }
});

test('SINGLE_SHOP を書くと、表が無い・空でも、その 1 店で動く（今までの default）。id の形が合わなければ 503。行があれば行が先', async () => {
  const blank = { v: globalThis.REDUX.roster.VERSION, shop: { name: '見本' }, trips: [], bookings: [], people: [], log: [] };
  const s = setup({ shops: false, single: 'default' });
  assert.equal((await staff(s, NOBODY, '/api/roster', 'PUT', { base: 0, state: blank })).status, 200);
  assert.deepEqual([...s.db.rows.keys()], ['default']);
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 202);
  assert.equal(stored(s, 'default').bookings.length, 1);
  assert.equal(s.db.daily.get('site\ndefault\n2026-10-27'), 1);
  assert.equal((await siteBooking(s, SITE_B, '見本 二郎')).status, 403, '1 店でも、SITE_ORIGINS に無いサイトは断る');
  s.db.shopsTable = true;   // 表はあるが空でも同じ
  assert.equal((await staff(s, NOBODY, '/api/roster', 'GET')).status, 200);
  const odd = setup({ shops: false, single: 'Bad Id' });
  assert.equal((await staff(odd, NOBODY, '/api/roster', 'GET')).status, 503, '形の合わない id は明示と見なさない');
  const rows = setup({ single: 'default' });
  assert.equal((await staff(rows, NOBODY, '/api/roster', 'GET')).status, 403, '行があれば SINGLE_SHOP は使わない（行に無い人は入れない）');
  assert.equal((await staff(rows, A_STAFF, '/api/roster', 'GET')).status, 200);
});

test('一覧の重なり: 2 店が同じ受け口・メール・サイトを持つと listShops が例外にし、全道が 503。理由の名前だけが出る', async () => {
  const dup = [['shops-dup-inbox', { inbox: 'A@yoyaku.example ' }], ['shops-dup-member', { members: [A_STAFF.toUpperCase()] }], ['shops-dup-site', { sites: [SITE_A] }]];
  for (const [why, over] of dup) {
    const s = setup({ single: 'default' });
    s.db.addShop({ id: 'shop-c', name: 'C', members: ['c.staff@example.com'], sites: ['https://shop-c.example.com'], inbox: 'c@yoyaku.example', ...over });
    await assert.rejects(listShops(s.db, s.env), (e) => e.message === why && shopsWhy(e, 'db') === why);
    logs.length = 0;
    assert.equal((await staff(s, A_STAFF, '/api/roster', 'GET')).status, 503, why);
    s.turnstile.hostname = 'shop-a.example.com';
    assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 503, why);
    assert.deepEqual(logs.map(l => JSON.parse(l).why), [why, why]);
    assert.equal(s.db.rows.size, 0, '名簿は書かれない');
  }
  const down = setup();
  down.db.failing = true;
  await assert.rejects(listShops(down.db, down.env), (e) => shopsWhy(e, 'db') === 'db', 'D1 の不調は一覧の問題と見分ける');
});

/* 届いたメールの見本（Email Routing が渡す形）。Cloudflare の名前の Authentication-Results が一番上にあり、SPF が封筒の From で pass、見出しの From も同じドメイン */
function mail(from, to) {
  const ar = `mx.cloudflare.net; spf=pass smtp.mailfrom=${from}`;
  const bytes = new TextEncoder().encode(`Authentication-Results: ${ar}\r\nFrom: ${from}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n11/5 体験ダイビング 1 名 見本 次郎 様`);
  return { from, to, rawSize: bytes.byteLength, rejected: '', headers: new Headers({ 'authentication-results': ar }),
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
  s.db.setCount('mail', '*', '2026-10-27', 60);
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
  const sql = shopSql(parseArgs(['add', '--id', 'shop-a', '--name', "A's ダイブ", '--member', 'Staff@Example.com', '--site', 'https://shop-a.example.com', '--inbox', 'A@reduxdive.com', '--sender', 'fwd@shop-a.example.com',
    '--reply-to', 'Info@Shop-A.example.com']));
  const m = sql.match(/VALUES \('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/);
  const [id, name, members, sites, inbox, senders, reply_to] = m.slice(1).map(x => x.replace(/''/g, "'"));
  const read = shopsFromRows([{ id, name, members, sites, inbox, senders, reply_to }]);
  assert.equal(read.length, 1);
  assert.deepEqual(read[0], { id: 'shop-a', name: "A's ダイブ", members: ['staff@example.com'], sites: ['https://shop-a.example.com'], inbox: 'a@reduxdive.com', senders: ['fwd@shop-a.example.com'],
    replyTo: 'info@shop-a.example.com' });
  assert.match(sql, /reply_to = excluded\.reply_to;$/, 'add は返信先も上書きする（付けなければ空に戻る）');
  assert.match(shopSql(parseArgs(['add', '--id', 'x', '--name', 'x', '--member', 'a@b.co'])), /, ''\) ON CONFLICT/, '--reply-to が無ければ空');
  for (const bad of [['add', '--id', 'Bad Id', '--name', 'x', '--member', 'a@b.co'], ['add', '--id', 'x', '--name', 'x'], ['add', '--id', 'x', '--name', 'x', '--member', 'a@b.co', '--site', 'http://evil.example.com'],
    ['add', '--id', 'x', '--name', 'x', '--member', "a'@b.co"], ['drop', '--id', 'x'],
    ['add', '--id', 'x', '--name', 'x', '--member', 'a@b.co', '--reply-to', 'not an address'], ['add', '--id', 'x', '--name', 'x', '--member', 'a@b.co', '--reply-to', 'a@b.co, c@d.co'],
    ['set-reply-to', '--id', 'Bad Id', '--reply-to', 'a@b.co'], ['set-reply-to', '--id', 'x'], ['set-reply-to', '--id', 'x', '--reply-to', 'a@b.co\r\nBcc: c@d.co']]) {
    assert.throws(() => shopSql(parseArgs(bad)), undefined, bad.join(' '));
  }
  assert.match(shopSql(parseArgs(['keep-sample', '--member', 'a@b.co'])), /VALUES \('default'/);
  /* 返信先だけを直す 1 文（いまある行の他の欄は変えない）。入れた値を Worker がそのまま読める */
  const upd = shopSql(parseArgs(['set-reply-to', '--id', 'shop-a', '--reply-to', ' Info@Shop-A.example.com ']));
  assert.equal(upd, "UPDATE shops SET reply_to = 'info@shop-a.example.com' WHERE id = 'shop-a';");
});

test('お店ごとの返信先（core）: reply_to は形を確かめて読む。合わなければ空（行は捨てない）。選び方: 行にあればそれ、無ければ 1 店だけ REPLY_TO、2 店以上は付けない', () => {
  const row = (id, replyTo) => ({ id, name: id, members: '[]', sites: '[]', inbox: '', senders: '[]', reply_to: replyTo });
  for (const bad of ['', '   ', 'not an address', 'a@b', 'a@b.co, c@d.co', 'a@b.co\r\nBcc: c@d.co', '<a@b.co>', '"a"@b.co', `${'x'.repeat(250)}@b.co`, null, undefined, 42]) {
    assert.equal(replyAddress(bad), '', String(bad).slice(0, 20));
    assert.deepEqual(shopsFromRows([row('shop-a', bad)]).map(x => x.replyTo), [''], `形の合わない返信先でも行は捨てない: ${String(bad).slice(0, 20)}`);
  }
  assert.equal(shopsFromRows([{ id: 'shop-a', name: 'A', members: '[]', sites: '[]', inbox: '', senders: '[]' }])[0].replyTo, '', '欄が無い行（0010 より前の形）も空');
  assert.equal(shopsFromRows([row('shop-a', ' Info@Shop-A.example.com ')])[0].replyTo, 'Info@Shop-A.example.com', '前後の空白は取る');
  const two = shopsFromRows([row('shop-a', 'a@a.example'), row('shop-b', '')]);
  assert.equal(replyToFor(two, 'shop-a', 'env@x.example'), 'a@a.example', '行にあれば、REPLY_TO より行');
  assert.equal(replyToFor(two, 'shop-b', 'env@x.example'), '', '2 店以上で行に無ければ、REPLY_TO に落とさず付けない');
  assert.equal(replyToFor(two, 'shop-z', 'env@x.example'), '', '一覧に無いお店も同じ');
  const one = shopsFromRows([row('shop-a', '')]);
  assert.equal(replyToFor(one, 'shop-a', 'env@x.example'), 'env@x.example', '1 店だけで行に無ければ、今までどおり REPLY_TO');
  assert.equal(replyToFor(one, 'shop-a'), '', 'REPLY_TO も無ければ付けない');
  assert.equal(replyToFor(shopsFromRows([row('shop-a', 'a@a.example')]), 'shop-a', 'env@x.example'), 'a@a.example', '1 店でも行にあれば行');
  assert.equal(replyToFor([singleShop('default')], 'default', 'env@x.example'), 'env@x.example', 'SINGLE_SHOP の 1 店は REPLY_TO');
});

test('お店ごとの返信先（Cron）: 2 店とも別々の返信先で送る。行に無い店には、REPLY_TO があっても付けない（別のお店の返信先に流さない）。直せば次から付く', async () => {
  const s = setup();
  s.env.REPLY_TO = 'owner-a@a.example';   // 前の 1 店の時の secret。2 店になっても全店に付けない
  s.db.shops.get('shop-a').reply_to = 'info@a.example';
  s.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(s, SITE_A, '見本 一郎')).status, 202);
  s.turnstile.hostname = 'shop-b.example.com';
  assert.equal((await siteBooking(s, SITE_B, '見本 二郎')).status, 202);
  await scheduled(s.env, s.io);
  const sent = s.env.EMAIL.sent;
  const by = (shop) => sent.find(m => m.from.name === shop);
  assert.equal(sent.length, 2);
  assert.equal(by('A ダイブ').replyTo, 'info@a.example', 'A のお客さんの返信は A へ');
  assert.equal(Object.hasOwn(by('B マリン'), 'replyTo'), false, 'B には Reply-To を付けない（A にも REPLY_TO にも流さない）');
  /* B の返信先を入れると、次の連絡から付く */
  s.db.shops.get('shop-b').reply_to = 'info@b.example';
  assert.equal((await siteBooking(s, SITE_B, '見本 三郎')).status, 202);
  sent.length = 0;
  await scheduled(s.env, s.io);
  assert.deepEqual(sent.map(m => [m.from.name, m.replyTo]), [['B マリン', 'info@b.example']]);
  /* 返信先の打ち間違い（形が合わない）は、全店を止めず、その店だけ付けない */
  s.db.shops.get('shop-b').reply_to = 'info@b.example, info@a.example';
  assert.equal((await siteBooking(s, SITE_B, '見本 四郎')).status, 202);
  sent.length = 0;
  await scheduled(s.env, s.io);
  assert.deepEqual(sent.map(m => [m.from.name, m.replyTo]), [['B マリン', undefined]]);
});

test('お店ごとの返信先（Cron）: 一覧が 1 店だけ（行・SINGLE_SHOP）なら今までどおり REPLY_TO。その店の行に返信先があれば行が先', async () => {
  const one = setup();
  one.db.shops.delete('shop-b');
  one.env.REPLY_TO = 'env@x.example';
  one.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(one, SITE_A, '見本 一郎')).status, 202);
  await scheduled(one.env, one.io);
  assert.equal(one.env.EMAIL.sent[0].replyTo, 'env@x.example', '行が 1 つで返信先が空なら REPLY_TO');
  one.db.shops.get('shop-a').reply_to = 'info@a.example';
  assert.equal((await siteBooking(one, SITE_A, '見本 二郎')).status, 202);
  one.env.EMAIL.sent.length = 0;
  await scheduled(one.env, one.io);
  assert.equal(one.env.EMAIL.sent[0].replyTo, 'info@a.example', '行に返信先があれば REPLY_TO より行');
  const single = setup({ shops: false, single: 'default' });
  single.env.REPLY_TO = 'env@x.example';
  single.turnstile.hostname = 'shop-a.example.com';
  assert.equal((await siteBooking(single, SITE_A, '見本 三郎')).status, 202);
  await scheduled(single.env, single.io);
  assert.equal(single.env.EMAIL.sent[0].replyTo, 'env@x.example', 'SINGLE_SHOP は REPLY_TO');
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
