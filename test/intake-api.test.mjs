// 予約の受け口 API（POST /api/v1/bookings。worker/public-handler.mjs の intake、worker/intake-route.mjs・intake-core.mjs・intake-db.mjs、
// 鍵のスタッフの道 /api/api-keys）を、外との境目を見本に差し替えて確かめる。決定ログ 2026-10-28 intake-api。
// 鍵（無い・違う・作り直して古い・止めた）、ブラウザの Origin、項目の誤りの一覧、同じ予約の 2 回目、1 日の件数、口の数、ログに秘密が出ないこと。
// 実行: node test/intake-api.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../worker/handler.mjs';
import { handlePublic } from '../worker/public-handler.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { SHOP_METHODS } from '../worker/shop-client.mjs';
import { scheduled } from '../worker/auto.mjs';
import { keyHash } from '../worker/ask-key.mjs';
import { claimIdem } from '../worker/intake-db.mjs';
import { checkIntake, checkKeyAction, INTAKE_DAILY_MAX, MAX_API_KEYS } from '../worker/intake-core.mjs';
import { bearerOf, idemKeyOf } from '../worker/ask-input.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { fakeKv, fakeAccess, fakeD1, fakeRateLimit, fakeShopBinding, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const PUBLIC = 'https://redux-ask.example.workers.dev';
const ASK_ORIGIN = 'https://ask.reduxdive.example';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const EMAIL_B = 'shop-b.member@example.com';
const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
const DAY = 86400000;

const REAL_LOG = console.log;
const logs = [];
console.log = (line) => logs.push(String(line));

const access = await fakeAccess(TEAM);
const jwtFor = (email) => access.sign({ iss: `https://${TEAM}`, aud: [AUD], email, exp: NOW / 1000 + 3600 * 24 * 30, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
const jwt = await jwtFor(EMAIL);
const jwtB = await jwtFor(EMAIL_B);

function setup(over = {}) {
  resetAccessCache();
  const db = fakeD1();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: `${EMAIL}, ${EMAIL_B}`, DAILY_LIMIT: '200', MONTHLY_USD: '5',
    BUDGET: fakeKv(), DB: db, SHOP_NAME: 'B マリン（見本）', SINGLE_SHOP: 'default', ASK_ORIGIN, ...over
  };
  const io = {
    clock: NOW,
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  const s = { db, env, io };
  s.pubEnv = { INTAKE_LIMIT: fakeRateLimit(1000), SHOP: fakeShopBinding(new ShopService(env, io)) };
  return s;
}

/* お店が 2 つ（shop-a は EMAIL、shop-b は EMAIL_B）。名簿は shop ごとの行 */
function setupTwo() {
  const s = setup({ SINGLE_SHOP: undefined });
  s.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: [EMAIL] });
  s.db.addShop({ id: 'shop-b', name: 'B ダイブ', members: [EMAIL_B] });
  return s;
}

