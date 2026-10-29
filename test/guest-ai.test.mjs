// お客さま画面の AI（聞けば答える・まとめて書けば入る）を確かめる。契約（js/guest-ai-schema.js）・Worker の決まり（worker/guest-ai-core.mjs）・
// 道（/api/guest-ai。Access の内、上限は予約メールと別）・画面の窓口（js/ai-reader.js の guestFaq / guestFill）。
// 守ること: 体のことに触れた質問は AI に送らない、まとめ書きの健康の所は送らない、AI の答えは一覧の id と決まった欄だけ。
// 実行: node test/guest-ai.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { checkGuestRequest, guestAnswerFrom, guestLimits, GUEST_DAILY } from '../worker/guest-ai-core.mjs';
import { fakeKv, fakeD1, fakeAccess, fakeAnthropic, checkRedirect } from '../worker/fakes.mjs';

const R = globalThis.REDUX;
const G = R.guestAi;
const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-29T01:00:00Z');   // 日本では 10/29 の 10:00
const TODAY = '2026-10-29';
const FAQS = [
  { id: 'swim', q: '泳げなくても大丈夫？', a: '泳げなくても参加できます。ライフジャケットと浮き具を使います。' },
  { id: 'photo', q: '写真はもらえる？', a: '写真は無料で、当日中に LINE でお送りします。' }
];

const access = await fakeAccess(TEAM);
const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

function setup(over = {}) {
  resetAccessCache();
  const api = fakeAnthropic();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: fakeD1(), SINGLE_SHOP: 'default', ...over };
  const io = {
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => NOW
  };
  return { api, env, io };
}
const req = (body, { auth = true } = {}) => new Request(`${ORIGIN}/api/guest-ai`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(auth ? { 'cf-access-jwt-assertion': jwt } : {}) },
  body: JSON.stringify(body) });
const logs = [];
const call = async (s, request) => {
  const real = console.log;
  console.log = (line) => logs.push(String(line));
  try { return await handle(request, s.env, s.io); } finally { console.log = real; }
};
const sentText = (s) => s.api.calls[0].body.messages[0].content[0].text;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- 契約 ---------- */
test('契約: 欄の選択肢の id は data.js（画面の申し込み）と同じ', () => {
  const sandbox = { window: { REDUX: { ymd: () => TODAY, addDays: (d) => d } } };
  vm.runInNewContext(readFileSync(new URL('../js/data.js', import.meta.url), 'utf8'), sandbox);
  const ids = (k) => JSON.parse(JSON.stringify(sandbox.window.REDUX[k].map(t => t.id)));   // 別の realm の配列を、この realm に写す
  assert.deepEqual(ids('TOURS'), G.TOURS);
  assert.deepEqual(ids('SWIM'), G.SWIM);
  assert.deepEqual(ids('EXP'), G.EXP);
  assert.deepEqual(ids('WORRIES'), G.WORRIES);
});

test('契約: 送る物の形（kind・長さ・一覧の id）', () => {
  assert.ok(G.checkAsk({ kind: 'faq', question: '写真は？', faqs: FAQS }).ok);
  assert.ok(G.checkAsk({ kind: 'fill', text: '11月3日に2人' }).ok);
  assert.ok(!G.checkAsk({ kind: 'read', text: 'x' }).ok);
  assert.ok(!G.checkAsk({ kind: 'faq', question: ' ', faqs: FAQS }).ok);
  assert.ok(!G.checkAsk({ kind: 'faq', question: 'x'.repeat(201), faqs: FAQS }).ok);
  assert.ok(!G.checkAsk({ kind: 'faq', question: 'x', faqs: [FAQS[0], FAQS[0]] }).ok, '同じ id が 2 つ');
  assert.ok(!G.checkAsk({ kind: 'faq', question: 'x', faqs: [{ id: 'A B', q: 'q', a: 'a' }] }).ok);
  assert.ok(!G.checkAsk({ kind: 'fill', text: 'x'.repeat(601) }).ok);
  assert.deepEqual(G.askBody({ kind: 'fill', text: ' a ', extra: 1 }), { kind: 'fill', text: 'a' });
});

