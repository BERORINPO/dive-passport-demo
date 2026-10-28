/* お客さんのリンクの本文の形（core）。外のもの（通信・D1・時計・暗号）は使わず、名簿の部品も読まない。
   同じ検査を 2 か所でかける: redux-ask（Access なし）が /api/ask の本文を、お店の Worker（ShopService）が redux-ask から渡された
   askApply の本文を（Service Binding の向こうの呼び手も信じない）。聞く項目の計算と直しの当て方は ask-core.mjs（お店の Worker 側だけ） */

/* 鍵は 32 バイトの base64url（43 字）。D1 に置くのは鍵の SHA-256（16 進 64 字）だけ。本文の上限 */
export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_ASK_BODY = 8192;
const ACTIONS = ['view', 'send', 'today', 'person-link'];
const FIELDS = ['action', 'personId', 'input', 'answer', 'consent'];
const ID = /^[\w-]{1,64}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* 鍵のほかの項目 */
function checkAction(given) {
  if (!ACTIONS.includes(given.action)) return { ok: false, error: 'action' };
  if (given.action !== 'view' && !(typeof given.personId === 'string' && ID.test(given.personId))) return { ok: false, error: 'person' };
  if (given.action === 'send' && !isObj(given.input)) return { ok: false, error: 'input' };
  if (given.action === 'today' && !['ok', 'unwell'].includes(given.answer)) return { ok: false, error: 'answer' };
  return { ok: true };
}

/* /api/ask の本文を確かめる。{ ok, k, action, personId, input, answer, consent } か { ok: false, error } */
export function checkAsk(given) {
  if (!isObj(given)) return { ok: false, error: 'shape' };
  if (!Object.keys(given).every(k => k === 'k' || FIELDS.includes(k))) return { ok: false, error: 'keys' };
  if (typeof given.k !== 'string' || !KEY_RE.test(given.k)) return { ok: false, error: 'key' };
  const got = checkAction(given);
  return got.ok ? { ok: true, ...given } : got;
}

/* askApply が受ける本文（鍵は含まない。view は askView の口なので受けない）。{ ok, action, personId, input, answer, consent } か { ok: false, error } */
export function checkApply(req) {
  if (!isObj(req)) return { ok: false, error: 'shape' };
  if (!Object.keys(req).every(k => FIELDS.includes(k))) return { ok: false, error: 'keys' };
  if (req.action === 'view') return { ok: false, error: 'action' };
  const got = checkAction(req);
  return got.ok ? { ok: true, ...req } : got;
}
