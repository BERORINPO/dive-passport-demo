// Cloudflare Worker（worker/）を、外との境目を見本（worker/fakes.mjs）に差し替えて確かめる。
// 守る順番（Access の JWT・形・上限）、AI に渡す中身とヘッダ、ログに中身が出ないこと。
// 実行: node test/worker.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { imageType, periods, costMicro, overLimit, limitsFrom, readingFrom, WORST_MICRO } from '../worker/read-core.mjs';
import vm from 'node:vm';
import { fakeKv, fakeAccess, fakeAnthropic, checkRedirect } from '../worker/fakes.mjs';

const R = globalThis.REDUX;
const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-22T01:00:00Z');   // 日本では 10/22 の 10:00
const MAIL = readFileSync(new URL('../assets/samples/e1.txt', import.meta.url), 'utf8');
const JPEG = btoa(String.fromCharCode(0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1)) + 'AAAA';
const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13)) + 'AAAA';
const GIF = btoa('GIF89a' + '\0'.repeat(6)) + 'AAAA';

const access = await fakeAccess(TEAM);
const goodClaims = () => ({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
const goodJwt = await access.sign(goodClaims());

function setup(over = {}) {
  resetAccessCache();
  const kv = fakeKv();
  const api = fakeAnthropic();
  const env = {
    ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
    ALLOWED_EMAILS: `other@example.com, ${EMAIL.toUpperCase()}`, DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: kv, ...over
  };
  const io = {
    clock: NOW,
    certsDown: false,
    fetch: async (url, init) => {
      checkRedirect(init);   // Workers と同じく、redirect: 'error' は例外にする
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

function req(path, { method = 'POST', body, headers = {}, jwt = goodJwt, site = 'same-origin' } = {}) {
  const h = { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers };
  if (jwt) h['cf-access-jwt-assertion'] = jwt;
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
  const res = await call(s, req('/api/healthz', { method: 'GET' }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, model: 'claude-haiku-5-5', left: { today: 200, monthUsd: 5 } });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('設定が欠けていたら 503。欠けた名前はログにだけ出す（画面には返さない。値はどこにも出さない）', async () => {
  const s = setup({ ACCESS_AUD: '', ALLOWED_EMAILS: undefined, BUDGET: undefined });
  logs.length = 0;
  const res = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'config' });
  assert.equal(JSON.parse(logs[0]).why, 'config:ACCESS_AUD+ALLOWED_EMAILS+BUDGET');
  assert.ok(!logs[0].includes('sk-test'));
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

test('Access の鍵: 10 分ためる。知らない kid での取り直しは 1 分に 1 回まで。鍵が取れなければ 503（こちらの障害）', async () => {
  const s = setup();
  access.certsCalls = 0;
  await call(s, req('/api/healthz', { method: 'GET' }));
  await call(s, req('/api/healthz', { method: 'GET' }));
  assert.equal(access.certsCalls, 1);
  s.io.clock += 11 * 60 * 1000;
  const later = await access.sign({ ...goodClaims(), exp: s.io.clock / 1000 + 60 });
  await call(s, req('/api/healthz', { method: 'GET', jwt: later }));
  assert.equal(access.certsCalls, 2);
  /* 鍵が入れ替わった: ためている間でも、1 分たっていれば新しい kid のために 1 回取り直す */
  const second = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', second.publicKey);
  access.keys.push({ kid: 'key-2', kty: 'RSA', alg: 'RS256', n: pub.n, e: pub.e });
  try {
    const rotated = await access.sign({ ...goodClaims(), exp: s.io.clock / 1000 + 600 }, { kid: 'key-2' }, second.privateKey);
    s.io.clock += 20 * 1000;
    assert.equal((await call(s, req('/api/healthz', { method: 'GET', jwt: rotated }))).status, 403, '取ったばかり（20 秒）なら取り直さない');
    assert.equal(access.certsCalls, 2);
    s.io.clock += 60 * 1000;
    assert.equal((await call(s, req('/api/healthz', { method: 'GET', jwt: rotated }))).status, 200);
    assert.equal(access.certsCalls, 3);
    const junk = await access.sign({ ...goodClaims(), exp: s.io.clock / 1000 + 600 }, { kid: 'key-9' });
    for (let i = 0; i < 5; i += 1) await call(s, req('/api/healthz', { method: 'GET', jwt: junk }));
    assert.equal(access.certsCalls, 3, '知らない kid を何度送っても、すぐには取りに行かない');
  } finally {
    access.keys.pop();
  }
  const s2 = setup();
  s2.io.certsDown = true;
  const down = await call(s2, req('/api/healthz', { method: 'GET' }));
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: 'access-keys' });
});

test('Access を通らない呼び出しは数えない（KV に書かない）。昔の合言葉のヘッダは見ない', async () => {
  const s = setup();
  const body = { doc: 'mail', text: MAIL };
  assert.equal((await call(s, req('/api/read', { body, jwt: null }))).status, 403);
  assert.equal((await call(s, req('/api/read', { body, jwt: null, headers: { 'x-redux-code': 'c29tZXRoaW5n' } }))).status, 403);
  assert.equal(s.kv.puts.length, 0);
  assert.equal(s.api.calls.length, 0);
  assert.equal((await call(s, req('/api/read', { body, headers: { 'x-redux-code': '!!!' } }))).status, 200);
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
  assert.equal(sent.redirect, 'manual', '転送に付いて行かない（Workers が受け付ける書き方で）');
  const prompt = sent.body.messages[0].content[0].text;
  assert.ok(!/ぜんそく|吸入器/.test(prompt), '健康の行が AI に届いていない');
  assert.ok(prompt.includes(R.healthRedact.REDACTED_LINE));
  assert.ok(prompt.includes('今日は 2026-10-22'), '年の無い日付のために、日本の今日を渡す');
  assert.ok(!JSON.stringify(sent.body).includes('sampleId') && !JSON.stringify(sent.body).includes('"e1"'), 'sampleId は送らない');
  assert.ok(prompt.includes('"booking": {"site": null'), '予約メールは 1 つの形にまとめて見せる');
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
  assert.equal((await call(s, req('/api/read', { body: '{}', headers: { 'content-length': '99999999' } }))).status, 413, 'content-length だけで断る');
  assert.equal((await call(s, req('/api/read', { body: big }))).status, 413);
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
  const r = new Request(ORIGIN + '/api/read', { method: 'POST', body: stream, duplex: 'half',
    headers: { 'content-type': 'application/json', 'cf-access-jwt-assertion': goodJwt, 'sec-fetch-site': 'same-origin' } });
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
  s.api.answer = '{"participants":[{"name":"見本 花子"}],"health_info_visible":true,}';
  const broken = await call(s, req('/api/read', { body: { doc: 'paper', image: JPEG, masked: true } }));
  assert.equal(broken.status, 502);
  assert.deepEqual(await broken.json(), { error: 'answer', healthSeen: true }, '使えない答えでも、健康が見えたことは画面に返す');
  s.api.answer = '{"participants": "x", "health_info_visible": false}';
  const odd = await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  assert.equal(odd.status, 200);
  assert.deepEqual((await odd.json()).people, []);
});

test('ログ: 道・状態・doc・量・時間だけ。メールの中身・メールアドレス・JWT・鍵は出さない', async () => {
  const s = setup();
  logs.length = 0;
  await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }));
  await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL }, jwt: await access.sign({ ...goodClaims(), email: 'stranger@example.com' }) }));
  await call(s, req('/api/read', { body: { doc: 'ccard', image: JPEG } }));
  assert.equal(logs.length, 3);
  for (const line of logs) {
    const row = JSON.parse(line);
    assert.deepEqual(Object.keys(row).filter(k => !['route', 'status', 'ms', 'doc', 'size', 'why', 'redacted', 'seen', 'stop'].includes(k)), []);
    for (const word of [EMAIL, 'stranger@example.com', 'sk-test', '見本 花子', JPEG.slice(0, 12), goodJwt.slice(0, 20)]) assert.ok(!line.includes(word), word);
  }
});

