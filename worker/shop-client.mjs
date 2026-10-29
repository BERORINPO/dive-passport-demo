/* redux-ask からお店の Worker を呼ぶ口（adapter）。相手は Service Binding の SHOP（お店の Worker の ShopRpc。口は shop-service.mjs の 9 つだけ）。
   向こうから返った値も信用しない: 形が合わない答えは例外にする（呼んだ側は 500 にして、ログに crash と残す）。見本は worker/fakes.mjs の fakeShopBinding。
   D1・名簿・お店の一覧には触れない（それはお店の Worker の中だけ。SEC-13） */

export const SHOP_METHODS = ['askView', 'askApply', 'siteHosts', 'siteBooking', 'walkinView', 'walkinSubmit', 'intakeBooking', 'trialView', 'trialAsk'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStatus = (v) => Number.isInteger(v) && v >= 100 && v <= 599;

/* ログに足す note は、決まった名前の短い文字か数だけ通す（ログの道・状態・時間を、向こうの答えで書き換えさせない） */
const NOTE_KEYS = ['why', 'shop', 'problems', 'added'];
function cleanNote(note) {
  const out = {};
  for (const k of NOTE_KEYS) {
    if (typeof note[k] === 'string') out[k] = note[k].slice(0, 60);
    else if (Number.isFinite(note[k])) out[k] = note[k];
  }
  return out;
}

/* { status, body, note } */
function plain(got) {
  if (!isObj(got) || !isStatus(got.status) || !isObj(got.body) || !isObj(got.note)) throw new Error('shop-reply');
  return { status: got.status, body: got.body, note: cleanNote(got.note) };
}

/* { ok: true, hosts, note } か { ok: false, status, body, note } */
function hosts(got) {
  if (!isObj(got) || !isObj(got.note)) throw new Error('shop-reply');
  if (got.ok === true && Array.isArray(got.hosts) && got.hosts.every(h => typeof h === 'string')) return { ok: true, hosts: got.hosts, note: cleanNote(got.note) };
  if (got.ok === false) return { ...plain(got), ok: false };
  throw new Error('shop-reply');
}

/* env.SHOP が無ければ null（呼んだ側は 503 config）。メソッドの有無は呼んだときに分かる（RPC の口は、呼ぶまで中身が見えない） */
export function shopClient(binding) {
  if (!binding) return null;
  return {
    askView: async (hash) => plain(await binding.askView(hash)),
    askApply: async (hash, req, origin) => plain(await binding.askApply(hash, req, origin)),
    siteHosts: async (origin) => hosts(await binding.siteHosts(origin)),
    siteBooking: async (origin, given) => plain(await binding.siteBooking(origin, given)),
    walkinView: async (hash) => plain(await binding.walkinView(hash)),
    walkinSubmit: async (hash, req) => plain(await binding.walkinSubmit(hash, req)),
    intakeBooking: async (hash, given, idem) => plain(await binding.intakeBooking(hash, given, idem)),
    trialView: async (t) => plain(await binding.trialView(t)),
    trialAsk: async (t, req) => plain(await binding.trialAsk(t, req))
  };
}
