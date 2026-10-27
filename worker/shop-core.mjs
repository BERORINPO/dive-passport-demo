/* お店の振り分けの決まり（core）。外のもの（通信・D1・時計）は使わない。お店の一覧（shop-db.mjs が読む）を受け取り、
   スタッフのメール・予約フォームのサイト・届いたメールの宛先から、どのお店の名簿かを決める。
   一覧が空のあいだは、今までどおり 1 店（SHOP_DEFAULT）で動く（置いたまま足していける）。計画は plan/server.md「お店ごと」 */
import { SHOP_DEFAULT } from './sync-core.mjs';

export const SHOP_ID = /^[a-z0-9-]{1,40}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (text) => {
  try { const v = JSON.parse(text); return Array.isArray(v) ? v.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []; } catch (e) { return []; }
};

/* D1 の行を、使う形にする。形の合わない行は捨てる（壊れた行で別のお店に振り分けない） */
export function shopsFromRows(rows) {
  return (rows || []).filter(r => isObj(r) && SHOP_ID.test(String(r.id)) && typeof r.name === 'string').map(r => ({
    id: String(r.id), name: r.name.slice(0, 60),
    members: list(r.members).map(m => m.toLowerCase()), sites: list(r.sites), inbox: String(r.inbox || '').trim().toLowerCase(),
    senders: list(r.senders).map(m => m.toLowerCase())
  }));
}

/* そのお店の予約メールを送ってきてよい送り主（「,」区切りの文字。auto-core.mjs の senderAllowed に渡す）。一覧が空なら MAIL_SENDERS */
export function sendersOf(shops, shop, mailSenders) {
  if (!shops.length) return String(mailSenders || '');
  const s = shops.find(x => x.id === shop);
  return s ? s.senders.join(',') : '';
}

/* 一覧にあるお店か（一覧から消したお店の名簿は、Cron もリンクも動かさない）。一覧が空なら default だけ */
export function knownShop(shops, shop) {
  return shops.length ? shops.some(s => s.id === shop) : shop === SHOP_DEFAULT;
}

/* Access でログインしたスタッフのお店。一覧が空なら 1 店。どのお店にもいなければ ''（名簿を見せない） */
export function shopForEmail(shops, email) {
  if (!shops.length) return SHOP_DEFAULT;
  const e = String(email || '').trim().toLowerCase();
  const hit = shops.find(s => s.members.includes(e));
  return hit ? hit.id : '';
}

/* 予約フォームのサイトのお店。一覧が空なら、SITE_ORIGINS に書いたサイトだけを 1 店へ */
export function shopForOrigin(shops, origin, siteOrigins) {
  if (!origin) return '';
  if (!shops.length) return splitList(siteOrigins).includes(origin) ? SHOP_DEFAULT : '';
  const hit = shops.find(s => s.sites.includes(origin));
  return hit ? hit.id : '';
}

/* 届いたメールの宛先のお店。一覧が空なら 1 店 */
export function shopForRecipient(shops, to) {
  if (!shops.length) return SHOP_DEFAULT;
  const t = String(to || '').trim().toLowerCase();
  const hit = shops.find(s => s.inbox && s.inbox === t);
  return hit ? hit.id : '';
}

/* そのお店の予約フォームのサイト（Turnstile の hostname を確かめる先）。一覧が空なら SITE_ORIGINS */
export function sitesOf(shops, shop, siteOrigins) {
  if (!shops.length) return splitList(siteOrigins);
  const s = shops.find(x => x.id === shop);
  return s ? s.sites : [];
}

/* 一覧に名前があるお店は、名簿のお店の名前をその名前にそろえる（端末の見本の名前で上書きさせない） */
export function nameOf(shops, shop, fallback) {
  const s = shops.find(x => x.id === shop);
  return s ? s.name : fallback;
}
export const withShopName = (state, name) => (name && state.shop.name !== name ? { ...state, shop: { ...state.shop, name } } : state);

export const splitList = (text) => String(text || '').split(',').map(s => s.trim()).filter(Boolean);
