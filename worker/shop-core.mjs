/* お店の振り分けの決まり（core）。外のもの（通信・D1・時計）は使わない。お店の一覧（shop-db.mjs が読む）を受け取り、
   スタッフのメール・予約フォームのサイト・届いたメールの宛先から、どのお店の名簿かを決める。
   一覧が空のまま 1 店で動くのは、env の SINGLE_SHOP でお店の id を明示したときだけ（shop-db.mjs が singleShop で 1 店の行を作る）。
   明示が無いのに一覧が空・表が無いときは、どのお店にも振り分けない（開いた側に倒さない。2026-10-28 shops-fail-closed）。計画は plan/server.md「お店ごと」 */

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

/* 一覧の食い違い。2 店が同じ受け口・メール・サイトを持つと、先に見つかった店に振り分けてしまう（別のお店の名簿に入る）ので、
   shop-db.mjs は形の合わない行と同じく例外にする。返すのは短い理由（'inbox' | 'member' | 'site'）で、無ければ ''（中身は返さない） */
const overlaps = (shops, pick) => {
  const seen = new Set();
  for (const s of shops) {
    for (const v of new Set(pick(s))) {
      if (seen.has(v)) return true;
      seen.add(v);
    }
  }
  return false;
};
export function shopsProblem(shops) {
  if (overlaps(shops, s => (s.inbox ? [s.inbox] : []))) return 'inbox';
  if (overlaps(shops, s => s.members)) return 'member';
  if (overlaps(shops, s => s.sites)) return 'site';
  return '';
}

/* env の SINGLE_SHOP で明示した 1 店（一覧が空のときだけ使う）。誰がログインしても・どの宛先でも、この 1 店（スタッフの許可は今までどおり ALLOWED_EMAILS）。
   予約フォームのサイトと送り主は env の SITE_ORIGINS・MAIL_SENDERS。id の形が合わなければ null（= 明示が無いのと同じ） */
export function singleShop(id, { siteOrigins = '', mailSenders = '' } = {}) {
  const shopId = String(id || '').trim();
  if (!SHOP_ID.test(shopId)) return null;
  return { id: shopId, name: '', members: [], sites: splitList(siteOrigins), inbox: '', senders: splitList(mailSenders), single: true };
}

/* そのお店の予約メールを送ってきてよい送り主（「,」区切りの文字。auto-core.mjs の senderAllowed に渡す） */
export function sendersOf(shops, shop) {
  const s = shops.find(x => x.id === shop);
  return s ? s.senders.join(',') : '';
}

/* 一覧にあるお店か（一覧から消したお店の名簿は、Cron もリンクも動かさない） */
export function knownShop(shops, shop) {
  return shops.some(s => s.id === shop);
}

/* Access でログインしたスタッフのお店。どのお店にもいなければ ''（名簿を見せない）。1 店の動き（single）では、ログインできた人は全員その店 */
export function shopForEmail(shops, email) {
  const e = String(email || '').trim().toLowerCase();
  const hit = shops.find(s => s.single || s.members.includes(e));
  return hit ? hit.id : '';
}

/* 予約フォームのサイトのお店 */
export function shopForOrigin(shops, origin) {
  if (!origin) return '';
  const hit = shops.find(s => s.sites.includes(origin));
  return hit ? hit.id : '';
}

/* 届いたメールの宛先のお店。1 店の動き（single）では、どの宛先もその店 */
export function shopForRecipient(shops, to) {
  const t = String(to || '').trim().toLowerCase();
  const hit = shops.find(s => s.single || (s.inbox && s.inbox === t));
  return hit ? hit.id : '';
}

/* そのお店の予約フォームのサイト（Turnstile の hostname を確かめる先） */
export function sitesOf(shops, shop) {
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
