// Cloudflare Worker（worker/）を、外との境目を見本（worker/fakes.mjs）に差し替えて確かめる。
// 守る順番（Access の JWT・合言葉・形・上限）、AI に渡す中身とヘッダ、ログに中身が出ないこと。
// 実行: node test/worker.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { imageType, periods, costMicro, WORST_MICRO } from '../worker/read-core.mjs';
import { fakeKv, fakeAccess, fakeAnthropic } from '../worker/fakes.mjs';

const R = globalThis.REDUX;
const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const CODE = 'うみがめ-2026';
const NOW = Date.parse('2026-10-22T01:00:00Z');   // 日本では 10/22 の 10:00
const MAIL = readFileSync(new URL('../assets/samples/e1.txt', import.meta.url), 'utf8');
const JPEG = btoa(String.fromCharCode(0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1)) + 'AAAA';
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13)) + 'AAAA';
const GIF = btoa('GIF89a' + '\0'.repeat(6)) + 'AAAA';

/* 画面（js/ai-reader.js）と同じ作り方の合言葉のヘッダ */
const codeHeader = (code) => {
  let bin = '';
  new TextEncoder().encode(code).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const access = await fakeAccess(TEAM);
const goodClaims = () => ({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
const goodJwt = await access.sign(goodClaims());

function setup(over = {}) {
  resetAccessCache();
  const kv = fakeKv();
  const api = fakeAnthropic();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', REDUX_CODE: CODE, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
    ALLOWED_EMAILS: `other@example.com, ${EMAIL.toUpperCase()}`, DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: kv, ...over
  };
  const io = {
    clock: NOW,
    certsDown: false,
    fetch: async (url, init) => {
      if (url === access.certsUrl) {
        access.certsCalls += 1;
        if (io.certsDown) return new Response('no', { status: 500 });
        return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      }
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  return { kv, api, env, io };
}

function req(path, { method = 'POST', body, headers = {}, jwt = goodJwt, code = CODE, site = 'same-origin' } = {}) {
  const h = { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers };
  if (jwt) h['cf-access-jwt-assertion'] = jwt;
  if (code !== null) h['x-redux-code'] = codeHeader(code);
  if (site) h['sec-fetch-site'] = site;
  return new Request(ORIGIN + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
}

/* ログに出た行を集める */
const logs = [];
const realLog = console.log;
const quiet = async (fn) => {
  console.log = (line) => logs.push(String(line));
  try { return await fn(); } finally { console.log = realLog; }
};
const call = (s, request) => quiet(() => handle(request, s.env, s.io));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('/api/healthz: Access を通った同じ場所の呼び出しに、model と今日・今月の残りだけを返す', async () => {
  const s = setup();
  const res = await call(s, req('/api/healthz', { method: 'GET', code: null }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, model: 'claude-haiku-5-5', left: { today: 200, monthUsd: 5 } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('設定が欠けていたら 503 で、欠けた名前だけを返す（値は出さない）', async () => {
  const s = setup({ REDUX_CODE: '', ALLOWED_EMAILS: undefined, BUDGET: undefined });
  const res = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.deepEqual(body.missing, ['REDUX_CODE', 'ALLOWED_EMAILS', 'BUDGET (KV)']);
  assert.ok(!JSON.stringify(body).includes('sk-test'));
  assert.equal(s.api.calls.length, 0);
});

test('道と method: 知らない道は 404、違う method と OPTIONS は 405（CORS のヘッダは出さない）', async () => {
  const s = setup();
  assert.equal((await call(s, req('/api/other', { method: 'GET' }))).status, 404);
  assert.equal((await call(s, req('/index.html', { method: 'GET' }))).status, 404);
  const opt = await call(s, req('/api/read', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }));
  assert.equal(opt.status, 405);
  assert.equal(opt.headers.get('access-control-allow-origin'), null);
  assert.equal((await call(s, req('/api/read', { method: 'GET' }))).status, 405);
});

test('Sec-Fetch-Site が same-origin でない呼び出しは 403（別のサイトや、ヘッダの無い道具から）', async () => {
  const s = setup();
  for (const site of ['cross-site', 'same-site', 'none', null]) {
    const res = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL }, site }));
    assert.equal(res.status, 403, String(site));
  }
  assert.equal(s.api.calls.length, 0);
});

test('Access の JWT: 無い・形が違う・別の鍵の署名・alg が違う・iss・aud・期限・まだ早い・許していないメールは 403', async () => {
  const s = setup();
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const [h, p] = goodJwt.split('.');
  const bad = {
    none: null,
    junk: 'abc.def',
    otherKey: await access.sign(goodClaims(), {}, other.privateKey),
    algNone: `${btoa(JSON.stringify({ alg: 'none', kid: 'key-1' })).replace(/=+$/, '')}.${p}.`,
    algHs: await access.sign(goodClaims(), { alg: 'HS256' }),
    swapped: `${h}.${btoa(JSON.stringify({ ...goodClaims(), email: 'other2@example.com' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.${goodJwt.split('.')[2]}`,
    iss: await access.sign({ ...goodClaims(), iss: 'https://other-team.cloudflareaccess.com' }),
    aud: await access.sign({ ...goodClaims(), aud: ['another-app'] }),
    expired: await access.sign({ ...goodClaims(), exp: NOW / 1000 - 120 }),
    early: await access.sign({ ...goodClaims(), nbf: NOW / 1000 + 600 }),
    email: await access.sign({ ...goodClaims(), email: 'stranger@example.com' }),
    noEmail: await access.sign({ ...goodClaims(), email: undefined }),
    unknownKid: await access.sign(goodClaims(), { kid: 'key-9' })
  };
  for (const [name, jwt] of Object.entries(bad)) {
    const res = await call(s, req('/api/healthz', { method: 'GET', jwt }));
    assert.equal(res.status, 403, name);
  }
  assert.equal((await call(s, req('/api/healthz', { method: 'GET' }))).status, 200, '大文字のメールアドレスの許可でも通る');
});

test('Access の鍵: 10 分ためる。知らない kid が来たら 1 回取り直す。鍵が取れなければ通さない', async () => {
  const s = setup();
  access.certsCalls = 0;
  await call(s, req('/api/healthz', { method: 'GET' }));
  await call(s, req('/api/healthz', { method: 'GET' }));
  assert.equal(access.certsCalls, 1);
  s.io.clock += 11 * 60 * 1000;
  const later = await access.sign({ ...goodClaims(), exp: s.io.clock / 1000 + 60 });
  await call(s, req('/api/healthz', { method: 'GET', jwt: later }));
  assert.equal(access.certsCalls, 2);
  const s2 = setup();
  s2.io.certsDown = true;
  assert.equal((await call(s2, req('/api/healthz', { method: 'GET' }))).status, 403);
});

test('合言葉: 無い・違う・前後の空白だけ違う・壊れたヘッダ。合っていれば日本語でも通る。失敗は KV に書かない', async () => {
  const s = setup();
  const body = { doc: 'mail', text: MAIL };
  assert.equal((await call(s, req('/api/read', { body, code: null }))).status, 401);
  assert.equal((await call(s, req('/api/read', { body, code: 'うみがめ-2025' }))).status, 401);
  assert.equal((await call(s, req('/api/read', { body, code: '' }))).status, 401);
  assert.equal((await call(s, req('/api/read', { body, headers: { 'x-redux-code': '!!!' }, code: null }))).status, 401);
  assert.equal((await call(s, req('/api/read', { body, headers: { 'x-redux-code': 'A'.repeat(500) }, code: null }))).status, 401);
  assert.equal(s.kv.puts.length, 0, '合言葉の失敗は数えない');
  assert.equal(s.api.calls.length, 0);
  assert.equal((await call(s, req('/api/read', { body, code: ` ${CODE} ` }))).status, 200);
});

test('予約メール: AI へはモデル・上限・中身だけを新しく組み立て、ヘッダは 3 つだけ。健康の行は Worker でも外す', async () => {
  const s = setup();
  const text = `${MAIL}\n既往症：ぜんそく（吸入器を持っていきます）`;
  const res = await call(s, req('/api/read', { body: { doc: 'mail', text, sampleId: 'e1' }, headers: { cookie: 'CF_Authorization=abc' } }));
  assert.equal(res.status, 200);
  const sent = s.api.calls[0];
  assert.deepEqual([...sent.headers.keys()].sort(), ['anthropic-version', 'content-type', 'x-api-key']);
  assert.equal(sent.headers.get('x-api-key'), 'sk-test-not-real');
  assert.deepEqual(Object.keys(sent.body).sort(), ['max_tokens', 'messages', 'model']);
  assert.equal(sent.body.model, 'claude-haiku-5-5');
  assert.equal(sent.body.max_tokens, 3000);
  const prompt = sent.body.messages[0].content[0].text;
  assert.ok(!/ぜんそく|吸入器/.test(prompt), '健康の行が AI に届いていない');
  assert.ok(prompt.includes(R.healthRedact.REDACTED_LINE));
  assert.ok(prompt.includes('今日は 2026-10-22'), '年の無い日付のために、日本の今日を渡す');
  assert.ok(!prompt.includes('e1'.repeat(3)) && !JSON.stringify(sent.body).includes('sampleId'));
});

test('写真: JPEG と PNG は先頭の印で種類を決めて送る。ほかの種類・塗っていない申込書・知らない項目は 400', async () => {
  const s = setup();
  for (const [image, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png']]) {
    const res = await call(s, req('/api/read', { body: { doc: 'ccard', image, masked: false } }));
    assert.equal(res.status, 200);
    const block = s.api.calls[s.api.calls.length - 1].body.messages[0].content[0];
    assert.equal(block.source.media_type, type);
  }
  const before = s.api.calls.length;
  for (const body of [
    { doc: 'ccard', image: GIF }, { doc: 'paper', image: JPEG, masked: false }, { doc: 'paper', image: JPEG },
    { doc: 'paper', image: JPEG, masked: true, health: { history: 'x' } }, { doc: 'mail', text: '' }, { doc: 'fax', text: 'x' },
    { doc: 'mail', text: 'Content-Transfer-Encoding: base64\n' + 'QUJD'.repeat(40) }, [1, 2], 'null'
  ]) {
    const res = await call(s, req('/api/read', { body }));
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal(s.api.calls.length, before);
  assert.equal((await call(s, req('/api/read', { body: '{not json' }))).status, 400);
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL }, headers: { 'content-type': 'text/plain' } }))).status, 415);
});