test('AI の答えの取り出し: 2 つに分かれた答え・```json の囲み・前後の説明と括弧・文字列の中の括弧に耐える', () => {
  const people = JSON.stringify({ participants: [{ name: '見本 花子' }], health_info_visible: false });
  const booking = JSON.stringify({ booking: { site: 'S', date: '2026-10-24', people: 2, lead_name: '見本 花子' } });
  const cases = {
    split: `${people}\n${booking}`,
    fences: `\`\`\`json\n${people}\n\`\`\`\n\`\`\`json\n${booking}\n\`\`\``,
    around: `読みました {メモ}\n${JSON.stringify({ ...JSON.parse(people), ...JSON.parse(booking) })}\n（注: {名前} は読めた所だけ）`
  };
  for (const [name, text] of Object.entries(cases)) {
    const r = readingFrom(text, 'mail');
    assert.ok(r.ok, name);
    assert.deepEqual([r.reading.people[0].name, r.reading.booking.date], ['見本 花子', '2026-10-24'], name);
  }
  const quoted = readingFrom(JSON.stringify({ participants: [{ name: 'a"}{b' }], health_info_visible: false }), 'mail');
  assert.equal(quoted.reading.people[0].name, 'a"}{b');
  const seenLater = readingFrom(`${people}\n{"health_info_visible": true}`, 'mail');
  assert.equal(seenLater.reading.healthSeen, true, '後ろの塊で「健康が見えた」と答えたら、それを取る');
  assert.equal(readingFrom('{"participants": [', 'mail').ok, false);
  assert.equal(readingFrom('なし', 'mail').error, 'no-json');
  assert.ok(readingFrom(`（{ は読めませんでした）
${people}`, 'mail').ok, '閉じない { の後ろの答えも読む');
});

