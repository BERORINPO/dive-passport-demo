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

/* ---------- 店頭の QR（/api/walkin。決定ログ 2026-10-28 walkin-qr） ----------
   鍵は ask の鍵と同じ形（32 バイトの base64url）。ここでは形と大きさだけを確かめ、名前・生年月日などの中身の検査は
   お店の Worker が名簿と同じ検査（worker/walkin-core.mjs）でかけ直す */
export const MAX_WALKIN_BODY = 4096;
const WALKIN_FIELDS = ['action', 'tripId', 'name', 'people', 'email', 'birthDate', 'address', 'emergency'];
const WALKIN_TEXT_MAX = 300;
const EMERGENCY_FIELDS = ['name', 'relation', 'phone'];
const shortText = (v) => typeof v === 'string' && v.length <= WALKIN_TEXT_MAX;

function walkinSubmitShape(g) {
  const e = g.emergency;
  const texts = ['tripId', 'name', 'email', 'birthDate', 'address'];
  if (!texts.every(k => g[k] === undefined || shortText(g[k]))) return 'text';
  if (g.tripId === undefined || g.name === undefined || g.birthDate === undefined || g.address === undefined) return 'missing';
  if (!Number.isInteger(g.people)) return 'people';
  if (!isObj(e) || !Object.keys(e).every(k => EMERGENCY_FIELDS.includes(k)) || !Object.values(e).every(shortText)) return 'emergency';
  return '';
}

/* /api/walkin の本文を確かめる。{ ok, k, action, req } か { ok: false, error }。req は鍵を除いた本文（view のときは {}） */
export function checkWalkin(given) {
  if (!isObj(given)) return { ok: false, error: 'shape' };
  if (!Object.keys(given).every(k => k === 'k' || WALKIN_FIELDS.includes(k))) return { ok: false, error: 'keys' };
  if (typeof given.k !== 'string' || !KEY_RE.test(given.k)) return { ok: false, error: 'key' };
  if (!['view', 'submit'].includes(given.action)) return { ok: false, error: 'action' };
  const { k, ...req } = given;
  if (given.action === 'view') return Object.keys(req).length === 1 ? { ok: true, k, action: 'view', req: {} } : { ok: false, error: 'keys' };
  const got = checkWalkinApply(req);
  return got.ok ? { ok: true, k, action: 'submit', req } : got;
}

/* walkinSubmit が受ける本文（鍵は含まない。お店の Worker が、redux-ask から渡された物ももう一度確かめる） */
export function checkWalkinApply(req) {
  if (!isObj(req) || !Object.keys(req).every(k => WALKIN_FIELDS.includes(k))) return { ok: false, error: 'keys' };
  if (req.action !== 'submit') return { ok: false, error: 'action' };
  const bad = walkinSubmitShape(req);
  return bad ? { ok: false, error: bad } : { ok: true };
}

/* askApply が受ける本文（鍵は含まない。view は askView の口なので受けない）。{ ok, action, personId, input, answer, consent } か { ok: false, error } */
export function checkApply(req) {
  if (!isObj(req)) return { ok: false, error: 'shape' };
  if (!Object.keys(req).every(k => FIELDS.includes(k))) return { ok: false, error: 'keys' };
  if (req.action === 'view') return { ok: false, error: 'action' };
  const got = checkAction(req);
  return got.ok ? { ok: true, ...req } : got;
}

/* ---------- 予約の受け口 API（POST /api/v1/bookings。決定ログ 2026-10-28 intake-api） ----------
   redux-ask は、Authorization の鍵の形と Idempotency-Key の形と本文の大きさだけを見る。項目の中身の検査は、お店の Worker が
   名簿と同じ検査（worker/intake-core.mjs）でかけ直す。鍵は「rdx_」と 32 バイトの base64url（43 字） */
export const MAX_INTAKE_BODY = 4096;
export const API_KEY_RE = /^rdx_[A-Za-z0-9_-]{43}$/;
const IDEM_RE = /^[\x21-\x7e]{1,128}$/;

/* Authorization ヘッダから鍵を取り出す。形が合わなければ '' */
export function bearerOf(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || '').trim());
  return m && API_KEY_RE.test(m[1]) ? m[1] : '';
}

/* Idempotency-Key（無ければ null か ''）。空は「付けていない」。{ ok: true, key } か { ok: false } */
export function idemKeyOf(value) {
  if (value === null || value === undefined || value === '') return { ok: true, key: '' };
  return typeof value === 'string' && IDEM_RE.test(value) ? { ok: true, key: value } : { ok: false };
}
