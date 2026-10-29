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
const KEEP = [/^index\.html$/, /^sw\.js$/, /^pass\.html$/, /^ask\.html$/, /^walkin\.html$/, /^data\.html$/, /^robots\.txt$/, /^favicon\.svg$/, /^css\/[^/]+\.css$/, /^js\/[^/]+\.js$/,
  /^fonts\/[^/]+\.(woff2|css|txt)$/, /^fonts\/SHA256SUMS$/, /^assets\/[^/]+\.png$/, /^assets\/samples\/[^/]+\.(jpg|txt)$/];

export function siteFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
    .filter(f => KEEP.some(r => r.test(f)) && !/\.local\./.test(f));
}

/* CDN を残す間は、サイト名だけで許さずパスまで書く（中身は integrity で確かめる）。自前で配ったら 'self' だけにする */
const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/'];

/* 見られ方と速さの計測（Cloudflare Web Analytics。決定ログ 2026-10-29 web-analytics）。読むのは計測のスクリプトだけ、送るのは計測の受け口だけ。
   app.reduxdive.com はダッシュボードの自動の差し込み（版の付いた /beacon.min.js/v…）、試し版は版を決めて自分で置く（trial.html。integrity 付き） */
export const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com/beacon.min.js/';
export const ANALYTICS_SEND = 'https://cloudflareinsights.com/cdn-cgi/rum';

