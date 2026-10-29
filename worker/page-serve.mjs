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
