// 置く画面の組み立て（tools/build-site.mjs）を確かめる。いまは CSP と、置く物の一覧（3D の亀をやめたあとに、残り物が無いこと）。
// 実行: node test/build-site.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headers, siteFiles, askHeaders, askFiles, askLpFiles } from '../tools/build-site.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const indexCsp = () => headers().match(/^\/index\.html\n(?:  .*\n)*?  Content-Security-Policy: (.*)$/m)[1];

test('お店の画面の CSP: script は同じ場所と qrcode-generator だけ。importmap の hash も three.js の CDN も無い', () => {
  const script = indexCsp().split('; ').find(d => d.startsWith('script-src '));
  assert.equal(script, "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/ https://static.cloudflareinsights.com/beacon.min.js/",
    '計測のスクリプト（ダッシュボードの自動の差し込み、版の付いたパス）だけを足す（決定ログ 2026-10-29 web-analytics）');
  assert.ok(!/sha256-|jsdelivr|three/.test(headers()), '_headers のどこにも three.js と hash は残さない');
});

test('計測（Cloudflare Web Analytics）: 送り先は受け口 1 つだけ。お店の画面と試し版だけで、お客さんのリンク・店頭の受付・パスポート・公表ページには足さない', () => {
  const h = headers();
  const lines = h.split(/\r?\n/);
  const csp = (path) => lines.slice(lines.indexOf(path) + 1).find(l => l.includes('Content-Security-Policy'));
  assert.ok(indexCsp().includes("connect-src 'self' blob:;"), '計測は同じホストの /cdn-cgi/rum に送るので、外の送り先は足さない');
  assert.ok(csp('/trial').includes("script-src 'self' https://static.cloudflareinsights.com/beacon.min.js/;"));
  assert.ok(csp('/trial').includes("connect-src 'self';"));
  const ask = askHeaders().split(/\r?\n/);
  const dataAt = ask.indexOf('/data');
  assert.ok(dataAt > 0 && ask[dataAt + 2] === '  Cache-Control: no-cache, no-transform', 'ask の公表ページにも見出し（CSP・no-transform）を付ける');
  for (const p of ['/ask', '/walkin', '/pass', '/data']) assert.ok(!/cloudflareinsights/.test(csp(p)), `${p} には計測を足さない`);
  /* 計測のスクリプトのタグは HTML に書かず、Worker が国で出し分けて足す（test/analytics.test.mjs。決定ログ 2026-10-29 analytics-country） */
  for (const f of ['ask.html', 'walkin.html', 'pass.html', 'data.html', 'index.html']) {
    assert.ok(!readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').includes('cloudflareinsights'), `${f} に計測のスクリプトを書かない`);
  }
});

test('公表ページ（data.html）: 置く物に入り、お客さまの画面と試し版の一番下からたどれる。スクリプトを読まない', () => {
  assert.ok(siteFiles().includes('data.html'));
  for (const f of ['index.html', 'trial.html']) assert.match(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'), /<footer[^>]*>\s*<a[^>]+href="data\.html"/);
  const page = readFileSync(new URL('../data.html', import.meta.url), 'utf8');
  assert.ok(!/<script/.test(page) && page.includes("script-src 'none'"));
  for (const words of ['Cloudflare, Inc.', 'Anthropic, PBC', 'cookie', '送る先', '目的', 'Sent to', 'Why']) assert.ok(page.includes(words), words);
});

test('お店向けの試用の案内（shops.html）: お客さん用の Worker に置き、スクリプトも入力欄も無い。申し込み先は trial@ だけ。約束の文がある', () => {
  assert.ok(siteFiles().includes('shops.html'));
  assert.ok(askFiles().includes('shops.html'));
  const lp = askLpFiles();
  for (const f of ['assets/lp/roster.webp', 'assets/lp/cm.mp4', 'assets/lp/cm-poster.jpg', 'assets/lp/form-1.webp', 'assets/lp/form-2.webp', 'assets/lp/form-4.webp']) assert.ok(lp.includes(f), f);
  assert.ok(lp.some(f => /^fonts\/.+\.woff2$/.test(f)), '字体も置く');
  const ask = askHeaders().split(/\r?\n/);
  const at = ask.indexOf('/shops');
  assert.ok(at > 0 && ask[at + 1].includes("script-src 'none'") && ask[at + 1].includes("media-src 'self'") && ask[at + 2] === '  Cache-Control: no-cache, no-transform');
  assert.ok(ask.includes('/fonts/*'), 'ask にも字体の見出しを付ける');
  const page = readFileSync(new URL('../shops.html', import.meta.url), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/<script|<form|<input|<textarea/.test(page), 'ここでは何も集めない');
  assert.deepEqual([...new Set([...page.matchAll(/[\w.+-]+@[\w.-]+/g)].map(m => m[0]))], ['trial@reduxdive.com'], '書くアドレスは申し込み先だけ');
  for (const words of ['先着 <b>3</b> 店', 'AI には送りません', '<span class="lp-fig">30</span> 日以内', '控えも含めて消します', 'Anthropic', 'href="data.html"']) assert.ok(page.includes(words), words);
  for (const m of page.matchAll(/<img [^>]*>/g)) assert.match(m[0], /width="\d+" height="\d+"/, '絵は幅と高さを書く（読み込みで画面がずれない）');
  /* 申し込みのボタンは 3 つ。どれも本文にひな形（お店の名前・予約メールのアドレス）を入れ、件名で押した所が分かる（決定ログ 2026-11-01 shop-lp-look） */
  const mails = [...page.matchAll(/href="mailto:([^"]+)"/g)].map(m => new URL('mailto:' + m[1].replace(/&amp;/g, '&')));
  assert.equal(mails.length, 3);
  for (const u of mails) assert.ok(u.searchParams.get('body').includes('お店の名前') && u.searchParams.get('body').includes('予約メールが届くアドレス'), u.href);
  assert.equal(new Set(mails.map(u => u.searchParams.get('subject'))).size, 3, '件名は押した所ごとに違う');
  assert.ok(page.includes('<span class="lp-addr">trial@reduxdive.com</span>'), 'メールの道具が開かない人のために、宛先を字でも出す');
});
test('お店の画面の CSP: 音（media-src）は要らない（声をやめた）。画像は同じ場所と blob・data だけ', () => {
  const csp = indexCsp();
  assert.ok(!csp.includes('media-src'));
  assert.ok(csp.includes("img-src 'self' blob: data:"));
});

test('index.html: importmap も module の script も置かない（外から読むスクリプトは qrcode-generator だけ）', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!/importmap|type="module"/.test(html));
  assert.deepEqual([...html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)].map(m => m[1]),
    ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js']);
});

test('置く物: 案内役の絵は置き、3D の亀（glb）と声（mp3）は置かない', () => {
  const files = siteFiles();
  assert.ok(files.includes('assets/chara.png'));
  assert.deepEqual(files.filter(f => /\.(glb|mp3)$/.test(f) || /turtle/.test(f)), []);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
