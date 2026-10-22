// Worker に置く画面のファイル（dist/）を作る。git に入っているファイルのうち、画面に要る物だけを写し、
// Static Assets が読む _headers（CSP・キャッシュ・noindex）を書く。test/・tools/・plan/・spec/・worker/ などは置かない。
// 実行: node tools/build-site.mjs   （wrangler deploy の前に毎回。dist/ は .gitignore）
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');

/* 置いてよい物だけを並べる（足したい物は、ここに書く）。*.local.* は手元の確かめ用なので置かない */
const KEEP = [/^index\.html$/, /^pass\.html$/, /^robots\.txt$/, /^css\/[^/]+\.css$/, /^js\/[^/]+\.js$/,
  /^fonts\/[^/]+\.(woff2|css|txt)$/, /^fonts\/SHA256SUMS$/, /^assets\/[^/]+\.glb$/, /^assets\/samples\/[^/]+\.(jpg|txt)$/, /^audio\/[^/]+\.mp3$/];

export function siteFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
    .filter(f => KEEP.some(r => r.test(f)) && !/\.local\./.test(f));
}

/* importmap は HTML の中のスクリプトなので、CSP では中身の hash で許す（<script type="importmap"> と </script> の間の文字そのまま） */
export function importmapHash(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html に importmap が無い');
  return `sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}`;
}

/* CDN を残す間は、サイト名だけで許さずパスまで書く（中身は integrity で確かめる）。自前で配ったら 'self' だけにする */
const CDN = ['https://cdn.jsdelivr.net/npm/three@0.160.0/', 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/'];

export function headers(indexHtml) {
  const index = [`default-src 'none'`, `script-src 'self' '${importmapHash(indexHtml)}' ${CDN.join(' ')}`, `style-src 'self'`, `font-src 'self'`,
    `img-src 'self' blob: data:`, `connect-src 'self' blob:`, `media-src 'self'`, `worker-src 'none'`, `manifest-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* pass.html（他のお店のスマホで開くパスポート）は字体も画像も読まず、どこにもつながない */
  const pass = [`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  const block = (paths, lines) => paths.map(p => [p, ...lines.map(l => `  ${l}`)].join('\n')).join('\n');
  return [
    block(['/*'], ['X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'X-Robots-Tag: noindex, nofollow',
      'Cross-Origin-Opener-Policy: same-origin', 'Permissions-Policy: geolocation=(), microphone=(), payment=(), usb=()']),
    block(['/', '/index.html', '/index'], [`Content-Security-Policy: ${index}`, 'Cache-Control: no-cache']),
    block(['/pass.html', '/pass'], [`Content-Security-Policy: ${pass}`, 'Cache-Control: no-cache']),
    /* どの束を取ったかで画面の字が分かるので、長くためて取りに来る回数を減らす（Worker を通らないので path はログに出ない） */
    block(['/fonts/*'], ['Cache-Control: public, max-age=31536000, immutable']),
    block(['/js/*', '/css/*'], ['Cache-Control: no-cache']),
    ''
  ].join('\n');
}

/* 他のお店のスマホで開くパスポートは、GitHub Pages の公開版（Worker は Access の中なので、他のお店は開けない。spec/architecture.md の pass-place） */
export const PASS_BASE = 'https://berorinpo.github.io/dive-passport-demo/';
const REFERRER_META = '<meta name="referrer" content="no-referrer">';

function build() {
  rmSync(out, { recursive: true, force: true });
  const files = siteFiles();
  for (const f of files) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(root, f), join(out, f));
  }
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  if (!index.includes(REFERRER_META)) throw new Error('index.html に referrer の meta が無い（パスポートの置き場所の meta を足す場所）');
  writeFileSync(join(out, 'index.html'), index.replace(REFERRER_META, `${REFERRER_META}\n<meta name="redux-pass-base" content="${PASS_BASE}">`));
  writeFileSync(join(out, '_headers'), headers(index));
  console.log(`dist/: ${files.length} files + _headers`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build();
