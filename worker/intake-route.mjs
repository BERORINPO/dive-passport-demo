/* 予約の受け口 API の中身（entry。お店の Worker 側。決定ログ 2026-10-28 intake-api）。
   - intakeBooking: redux-ask の POST /api/v1/bookings が Service Binding の口（shop-service.mjs）から呼ぶ。鍵の SHA-256 から、お店と鍵を引き、
     同じ Idempotency-Key の 2 回目なら 1 回目の結果を返し、そうでなければ本文を検査し（intake-core.mjs）、鍵ごとの 1 日の件数を数えてから、名簿に入れる。
     お願いの連絡は次の Cron が送る。呼び手（redux-ask）の値は信じず、形を確かめ直す
   - listKeysFor / changeKeysFor: スタッフの画面（Access の内。handler.mjs の /api/api-keys）。鍵を作る・作り直す・止める
   守りの順番  鍵 → （Idempotency-Key の受け付け）→ 本文の形 → 鍵ごとの 1 日の件数 → 名簿。入れられなかった要求は、受け付けた印を外す（同じ鍵でやり直せる）。
   返すのは { status, body }。ログに出す理由は note.why に足す（鍵・名前・メールアドレス・電話・Idempotency-Key は出さない） */
import { clockOf, changeRoster, newId } from './auto.mjs';
import { newKey, keyHash } from './ask-key.mjs';
import { takeDaily, takeDailyAll } from './limit-db.mjs';
import { putApiKey, findApiKey, countApiKeys, listApiKeys, rotateApiKey, revokeApiKey, claimIdem, readIdem, finishIdem, releaseIdem } from './intake-db.mjs';
import { checkIntake, addIntakeBooking, externalIdOf, checkKeyAction, dailyMax, MAX_API_KEYS, IDEM_KEEP_DAYS, IDEM_PENDING_MS } from './intake-core.mjs';
import { idemKeyOf } from './ask-input.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';
import { knownShop, nameOf } from './shop-core.mjs';

const DAY_MS = 86400000;
const KEY_LIST_MAX = 50;
/* 鍵が無い・止めた・お店が一覧に無い、はどれも同じ答え（どれかを外から見分けさせない） */
const DENIED = { status: 401, body: { error: 'auth' } };
const DB_DOWN = { status: 503, body: { error: 'db' } };

/* 鍵の id（SHA-256 でも鍵でもない、画面に出して「作り直す」「止める」で指す名前）。k + 乱数 20 字 */
const keyId = () => {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return `k${[...bytes].map(x => x.toString(16).padStart(2, '0')).join('')}`;
};

/* 鍵の SHA-256 から、お店を引く。{ key, shops } か、そのまま返す { res } */
async function openKey(env, note, hash) {
  let key;
  try { key = await findApiKey(env.DB, hash); } catch (e) { note.why = 'db'; return { res: DB_DOWN }; }
  if (!key) { note.why = 'auth-key'; return { res: DENIED }; }
  note.shop = key.shop;
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { note.why = shopsWhy(e, 'db'); return { res: { status: 503, body: { error: note.why === 'db' ? 'db' : 'shops' } } }; }
  if (!knownShop(shops, key.shop)) { note.why = 'auth-shop'; return { res: DENIED }; }
  return { key, shops };
}

/* お店ごと・全店あわせた 1 日の上限（鍵ごとの上限 dailyMax とは別） */
const API_SHOP_DAILY_MAX = 200;
const API_ALL_DAILY_MAX = 1000;

/* 本文を検査し、件数を数え、名簿に入れる。受け付けた印の扱いは呼ぶ側 */
async function addBooking(env, io, note, { key, shops }, given) {
  const { at, nowJst, today } = clockOf(io);
  const checked = checkIntake(given, { today });
  if (!checked.ok) { note.why = 'input'; note.problems = checked.fields.length; return { status: 400, body: { error: 'input', fields: checked.fields } }; }
  let taken;
  /* 鍵ごとに加えて、お店ごとと全店あわせた上限もかける（漏れた鍵 1 本で、任意の宛先へお願いのメールを大量に出させない。ザクのレビュー 2026-10-28 MEDIUM） */
  try {
    taken = await takeDaily(env.DB, { scope: 'api', shop: key.id, day: today, max: dailyMax(env) })
      && await takeDailyAll(env.DB, { scope: 'api-shop', shop: key.shop, day: today, max: API_SHOP_DAILY_MAX, maxAll: API_ALL_DAILY_MAX });
  } catch (e) { note.why = 'limit-db'; return DB_DOWN; }
  if (!taken) { note.why = 'api-daily'; return { status: 429, body: { error: 'limit' } }; }
  const added = await changeRoster(env, io, s => addIntakeBooking(s, { booking: checked.booking, label: key.label, at, nowJst, newId }),
    { fromOutside: true, shop: key.shop, name: nameOf(shops, key.shop, '') });
  if (!added.ok) {
    note.why = `add-${added.why}`;
    return { status: added.why === 'conflict' || added.why === 'full' ? 503 : 500, body: { error: added.why === 'full' ? 'full' : 'roster' } };
  }
  note.added = 1;
  return { status: 201, body: { ok: true, booking_id: added.out.bookingId }, bookingId: added.out.bookingId };
}