/* HTML の中に直に書くスクリプトは無いので、script-src に hash は要らない（importmap をやめた 2026-10-28） */
export function headers() {
  const index = [`default-src 'none'`, `script-src 'self' ${CDN.join(' ')} ${ANALYTICS_SCRIPT}`, `style-src 'self'`, `font-src 'self'`,
    `img-src 'self' blob: data:`, `connect-src 'self' blob: ${ANALYTICS_SEND}`, `worker-src 'self'`, `manifest-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* pass.html（他のお店のスマホで開くパスポート）は字体も画像も読まず、どこにもつながない */
  const pass = [`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* ask.html（お店が送ったリンクから開くお客さんの画面）と walkin.html（店頭の QR から開く画面）は同じ場所の /api/ask・/api/walkin だけにつなぎ、字体は読まない。
     Access の外に出す道（plan/meibo.md） */
  const ask = [`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'self'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  /* trial.html（実在のお店の試し版。決定ログ 2026-10-29 trial-shops）は ask と同じで、案内役の絵とロゴだけ同じ場所から読む。
     計測（web-analytics）のスクリプトと受け口だけを足す。ask.html・walkin.html（名前などが出る）には足さない */
  const trial = ask.replace(`img-src 'none'`, `img-src 'self'`).replace(`script-src 'self'`, `script-src 'self' ${ANALYTICS_SCRIPT}`)
    .replace(`connect-src 'self'`, `connect-src 'self' ${ANALYTICS_SEND}`);
  /* data.html（データの扱いと外部送信についての公表ページ）は CSS だけを読む */
  const data = [`default-src 'none'`, `script-src 'none'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`,
    `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`].join('; ');
  const block = (paths, lines) => paths.map(p => [p, ...lines.map(l => `  ${l}`)].join('\n')).join('\n');
  return [
    block(['/*'], ['X-Content-Type-Options: nosniff', 'Referrer-Policy: no-referrer', 'X-Robots-Tag: noindex, nofollow',
      'Cross-Origin-Opener-Policy: same-origin', 'Permissions-Policy: geolocation=(), microphone=(), payment=(), usb=()']),
    block(['/', '/index.html', '/index'], [`Content-Security-Policy: ${index}`, 'Cache-Control: no-cache']),
    block(['/pass.html', '/pass'], [`Content-Security-Policy: ${pass}`, 'Cache-Control: no-cache']),
    block(['/ask.html', '/ask', '/walkin.html', '/walkin'], [`Content-Security-Policy: ${ask}`, 'Cache-Control: no-store']),
    block(['/trial.html', '/trial'], [`Content-Security-Policy: ${trial}`, 'Cache-Control: no-store']),
    block(['/data.html', '/data'], [`Content-Security-Policy: ${data}`, 'Cache-Control: no-cache']),
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
/* 予約の受け口 API の説明書（docs/api.md）。鍵の画面（js/api-keys-staff.js）のリンクの先。js には外の URL を書けないので、meta で渡す */
export const API_DOCS_URL = 'https://github.com/BERORINPO/dive-passport-demo/blob/main/docs/api.md';
const REFERRER_META = '<meta name="referrer" content="no-referrer">';

/* Worker 版の index.html。redux-worker の印（画面はこの印があるときだけ /api/healthz を確かめ、名簿をサーバーとそろえる。js/app.js）を足し、
   見本の画面だけに要る物（見本の帯と、題の「（見本）」）を外す。本物の画面に「見本」と出ないようにする（js/demo-band.js も同じことを確かめ直す） */
export function workerIndex(index) {
  if (!index.includes(REFERRER_META)) throw new Error('index.html に referrer の meta が無い（パスポートの置き場所の meta を足す場所）');
  const band = /<!-- 見本の帯[^\n]*-->\r?\n<p class="demo-band"[^\n]*<\/p>\r?\n/;
  if (!band.test(index) || !index.includes('（見本）</title>')) throw new Error('index.html に見本の帯か題の印が無い（Worker 版から外す物の形が変わった）');
  return index.replace(band, '').replace('（見本）</title>', '</title>').replace(REFERRER_META,
    `${REFERRER_META}\n<meta name="redux-pass-base" content="${PASS_BASE}">\n<meta name="redux-api-docs" content="${API_DOCS_URL}">\n<meta name="redux-worker" content="1">`);
}

function build() {
  rmSync(out, { recursive: true, force: true });
  const files = siteFiles();
  for (const f of files) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(root, f), join(out, f));
  }
  writeFileSync(join(out, 'index.html'), workerIndex(readFileSync(join(root, 'index.html'), 'utf8')));
  writeFileSync(join(out, '_headers'), headers());
  writeFileSync(join(out, 'sw.js'), swFor(files.map(f => [f, readFileSync(join(out, f))])));
  console.log(`dist/: ${files.length} files + _headers`);
}

/* sw.js に、最初に写しておく画面の骨組み（SHELL）と版（VERSION）を書き込む。版は置く物の中身の hash（置き直すと変わり、前の写しが消える）。
   字（fonts）と絵（assets）は最初には取らず、使ったときに写す（sw.js の shell） */
const SHELL_FILES = /^(js\/[^/]+\.js|css\/[^/]+\.css|favicon\.svg)$/;
export function swFor(entries, template = readFileSync(join(root, 'sw.js'), 'utf8')) {
  const hash = createHash('sha256');
  for (const [f, body] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1))) hash.update(f).update(body);
  const shell = ['/', ...entries.map(([f]) => f).filter(f => SHELL_FILES.test(f)).sort().map(f => `/${f}`)];
  const version = hash.digest('hex').slice(0, 16);
  if (!template.includes("'__REDUX_SW_SHELL__'") || !template.includes('__REDUX_SW_VERSION__')) throw new Error('sw.js に書き込む印が無い');
  return template.replace("'__REDUX_SW_SHELL__'", shell.map(p => `'${p}'`).join(', ')).replace('__REDUX_SW_VERSION__', version);
}

/* お客さん用の Worker に置くページ: お店が送ったリンクの ask.html と、店頭の QR の walkin.html と、実在のお店の試し版の trial.html */
export const ASK_PAGES = ['ask.html', 'walkin.html', 'trial.html', 'data.html'];
/* trial.html が読む絵（案内役と、css/app.css の --logo-mark のロゴ） */
export const ASK_ASSETS = ['assets/chara.png', 'assets/logo-mark.png', 'assets/logo-mark-light.png'];

/* ASK_PAGES が読む js と css（script の src と stylesheet の href）。これ以外はお客さん用の Worker に置かない */
export function askFiles(htmls = ASK_PAGES.map(p => [p, readFileSync(join(root, p), 'utf8')])) {
  const refs = [];
  for (const [page, html] of htmls) {
    const found = [...html.matchAll(/<script src="([^"]+)"><\/script>|<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1] || m[2]);
    if (!found.every(f => /^(js|css)\/[\w.-]+\.(js|css)$/.test(f))) throw new Error(`${page} が js/ と css/ のほかを読んでいる`);
    refs.push(...found);
  }
  return [...htmls.map(([page]) => page), ...new Set(refs)];
}

export function askHeaders() {
  const all = headers().split('\n');
  /* 共通（/*）と、ask.html・/ask の CSP、js と css のキャッシュだけを、同じ書き方で写す */
  const keep = new Set(['/*', '/ask.html', '/ask', '/walkin.html', '/walkin', '/trial.html', '/trial', '/js/*', '/css/*']);
  const out = [];
  let on = false;
  for (const line of all) {
    if (/^\S/.test(line)) on = keep.has(line.trim());
    if (on && line) out.push(line);
  }
  return `${out.join('\n')}\n`;
}

function buildAsk() {
  rmSync(outAsk, { recursive: true, force: true });
  const files = [...askFiles(), ...ASK_ASSETS];
  for (const f of files) {
    mkdirSync(dirname(join(outAsk, f)), { recursive: true });
    cpSync(join(root, f), join(outAsk, f));
  }
  writeFileSync(join(outAsk, '_headers'), askHeaders());
  console.log(`dist-ask/: ${files.length} files + _headers`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  build();
  buildAsk();
}
