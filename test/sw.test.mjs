// 電波の無い所でも画面を開く Service Worker（sw.js）と、置くときの書き込み（tools/build-site.mjs の swFor）を確かめる。
// 実行: node test/sw.test.mjs （Node 18 以上。依存なし。ブラウザの caches と fetch は見本）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { swFor } from '../tools/build-site.mjs';

const SRC = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://shop.example';

/* ブラウザの caches の見本（キーは URL の path） */
function fakeCaches() {
  const stores = new Map();
  const keyOf = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
  return {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return { async put(req, res) { m.set(keyOf(req), res); }, async match(req) { return m.get(keyOf(req)); } };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); }
  };
}
const res = (body, over = {}) => ({ ok: true, status: 200, type: 'basic', redirected: false, body, clone() { return res(body, over); }, ...over });

function load({ fetch, caches, src = SRC }) {
  const ctx = { URL, Promise, setTimeout, clearTimeout, fetch, caches, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.REDUX_SW;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('振り分け: 同じ場所の画面の部品だけを扱い、名簿の通信・Access・お客さんの画面・CDN・GET 以外は触らない', () => {
  const sw = load({ fetch: async () => res(''), caches: fakeCaches() });
  const d = (path, method = 'GET', base = ORIGIN) => sw.decide(new URL(path, base).href, method, ORIGIN);
  assert.equal(d('/'), 'shell');
  assert.equal(d('/js/app.js?v=1'), 'shell');
  assert.equal(d('/fonts/x.woff2'), 'shell');
  assert.equal(d('/api/roster'), 'pass', '名簿の通信は写さない');
  assert.equal(d('/api/roster', 'PUT'), 'pass');
  assert.equal(d('/cdn-cgi/access/login'), 'pass', 'Access の道は触らない');
  assert.equal(d('/ask'), 'pass');
  assert.equal(d('/ask.html'), 'pass');
  assert.equal(d('/pass.html'), 'pass');
  assert.equal(d('/three.module.js', 'GET', 'https://cdn.jsdelivr.net'), 'pass', '別の場所は触らない');
  assert.equal(d('/js/app.js', 'POST'), 'pass');
  assert.equal(sw.decide('not a url', 'GET', ORIGIN), 'pass');
});

test('つながっているときはネットの返事を出し、写しを残す。電波が無ければ写しを出す（画面を開くときは / の写し）', async () => {
  const caches = fakeCaches();
  let online = true;
  const fetch = async (req) => { if (!online) throw new TypeError('Load failed'); return res(`net:${new URL(req.url || req, ORIGIN).pathname}`); };
  const sw = load({ fetch, caches });
  const page = { url: `${ORIGIN}/`, mode: 'navigate' };
  assert.equal((await sw.shell(page)).body, 'net:/');
  assert.equal((await sw.shell({ url: `${ORIGIN}/js/app.js`, mode: 'no-cors' })).body, 'net:/js/app.js');
  online = false;
  assert.equal((await sw.shell(page)).body, 'net:/', '電波が無ければ前の写し');
  assert.equal((await sw.shell({ url: `${ORIGIN}/index.html`, mode: 'navigate' })).body, 'net:/', '別の住所で開いても / の写しで開く');
  assert.equal((await sw.shell({ url: `${ORIGIN}/js/app.js`, mode: 'no-cors' })).body, 'net:/js/app.js');
  await assert.rejects(sw.shell({ url: `${ORIGIN}/js/never.js`, mode: 'no-cors' }), /Load failed/, '写しも無ければ、つながらないまま');
});

test('ログインへの転送・200 以外・別の場所の返事は写さない（ログイン切れの画面を電波の無い時に出さない）', async () => {
  const caches = fakeCaches();
  let reply = res('login', { redirected: true });
  const sw = load({ fetch: async () => reply, caches });
  const page = { url: `${ORIGIN}/`, mode: 'navigate' };
  await sw.shell(page);
  reply = res('', { ok: false, status: 0, type: 'opaqueredirect' });
  await sw.shell(page);
  reply = res('err', { ok: false, status: 503 });
  await sw.shell(page);
  const store = caches.stores.get(sw.CACHE);
  assert.ok(!store || !store.has('/'), '何も写していない');
  assert.equal(sw.keepable(res('ok')), true);
});

test('入れるとき: 骨組みを写す。1 つ取れなくても、ほかは残す', async () => {
  const caches = fakeCaches();
  const src = swFor([['index.html', 'a'], ['js/app.js', 'b'], ['js/core.js', 'c'], ['css/app.css', 'd']].map(([f, b]) => [f, Buffer.from(b)]), SRC);
  const sw = load({ src, caches, fetch: async (p) => (p === '/js/app.js' ? Promise.reject(new TypeError('Load failed'))
    : p === '/css/app.css' ? res('login', { redirected: true }) : res(`net:${p}`)) });
  await sw.install();
  assert.deepEqual([...caches.stores.get(sw.CACHE).keys()].sort(), ['/', '/js/core.js'], '取れた物だけ写す（転送された物と取れなかった物は写さない）');
});

test('置くときの書き込み: / と js・css・favicon を骨組みにし、字と絵は入れない。中身が変われば版が変わる', () => {
  const files = [['index.html', 'a'], ['js/app.js', 'b'], ['css/app.css', 'c'], ['fonts/x.woff2', 'd'], ['assets/chara.png', 'e'], ['favicon.svg', 'f'], ['sw.js', SRC]];
  const out = swFor(files.map(([f, b]) => [f, Buffer.from(b)]), SRC);
  const ctx = { URL, Promise, setTimeout, console };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(out, ctx);
  assert.deepEqual([...ctx.REDUX_SW.SHELL], ['/', '/css/app.css', '/favicon.svg', '/js/app.js']);
  assert.match(ctx.REDUX_SW.VERSION, /^[0-9a-f]{16}$/);
  const other = swFor(files.map(([f, b]) => [f, Buffer.from(f === 'js/app.js' ? 'changed' : b)]), SRC);
  assert.notEqual(other.match(/const VERSION = '([0-9a-f]+)'/)[1], ctx.REDUX_SW.VERSION, '置き直すと版が変わる');
  assert.throws(() => swFor([], 'no marks'), /印が無い/);
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
process.exit(failed ? 1 : 0);
