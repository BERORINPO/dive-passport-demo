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
/* お客さんのリンクだけの Worker（wrangler.ask.jsonc）に置く物。ask.html と、ask.html が読むファイルだけ（お店の画面は置かない） */
const outAsk = join(root, 'dist-ask');

/* 置いてよい物だけを並べる（足したい物は、ここに書く）。*.local.* は手元の確かめ用なので置かない */
const KEEP = [/^index\.html$/, /^sw\.js$/, /^pass\.html$/, /^ask\.html$/, /^robots\.txt$/, /^favicon\.svg$/, /^css\/[^/]+\.css$/, /^js\/[^/]+\.js$/,
  /^fonts\/[^/]+\.(woff2|css|txt)$/, /^fonts\/SHA256SUMS$/, /^assets\/[^/]+\.glb$/, /^assets\/samples\/[^/]+\.(jpg|txt)$/, /^audio\/[^/]+\.mp3$/];

export function siteFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
    .filter(f => KEEP.some(r => r.test(f)) && !/\.local\./.test(f));
}

/* importmap は HTML の中のスクリプトなので、CSP では中身の hash で許す（<script type="importmap"> と </script> の間の文字）。
   ブラウザは HTML を読む前に改行を LF にそろえる（CRLF と CR は LF になる）ので、hash も LF にそろえてから取る。
   Windows で取り出した repo（core.autocrlf）は CRLF なので、そろえないと CSP が importmap を止め、three.js（3D の亀）が動かない（2026-10-28） */
export function importmapHash(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html に importmap が無い');
  return `sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}`;
}

/* CDN を残す間は、サイト名だけで許さずパスまで書く（中身は integrity で確かめる）。自前で配ったら 'self' だけにする */
const CDN = ['https://cdn.jsdelivr.net/npm/three@0.160.0/', 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/'];

export function headers(indexHtml) {
  const index = [`default-src 'none'`, `script-src 'self' '${importmapHash(indexHtml)}' ${CDN.join(' ')}`, `style-src 'self'`, `font-src 'self'`,
    `img-src 'self' blob: data:`, `connect-src 'self' blob:`, `media-src 'self'`, `worker-src 'self'`, `manifest-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* pass.html（他のお店のスマホで開くパスポート）は字体も画像も読まず、どこにもつながない */
  const pass = [`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* ask.html（お店が送ったリンクから開くお客さんの画面）は同じ場所の /api/ask だけにつなぎ、字体は読まない。Access の外に出す道（plan/meibo.md） */
  const ask = [`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'self'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  const block = (paths, lines) => paths.map(p => [p, ...lines.map(l => `  ${l}`)].join('\n')).join('\n');
  return [
    block(['/*'], ['X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'X-Robots-Tag: noindex, nofollow',
      'Cross-Origin-Opener-Policy: same-origin', 'Permissions-Policy: geolocation=(), microphone=(), payment=(), usb=()']),
    block(['/', '/index.html', '/index'], [`Content-Security-Policy: ${index}`, 'Cache-Control: no-cache']),
    block(['/pass.html', '/pass'], [`Content-Security-Policy: ${pass}`, 'Cache-Control: no-cache']),
    block(['/ask.html', '/ask'], [`Content-Security-Policy: ${ask}`, 'Cache-Control: no-store']),
    /* どの束を取ったかで画面の字が分かるので、長くためて取りに来る回数を減らす（Worker を通らないので path はログに出ない） */
    block(['/fonts/*'], ['Cache-Control: public, max-age=31536000, immutable']),
    block(['/js/*', '/css/*'], ['Cache-Control: no-cache']),
    /* 電波の無い所でも画面を開くための Service Worker（sw.js）。中から読むのは同じ場所だけ。毎回確かめて、新しい版をすぐ入れる */
    block(['/sw.js'], [`Content-Security-Policy: default-src 'none'; connect-src 'self'`, 'Cache-Control: no-cache']),
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
  /* redux-worker: 画面はこの印があるときだけ /api/healthz を確かめる（js/app.js） */
  writeFileSync(join(out, 'index.html'), index.replace(REFERRER_META,
    `${REFERRER_META}\n<meta name="redux-pass-base" content="${PASS_BASE}">\n<meta name="redux-worker" content="1">`));
  writeFileSync(join(out, '_headers'), headers(index));
  writeFileSync(join(out, 'sw.js'), swFor(files.map(f => [f, readFileSync(join(out, f))])));
  console.log(`dist/: ${files.length} files + _headers`);
}

/* sw.js に、最初に写しておく画面の骨組み（SHELL）と版（VERSION）を書き込む。版は置く物の中身の hash（置き直すと変わり、前の写しが消える）。
   字（fonts）と亀（assets）は重いので最初には取らず、使ったときに写す（sw.js の shell） */
const SHELL_FILES = /^(js\/[^/]+\.js|css\/[^/]+\.css|favicon\.svg)$/;
export function swFor(entries, template = readFileSync(join(root, 'sw.js'), 'utf8')) {
  const hash = createHash('sha256');
  for (const [f, body] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) hash.update(f).update(body);
  const shell = ['/', ...entries.map(([f]) => f).filter(f => SHELL_FILES.test(f)).sort().map(f => `/${f}`)];
  const version = hash.digest('hex').slice(0, 16);
  if (!template.includes("'__REDUX_SW_SHELL__'") || !template.includes('__REDUX_SW_VERSION__')) throw new Error('sw.js に書き込む印が無い');
  return template.replace("'__REDUX_SW_SHELL__'", shell.map(p => `'${p}'`).join(', ')).replace('__REDUX_SW_VERSION__', version);
}

/* ask.html が読む js と css（script の src と stylesheet の href）。これ以外はお客さん用の Worker に置かない */
export function askFiles(html = readFileSync(join(root, 'ask.html'), 'utf8')) {
  const refs = [...html.matchAll(/<script src="([^"]+)"><\/script>|<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1] || m[2]);
  if (!refs.every(f => /^(js|css)\/[\w.-]+\.(js|css)$/.test(f))) throw new Error('ask.html が js/ と css/ のほかを読んでいる');
  return ['ask.html', ...refs];
}

export function askHeaders(indexHtml) {
  const all = headers(indexHtml).split('\n');
  /* 共通（/*）と、ask.html・/ask の CSP、js と css のキャッシュだけを、同じ書き方で写す */
  const keep = new Set(['/*', '/ask.html', '/ask', '/js/*', '/css/*']);
  const out = [];
  let on = false;
  for (const line of all) {
    if (/^\S/.test(line)) on = keep.has(line.trim());
    if (on && line) out.push(line);
  }
  return `${out.join('\n')}\n`;
}

function buildAsk(index) {
  rmSync(outAsk, { recursive: true, force: true });
  const files = askFiles();
  for (const f of files) {
    mkdirSync(dirname(join(outAsk, f)), { recursive: true });
    cpSync(join(root, f), join(outAsk, f));
  }
  writeFileSync(join(outAsk, '_headers'), askHeaders(index));
  console.log(`dist-ask/: ${files.length} files + _headers`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build();
  buildAsk(readFileSync(join(root, 'index.html'), 'utf8'));
}