/* お店のスタッフ（Access の内）。鍵を作る・作り直す・止める・一覧 */
const staff = (s, method, body, { token = jwt } = {}) => handle(new Request(`${ORIGIN}/api/api-keys`, {
  method, headers: { 'sec-fetch-site': 'same-origin', ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined }), s.env, s.io);
const act = async (s, body, opts) => { const r = await staff(s, 'POST', body, opts); return { status: r.status, body: await r.json() }; };
const mint = async (s, label = '公式サイト', opts) => { const r = await act(s, { action: 'create', label }, opts); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };
const list = async (s, opts) => (await staff(s, 'GET', undefined, opts)).json();

/* 外のシステム（API キーで）。key が null なら Authorization なし */
const GOOD = { date: '2026-11-03', start: '08:30', tour: '体験ダイビング（ボート・2 本）', people: 2, lead_name: '見本 花子', lead_email: 'hanako@mail.example',
  lead_phone: '090-0000-0000', lang: 'ja', note: '', external_id: 'WP-1001' };
const post = (s, key, body = GOOD, { headers = {}, env = s.pubEnv, method = 'POST', type = 'application/json', ip = '203.0.113.9', auth } = {}) => handlePublic(new Request(`${PUBLIC}/api/v1/bookings`, {
  method, headers: { ...(type ? { 'content-type': type } : {}), 'cf-connecting-ip': ip, ...(auth ? { authorization: auth } : key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined }), env, s.io);
const send = async (s, key, body, opts) => { const r = await post(s, key, body, opts); return { status: r.status, body: await r.json(), res: r }; };
const stored = (s, shop = 'default') => JSON.parse(s.db.rows.get(shop).state);
const countBookings = (s, shop = 'default') => (s.db.rows.has(shop) ? stored(s, shop).bookings.length : 0);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('鍵を作る: 鍵は作った返事に 1 回だけ出る。D1 には SHA-256 だけ、一覧に鍵も SHA-256 も出ない。作り直しと止めるも同じ鍵の id で', async () => {
  const s = setup();
  const made = await mint(s, 'WordPress');
  assert.match(made.key, /^rdx_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.endpoint, `${ASK_ORIGIN}/api/v1/bookings`);
  assert.match(made.id, /^k[0-9a-f]{20}$/);
  const row = s.db.apiKeys.get(made.id);
  assert.equal(row.hash, await keyHash(made.key));
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify([...s.db.apiKeys.values()]).includes(made.key), '鍵そのものは D1 に置かない');
  const got = await list(s);
  assert.deepEqual(got.items.map(i => Object.keys(i).sort()), [['at', 'id', 'label', 'revokedAt']]);
  assert.equal(got.max, MAX_API_KEYS);
  assert.ok(!JSON.stringify(got).includes(made.key) && !JSON.stringify(got).includes(row.hash), '一覧に鍵も SHA-256 も出ない');
  /* 作り直し: 同じ id・名前のまま鍵が替わる。前の鍵はすぐ使えない */
  s.io.clock += 1000;
  const again = await act(s, { action: 'rotate', id: made.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, made.id);
  assert.notEqual(again.body.key, made.key);
  assert.equal((await send(s, made.key)).status, 401, '前の鍵は開けない');
  assert.equal((await send(s, again.body.key)).status, 201);
  assert.equal((await list(s)).items[0].label, 'WordPress');
  /* 止める */
  assert.deepEqual(await act(s, { action: 'revoke', id: made.id }), { status: 200, body: { ok: true } });
  assert.equal((await send(s, again.body.key, { ...GOOD, external_id: 'WP-2' })).status, 401, '止めた鍵は開けない');
  assert.equal((await list(s)).items[0].revokedAt !== '', true);
  assert.equal((await act(s, { action: 'revoke', id: made.id })).status, 404, '止めた鍵をもう一度止めても 404');
  assert.equal((await act(s, { action: 'rotate', id: made.id })).status, 404, '止めた鍵は作り直せない');
});

test('鍵の管理は Access の内だけ・本文の形が合わなければ 400・鍵は 1 つのお店に 10 本まで（止めれば空く）', async () => {
  const s = setup();
  assert.equal((await staff(s, 'POST', { action: 'create', label: 'x' }, { token: null })).status, 403, 'ログインしていなければ断る');
  assert.equal((await staff(s, 'GET', undefined, { token: null })).status, 403);
  for (const body of [{}, { action: 'create' }, { action: 'create', label: '' }, { action: 'create', label: 'a'.repeat(41) }, { action: 'create', label: 'http://evil.example/x' },
    { action: 'create', label: 'a\nb' }, { action: 'create', label: 'x', extra: 1 }, { action: 'rotate' }, { action: 'rotate', id: 'K 1' }, { action: 'revoke', id: 'a'.repeat(41) },
    { action: 'delete', id: 'k1' }, 'x', []]) {
    assert.equal((await act(s, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(s.db.apiKeys.size, 0, '断った要求は何も置かない');
  const ids = [];
  for (let i = 0; i < MAX_API_KEYS; i += 1) ids.push((await mint(s, `連携 ${i}`)).id);
  assert.deepEqual(await act(s, { action: 'create', label: '11 本目' }), { status: 409, body: { error: 'limit' } });
  await act(s, { action: 'revoke', id: ids[0] });
  assert.equal((await act(s, { action: 'create', label: '11 本目' })).status, 200, '止めた分は数えない');
  assert.equal((await staff(s, 'PUT', {})).status, 405);
});

test('鍵はお店ごと: 別のお店のスタッフは、他のお店の鍵を見えず・作り直せず・止められない。予約は鍵のお店の名簿に入る', async () => {
  const s = setupTwo();
  const a = await mint(s, 'A の連携');
  const b = await mint(s, 'B の連携', { token: jwtB });
  assert.deepEqual((await list(s)).items.map(i => i.id), [a.id]);
  assert.deepEqual((await list(s, { token: jwtB })).items.map(i => i.id), [b.id]);
  assert.equal((await act(s, { action: 'revoke', id: a.id }, { token: jwtB })).status, 404);
  assert.equal((await act(s, { action: 'rotate', id: a.id }, { token: jwtB })).status, 404);
  assert.equal(s.db.apiKeys.get(a.id).revoked_at, '');
  assert.equal((await send(s, a.key, { ...GOOD, external_id: 'A-1' })).status, 201);
  assert.equal((await send(s, b.key, { ...GOOD, external_id: 'B-1', lead_name: '見本 次郎' })).status, 201);
  assert.deepEqual([countBookings(s, 'shop-a'), countBookings(s, 'shop-b')], [1, 1]);
  assert.equal(stored(s, 'shop-a').bookings[0].leadName, '見本 花子');
  assert.equal(stored(s, 'shop-b').bookings[0].leadName, '見本 次郎');
  assert.equal(stored(s, 'shop-a').shop.name, 'A ダイブ');
  /* お店を一覧から消すと、その鍵は使えない（Cron やリンクと同じ） */
  s.db.shops.delete('shop-a');
  assert.equal((await send(s, a.key, { ...GOOD, external_id: 'A-2' })).status, 401);
});

test('認証: 鍵が無い・形が違う・知らない・作り直して古い・止めた、はどれも同じ 401（何も書かない）', async () => {
  const s = setup();
  const k = await mint(s);
  const rotated = await act(s, { action: 'rotate', id: k.id });
  const revoked = await mint(s, '止める鍵');
  await act(s, { action: 'revoke', id: revoked.id });
  const fresh = `rdx_${'A'.repeat(43)}`;
  const cases = [['なし', null, undefined], ['Bearer だけ', null, 'Bearer'], ['Basic', null, `Basic ${k.key}`], ['形が違う', 'rdx_short', undefined], ['接頭辞が違う', k.key.replace('rdx_', 'xxx_'), undefined],
    ['知らない鍵', fresh, undefined], ['作り直して古い鍵', k.key, undefined], ['止めた鍵', revoked.key, undefined]];
  for (const [name, key, auth] of cases) {
    const r = await post(s, key, GOOD, { auth });
    assert.equal(r.status, 401, name);
    assert.deepEqual(await r.json(), { error: 'auth' }, name);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer', name);
  }
  assert.equal(countBookings(s), 0, '断った要求は名簿を変えない');
  assert.equal((await send(s, rotated.body.key)).status, 201, '今の鍵は通る');
  assert.equal((await send(s, rotated.body.key, GOOD, { auth: `bearer ${rotated.body.key}`, headers: { 'idempotency-key': 'case-1' } })).status, 201, 'Bearer は大文字小文字を問わない');
});

test('ブラウザの要求は 403: Origin か Sec-Fetch-Site が付いていたら、鍵が正しくても断る。CORS のヘッダは何にも付けず、OPTIONS は 405', async () => {
  const s = setup();
  const k = await mint(s);
  for (const headers of [{ origin: 'https://shop.example.com' }, { origin: 'null' }, { origin: PUBLIC }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-origin' }]) {
    const r = await send(s, k.key, GOOD, { headers });
    assert.deepEqual([r.status, r.body], [403, { error: 'origin' }], JSON.stringify(headers));
    assert.equal(r.res.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(countBookings(s), 0);
  /* 鍵が無くても同じ（先に断る） */
  assert.equal((await send(s, null, GOOD, { headers: { origin: 'https://shop.example.com' } })).status, 403);
  const pre = await post(s, null, undefined, { method: 'OPTIONS', headers: { origin: 'https://shop.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' } });
  assert.equal(pre.status, 405);
  assert.equal(pre.headers.get('allow'), 'POST');
  for (const r of [pre, (await send(s, k.key)).res, (await send(s, null)).res]) {
    for (const h of ['access-control-allow-origin', 'access-control-allow-headers', 'access-control-allow-methods']) assert.equal(r.headers.get(h), null, h);
  }
  assert.equal((await post(s, k.key, undefined, { method: 'GET' })).status, 405);
});

test('予約が入る: 201 と booking_id。名簿には代表者・人数・連絡先・外部の番号・鍵の名前が入り、同じ便にはまとまり、お願いの予定ができる', async () => {
  const s = setup();
  const k = await mint(s, '公式サイト');
  const r = await send(s, k.key);
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['booking_id', 'ok']);
  const st = stored(s);
  const b = st.bookings.find(x => x.id === r.body.booking_id);
  assert.deepEqual([b.leadName, b.leadEmail, b.leadPhone, b.lang, b.people, b.ref, b.site, b.source], ['見本 花子', 'hanako@mail.example', '090-0000-0000', 'ja', 2, 'WP-1001', '公式サイト', 'form']);
  const trip = st.trips.find(t => t.id === b.tripId);
  assert.deepEqual([trip.date, trip.start, trip.kind, trip.tour], ['2026-11-03', '08:30', 'dive', '体験ダイビング（ボート・2 本）']);
  const people = st.people.filter(p => p.bookingId === b.id);
  assert.deepEqual([people.length, people[0].name, people[1].name], [2, '見本 花子', '']);
  assert.ok(st.jobs.some(j => j.bookingId === b.id && j.kind === 'request' && j.status === 'waiting'), 'お願いの予定ができる（送るのは次の Cron）');
  assert.ok(st.log.some(l => l.act === 'add' && l.kind === 'booking' && l.id === b.id && l.who === 'guest'));
  /* 同じ日・同じ時刻・同じ種類の便にまとまる。時刻が違えば別の便。スノーケルの名前なら種類が変わる。時刻を書かなくてもよい */
  const second = await send(s, k.key, { ...GOOD, external_id: 'WP-1002', lead_name: 'Taro Sample', people: 3 });
  assert.equal(stored(s).bookings.find(x => x.id === second.body.booking_id).tripId, trip.id);
  const later = await send(s, k.key, { ...GOOD, external_id: 'WP-1003', start: '13:00' });
  assert.notEqual(stored(s).bookings.find(x => x.id === later.body.booking_id).tripId, trip.id);
  const snorkel = await send(s, k.key, { date: '2026-11-04', tour: 'ボートスノーケル（1 回）', people: 1, lead_name: '見本 三郎' });
  const sb = stored(s).bookings.find(x => x.id === snorkel.body.booking_id);
  assert.deepEqual([stored(s).trips.find(t => t.id === sb.tripId).kind, sb.leadEmail, sb.ref, sb.lang], ['snorkel', '', '', 'ja']);
  assert.equal(stored(s).bookings.length, 4);
});

test('項目の誤り: 400 と、誤った項目の名前の一覧。誤りの種類ごとに、名簿を変えない', async () => {
  const s = setup();
  const k = await mint(s);
  const bad = async (patch, fields, name) => {
    const r = await send(s, k.key, typeof patch === 'function' ? patch(GOOD) : { ...GOOD, ...patch });
    assert.equal(r.status, 400, name);
    assert.deepEqual(r.body, { error: 'input', fields }, name);
  };
  await bad({ date: '2026-10-26' }, ['date'], '過ぎた日');
  await bad({ date: '2026-02-30' }, ['date'], '無い日');
  await bad({ date: '2026/11/03' }, ['date'], '形');
  await bad({ date: '2028-01-01' }, ['date'], '先すぎる');
  await bad({ start: '25:00' }, ['start'], '時刻');
  await bad({ start: '8:30' }, ['start'], '時刻の形');
  await bad({ tour: '' }, ['tour'], 'ツアー無し');
  await bad({ tour: 'https://evil.example/x' }, ['tour'], 'ツアーに URL');
  await bad({ tour: 'a'.repeat(81) }, ['tour'], 'ツアーが長い');
  for (const people of [0, 31, 2.5, '2.5', 'abc', true, null, [2]]) await bad({ people }, ['people'], `人数 ${JSON.stringify(people)}`);
  await bad({ lead_name: '' }, ['lead_name'], '名前無し');
  await bad({ lead_name: 'a'.repeat(61) }, ['lead_name'], '名前が長い');
  await bad({ lead_name: '見本 花子\nTo: x' }, ['lead_name'], '名前に改行');
  await bad({ lead_name: 'お得 www.evil.example' }, ['lead_name'], '名前に www');
  await bad({ lead_name: 'evil.example.com' }, ['lead_name'], '名前にドメイン');
  await bad({ lead_email: 'not-an-email' }, ['lead_email'], 'メール');
  await bad({ lead_phone: '090-abcd' }, ['lead_phone'], '電話');
  await bad({ lead_phone: '0'.repeat(31) }, ['lead_phone'], '電話が長い');
  await bad({ lang: 'fr' }, ['lang'], '言語');
  await bad({ note: 'a'.repeat(401) }, ['note'], 'メモが長い');
  await bad({ external_id: 'has space' }, ['external_id'], '外部の番号');
  await bad({ external_id: 'x'.repeat(61) }, ['external_id'], '外部の番号が長い');
  await bad({ date: 'x', people: 0, lead_name: '' }, ['date', 'people', 'lead_name'], '複数の誤りは全部並べる（項目の順）');
  await bad((g) => { const { date, ...rest } = g; return rest; }, ['date'], '必須の項目が無い');
  /* 健康の項目は受けない: 余分な項目は名前つきで断る（黙って受けない）。名前が変なものは unknown */
  await bad({ health: 'ぜんそく', medical_history: 'x' }, ['health', 'medical_history'], '健康の項目');
  await bad({ ['a b']: 1, ['x'.repeat(50)]: 2 }, ['unknown'], '変な名前は unknown');
  assert.equal(countBookings(s), 0);
  assert.equal(s.db.daily.size, 0, '誤りは 1 日の件数に数えない');
  /* 本文が JSON でない・オブジェクトでない・大きすぎる・種類が違う */
  assert.deepEqual((await send(s, k.key, '{oops')).body, { error: 'json' });
  assert.deepEqual((await send(s, k.key, [])).body, { error: 'input', fields: ['body'] });
  assert.deepEqual((await send(s, k.key, 'null')).body, { error: 'input', fields: ['body'] });
  assert.equal((await send(s, k.key, JSON.stringify({ ...GOOD, note: 'あ'.repeat(5000) }))).status, 413);
  assert.equal((await send(s, k.key, JSON.stringify(GOOD), { type: 'text/plain' })).status, 415);
  assert.equal((await send(s, k.key, JSON.stringify(GOOD), { type: null })).status, 415);
  assert.equal((await send(s, k.key, JSON.stringify(GOOD), { headers: { 'content-length': '999999' } })).status, 413);
});

test('CF7 や Zapier の送り方: 空の項目は無いのと同じ、人数は数の文字でもよい、時刻・言語・メモ・外部の番号は省ける。健康のことを書いたメモは行ごと外す', async () => {
  const s = setup();
  const k = await mint(s, 'CF7');
  const r = await send(s, k.key, { date: '2026-11-03', start: '', tour: '体験ダイビング', people: '2', lead_name: ' 見本 花子 ', lead_email: '', lead_phone: '', lang: '', note: '', external_id: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const b = stored(s).bookings[0];
  assert.deepEqual([b.leadName, b.people, b.leadEmail, b.leadPhone, b.lang, b.ref, b.note], ['見本 花子', 2, '', '', 'ja', '', '']);
  assert.equal(stored(s).trips[0].start, '');
  const withNull = await send(s, k.key, { date: '2026-11-03', tour: '体験ダイビング', people: 1, lead_name: '見本 次郎', lead_email: null, note: null });
  assert.equal(withNull.status, 201);
  const noted = await send(s, k.key, { ...GOOD, external_id: 'N-1', note: '船酔いしやすいです\n持病に喘息があります\n13 時ごろ着きます' });
  assert.equal(noted.status, 201);
  const note = stored(s).bookings.find(x => x.id === noted.body.booking_id).note;
  assert.ok(note.includes('船酔い') && !note.includes('喘息'), `健康の行は外れる: ${note}`);
  assert.equal((await send(s, k.key, { ...GOOD, external_id: 12345 })).status, 201, '外部の番号は整数でもよい');
  assert.equal(stored(s).bookings.at(-1).ref, '12345');
});

test('同じ予約の 2 回目: Idempotency-Key（なければ external_id）が同じなら 200 で 1 回目の結果。予約は増えない。鍵ごとに別、7 日を過ぎたら別', async () => {
  const s = setup();
  const k = await mint(s, '公式サイト');
  const other = await mint(s, 'Zapier');
  const body = { ...GOOD, date: '2026-12-20', external_id: undefined };
  const first = await send(s, k.key, body, { headers: { 'idempotency-key': 'order-77' } });
  assert.equal(first.status, 201);
  const replay = await send(s, k.key, body, { headers: { 'idempotency-key': 'order-77' } });
  assert.deepEqual([replay.status, replay.body], [200, { ok: true, booking_id: first.body.booking_id, replayed: true }]);
  assert.equal(countBookings(s), 1);
  /* 本文が違っても、同じ Idempotency-Key なら 1 回目の結果（鍵の取り違えより、二重の予約を防ぐ） */
  assert.equal((await send(s, k.key, { ...body, people: 5 }, { headers: { 'idempotency-key': 'order-77' } })).body.booking_id, first.body.booking_id);
  /* external_id だけでも同じ */
  const ext = await send(s, k.key, { ...body, external_id: 'WP-9' });
  const extAgain = await send(s, k.key, { ...body, external_id: 'WP-9' });
  assert.deepEqual([ext.status, extAgain.status, extAgain.body.booking_id], [201, 200, ext.body.booking_id]);
  /* Idempotency-Key が先。external_id が違っても、同じ Idempotency-Key なら 2 回目 */
  assert.equal((await send(s, k.key, { ...body, external_id: 'WP-10' }, { headers: { 'idempotency-key': 'order-77' } })).status, 200);
  assert.equal(countBookings(s), 2);
  /* 別の鍵・別の Idempotency-Key は別の予約 */
  assert.equal((await send(s, other.key, body, { headers: { 'idempotency-key': 'order-77' } })).status, 201, '鍵ごとに別');
  assert.equal((await send(s, k.key, body, { headers: { 'idempotency-key': 'order-78' } })).status, 201);
  assert.equal((await send(s, k.key, body)).status, 201, 'どちらも無ければ毎回新しい予約');
  assert.equal(countBookings(s), 5);
  /* 形が合わない Idempotency-Key は 400 */
  for (const v of ['a b', 'x'.repeat(129)]) {
    const r = await send(s, k.key, body, { headers: { 'idempotency-key': v } });
    assert.deepEqual([r.status, r.body], [400, { error: 'input', fields: ['idempotency_key'] }], v);
  }
  /* 7 日を過ぎたら覚えていない */
  s.io.clock += 8 * DAY;
  const old = await send(s, k.key, { ...body, date: '2027-01-10' }, { headers: { 'idempotency-key': 'order-77' } });
  assert.equal(old.status, 201);
  assert.notEqual(old.body.booking_id, first.body.booking_id);
});

test('同じ予約の 2 回目は、日が過ぎたあとでも 1 回目の結果。入れられなかった要求は印を外し、同じ鍵でやり直せる', async () => {
  const s = setup({ INTAKE_DAILY_MAX: '1' });
  const k = await mint(s);
  const idem = { 'idempotency-key': 'retry-1' };
  const first = await send(s, k.key, { ...GOOD, date: '2026-10-28' }, { headers: idem });
  assert.equal(first.status, 201);
  s.io.clock += 2 * DAY;   // 10/29: 予約の日は過ぎた
  const replay = await send(s, k.key, { ...GOOD, date: '2026-10-28' }, { headers: idem });
  assert.deepEqual([replay.status, replay.body.booking_id], [200, first.body.booking_id], '日が過ぎていても 400 にしない');
  /* 誤りで断られた要求は、印を残さない: 直して同じ鍵で送り直せる */
  const bad = await send(s, k.key, { ...GOOD, people: 0 }, { headers: { 'idempotency-key': 'retry-2' } });
  assert.equal(bad.status, 400);
  assert.equal(s.db.idem.size, 1, '断った要求の印は消える');
  /* 件数の上限で断られた要求も、印を残さない: 翌日に同じ鍵で送れる */
  const capped = await send(s, k.key, { ...GOOD, date: '2026-11-05' }, { headers: { 'idempotency-key': 'retry-2' } });
  assert.equal(capped.status, 201, '上限 1 件。この日の 1 件目');
  const over = await send(s, k.key, { ...GOOD, date: '2026-11-05' }, { headers: { 'idempotency-key': 'retry-3' } });
  assert.equal(over.status, 429);
  const hash3 = await keyHash('retry-3');
  assert.ok(![...s.db.idem.keys()].some(x => x.endsWith(`\n${hash3}`)), '上限で断った要求の印は消える');
  s.io.clock += DAY;
  assert.equal((await send(s, k.key, { ...GOOD, date: '2026-11-05' }, { headers: { 'idempotency-key': 'retry-3' } })).status, 201, '翌日、同じ鍵でやり直せる');
});

test('名簿を読めずに落ちた要求は 500。受け付けた印を外すので、同じ Idempotency-Key で送り直せる。印を書き換えられなくても、入った予約の結果は返る', async () => {
  const s = setup();
  const k = await mint(s);
  const real = s.db.prepare.bind(s.db);
  const sickRoster = (sql) => (/FROM rosters WHERE shop/.test(sql) ? { bind: () => ({ first: async () => { throw new Error('d1 down'); } }) } : real(sql));
  s.db.prepare = sickRoster;
  const crashed = await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'sick-1' } });
  assert.deepEqual([crashed.status, crashed.body], [500, { error: 'server' }]);
  assert.equal(s.db.idem.size, 0, '落ちた要求の印は消える');
  s.db.prepare = real;
  assert.equal((await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'sick-1' } })).status, 201, '同じ鍵で送り直せる');
  /* 結果を書く文だけが失敗しても、入った予約の 201 は返す（印は受け付け中のまま残り、2 分で引き継げる） */
  s.db.prepare = (sql) => (/^UPDATE api_idempotency SET booking_id/.test(sql) ? { bind: () => ({ run: async () => { throw new Error('d1 down'); } }) } : real(sql));
  logs.length = 0;
  const done = await send(s, k.key, { ...GOOD, date: '2026-11-10' }, { headers: { 'idempotency-key': 'sick-2' } });
  assert.equal(done.status, 201);
  assert.equal(JSON.parse(logs[logs.length - 1]).why, 'idem-db');
  assert.equal(countBookings(s), 2);
});

test('受け付け中の同じ予約: 先の要求が入れている間は 503（busy）。落ちて 2 分たった印は引き継いで入れる', async () => {
  const s = setup();
  const k = await mint(s);
  const keyId = k.id;
  const idem = await keyHash('crashed-1');
  const at = new Date(s.io.clock).toISOString();
  assert.equal(await claimIdem(s.db, { keyId, idem, at, staleBefore: '0', expiredBefore: '0' }), true, '別の要求が受け付けた');
  const busy = await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'crashed-1' } });
  assert.deepEqual([busy.status, busy.body], [503, { error: 'busy' }]);
  assert.equal(countBookings(s), 0);
  s.io.clock += 3 * 60000;
  const taken = await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'crashed-1' } });
  assert.equal(taken.status, 201, '2 分たった受け付け中の印は引き継ぐ');
  assert.equal((await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'crashed-1' } })).status, 200);
  assert.equal(countBookings(s), 1);
  /* 同時に 5 件同じ Idempotency-Key で来ても、入るのは 1 件 */
  const burst = await Promise.all(Array.from({ length: 5 }, () => send(s, k.key, { ...GOOD, date: '2026-11-10' }, { headers: { 'idempotency-key': 'burst-1' } })));
  assert.equal(burst.filter(r => r.status === 201).length, 1);
  assert.ok(burst.every(r => [201, 200, 503].includes(r.status)), burst.map(r => r.status).join());
  assert.equal(countBookings(s), 2);
});