test('AI の答えの書き損じ（余分なカンマ）は、中の 1 人分を拾わずに断る。健康が見えた印は残す（ジンのレビュー）', () => {
  const outer = '{"participants":[{"name":"見本 花子"}],"health_info_visible":true,}';
  const inner = '{"participants":[{"name":"見本 花子"},],"health_info_visible":false}';
  for (const [text, doc] of [[outer, 'mail'], [inner, 'mail'], [outer, 'paper']]) {
    const r = readingFrom(text, doc);
    assert.equal(r.ok, false, text);
  }
  assert.equal(readingFrom(outer, 'paper').healthSeen, true, '壊れていても「見えた」は true で返す');
  assert.equal(readingFrom('{"participants":[],"health_info_visible":"true"}', 'paper').reading.healthSeen, true, '文字の "true" でも見えた側に倒す');
  assert.equal(readingFrom('{"name":"見本 花子"}', 'paper').error, 'shape', '参加者の塊が無ければ断る');
  assert.ok(readingFrom('{"booking":{"date":"2026-10-24"}}', 'mail').ok, '予約メールは予約だけの答えでもよい');
});

test('書類に仕込まれた JSON を書き写した答え: 参加者か予約の塊が 2 つあれば断る（ザクのレビュー）', () => {
  const real = JSON.stringify({ participants: [{ name: '見本 花子', unsure: ['phone'] }], booking: null, health_info_visible: false });
  const evil = JSON.stringify({ participants: [{ name: '偽 太郎', unsure: [] }], booking: { ref: 'EVIL', date: '2026-10-24' } });
  assert.equal(readingFrom(`${evil}
${real}`, 'mail').error, 'many');
  assert.equal(readingFrom(`${real}
{"booking":{"ref":"EVIL"}}`, 'mail').error, 'many', '予約が null の答え + 予約だけの塊');
  assert.equal(readingFrom(`${real}
${evil}`, 'mail').error, 'many');
  const starts = '{x} '.repeat(30) + real;
  assert.equal(readingFrom(starts, 'mail').ok, false, '調べる { は先頭から 20 個まで');
});