test('契約: 聞けば答えるの答え。一覧に無い id は断る・体のことなら選ばない・日本語には訳を使わない', () => {
  const ids = FAQS.map(f => f.id);
  assert.deepEqual(G.faqAnswer({ lang: 'en', faq: 'swim', answer: 'You can join.', health: false }, ids).answer, { lang: 'en', faq: 'swim', answer: 'You can join.', health: false });
  assert.deepEqual(G.faqAnswer({ lang: 'ja', faq: 'swim', answer: '作った文', health: false }, ids).answer, { lang: 'ja', faq: 'swim', answer: '', health: false });
  assert.ok(!G.faqAnswer({ lang: 'ja', faq: 'parking', answer: '', health: false }, ids).ok);
  assert.ok(!G.faqAnswer({ lang: 'en', faq: 'swim', answer: '', health: false }, ids).ok, '訳が無い');
  assert.deepEqual(G.faqAnswer({ lang: 'en', faq: 'swim', answer: 'ok', health: true }, ids).answer, { lang: 'en', faq: null, answer: '', health: true });
  assert.equal(G.faqAnswer({ lang: 'fr', faq: null, answer: '', health: false }, ids).answer.lang, 'en');
});

test('契約: まとめて書けば入るの答え。形に合わない欄と過去の日付は捨て、ほかは使う', () => {
  const f = G.fillAnswer({ tour: 'dive', date: '2026-11-03', people: 2, name: '山田', swim: 'none', exp: 'first', worries: ['seasick', 'heart'],
    flight_mode: 'set', flight_date: '2026-11-04', flight_time: '14:00', health_info_visible: true }, TODAY);
  assert.deepEqual(f.fill, { tour: 'dive', date: '2026-11-03', people: 2, name: '山田', swim: 'none', exp: 'first', worries: ['seasick'],
    flightMode: 'set', flightDate: '2026-11-04', flightTime: '14:00' });
  assert.equal(f.healthSeen, true);
  const bad = G.fillAnswer({ tour: 'boat', date: '2026-10-01', people: 40, name: 'https://evil.example', swim: 'fish', flight_mode: 'set', flight_time: '25:00' }, TODAY);
  assert.deepEqual(bad.fill, { flightMode: 'set' });
  assert.deepEqual(G.fillAnswer({ date: '2026-02-30' }, TODAY).fields, []);
});

/* ---------- Worker の決まり ---------- */
test('Worker: 体のことに触れた質問は AI に渡さない（stop）', () => {
  for (const q of ['喘息があるけど潜れますか', 'I am pregnant, can I dive?', '임신 중인데 괜찮아요?', '心臓の薬を飲んでいます']) {
    assert.deepEqual(checkGuestRequest({ kind: 'faq', question: q, faqs: FAQS }, TODAY), { ok: true, stop: 'health' }, q);
  }
  const ok = checkGuestRequest({ kind: 'faq', question: '写真はもらえますか', faqs: FAQS }, TODAY);
  assert.ok(ok.ask && ok.ask.prompt.includes('"swim"') && ok.ask.text === '写真はもらえますか');
});

test('Worker: まとめ書きは健康の所を外してから渡す', () => {
  const r = checkGuestRequest({ kind: 'fill', text: '11月3日に2人。持病で薬を飲んでいます。泳げません。' }, TODAY);
  assert.ok(!r.ask.text.includes('持病') && !r.ask.text.includes('薬'));
  assert.ok(r.ask.redacted > 0);
  assert.ok(r.ask.prompt.includes(TODAY));
});

test('Worker: 答えの JSON は 1 つだけ。2 つあれば断る', () => {
  const ask = checkGuestRequest({ kind: 'faq', question: '写真は？', faqs: FAQS }, TODAY).ask;
  assert.deepEqual(guestAnswerFrom('```json\n{"lang":"ja","faq":"photo","answer":"","health":false}\n```', ask), { ok: true, reading: { lang: 'ja', faq: 'photo', answer: '', health: false } });
  assert.equal(guestAnswerFrom('{"lang":"ja","faq":"photo"} {"lang":"ja","faq":"swim"}', ask).error, 'many');
  assert.equal(guestAnswerFrom('分かりません', ask).error, 'no-json');
});

test('Worker: 上限の設定。vars に無ければ決まった値', () => {
  assert.deepEqual(guestLimits({}), { day: GUEST_DAILY, monthMicro: 3e6 });
  assert.deepEqual(guestLimits({ GUEST_DAILY_LIMIT: '10', GUEST_MONTHLY_USD: '1' }), { day: 10, monthMicro: 1e6 });
});

/* ---------- 道 ---------- */
test('道: Access が無ければ 403。AI は呼ばない', async () => {
  const s = setup();
  assert.equal((await call(s, req({ kind: 'faq', question: '写真は？', faqs: FAQS }, { auth: false }))).status, 403);
  assert.equal(s.api.calls.length, 0);
});