test('ザクのレビュー 2026-10-28: 鍵を何本作っても、お店ごと（200）と全店（1000）の 1 日の上限で止まる（漏れた鍵で大量にメールを出させない）', async () => {
  const s = setup();
  const k = await mint(s, 'A');
  s.db.daily.set(['api-shop', 'default', '2026-10-27'].join('\n'), 200);
  const shopFull = await send(s, k.key, { ...GOOD, external_id: undefined }, { headers: { 'idempotency-key': 'shop-cap' } });
  assert.deepEqual([shopFull.status, shopFull.body], [429, { error: 'limit' }]);
  assert.equal(countBookings(s), 0);
});

test('1 日の件数: 鍵ごとに数える（既定 100）。上限を超えたら 429、別の鍵は別、日が変われば戻る。誤り・2 回目は数えない', async () => {
  assert.equal(INTAKE_DAILY_MAX, 100);
  const s = setup({ INTAKE_DAILY_MAX: '3' });
  const k = await mint(s, 'A');
  const o = await mint(s, 'B');
  let n = 0;
  const one = (key, extra = {}) => send(s, key, { ...GOOD, external_id: undefined, ...extra }, { headers: { 'idempotency-key': `cap-${(n += 1)}` } });
  assert.deepEqual([(await one(k.key)).status, (await one(k.key)).status, (await one(k.key)).status], [201, 201, 201]);
  const over = await one(k.key);
  assert.deepEqual([over.status, over.body], [429, { error: 'limit' }]);
  assert.equal(countBookings(s), 3);
  assert.equal(s.db.daily.get(['api', k.id, '2026-10-27'].join('\n')), 3, '数えた値は上限と同じ');
  assert.equal((await one(o.key)).status, 201, '別の鍵は別に数える');
  /* 誤りと 2 回目は数えない */
  const usedBefore = s.db.daily.get(['api', o.id, '2026-10-27'].join('\n'));
  assert.equal((await one(o.key, { people: 0 })).status, 400);
  assert.equal(s.db.daily.get(['api', o.id, '2026-10-27'].join('\n')), usedBefore, '誤りは数えない');
  const twice = { 'idempotency-key': 'cap-twice' };
  assert.equal((await send(s, o.key, { ...GOOD, external_id: undefined }, { headers: twice })).status, 201);
  const used = s.db.daily.get(['api', o.id, '2026-10-27'].join('\n'));
  assert.equal(used, usedBefore + 1);
  assert.equal((await send(s, o.key, { ...GOOD, external_id: undefined }, { headers: twice })).status, 200);
  assert.equal(s.db.daily.get(['api', o.id, '2026-10-27'].join('\n')), used, '2 回目は数えない');
  /* 日が変われば戻る（日本の日付） */
  s.io.clock += DAY;
  assert.equal((await one(k.key, { date: '2026-11-04' })).status, 201);
  /* D1 が答えないとき、件数を数えられないので入れない（503） */
  const sick = setup({ INTAKE_DAILY_MAX: '3' });
  const sk = await mint(sick);
  const real = sick.db.prepare.bind(sick.db);
  sick.db.prepare = (sql) => (/INSERT INTO daily_counts/.test(sql) ? { bind: () => ({ run: async () => { throw new Error('d1 down'); } }) } : real(sql));
  assert.deepEqual([(await send(sick, sk.key)).status, countBookings(sick)], [503, 0]);
  /* env の上限が変なら既定に戻す */
  for (const bad of ['0', '-1', 'abc', '1001', '']) {
    const t = setup({ INTAKE_DAILY_MAX: bad });
    const tk = await mint(t);
    for (let i = 0; i < 4; i += 1) assert.equal((await send(t, tk.key, { ...GOOD, external_id: `E${i}` })).status, 201);
  }
});

