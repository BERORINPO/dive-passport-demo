// 置く画面の組み立て（tools/build-site.mjs）を確かめる。いまは CSP と、置く物の一覧（3D の亀をやめたあとに、残り物が無いこと）。
// 実行: node test/build-site.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { headers, siteFiles } from '../tools/build-site.mjs';

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
  assert.ok(indexCsp().includes("connect-src 'self' blob: https://cloudflareinsights.com/cdn-cgi/rum;"));
  assert.ok(csp('/trial').includes("script-src 'self' https://static.cloudflareinsights.com/beacon.min.js/;"));
  assert.ok(csp('/trial').includes("connect-src 'self' https://cloudflareinsights.com/cdn-cgi/rum;"));
  for (const p of ['/ask', '/walkin', '/pass', '/data']) assert.ok(!/cloudflareinsights/.test(csp(p)), `${p} には計測を足さない`);
  const trial = readFileSync(new URL('../trial.html', import.meta.url), 'utf8');
  const tag = trial.match(/<script[^>]+cloudflareinsights[^>]*>/)[0];
  assert.match(tag, /integrity="sha512-[^"]+"/);
  assert.match(tag, /crossorigin="anonymous"/);
  assert.match(tag, /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js\/v[0-9a-f]+"/, '版を決めた URL（integrity で確かめられる）');
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
