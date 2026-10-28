/* 店頭の QR の中身（entry。お店の Worker 側）。お客さんの 2 つの口 walkinView・walkinSubmit（redux-ask から Service Binding で呼ばれる。口は shop-service.mjs）と、
   スタッフの 3 つ（Access の内。handler.mjs の /api/walkin-key・/api/walkins・/api/walkin-drop）。守り（道・Sec-Fetch-Site・種類・IP の回数・大きさ・本文の形・
   鍵の SHA-256 にする）は redux-ask の public-handler.mjs が先にかける。ここは鍵の行（walkin-db.mjs）を引き、決まり（walkin-core.mjs）を当てる。
   返すのは { status, body }。ログに出す理由は note.why に足す（名前・住所・鍵は出さない）。決定ログ 2026-10-28 walkin-qr */
import { getRoster } from './roster-db.mjs';
import { readStored } from './sync-core.mjs';
import { clockOf } from './auto.mjs';
import { newKey, keyHash } from './ask-key.mjs';
import { takeDailyAll } from './limit-db.mjs';
import { putWalkinKey, findWalkinShop, walkinKeyAt, addWalkin, listWalkins, dropWalkin } from './walkin-db.mjs';
import { walkinTrips, checkWalkinInput, walkinItem, walkinExpiry, WALKIN_DAILY_MAX, WALKIN_DAILY_MAX_ALL, WALKIN_LIST_MAX } from './walkin-core.mjs';
import { SHOP_ID, knownShop, nameOf } from './shop-core.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';

/* 鍵が無い・作り直して古くなった・お店が一覧に無い、はどれも同じ答え */
const GONE = { status: 404, body: { error: 'gone' } };
const ID = /^[a-z0-9]{1,40}$/;

const newId = () => {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
};

/* 鍵の SHA-256 から、お店とお店の一覧を引く。{ shop, shops } か、そのまま返す { res } */
async function openKey(env, note, hash) {
  let shop;
  try { shop = await findWalkinShop(env.DB, hash); } catch (e) { note.why = 'db'; return { res: { status: 503, body: { error: 'db' } } }; }
  if (!shop || !SHOP_ID.test(shop)) { note.why = 'gone'; return { res: GONE }; }
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { note.why = shopsWhy(e, 'db'); return { res: { status: 503, body: { error: note.why === 'db' ? 'db' : 'shops' } } }; }
  if (!knownShop(shops, shop)) { note.why = 'gone'; return { res: GONE }; }
  return { shop, shops };
}

/* お客さんが QR を開いた（action: view）。見せるのは、お店の名前と、今日と明日の便の日付・時刻・ツアーの名前だけ */
export async function walkinView(env, io, note, hash) {
  const opened = await openKey(env, note, hash);
  if (opened.res) return opened.res;
  const { today, at } = clockOf(io);
  let got;
  try { got = await getRoster(env.DB, opened.shop); } catch (e) { note.why = 'db'; return { status: 503, body: { error: 'db' } }; }
  const state = got.text === null ? null : readStored(got.text, { today, at });
  const shop = state && state.shop.name ? state.shop.name : nameOf(opened.shops, opened.shop, '');
  return { status: 200, body: { shop, today, trips: state ? walkinTrips(state, today) : [] } };
}

/* お客さんが入れた（action: submit）。名簿と同じ検査と整形を通し、1 日の件数を数えてから、名簿の本体ではなく walkin_pending に置く */
export async function walkinSubmit(env, io, note, hash, req) {
  const opened = await openKey(env, note, hash);
  if (opened.res) return opened.res;
  const { today, at } = clockOf(io);
  const checked = checkWalkinInput(req, { today });
  if (!checked.ok) { note.why = 'input'; note.problems = checked.problems.length; return { status: 400, body: { error: 'input', problems: checked.problems } }; }
  let taken;
  try {
    taken = await takeDailyAll(env.DB, { scope: 'walkin', shop: opened.shop, day: today, max: WALKIN_DAILY_MAX, maxAll: WALKIN_DAILY_MAX_ALL });
  } catch (e) {
    note.why = 'limit-db';
    return { status: 503, body: { error: 'db' } };
  }
  if (!taken) { note.why = 'walkin-daily'; return { status: 429, body: { error: 'limit' } }; }
  try {
    await addWalkin(env.DB, { shop: opened.shop, id: newId(), tripId: checked.tripId, body: JSON.stringify(checked.record), at, expiresOn: walkinExpiry(today) });
  } catch (e) {
    note.why = 'db';
    return { status: 503, body: { error: 'db' } };
  }
  note.added = 1;
  return { status: 202, body: { ok: true } };
}

/* スタッフが店頭の QR を作る・作り直す（Access の内）。鍵はここで作り、SHA-256 だけを置く。URL（鍵つき）は返事に 1 回だけ出る。
   作り直すと前の鍵は開けない。origin はお客さんの Worker の住所（ASK_ORIGIN。手元は同じ場所） */
export async function makeWalkinKey(env, io, note, shop, origin) {
  const { at } = clockOf(io);
  const key = newKey();
  try {
    await putWalkinKey(env.DB, { shop, hash: await keyHash(key), at });
  } catch (e) {
    note.why = 'db';
    return { status: 503, body: { error: 'db' } };
  }
  return { status: 200, body: { url: `${String(origin).replace(/\/+$/, '')}/walkin#w=${key}`, at } };
}

/* スタッフの「店頭で入れた人」の一覧（Access の内）。期限を過ぎていない行を古い順に、鍵を作った時刻と一緒に */
export async function listWalkinsFor(env, io, note, shop) {
  const { today } = clockOf(io);
  try {
    const rows = await listWalkins(env.DB, shop, today, WALKIN_LIST_MAX);
    const items = rows.map(walkinItem).filter(Boolean);
    note.rows = items.length;
    return { status: 200, body: { items, keyAt: await walkinKeyAt(env.DB, shop) } };
  } catch (e) {
    note.why = 'db';
    return { status: 503, body: { error: 'db' } };
  }
}

/* スタッフが「入れた」「入れない」を押した行を消す（Access の内）。もう無ければ 404（画面は消えたものとして扱う） */
export async function dropWalkinFor(env, io, note, shop, given) {
  if (!given || typeof given !== 'object' || Object.keys(given).join() !== 'id' || typeof given.id !== 'string' || !ID.test(given.id)) {
    note.why = 'input';
    return { status: 400, body: { error: 'input' } };
  }
  try {
    return (await dropWalkin(env.DB, shop, given.id)) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: 'gone' } };
  } catch (e) {
    note.why = 'db';
    return { status: 503, body: { error: 'db' } };
  }
}