test('1 つの IP の回数: 鍵を見る前に数える。超えたら 429。binding が無ければ 503（受けない側に倒す）。本文は 4 KB まで', async () => {
  const s = setup();
  const k = await mint(s);
  s.pubEnv.INTAKE_LIMIT = fakeRateLimit(2);
  assert.deepEqual([(await send(s, k.key, { ...GOOD, external_id: 'a' })).status, (await send(s, null)).status, (await send(s, k.key)).status], [201, 401, 429]);
  assert.equal((await send(s, k.key, GOOD, { ip: '198.51.100.7' })).status, 201, '別の IP は別に数える');
  assert.equal((await send(s, k.key, GOOD, { env: { SHOP: s.pubEnv.SHOP } })).status, 503, 'INTAKE_LIMIT が無い');
  assert.equal((await send(s, k.key, GOOD, { env: { INTAKE_LIMIT: fakeRateLimit(5) } })).status, 503, 'SHOP が無い');
  const broken = { INTAKE_LIMIT: { limit: async () => { throw new Error('down'); } }, SHOP: s.pubEnv.SHOP };
  assert.equal((await send(s, k.key, GOOD, { env: broken })).status, 429);
});

test('お店の Worker の口 intakeBooking: 呼び手の値を信じない（鍵の形・Idempotency-Key の形・D1）。お店は鍵の行から決める', async () => {
  const s = setup();
  const k = await mint(s);
  const shop = new ShopService(s.env, s.io);
  const hash = await keyHash(k.key);
  for (const bad of [undefined, '', 'abc', hash.toUpperCase(), hash + '0', 5, {}]) {
    const r = await shop.intakeBooking(bad, GOOD, '');
    assert.deepEqual([r.status, r.body, r.note], [400, { error: 'input' }, { why: 'input-hash' }], String(bad));
  }
  for (const bad of ['a b', 5, {}, 'x'.repeat(129)]) assert.deepEqual([(await shop.intakeBooking(hash, GOOD, bad)).status, (await shop.intakeBooking(hash, GOOD, bad)).note], [400, { why: 'input-idem' }]);
  const unknown = await shop.intakeBooking('0'.repeat(64), GOOD, '');
  assert.deepEqual([unknown.status, unknown.body, unknown.note], [401, { error: 'auth' }, { why: 'auth-key' }]);
  const ok = await shop.intakeBooking(hash, GOOD, '');
  assert.deepEqual([ok.status, ok.body.ok, ok.note], [201, true, { shop: 'default', added: 1 }]);
  assert.deepEqual((await new ShopService({ ...s.env, DB: undefined }, s.io).intakeBooking(hash, GOOD, '')).note, { why: 'config:DB' });
  s.db.failing = true;
  assert.equal((await shop.intakeBooking(hash, GOOD, '')).status, 503);
  s.db.failing = false;
  const noShops = await new ShopService({ ...s.env, SINGLE_SHOP: undefined }, s.io).intakeBooking(hash, GOOD, '');
  assert.deepEqual([noShops.status, noShops.body], [503, { error: 'shops' }], 'お店の一覧が使えなければ入れない（開いた側に倒さない）');
});