/* Idempotency-Key（なければ external_id）で、同じ予約の 2 回目を見分ける。無ければ '' */
async function idemOf(header, given) {
  const got = idemKeyOf(header);
  if (!got.ok) return { bad: true };
  const source = got.key || externalIdOf(given);
  return { idem: source ? await keyHash(source) : '' };
}

export async function intakeBooking(env, io, note, hash, given, idemHeader) {
  const opened = await openKey(env, note, hash);
  if (opened.res) return opened.res;
  const { key } = opened;
  const named = await idemOf(idemHeader, given);
  if (named.bad) { note.why = 'input'; note.problems = 1; return { status: 400, body: { error: 'input', fields: ['idempotency_key'] } }; }
  const idem = named.idem;
  if (!idem) {
    const res = await addBooking(env, io, note, opened, given);
    return { status: res.status, body: res.body };
  }

  const { at } = clockOf(io);
  const now = io.now();
  let claimed;
  try {
    const staleBefore = new Date(now - IDEM_PENDING_MS).toISOString();
    const expiredBefore = new Date(now - IDEM_KEEP_DAYS * DAY_MS).toISOString();
    claimed = await claimIdem(env.DB, { keyId: key.id, idem, at, staleBefore, expiredBefore });
  } catch (e) { note.why = 'db'; return DB_DOWN; }
  if (!claimed) {
    let first;
    try { first = await readIdem(env.DB, { keyId: key.id, idem }); } catch (e) { note.why = 'db'; return DB_DOWN; }
    if (first) { note.why = 'replay'; return { status: 200, body: { ok: true, booking_id: first, replayed: true } }; }
    note.why = 'idem-busy';   // 同じ要求がまだ入れている途中（落ちていれば 2 分で引き継げる）
    return { status: 503, body: { error: 'busy' } };
  }
  /* 入れられたら結果（予約の id）を書き、入れられなかったら（落ちたときも）受け付けた印を外す。印を書き換えられなくても、予約の結果は返す
     （受け付け中のまま残った印は、2 分で引き継げる） */
  const settle = async (bookingId) => {
    try {
      if (bookingId) await finishIdem(env.DB, { keyId: key.id, idem, bookingId });
      else await releaseIdem(env.DB, { keyId: key.id, idem });
    } catch (e) { note.why = 'idem-db'; }
  };
  let res;
  try { res = await addBooking(env, io, note, opened, given); } catch (e) { await settle(''); throw e; }
  await settle(res.status === 201 ? res.bookingId : '');
  return { status: res.status, body: res.body };
}

/* ---------- スタッフの画面（Access の内） ---------- */
const endpointOf = (origin) => `${String(origin).replace(/\/+$/, '')}/api/v1/bookings`;

/* 鍵の一覧（止めた物も）。鍵そのものも SHA-256 も返さない */
export async function listKeysFor(env, io, note, shop, origin) {
  try {
    const items = await listApiKeys(env.DB, shop, KEY_LIST_MAX);
    note.rows = items.length;
    return { status: 200, body: { items, endpoint: endpointOf(origin), max: MAX_API_KEYS } };
  } catch (e) {
    note.why = 'db';
    return DB_DOWN;
  }
}

/* 作る・作り直す・止める。鍵は作った返事に 1 回だけ出る（D1 には SHA-256 だけ） */
export async function changeKeysFor(env, io, note, shop, given, origin) {
  const checked = checkKeyAction(given);
  if (!checked.ok) { note.why = `input-${checked.error}`; return { status: 400, body: { error: 'input' } }; }
  const { at } = clockOf(io);
  try {
    if (checked.action === 'revoke') {
      return (await revokeApiKey(env.DB, { shop, id: checked.id, at })) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'gone' } };
    }
    const key = `rdx_${newKey()}`;
    const hash = await keyHash(key);
    if (checked.action === 'rotate') {
      if (!(await rotateApiKey(env.DB, { shop, id: checked.id, hash, at }))) return { status: 404, body: { error: 'gone' } };
      return { status: 200, body: { id: checked.id, key, at, endpoint: endpointOf(origin) } };
    }
    if ((await countApiKeys(env.DB, shop)) >= MAX_API_KEYS) { note.why = 'key-limit'; return { status: 409, body: { error: 'limit' } }; }
    const id = keyId();
    await putApiKey(env.DB, { id, shop, hash, label: checked.label, at });
    return { status: 200, body: { id, label: checked.label, key, at, endpoint: endpointOf(origin) } };
  } catch (e) {
    note.why = 'db';
    return DB_DOWN;
  }
}
