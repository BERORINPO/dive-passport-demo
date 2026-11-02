/* 計測を国で出し分けるページを、Worker が返す（entry。Static Assets の binding ASSETS と core をつなぐだけ）。決定ログ 2026-10-29 analytics-country。
   お店の Worker は /（お客さまの画面がある index.html）、お客さんの Worker は /trial（試し版）。ほかのページは今までどおり Static Assets が直に配る。
   Worker が返す応答には _headers が付かないので、見出しは worker/page-headers.mjs から付ける */
import { analyticsOn, withBeacon } from './analytics-core.mjs';
import { COMMON, PAGE } from './page-headers.mjs';

/* 道 → { 中身を取る道, 見出しの組 } */
export const SHOP_PAGES = { '/': { asset: '/', page: 'index' }, '/index.html': { asset: '/', page: 'index' } };
export const ASK_PAGES = { '/trial': { asset: '/trial', page: 'trial' }, '/trial.html': { asset: '/trial', page: 'trial' } };

export async function servePage(request, env, spec) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const assets = env.ASSETS;   // 同じ Worker の Static Assets の binding（外へは出ない）
  if (!assets || typeof assets.fetch !== 'function') return new Response('Not found', { status: 404 }); // arch-allow: Static Assets の binding
  /* 条件付きの見出し（If-None-Match など）は渡さない。国で中身が変わるので、いつも全部を取って組み直す */
  const asset = await assets.fetch(new Request(new URL(spec.asset, request.url), { method: 'GET' })); // arch-allow: Static Assets の binding
  if (asset.status !== 200) return asset;
  const country = request.cf && request.cf.country;
  const html = await asset.text();
  const body = analyticsOn(country) ? withBeacon(html) : html;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });
  [...COMMON, ...PAGE[spec.page]].forEach(([k, v]) => headers.set(k, v));
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

/* 動画は Worker が返し、Range（一部だけ）に 206 で応える。Static Assets は Range に 200 で全体を返し、iPhone の Safari はそれを再生しない
   （2026-11-02 に ask.reduxdive.com/assets/lp/cm.mp4 で確かめた）。中身は 1 本 1.2 MB なので、全体を取って切り出す */
export const ASK_MEDIA = { '/assets/lp/cm.mp4': 'video/mp4' };

/* Range の見出し → { start, end }（end を含む）。形が違う・複数の範囲は null（全体を返す）。範囲が外なら 'bad' */
export function rangeOf(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    return n > 0 ? { start: Math.max(size - n, 0), end: size - 1 } : 'bad';
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start < size && start <= end ? { start, end } : 'bad';
}

export async function serveMedia(request, env, type) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const assets = env.ASSETS;
  if (!assets || typeof assets.fetch !== 'function') return new Response('Not found', { status: 404 }); // arch-allow: Static Assets の binding
  const asset = await assets.fetch(new Request(new URL(request.url).href, { method: 'GET' })); // arch-allow: Static Assets の binding
  if (asset.status !== 200) return asset;
  const body = new Uint8Array(await asset.arrayBuffer());
  const headers = new Headers({ 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=3600' });
  COMMON.forEach(([k, v]) => headers.set(k, v));
  const etag = asset.headers.get('etag');
  if (etag) headers.set('etag', etag);
  const range = rangeOf(request.headers.get('range'), body.length);
  if (range === 'bad') {
    headers.set('content-range', `bytes */${body.length}`);
    return new Response(null, { status: 416, headers });
  }
  const part = range ? body.subarray(range.start, range.end + 1) : body;
  headers.set('content-length', String(part.length));
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${body.length}`);
  return new Response(request.method === 'HEAD' ? null : part, { status: range ? 206 : 200, headers });
}
