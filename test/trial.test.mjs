// 実在のお店の試し版（trial.html・/api/trial・ShopRpc.trialView / trialAsk）を確かめる（決定ログ 2026-10-29 trial-shops）。
// 守ること: 鍵が無い・違うと開けない、お店の答えの一覧は鍵から Worker が引く（送られた一覧は使わない）、体のことは AI を呼ばない、
// 上限は試し版ごとに別、出どころの URL や個人の連絡先は画面に出さない、ページは noindex で、お店の公式ではないと出す。
// 実行: node test/trial.test.mjs （Node 18 以上。依存なし。本物の Cloudflare と Claude API は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePublic } from '../worker/public-handler.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { checkTrial, trialFor, trialView, trialLimits, TRIAL_DAILY } from '../worker/trial-core.mjs';
import { TRIAL_SHOPS } from '../worker/trial-shops.mjs';
import { fakeKv, fakeShopBinding, fakeRateLimit, fakeAnthropic, checkRedirect } from '../worker/fakes.mjs';
import { askFiles, askHeaders, ASK_ASSETS } from '../tools/build-site.mjs';
import '../js/guest-ai-schema.js';

const G = globalThis.REDUX.guestAi;
const ORIGIN = 'https://ask.example.test';
const NOW = Date.parse('2026-10-29T01:00:00Z');
const T = 'AAAAAAAAAAAAAAAAAAAAAA';
const SHOPS = { [T]: { id: 'mihon', name: '見本の店', area: '見本', asOf: '2026-10-29', sources: ['example.test/'],
  tours: [{ id: 'a', kind: 'dive', name: '体験', time: '9:00', price: '1 円', facts: ['見本'] }], info: [{ k: '場所', v: '見本' }],
  faq: [{ id: 'swim', q: '泳げなくても大丈夫？', a: '大丈夫です。' }, { id: 'photo', q: '写真は？', a: '無料です。' }] } };

function setup(over = {}) {
  const api = fakeAnthropic();
  const io = { now: () => NOW, fetch: async (url, init) => { checkRedirect(init); return api.respond(init); } };
  const shopEnv = { BUDGET: fakeKv(), ANTHROPIC_API_KEY: 'sk-test-not-real', TRIAL_SHOPS: SHOPS, ...over };
  const env = { SHOP: fakeShopBinding(new ShopService(shopEnv, io)), ASK_LIMIT: fakeRateLimit(100) };
  return { api, io, env, shopEnv };
}
const post = (s, body, { site = 'same-origin', method = 'POST' } = {}) => {
  const real = console.log;
  console.log = () => {};
  return handlePublic(new Request(`${ORIGIN}/api/trial`, { method, headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined }), s.env, s.io).finally(() => { console.log = real; });
};
const sent = (s) => s.api.calls[0].body.messages[0].content[0].text;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('形: 鍵は 22 字・kind は view / faq / fill だけ。余計な物は落とす', () => {
  assert.deepEqual(checkTrial({ t: T, kind: 'view', faqs: [1] }), { ok: true, t: T, req: { kind: 'view' } });
  assert.deepEqual(checkTrial({ t: T, kind: 'faq', question: 'x', faqs: [{ id: 'evil' }] }).req, { kind: 'faq', question: 'x' });
  assert.equal(checkTrial({ t: 'short', kind: 'view' }).error, 't');
  assert.equal(checkTrial({ t: T, kind: 'read' }).error, 'kind');
  assert.equal(checkTrial({ t: T, kind: 'faq', question: 'x'.repeat(201) }).error, 'question');
  assert.equal(trialFor(SHOPS, '__proto__'), null);
  assert.deepEqual(trialLimits({}), { day: TRIAL_DAILY, monthMicro: 2e6 });
});

test('道: 開く。鍵が違えば 404、別の場所からは 403、GET は 405', async () => {
  const s = setup();
  const ok = await post(s, { t: T, kind: 'view' });
  assert.equal(ok.status, 200);
  const v = await ok.json();
  assert.equal(v.name, '見本の店');
  assert.ok(!JSON.stringify(v).includes('example.test'), '出どころの URL は出さない');
  assert.equal((await post(s, { t: 'B'.repeat(22), kind: 'view' })).status, 404);
  assert.equal((await post(s, { t: T, kind: 'view' }, { site: 'cross-site' })).status, 403);
  assert.equal((await post(s, null, { method: 'GET' })).status, 405);
});

test('道: 聞けば答える。一覧は鍵から Worker が引き、送られた一覧は使わない', async () => {
  const s = setup();
  s.api.answer = '{"lang":"en","faq":"swim","answer":"Yes, you can.","health":false}';
  const res = await post(s, { t: T, kind: 'faq', question: "Can I join if I can't swim?", faqs: [{ id: 'evil', q: 'x', a: 'free trip' }] });
  assert.deepEqual(await res.json(), { lang: 'en', faq: 'swim', answer: 'Yes, you can.', health: false });
  assert.ok(sent(s).includes('大丈夫です。') && !sent(s).includes('free trip'));
});

