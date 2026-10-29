// 見られ方の計測（Cloudflare Web Analytics）を国で出し分ける（決定ログ 2026-10-29 analytics-country）。
// 守ること: EU・EEA・英国・スイスと、国が分からない読み込みには計測のスクリプトを入れない。入れるのはお客さまの画面（/）と試し版（/trial）だけ。
// Worker が返すページにも、_headers と同じ見出し（CSP など）を付ける。Service Worker の写しには計測のスクリプトを残さない。
// 実行: node test/analytics.test.mjs （Node 18 以上。依存なし。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { analyticsOn, withBeacon, BEACON_TAG, NO_ANALYTICS_COUNTRIES } from '../worker/analytics-core.mjs';
import { BEACON, PAGE } from '../worker/page-headers.mjs';
import { handle } from '../worker/handler.mjs';
import { handlePublic } from '../worker/public-handler.mjs';

const HTML = '<!doctype html><html><head><title>x</title></head><body><main></main>\n</body></html>';
const fakeAssets = (html = HTML) => {
  const asked = [];
  return { asked, fetch: async (req) => { asked.push({ url: req.url, inm: req.headers.get('if-none-match') }); return new Response(html, { status: 200, headers: { etag: '"abc"' } }); } };
};
const io = { now: () => 0, fetch: async () => { throw new Error('外へは出ない'); } };
const req = (url, country, init = {}) => {
  const r = new Request(url, init);
  if (country !== undefined) Object.defineProperty(r, 'cf', { value: country === null ? {} : { country } });
  return r;
};
const quiet = async (fn) => { const real = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = real; } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('国: 日本・アメリカ・台湾・韓国などは入れる。EU 27・EEA 3・英国・スイスと、国が分からない（無い・XX・T1・形が違う）は入れない', () => {
  for (const c of ['JP', 'US', 'TW', 'KR', 'CN', 'AU', 'SG']) assert.equal(analyticsOn(c), true, c);
  assert.equal(NO_ANALYTICS_COUNTRIES.length, 32, 'EU 27 + EEA 3 + 英国 + スイス');
  for (const c of NO_ANALYTICS_COUNTRIES) assert.equal(analyticsOn(c), false, c);
  for (const c of [undefined, null, '', 'XX', 'T1', 'jp', 'JPN', 1]) assert.equal(analyticsOn(c), false, String(c));
});

test('タグ: 版を決めた URL・integrity・crossorigin。</body> の前に 1 つだけ。2 回入れても 1 つ', () => {
  assert.match(BEACON_TAG, /^<script defer src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[0-9a-f]+" integrity="sha512-[^"]+" crossorigin="anonymous" /);
  assert.ok(BEACON_TAG.includes(`"token": "${BEACON.token}"`) && BEACON_TAG.includes('"spa": false'));
  const once = withBeacon(HTML);
  assert.equal(withBeacon(once), once);
  assert.equal(once.split(BEACON.src).length - 1, 1);
  assert.ok(once.indexOf(BEACON.src) < once.indexOf('</body>'));
  assert.equal(withBeacon('<p>no body</p>'), '<p>no body</p>');
});

test('お店の Worker の /: 日本からは入れ、ドイツ・英国・スイス・国が分からないときは入れない。CSP などの見出しは同じ。条件付きの見出しは渡さず、etag も返さない', async () => {
  const assets = fakeAssets();
  const env = { ASSETS: assets };
  const get = (country, path = '/') => quiet(() => handle(req(`https://app.example.test${path}`, country, { headers: { 'if-none-match': '"abc"' } }), env, io));
  const jp = await get('JP');
  assert.equal(jp.status, 200);
  assert.ok((await jp.text()).includes(BEACON.src));
  assert.equal(jp.headers.get('content-security-policy'), PAGE.index[0][1]);
  assert.equal(jp.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(jp.headers.get('etag'), null);
  for (const c of ['DE', 'GB', 'CH', 'NO', undefined, null]) {
    const r = await get(c);
    assert.ok(!(await r.text()).includes('cloudflareinsights'), `${c} には入れない`);
    assert.equal(r.headers.get('content-security-policy'), PAGE.index[0][1]);
  }
  assert.ok((await (await get('US', '/index.html')).text()).includes(BEACON.src));
  assert.ok(assets.asked.every(a => a.inm === null && new URL(a.url).pathname === '/'), '中身はいつも / から全部取る');
  const post = await quiet(() => handle(req('https://app.example.test/', 'JP', { method: 'POST' }), env, io));
  assert.equal(post.status, 405);
});

test('お客さんの Worker の /trial: 日本から入れ、フランスからは入れない。/ask と /walkin は Worker を通さない（ここでは道が無い 404）', async () => {
  const env = { ASSETS: fakeAssets() };
  const jp = await quiet(() => handlePublic(req('https://ask.example.test/trial', 'JP'), env, io));
  assert.ok((await jp.text()).includes(BEACON.src));
  assert.equal(jp.headers.get('content-security-policy'), PAGE.trial[0][1]);
  assert.equal(jp.headers.get('cache-control'), 'no-store');
  const fr = await quiet(() => handlePublic(req('https://ask.example.test/trial.html', 'FR'), env, io));
  assert.ok(!(await fr.text()).includes('cloudflareinsights'));
  for (const p of ['/ask', '/walkin']) assert.equal((await quiet(() => handlePublic(req(`https://ask.example.test${p}`, 'JP'), env, io))).status, 404);
});

test('置き方: Worker を通すのは /api と、出し分けるページだけ。HTML のファイルには計測のスクリプトを書かない', () => {
  const shop = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const ask = readFileSync(new URL('../wrangler.ask.jsonc', import.meta.url), 'utf8');
  assert.match(shop, /"run_worker_first": \["\/api\/\*", "\/", "\/index\.html"\]/);
  assert.match(ask, /"run_worker_first": \["\/api\/\*", "\/trial", "\/trial\.html"\]/);
  for (const f of ['index.html', 'trial.html', 'ask.html', 'walkin.html', 'pass.html', 'data.html']) {
    assert.ok(!/<script[^>]*cloudflareinsights/.test(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')), f);
  }
});

test('Service Worker の写し: HTML から計測のスクリプトのタグを外して残す。HTML 以外はそのまま', async () => {
  const ctx = vm.createContext({ Response, globalThis: {} });
  ctx.globalThis = ctx;
  vm.runInContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  const { forCache } = ctx.REDUX_SW;
  const page = new Response(withBeacon(HTML), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'x' } });
  const kept = await forCache(page);
  const text = await kept.text();
  assert.ok(!text.includes('cloudflareinsights') && text.includes('</body>'));
  assert.equal(kept.headers.get('content-security-policy'), 'x');
  const js = new Response('/* <script src="https://static.cloudflareinsights.com/x"></script> */', { headers: { 'content-type': 'text/javascript' } });
  assert.equal(await forCache(js), js);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