test('Service Binding の口: 6 つは今まで通りで、足したのは intakeBooking だけ。fakeShopBinding・ShopRpc も同じ。redux-ask に D1 の binding は無く、INTAKE_LIMIT が増える', async () => {
  assert.deepEqual(SHOP_METHODS.slice(0, 6), ['askView', 'askApply', 'siteHosts', 'siteBooking', 'walkinView', 'walkinSubmit']);
  assert.deepEqual(SHOP_METHODS.slice(6, 7), ['intakeBooking']);   // 後ろの trialView・trialAsk は 2026-10-29 trial-shops（test/trial.test.mjs）
  const s = setup();
  const binding = fakeShopBinding(new ShopService(s.env, s.io));
  assert.deepEqual(Object.keys(binding).filter(k => typeof binding[k] === 'function').sort(), [...SHOP_METHODS].sort());
  for (const leak of ['env', 'io', 'DB', 'prepare', 'findApiKey', 'listApiKeys', 'changeKeysFor', 'putApiKey']) assert.equal(binding[leak], undefined, leak);
  const rpc = readFileSync(new URL('../worker/shop-rpc.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...rpc.matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1]).sort(), [...SHOP_METHODS].sort());
  const jsonc = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const ask = jsonc('wrangler.ask.jsonc');
  assert.equal(ask.d1_databases, undefined);
  assert.deepEqual(ask.ratelimits.map(r => r.name).sort(), ['ASK_LIMIT', 'BOOKING_LIMIT', 'INTAKE_LIMIT']);
  assert.equal(new Set(ask.ratelimits.map(r => r.namespace_id)).size, 3, 'namespace_id は重ならない');
  /* 呼び手はお店の判定に使う値を渡さない: 口の引数は鍵の SHA-256・本文・Idempotency-Key だけ */
  assert.equal(new ShopService(s.env, s.io).intakeBooking.length, 3);
  /* 向こうの答えが壊れていたら 500（crash） */
  const k = await mint(s);
  const broken = { INTAKE_LIMIT: fakeRateLimit(10), SHOP: { ...binding, intakeBooking: async () => ({ status: '201', body: {}, note: {} }) } };
  assert.equal((await send(s, k.key, GOOD, { env: broken })).status, 500);
});

test('入力の部品: Authorization・Idempotency-Key・本文の検査は純粋な関数で、同じ入力は同じ答え', () => {
  const key = `rdx_${'a'.repeat(43)}`;
  assert.equal(bearerOf(`Bearer ${key}`), key);
  assert.equal(bearerOf(`bearer   ${key} `), key);
  for (const bad of [null, '', 'Bearer', `Bearer ${key} x`, `Token ${key}`, `Bearer ${key}x`, `Bearer ${key.slice(0, -1)}`, 'Bearer rdx_ほげ']) assert.equal(bearerOf(bad), '', String(bad));
  assert.deepEqual([idemKeyOf(null), idemKeyOf(''), idemKeyOf('abc-1'), idemKeyOf('a b'), idemKeyOf(5)], [{ ok: true, key: '' }, { ok: true, key: '' }, { ok: true, key: 'abc-1' }, { ok: false }, { ok: false }]);
  const today = '2026-10-27';
  assert.equal(checkIntake(GOOD, { today }).ok, true);
  assert.deepEqual(checkIntake(GOOD, { today }), checkIntake({ ...GOOD }, { today }));
  assert.deepEqual(checkKeyAction({ action: 'create', label: ' 公式サイト ' }), { ok: true, action: 'create', label: '公式サイト' });
  assert.deepEqual(checkKeyAction({ action: 'rotate', id: 'k1' }), { ok: true, action: 'rotate', id: 'k1' });
});

test('Cron: 7 日を過ぎた「同じ予約の 2 回目」の記録だけを消す', async () => {
  const s = setup({ BUDGET: fakeKv() });
  const k = await mint(s);
  await send(s, k.key, GOOD, { headers: { 'idempotency-key': 'old-1' } });
  s.io.clock += 6 * DAY;
  await send(s, k.key, { ...GOOD, date: '2026-12-01' }, { headers: { 'idempotency-key': 'new-1' } });
  s.io.clock += 2 * DAY;   // old-1 は 8 日前、new-1 は 2 日前
  await scheduled(s.env, s.io);
  assert.equal(s.db.idem.size, 1);
  assert.ok([...s.db.idem.keys()][0].endsWith(await keyHash('new-1')));
});

test('ログ: 道・お店・理由・数だけ。鍵・名前・メールアドレス・電話・メモ・外部の番号・Idempotency-Key は出ない', async () => {
  const s = setup();
  const k = await mint(s, '秘密のラベル');
  const rotated = await act(s, { action: 'rotate', id: k.id });
  logs.length = 0;
  const idem = { 'idempotency-key': 'secret-order-4242' };
  const body = { ...GOOD, note: '内緒のメモ', external_id: 'EXT-SECRET-1' };
  await send(s, rotated.body.key, body, { headers: idem });
  await send(s, rotated.body.key, body, { headers: idem });
  await send(s, rotated.body.key, { ...body, lead_name: '見本 悪太郎 www.evil.example', people: 0, health: 'ぜんそく' });
  await send(s, k.key, body);
  await send(s, null, body);
  await send(s, rotated.body.key, body, { headers: { origin: 'https://shop.example.com' } });
  await send(s, rotated.body.key, '{oops');
  await post(s, rotated.body.key, body, { method: 'OPTIONS' });
  await staff(s, 'GET');
  const all = logs.join('\n');
  const secrets = [k.key, rotated.body.key, rotated.body.key.slice(4), await keyHash(rotated.body.key), '見本 花子', '悪太郎', 'hanako@mail.example', '090-0000-0000', '内緒のメモ', 'EXT-SECRET-1',
    'secret-order-4242', await keyHash('secret-order-4242'), 'ぜんそく', '秘密のラベル', 'Bearer', 'authorization', EMAIL];
  for (const x of secrets) assert.ok(!all.includes(x), `ログに出ている: ${x}`);
  const lines = logs.map(l => JSON.parse(l)).filter(l => l.route === '/api/v1/bookings');
  assert.deepEqual(lines.map(l => l.status), [201, 200, 400, 401, 401, 403, 400, 405]);
  assert.deepEqual(lines.map(l => l.why), [undefined, 'replay', 'input', 'auth-key', 'auth-missing', 'origin', undefined, undefined]);
  assert.deepEqual([lines[0].shop, lines[0].added, lines[2].problems], ['default', 1, 3]);
  for (const l of lines) assert.deepEqual(Object.keys(l).filter(x => !['worker', 'route', 'status', 'ms', 'why', 'shop', 'added', 'problems'].includes(x)), [], JSON.stringify(l));
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
