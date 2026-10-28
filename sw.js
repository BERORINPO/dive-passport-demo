/* 電波の無い所でも、お店の画面そのものを開けるようにする（Service Worker。Worker 版だけが登録する: js/app.js）。
   - 画面の部品（index.html・js・css・字・絵）は、まずネットから取り、取れたら写しを残す。取れない・3 秒待っても返事が無いときは写しを出す
   - 名簿の通信（/api/*）・Access の道（/cdn-cgi/*）・お客さんの画面（ask・pass）・別の場所（CDN）は触らない（写しを残さない）
   - Access のログインへの転送（redirect）や 200 以外の返事は写しにしない（ログイン切れの画面を、電波の無い時に出さない）
   - 置き直すたびに版（VERSION）が変わり、前の版の写しは消す。部品の一覧（SHELL）と版は tools/build-site.mjs が書き込む
   決め事は spec/architecture.md の offline-shell。試しは test/sw.test.mjs */
const VERSION = '__REDUX_SW_VERSION__';
const SHELL = ['__REDUX_SW_SHELL__'];
const CACHE = `redux-shell-${VERSION}`;
const WAIT_MS = 3000;

/* どう扱うか: 'pass'（触らない）か 'shell'（ネットを先に、だめなら写し） */
function decide(url, method, origin) {
  if (method !== 'GET') return 'pass';
  let u;
  try { u = new URL(url); } catch (e) { return 'pass'; }
  if (u.origin !== origin) return 'pass';
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/cdn-cgi/')) return 'pass';
  if (/^\/(ask|pass)(\.html)?$/.test(u.pathname)) return 'pass';
  return 'shell';
}

/* 写しにしてよい返事: 同じ場所の 200 で、転送されていない物だけ */
const keepable = (res) => !!res && res.ok && res.status === 200 && res.type === 'basic' && !res.redirected;

async function shell(request) {
  const cache = await caches.open(CACHE);
  const net = fetch(request).then(async (res) => {
    if (keepable(res)) await cache.put(request, res.clone());
    return res;
  });
  const first = await Promise.race([net.catch(() => null), new Promise(r => setTimeout(r, WAIT_MS, null))]);
  if (first) return first;
  const hit = (await cache.match(request, { ignoreSearch: true })) || (request.mode === 'navigate' ? await cache.match('/') : undefined);
  return hit || net;   // 写しが無ければ、ネットの返事を待つ（だめならブラウザの「つながらない」）
}

/* 入れるときに部品を写しておく（1 つ取れなくても、ほかは残す。ログイン切れなら何も写さず、次に開いたときにやり直す） */
async function install() {
  const cache = await caches.open(CACHE);
  await Promise.all(SHELL.map(async (path) => {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (keepable(res)) await cache.put(path, res);
    } catch (e) { /* 次に開いたときの shell() で写す */ }
  }));
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined') {
  self.addEventListener('install', (event) => { event.waitUntil(install().then(() => self.skipWaiting())); });
  self.addEventListener('activate', (event) => {
    event.waitUntil(caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('redux-shell-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
  });
  self.addEventListener('fetch', (event) => {
    if (decide(event.request.url, event.request.method, self.location.origin) === 'shell') event.respondWith(shell(event.request));
  });
}

/* 試し（test/sw.test.mjs）が読む */
if (typeof globalThis !== 'undefined') globalThis.REDUX_SW = { decide, keepable, shell, install, VERSION, SHELL, CACHE };
