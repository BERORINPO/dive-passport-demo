// Google Fonts の CSS に並んだ woff2 を全部取り、名前を付け直して置く。あわせて自前の @font-face を書く。
// 使い方: node get-fonts.mjs <google.css> <取ったファイルを置く所> <書く fonts.css>
// google.css は、woff2 を返させるため新しい Chrome の User-Agent を付けて取る（fonts/README.md）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [cssPath, outDir, outCss] = process.argv.slice(2);
const css = readFileSync(cssPath, 'utf8');
/* 番号の付いた束は URL の .N.woff2、名前の付いた束（latin など）は前のコメントで名前を付ける */
const faces = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([\s\S]*?)\}/g)].map(m => {
  const body = m[2];
  const label = m[1];
  const get = (k) => (body.match(new RegExp(`${k}:\\s*([^;]+);`)) || [])[1];
  const url = (body.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/) || [])[1];
  const index = (url && url.match(/\.(\d+)\.woff2$/)) ? url.match(/\.(\d+)\.woff2$/)[1] : label;
  return { family: (get('font-family') || '').replace(/'/g, ''), weight: get('font-weight'), range: get('unicode-range'), url, index };
});
if (faces.some(f => !f.url || !f.range || !f.family || !f.weight || !f.index)) throw new Error('読めない @font-face がある');

mkdirSync(outDir, { recursive: true });
const slug = (f) => f.family.toLowerCase().replace(/[^a-z]/g, '');
const named = faces.map(f => ({ ...f, file: `${slug(f)}-${f.weight}-${f.index}.woff2` }));
if (new Set(named.map(f => f.file)).size !== named.length) throw new Error('名前が重なる');

let total = 0;
const queue = [...named];
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const res = await fetch(f.url);
    if (!res.ok) throw new Error(`${res.status} ${f.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`woff2 ではない: ${f.url}`);
    writeFileSync(join(outDir, f.file), buf);
    total += buf.length;
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

const out = named.map(f => `@font-face { font-family: '${f.family}'; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(../fonts/${f.file}) format('woff2'); unicode-range: ${f.range}; }`);
writeFileSync(outCss, out.join('\n') + '\n');
console.log(`files ${named.length} / bytes ${total} (${(total / 1048576).toFixed(2)} MB)`);
