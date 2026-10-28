/* redux-ask（Access なし）がお店の Worker を呼ぶ 4 つの口（entry。お店の Worker 側）。D1・名簿・お店の一覧に触れるのはここから先だけで、
   redux-ask は D1 の binding を持たない（SEC-13。2026-10-28 ask-service-binding）。
   - askView(hash)                       お客さんのリンクを開く。鍵の SHA-256 から、名前と聞く項目の名前だけを返す
   - askApply(hash, req, origin)         リンクから答える・1 人ずつのリンクを作る（req は鍵を除いた本文）
   - siteHosts(origin)                   予約フォームのサイト（origin）が、どれかのお店の物か。Turnstile の確かめに使うホスト名を返す
   - siteBooking(origin, given)          サイトの予約を、その origin のお店の名簿に入れる（Turnstile と回数は redux-ask が先にかける）
   どの口も { status, body, note } を返す（siteHosts は { ok, hosts, note } か { ok: false, status, body, note }）。note はログに足す短い理由で、
   中身・名前・メールアドレスは入れない。呼び手が送ってくる値も信じない: 形を確かめ直し（ask-input.mjs）、お店は origin と鍵の行から自分で決める。
   Cloudflare の口は shop-rpc.mjs（WorkerEntrypoint）。ここは素のクラスで、テストは直に呼ぶ（外との境目の見本は fakes.mjs の fakeShopBinding） */
import { askView, askApply } from './ask-route.mjs';
import { takeSiteBooking } from './auto.mjs';
import { HASH_RE, checkApply } from './ask-input.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';
import { shopForOrigin, sitesOf, nameOf } from './shop-core.mjs';

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]{1,120}(?::\d{1,5})?$/;

const dbReady = (env) => Boolean(env.DB && typeof env.DB.prepare === 'function');
const refuse = (status, error, why) => ({ status, body: { error }, note: { why } });
const hostOf = (site) => { try { return new URL(site).hostname.toLowerCase(); } catch (e) { return ''; } };

/* 一覧が使えない・サイトがどのお店の物でもない、のとき { res }（siteHosts は { ok: false, ...res }）。使えるとき { shops, shop } */
async function shopOfOrigin(env, origin) {
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) return { res: refuse(403, 'origin', 'origin') };
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { const why = shopsWhy(e, 'db'); return { res: refuse(503, why === 'db' ? 'db' : 'shops', why) }; }
  const shop = shopForOrigin(shops, origin);
  return shop ? { shops, shop } : { res: refuse(403, 'origin', 'origin') };
}

export class ShopService {
  constructor(env, io) {
    this.env = env;
    this.io = io;
  }

  async askView(hash) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const note = {};
    return { ...(await askView(this.env, this.io, note, hash)), note };
  }

  async askApply(hash, req, origin) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const checked = checkApply(req);
    if (!checked.ok) return refuse(400, 'input', `input-${checked.error}`);
    if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) return refuse(400, 'input', 'input-origin');
    const note = {};
    return { ...(await askApply(this.env, this.io, note, hash, checked, origin)), note };
  }

  async siteHosts(origin) {
    if (!dbReady(this.env)) return { ok: false, ...refuse(503, 'config', 'config:DB') };
    const got = await shopOfOrigin(this.env, origin);
    if (got.res) return { ok: false, ...got.res };
    return { ok: true, hosts: sitesOf(got.shops, got.shop).map(hostOf).filter(Boolean), note: { shop: got.shop } };
  }

  async siteBooking(origin, given) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    const got = await shopOfOrigin(this.env, origin);
    if (got.res) return got.res;
    const note = { shop: got.shop };
    return { ...(await takeSiteBooking(given, this.env, this.io, note, got.shop, nameOf(got.shops, got.shop, ''))), note };
  }
}