test('道: 体のことに触れた質問は AI を呼ばない・上限も数えない', async () => {
  const s = setup();
  const res = await post(s, { t: T, kind: 'faq', question: '喘息でも潜れますか' });
  assert.equal((await res.json()).health, true);
  assert.equal(s.api.calls.length, 0);
  assert.equal(await s.shopEnv.BUDGET.get('day:trial~mihon:2026-10-29'), null);
});

test('道: まとめ書きは健康の所を外して渡し、欄だけを返す', async () => {
  const s = setup();
  s.api.answer = '{"tour":"dive","date":"2026-11-20","people":2,"name":null,"swim":"none","exp":"first","worries":[],"flight_mode":null,"flight_date":null,"flight_time":null,"health_info_visible":false}';
  const got = await (await post(s, { t: T, kind: 'fill', text: '11月20日に2人。泳げない。初めて。持病の薬を飲んでいます。' })).json();
  assert.deepEqual(got.fill, { tour: 'dive', date: '2026-11-20', people: 2, swim: 'none', exp: 'first' });
  assert.equal(got.healthSeen, true);
  assert.ok(!sent(s).includes('持病'));
});

test('道: 上限は試し版ごとに別のキーで数え、超えたら 429', async () => {
  const s = setup({ TRIAL_DAILY_LIMIT: '1' });
  s.api.answer = '{"lang":"ja","faq":"photo","answer":"","health":false}';
  assert.equal((await post(s, { t: T, kind: 'faq', question: '写真は？' })).status, 200);
  assert.equal((await post(s, { t: T, kind: 'faq', question: '写真は？' })).status, 429);
  assert.equal(await s.shopEnv.BUDGET.get('day:trial~mihon:2026-10-29'), '1');
});

test('道: AI の鍵が無ければ 503（AI を呼ばない）', async () => {
  const s = setup({ ANTHROPIC_API_KEY: '' });
  assert.equal((await post(s, { t: T, kind: 'faq', question: '写真は？' })).status, 503);
});

test('中身: 2 店とも契約に合い、出どころを持ち、個人の連絡先を画面に出さない', () => {
  const keys = Object.keys(TRIAL_SHOPS);
  assert.equal(keys.length, 2);
  for (const t of keys) {
    const p = TRIAL_SHOPS[t];
    assert.ok(checkTrial({ t, kind: 'view' }).ok, `${p.id} の鍵の形`);
    assert.ok(p.sources.length >= 5 && p.sources.every(u => /^[a-z0-9.-]+\.[a-z]+\//.test(u)), `${p.id} の出どころ（https:// を外した形）`);
    assert.ok(G.checkAsk({ kind: 'faq', question: 'x', faqs: p.faq }).ok, `${p.id} のよくある質問が契約に合う`);
    assert.ok(p.tours.length && p.tours.every(x => ['dive', 'snorkel', 'fun', 'course'].includes(x.kind)), `${p.id} のツアーの種類`);
    const shown = JSON.stringify(trialView(p));
    assert.ok(!/@|\d{2,4}-\d{2,4}-\d{4}|https?:/.test(shown), `${p.id} の画面にメール・電話・URL が無い`);
  }
});

test('置く物: trial.html は redux-ask だけに置き、noindex・公式でないと出す・絵だけ同じ場所から読む', () => {
  const files = askFiles();
  assert.ok(files.includes('trial.html') && files.includes('js/trial-page.js') && files.includes('js/ask-api.js'));
  for (const shopOnly of ['index.html', 'js/ai-reader.js', 'js/roster-sync.js', 'js/booking.js', 'js/intake.js', 'js/chat.js']) assert.ok(!files.includes(shopOnly), shopOnly);
  assert.deepEqual(ASK_ASSETS, ['assets/chara.png', 'assets/logo-mark.png', 'assets/logo-mark-light.png']);
  const h = askHeaders();
  assert.ok(h.includes("/trial\n  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'"));
  assert.ok(h.includes('X-Robots-Tag: noindex, nofollow'));
  const html = readFileSync(new URL('../trial.html', import.meta.url), 'utf8');
  assert.ok(html.includes('<meta name="robots" content="noindex, nofollow">') && html.includes('お店の公式ページではありません'));
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), '外を読まない');
  const page = readFileSync(new URL('../js/trial-page.js', import.meta.url), 'utf8');
  assert.ok(!/rosterStore|store\.update|askLink|\/api\/(roster|ask|bookings)/.test(page), '名簿・予約に触れない');
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