test('大きすぎる本文は読まずに 413（content-length でも、実際の長さでも）', async () => {
  const s = setup();
  const big = JSON.stringify({ doc: 'ccard', image: 'A'.repeat(R.roster.MAX_IMAGE + 5000) });
  assert.equal((await call(s, req('/api/read', { body: big }))).status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const r = new Request(ORIGIN + '/api/read', { method: 'POST', body: stream, duplex: 'half',
    headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': goodJwt, 'x-redux-code': codeHeader(CODE), 'sec-fetch-site': 'same-origin' } });
  assert.equal((await call(s, r)).status, 413);
  assert.equal(s.api.calls.length, 0);
});

test('1 日の回数の上限: 呼ぶ前に数え、超えたら AI を呼ばずに 429。日が変われば戻る（日本の日付）', async () => {
  const s = setup({ DAILY_LIMIT: '2' });
  const body = { doc: 'mail', text: MAIL };
  assert.equal((await call(s, req('/api/read', { body }))).status, 200);
  assert.equal((await call(s, req('/api/read', { body }))).status, 200);
  const third = await call(s, req('/api/read', { body }));
  assert.equal(third.status, 429);
  assert.deepEqual(await third.json(), { error: 'limit', which: 'day' });
  assert.equal(s.api.calls.length, 2);
  assert.equal(s.kv.peek('day:2026-10-22'), '2');
  s.io.clock = Date.parse('2026-10-22T15:00:00Z');   // 日本では 10/23 の 0:00
  assert.equal((await call(s, req('/api/read', { body, jwt: await access.sign({ ...goodClaims(), exp: s.io.clock / 1000 + 60 }) }))).status, 200);
  assert.equal(s.kv.peek('day:2026-10-23'), '1');
});

test('今月の額の上限: 使った額 + 1 件の最大の見込みが上限を超えるなら 429。使った額は答えの usage で足す', async () => {
  const s = setup({ MONTHLY_USD: '0.005' });
  const body = { doc: 'mail', text: MAIL };
  assert.equal((await call(s, req('/api/read', { body }))).status, 200);
  assert.equal(s.kv.peek('month:2026-10'), String(costMicro(s.api.usage)));
  s.api.usage = { input_tokens: 20000, output_tokens: 3000 };   // 1 件で 0.0035 ドル
  assert.equal((await call(s, req('/api/read', { body }))).status, 200);
  const res = await call(s, req('/api/read', { body }));
  assert.equal(res.status, 429);
  assert.equal((await res.json()).which, 'month');
  assert.equal(s.api.calls.length, 2);
  assert.equal(costMicro(undefined), WORST_MICRO, 'usage が無ければ最大の見込みで数える');
});

test('KV が読めないときは AI を呼ばずに 503。答えのあとに書けないときは、読み取りは返してログに残す', async () => {
  const s = setup();
  s.kv.failing = true;
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 503);
  assert.equal(s.api.calls.length, 0);
  assert.equal((await call(s, req('/api/healthz', { method: 'GET' }))).status, 503);
  const s2 = setup();
  const realPut = s2.kv.put;
  s2.kv.put = async (k, v, o) => { if (k.startsWith('month:')) throw new Error('kv'); return realPut(k, v, o); };
  logs.length = 0;
  assert.equal((await call(s2, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 200);
  assert.ok(logs.some(l => l.includes('spend-kv')));
});

test('Claude API の失敗: 状態の番号もエラーの本文も画面に返さず 502。断られた（refusal）・答えが空も 502', async () => {
  const s = setup();
  s.api.status = 529;
  const res = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.ok(!text.includes('secret detail') && !text.includes('529'));
  s.api.status = 200;
  s.api.stopReason = 'refusal';
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 502);
  assert.equal(s.kv.peek('month:2026-10'), String(costMicro(s.api.usage)), '断られた分の費用も数える');
  s.api.stopReason = 'end_turn';
  s.api.answer = '';
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 502);
});

test('AI の答え: 考えた所は使わず文だけを読み、答えの形に直す。健康の項目と知らない項目は捨て、写真の予約は受け取らない', async () => {
  const s = setup();
  s.api.answer = '読み取りました。\n```json\n' + JSON.stringify({
    participants: [{ name: '見本 花子', birth_date: '1990-04-01', phone: '090-1234-5678', medical_history: 'ぜんそく',
      cert_course: 'ow', cert_date: '2020-05', dive_count: 12, unsure: ['phone', 'medical_history'], extra: 'x' }],
    booking: { site: '予約サイト', date: '2026-10-24', start: '08:30', people: 2, lead_name: '見本 花子' },
    health_info_visible: true, note: 'x'
  }) + '\n```';
  const res = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(res.status, 200);
  const reading = await res.json();
  assert.ok(R.roster.validateReading(reading).ok, '画面の検査（validateReading）を通る形');
  assert.equal(reading.healthSeen, true);
  assert.equal(reading.people[0].cert.course, 'OW');
  assert.deepEqual(reading.people[0].unsure, ['phone']);
  assert.ok(!JSON.stringify(reading).includes('ぜんそく'));
  assert.equal(reading.booking.date, '2026-10-24');
  const photo = await call(s, req('/api/read', { body: { doc: 'ccard', image: JPEG } }));
  assert.equal((await photo.json()).booking, null);
  s.api.answer = 'JSON はありません';
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 502);
  s.api.answer = '{"participants": "x", "health_info_visible": false}';
  const odd = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(odd.status, 200);
  assert.deepEqual((await odd.json()).people, []);
});

test('ログ: 道・状態・doc・量・時間だけ。メールの中身・メールアドレス・合言葉・鍵は出さない', async () => {
  const s = setup();
  logs.length = 0;
  await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL }, code: 'ちがう' }));
  await call(s, req('/api/read', { body: { doc: 'ccard', image: JPEG } }));
  assert.equal(logs.length, 3);
  for (const line of logs) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).filter(k => !['route', 'status', 'ms', 'doc', 'size', 'why'].includes(k)), []);
    for (const word of [EMAIL, CODE, 'ちがう', 'sk-test', '見本 花子', JPEG.slice(0, 12), goodJwt.slice(0, 20)]) assert.ok(!line.includes(word), word);
  }
});

test('core の小さな決まり: 日本の日付と月、写真の種類', () => {
  assert.deepEqual(periods(Date.parse('2026-10-31T15:30:00Z')), { day: '2026-11-01', month: '2026-11' });
  assert.equal(imageType(JPEG), 'image/jpeg');
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(GIF), '');
  assert.equal(imageType('***'), '');
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
if (failed) process.exit(1);
