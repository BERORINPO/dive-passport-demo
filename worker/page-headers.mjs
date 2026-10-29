/* 画面のページに付ける応答の見出し（CSP など）と、見られ方の計測のスクリプトの決め事（shared。何も読まない）。
   静的な配信の _headers（tools/build-site.mjs）と、Worker が出し分けて返すページ（worker/page-serve.mjs）の両方がここを使う。
   Worker が返した応答には _headers が付かないため、1 か所に置いて食い違わないようにする（決定ログ 2026-10-29 analytics-country） */

/* CDN を残す間は、サイト名だけで許さずパスまで書く（中身は integrity で確かめる）。自前で配ったら 'self' だけにする */
export const CDN = ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/'];

/* 見られ方と速さの計測（Cloudflare Web Analytics）。読むのは版を決めたスクリプト 1 つ、送るのは計測の受け口だけ。
   版の付いた URL の中身を integrity で確かめる（版を上げるときは、中身を取って sha512 を計り直す） */
export const ANALYTICS_SCRIPT = 'https://static.cloudflareinsights.com/beacon.min.js/';
export const ANALYTICS_SEND = 'https://cloudflareinsights.com/cdn-cgi/rum';
export const BEACON = {
  src: 'https://static.cloudflareinsights.com/beacon.min.js/vce701823e78c4301a35b7e07294d87301792088814092',
  integrity: 'sha512-UKNk8GbxkABxKcXYuLkO16EleLGUkcvJWtpSNmExE0Too3ZaFAxTscNWEc1OdAv5/BikHawapSCaiD2XCmp+Bw==',
  token: 'd5a7a1a0b5134ee296b105a84f22d926'   // 計測の site の token（ページに書く物で、鍵ではない）
};

const join = (list) => list.join('; ');
const TAIL = [`base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`, `object-src 'none'`];
/* HTML の中に直に書くスクリプトは無いので、script-src に hash は要らない（importmap をやめた 2026-10-28） */
const index = join([`default-src 'none'`, `script-src 'self' ${CDN.join(' ')} ${ANALYTICS_SCRIPT}`, `style-src 'self'`, `font-src 'self'`,
  `img-src 'self' blob: data:`, `connect-src 'self' blob: ${ANALYTICS_SEND}`, `worker-src 'self'`, `manifest-src 'none'`, ...TAIL]);
/* pass.html（他のお店のスマホで開くパスポート）は字体も画像も読まず、どこにもつながない */
const pass = join([`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`, ...TAIL]);
/* ask.html（お店が送ったリンクから開くお客さんの画面）と walkin.html（店頭の QR から開く画面）は同じ場所の /api/ask・/api/walkin だけにつなぎ、字体は読まない。
   名前などが出るページなので、計測は置かない */
const ask = join([`default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'self'`, ...TAIL]);
/* trial.html（実在のお店の試し版。決定ログ 2026-10-29 trial-shops）は ask と同じで、案内役の絵とロゴだけ同じ場所から読む。計測のスクリプトと受け口だけを足す */
const trial = ask.replace(`img-src 'none'`, `img-src 'self'`).replace(`script-src 'self'`, `script-src 'self' ${ANALYTICS_SCRIPT}`)
  .replace(`connect-src 'self'`, `connect-src 'self' ${ANALYTICS_SEND}`);
/* data.html（データの扱いと外部送信についての公表ページ）は CSS だけを読む */
const data = join([`default-src 'none'`, `script-src 'none'`, `style-src 'self'`, `img-src 'none'`, `connect-src 'none'`, ...TAIL]);

export const CSP = { index, pass, ask, trial, data };

/* どのページにも付ける見出し */
export const COMMON = [['X-Content-Type-Options', 'nosniff'], ['Referrer-Policy', 'no-referrer'], ['X-Robots-Tag', 'noindex, nofollow'],
  ['Cross-Origin-Opener-Policy', 'same-origin'], ['Permissions-Policy', 'geolocation=(), microphone=(), payment=(), usb=()']];

/* ページごとの見出し（共通の物のあとに付ける） */
export const PAGE = {
  index: [['Content-Security-Policy', index], ['Cache-Control', 'no-cache']],
  pass: [['Content-Security-Policy', pass], ['Cache-Control', 'no-cache']],
  ask: [['Content-Security-Policy', ask], ['Cache-Control', 'no-store']],
  trial: [['Content-Security-Policy', trial], ['Cache-Control', 'no-store']],
  data: [['Content-Security-Policy', data], ['Cache-Control', 'no-cache']]
};
