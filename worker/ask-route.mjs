/* お客さんのリンクの中身（entry。お店の Worker 側）。askView・askApply（redux-ask から Service Binding で呼ばれる。口は shop-service.mjs）と、
   makeAskLink（/api/ask-link。Access の内で、お店がリンクを作る）。守り（道・Sec-Fetch-Site・種類・回数・大きさ・本文の形・鍵の SHA-256 にする）は、
   redux-ask の public-handler.mjs が先にかける。ここは鍵の行（ask-db.mjs）と名簿を引いて、決まり（ask-core.mjs）を当てる。
   返すのは { status, body }。ログに出す理由は note.why に足す。計画は plan/meibo.md「お客さんのリンク」 */
import { getRoster } from './roster-db.mjs';
import { readStored, SHOP_DEFAULT } from './sync-core.mjs';
import { changeRoster, clockOf } from './auto.mjs';
import { findLink, useLink, mintLink, countLinks } from './ask-db.mjs';
import { linkView, applyLink, personLinkTarget, bookingLinkTarget, USES_PER_DAY } from './ask-core.mjs';
import { SHOP_ID, knownShop } from './shop-core.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';

/* 鍵が無い・切れた・違う・予約が無い、はどれも同じ答え */
const GONE = { status: 404, body: { error: 'gone' } };
/* 1 人ずつのリンクは 1 人あたりこの本数まで（前の物は止めない） */
const PERSON_LINKS_MAX = 3;

async function currentState(env, io, shop) {
  const { today, at } = clockOf(io);
  const got = await getRoster(env.DB, shop);
  return got.text === null ? null : readStored(got.text, { today, at });
}

/* 鍵の SHA-256 から、開いてよいリンクを引き、1 日の回数を数える。返すのは { link, shop } か、そのまま返す { res }。
   どのお店の名簿かは、鍵と一緒に置いたお店（お客さんから届いた物は信じない）。一覧から消したお店のリンクは開かない */
async function openLink(env, io, note, hash) {
  const { today } = clockOf(io);
  const link = await findLink(env.DB, hash);
  if (!link || !SHOP_ID.test(link.shop) || link.expiresOn < today) { note.why = 'gone'; return { res: GONE }; }
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { note.why = shopsWhy(e, 'db'); return { res: { status: 503, body: { error: note.why === 'db' ? 'db' : 'shops' } } }; }
  if (!knownShop(shops, link.shop)) { note.why = 'gone'; return { res: GONE }; }
  if (!(await useLink(env.DB, hash, today, USES_PER_DAY))) { note.why = 'key-limit'; return { res: { status: 429, body: { error: 'limit' } } }; }
  return { link, shop: link.shop };
}

/* お客さんがリンクを開く（action: view）。見せるのは名前と聞く項目の名前だけ */
export async function askView(env, io, note, hash) {
  const opened = await openLink(env, io, note, hash);
  if (opened.res) return opened.res;
  const { today } = clockOf(io);
  const state = await currentState(env, io, opened.shop);
  const view = state && linkView(state, opened.link, today);
  if (!view) note.why = 'gone';
  return view ? { status: 200, body: view } : GONE;
}

/* お客さんがリンクから答える・もう 1 人分のリンクを作る（action: send・today・person-link）。req は ask-input.mjs の checkApply を通った本文。
   origin は 1 人ずつのリンクを作るときの頭（redux-ask の住所） */
export async function askApply(env, io, note, hash, req, origin) {
  const opened = await openLink(env, io, note, hash);
  if (opened.res) return opened.res;
  const { link, shop } = opened;
  const { today, at } = clockOf(io);
  if (req.action === 'person-link') {
    const state = await currentState(env, io, shop);
    const t = state && personLinkTarget(state, link, req.personId, today);
    if (!t || !t.ok) { note.why = 'gone'; return GONE; }
    if (await countLinks(env.DB, { shop, bookingId: t.bookingId, personId: t.personId, today }) >= PERSON_LINKS_MAX) {
      note.why = 'person-links';
      return { status: 429, body: { error: 'links' } };
    }
    const url = await mintLink(env.DB, { shop, bookingId: t.bookingId, personId: t.personId, expiresOn: link.expiresOn, at, base: origin, mintedBy: 'booking' });
    return { status: 200, body: { url } };
  }

  let problems = [];
  const saved = await changeRoster(env, io, s => {
    const out = applyLink(s, link, req, { today, at });
    problems = out.problems;
    return { state: out.state };
  }, { shop });
  if (!saved.ok) { note.why = `save-${saved.why}`; return { status: 503, body: { error: 'save' } }; }
  if (problems.includes('gone')) { note.why = 'gone'; return GONE; }
  note.problems = problems.length;
  return { status: 200, body: { problems, view: linkView(saved.state, link, today) } };
}

/* お店が予約のリンクを作る（Access の内）。作り直したら前のリンクは開けない。shop はログインしたスタッフのお店。
   personId を渡すと、その予約の 1 人ずつのリンクを作る（お店が作った鍵だけが、AI が読んだ値を見せる・直せる。決定ログ unconfirmed-marks） */
export async function makeAskLink(given, env, io, note, origin, shop = SHOP_DEFAULT) {
  const idOf = (v) => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : '');
  const g = given !== null && typeof given === 'object' ? given : {};
  const bookingId = idOf(g.bookingId);
  const personId = g.personId !== undefined ? idOf(g.personId) : '';
  if (!bookingId || (g.personId !== undefined && !personId)) { note.why = 'input'; return { status: 400, body: { error: 'input' } }; }
  const { today, at } = clockOf(io);
  const state = await currentState(env, io, shop);
  const t = state && bookingLinkTarget(state, bookingId, today, personId);
  if (!t || !t.ok) { note.why = 'no-booking'; return { status: 404, body: { error: 'booking' } }; }
  const url = await mintLink(env.DB, { shop, bookingId, personId, expiresOn: t.expiresOn, at, base: origin, mintedBy: 'staff' });
  return { status: 200, body: { url, expiresOn: t.expiresOn } };
}
