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
  assert.equal(script, "script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/");
  assert.ok(!/sha256-|jsdelivr|three/.test(headers()), '_headers のどこにも three.js と hash は残さない');
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
