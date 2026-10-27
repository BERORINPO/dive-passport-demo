// fonts/ の woff2 の SHA-256 を fonts/SHA256SUMS に書く。字体を取り直したら、これを走らせて差分を見る。
// repo が字体の出どころなので、すり替えを PR の差分と test/arch.check.mjs で見えるようにするため。
// 使い方: node tools/font-sums.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../fonts/', import.meta.url);
const files = readdirSync(dir).filter(f => f.endsWith('.woff2')).sort();
const lines = files.map(f => `${createHash('sha256').update(readFileSync(new URL(f, dir))).digest('hex')}  ${f}`);
writeFileSync(new URL('SHA256SUMS', dir), lines.join('\n') + '\n');
console.log(`${files.length} files`);