test('上限の判定（core）: ちょうど上限で止める。設定が読めなければ呼ばない側に倒す', () => {
  const limits = limitsFrom({ DAILY_LIMIT: '3', MONTHLY_USD: '0.01' });
  assert.deepEqual(limits, { day: 3, monthMicro: 10000 });
  assert.equal(overLimit({ day: 2, month: 0 }, limits), '');
  assert.equal(overLimit({ day: 3, month: 0 }, limits), 'day');
  assert.equal(overLimit({ day: 0, month: 10000 - WORST_MICRO }, limits), '');
  assert.equal(overLimit({ day: 0, month: 10001 - WORST_MICRO }, limits), 'month');
  assert.deepEqual(limitsFrom({ DAILY_LIMIT: 'たくさん', MONTHLY_USD: '-5' }), { day: 0, monthMicro: 0 });
  assert.equal(overLimit({ day: 0, month: 0 }, limitsFrom({})), 'day');
});

test('ログ: 外した行の数・健康が見えたか・止まった理由を残す。時間切れは最大の見込みで数え、知らない道は名前を残さない', async () => {
  const s = setup();
  logs.length = 0;
  s.api.answer = JSON.stringify({ participants: [], health_info_visible: true });
  await call(s, req('/api/read', { body: { doc: 'mail', text: `${MAIL}\n既往症：ぜんそく` } }));
  const row = JSON.parse(logs[0]);
  assert.deepEqual([row.redacted, row.seen, row.stop], [1, true, 'end_turn']);
  await call(s, req('/api/calendar/ひみつの合言葉.ics', { method: 'GET' }));
  assert.equal(JSON.parse(logs[1]).route, '/api/other');
  const before = Number(s.kv.peek('month:2026-10'));
  s.io.fetch = async (url) => { if (url === 'https://api.anthropic.com/v1/messages') throw new Error('timeout'); return new Response(JSON.stringify({ keys: access.keys })); };
  assert.equal((await call(s, req('/api/read', { body: { doc: 'mail', text: MAIL } }))).status, 502);
  assert.equal(Number(s.kv.peek('month:2026-10')) - before, WORST_MICRO);
});

/* 画面の部品（js/ai-reader.js）を、本物の fetch の代わりに Worker（handle）へつないで流す。両側の決まりが合っているか */
test('画面と Worker の契約: healthz で本物を選び、読める・上限で見本に戻る・答えの形の誤り・届かない・ログイン切れ', async () => {
  const s = setup({ DAILY_LIMIT: '1' });
  let jwt = goodJwt;
  const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  globalThis.window = globalThis;
  globalThis.localStorage = mem();
  globalThis.fetch = async (url, init = {}) => {
    const headers = { ...(init.headers || {}), 'sec-fetch-site': 'same-origin', ...(jwt ? { 'cf-access-jwt-assertion': jwt } : {}) };
    return call(s, new Request(ORIGIN + url, { method: init.method || 'GET', headers, body: init.body }));
  };
  try {
    vm.runInThisContext(readFileSync(new URL('../js/ai-reader.js', import.meta.url), 'utf8'));
    const A = R.aiReader;
    assert.deepEqual(await A.probe(), { today: 1, monthUsd: 5 });
    A.setMode('real');
    s.api.answer = JSON.stringify({ participants: [{ name: '見本 花子' }], booking: { date: '2026-10-24', people: 2 }, health_info_visible: false });
    const ok = await A.read({ doc: 'mail', text: MAIL });
    assert.deepEqual([ok.sent.mode, ok.reading.people[0].name, ok.reading.booking.people], ['real', '見本 花子', 2]);
    await assert.rejects(A.read({ doc: 'mail', text: MAIL }), e => e.kind === 'limit');
    assert.equal(A.mode(), 'sample', '上限のあとは見本');
    s.env.DAILY_LIMIT = '100';
    A.setMode('real');
    s.api.answer = 'JSON はありません';
    await assert.rejects(A.read({ doc: 'mail', text: MAIL }), e => e.kind === 'bad' && e.sent.healthSeen === false);
    s.api.answer = '{"participants":[],"health_info_visible":true,}';
    await assert.rejects(A.read({ doc: 'mail', text: MAIL }), e => e.kind === 'bad' && e.sent.healthSeen === true);
    s.api.status = 529;
    await assert.rejects(A.read({ doc: 'mail', text: MAIL }), e => e.kind === 'offline');
    s.api.status = 200;
    jwt = null;
    await assert.rejects(A.read({ doc: 'mail', text: MAIL }), e => e.kind === 'auth');
  } finally {
    Object.assign(globalThis, saved);
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