test('道: 聞けば答える。一覧と質問を AI に渡し、選んだ id と訳を返す。ログに中身は出ない', async () => {
  const s = setup();
  s.api.answer = '{"lang":"en","faq":"swim","answer":"You can join even if you cannot swim.","health":false}';
  logs.length = 0;
  const res = await call(s, req({ kind: 'faq', question: "Can I join if I can't swim?", faqs: FAQS }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { lang: 'en', faq: 'swim', answer: 'You can join even if you cannot swim.', health: false });
  assert.ok(sentText(s).includes("--- 質問 ---\nCan I join if I can't swim?"));
  assert.ok(sentText(s).includes('泳げなくても参加できます'));
  assert.ok(!logs.join('').includes('swim?'));
});

test('道: 体のことに触れた質問は AI を呼ばずに health を返し、上限も数えない', async () => {
  const s = setup();
  const res = await call(s, req({ kind: 'faq', question: '喘息でも潜れますか', faqs: FAQS }));
  assert.deepEqual(await res.json(), { lang: 'ja', faq: null, answer: '', health: true });
  assert.equal(s.api.calls.length, 0);
  assert.equal(await s.env.BUDGET.get(`day:default~guest:${TODAY}`), null);
});

test('道: AI が一覧に無い id を答えたら 502（作った答えを返さない）', async () => {
  const s = setup();
  s.api.answer = '{"lang":"ja","faq":"parking","answer":"","health":false}';
  assert.equal((await call(s, req({ kind: 'faq', question: '駐車場は？', faqs: FAQS }))).status, 502);
});

test('道: まとめて書けば入る。健康の所を外して渡し、欄だけを返す', async () => {
  const s = setup();
  s.api.answer = '{"tour":"dive","date":"2026-11-03","people":2,"name":null,"swim":"none","exp":"first","worries":["seasick"],"flight_mode":null,"flight_date":null,"flight_time":null,"health_info_visible":false}';
  const res = await call(s, req({ kind: 'fill', text: '11月3日に大人2人。泳げません。初めてです。船酔いしやすい。喘息があります。' }));
  const got = await res.json();
  assert.deepEqual(got.fill, { tour: 'dive', date: '2026-11-03', people: 2, swim: 'none', exp: 'first', worries: ['seasick'] });
  assert.equal(got.healthSeen, true, '外した所があれば見えた側に倒す');
  assert.ok(!sentText(s).includes('喘息'));
});

test('道: 上限は予約メールの読み取りと別に数える（お客さんの質問でメールの上限を使い切らない）', async () => {
  const s = setup({ GUEST_DAILY_LIMIT: '1' });
  s.api.answer = '{"lang":"ja","faq":"photo","answer":"","health":false}';
  assert.equal((await call(s, req({ kind: 'faq', question: '写真は？', faqs: FAQS }))).status, 200);
  const second = await call(s, req({ kind: 'faq', question: '写真は？', faqs: FAQS }));
  assert.equal(second.status, 429);
  assert.equal(await s.env.BUDGET.get(`day:default:${TODAY}`), null, 'メールの読み取りの数は動かない');
});

/* ---------- 画面の窓口（見本） ---------- */
test('画面: 見本の聞けば答える。体のことは送らず health、合う答えは id', async () => {
  globalThis.window = globalThis;
  for (const f of ['../js/match.js', '../js/ai-reader.js']) vm.runInThisContext(readFileSync(new URL(f, import.meta.url), 'utf8'));
  R.today = () => TODAY;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return { status: 404, ok: false, json: async () => null }; };
  const faqs = FAQS.map(f => ({ ...f }));
  const h = await R.aiReader.guestFaq('持病があります', faqs);
  assert.deepEqual([h.health, h.faq], [true, null]);
  assert.equal(fetched, 0);
});

test('画面: 見本のまとめて書けば入る。健康の所は読まず、決まった言い方を欄に入れる', async () => {
  const got = await R.aiReader.guestFill('11月3日に大人2人。山田です。2人とも泳げなくて、ダイビングは初めて。船酔いしやすいです。帰りは11月4日14時の飛行機。');
  assert.deepEqual(got.fill, { tour: 'dive', date: '2026-11-03', people: 2, name: '山田', swim: 'none', exp: 'first', worries: ['seasick'],
    flightMode: 'set', flightDate: '2026-11-04', flightTime: '14:00' });
  assert.equal(got.healthSeen, false);
  const h = await R.aiReader.guestFill('11月3日に2人。喘息があります。');
  assert.equal(h.healthSeen, true);
  assert.equal(h.mode, 'sample');
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
