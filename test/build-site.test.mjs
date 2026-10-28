// 置く画面の組み立て（tools/build-site.mjs）を確かめる。いまは CSP の importmap の hash だけ。
// 実行: node test/build-site.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { importmapHash, headers } from '../tools/build-site.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const sha = (text) => `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;

test('importmap の hash は、ブラウザと同じく改行を LF にそろえてから取る（Windows の CRLF でも CSP が止めない）', () => {
  const body = '\n{ "imports": {\n  "three": "x"\n} }\n';
  const lf = `<p></p><script type="importmap">${body}</script>`;
  assert.equal(importmapHash(lf), sha(body));
  assert.equal(importmapHash(lf.replace(/\n/g, '\r\n')), sha(body), 'CRLF の repo でも同じ hash');
  assert.equal(importmapHash(lf.replace(/\n/g, '\r')), sha(body), 'CR だけの改行も LF として数える');
});

test('本物の index.html: 取り出した改行の形にかかわらず、_headers の hash は LF の中身の hash', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const body = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
  assert.ok(headers(html).includes(`'${sha(body)}'`));
  assert.ok(headers(html.replace(/\r?\n/g, '\r\n')).includes(`'${sha(body)}'`), 'CRLF に変えても同じ');
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
