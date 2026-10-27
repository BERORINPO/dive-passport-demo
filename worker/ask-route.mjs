/* お客さんのリンクの入口（entry）。/api/ask（Access の外。お客さんが ask.html から呼ぶ）と /api/ask-link（Access の内。お店がリンクを作る）の中身だけ。
   守り（道・Sec-Fetch-Site・設定・Access・種類・回数・大きさ）は handler.mjs が先にかける。決まりは ask-core.mjs、鍵は ask-db.mjs。
   計画は plan/meibo.md「お客さんのリンク」 */
import { getRoster } from './roster-db.mjs';
import { readStored, SHOP_DEFAULT } from './sync-core.mjs';
import { changeRoster, clockOf } from './auto.mjs';
import { keyHash, findLink, useLink, mintLink, countLinks } from './ask-db.mjs';
import { checkAsk, linkView, applyLink, personLinkTarget, bookingLinkTarget, USES_PER_DAY } from './ask-core.mjs';

/* 鍵が無い・切れた・違う・予約が無い、はどれも同じ答え */
const GONE = { status: 404, body: { error: 'gone' } };
/* 1 人ずつのリンクは 1 人あたりこの本数まで（前の物は止めない） */
const PERSON_LINKS_MAX = 3;

async function currentState(env, io) {
  const { today, at } = clockOf(io);
  const got = await getRoster(env.DB, SHOP_DEFAULT);
  return got.text === null ? null : readStored(got.text, { today, at });
}

/* お客さんのリンク。返すのは { status, body }。origin は 1 人ずつのリンクを作るときの頭（同じ場所） */
export async function takeAsk(given, env, io, note, origin) {
  const checked = checkAsk(given);
  if (!checked.ok) { note.why = `input-${checked.error}`; return { status: 400, body: { error: 'input' } }; }
  note.action = checked.action;
  const { today, at } = clockOf(io);
  const hash = await keyHash(checked.k);
  const link = await findLink(env.DB, hash);
  if (!link || link.shop !== SHOP_DEFAULT || link.expiresOn < today) { note.why = 'gone'; return GONE; }
  if (!(await useLink(env.DB, hash, today, USES_PER_DAY))) { note.why = 'key-limit'; return { status: 429, body: { error: 'limit' } }; }

  if (checked.action === 'view') {
    const state = await currentState(env, io);
    const view = state && linkView(state, link, today);
    if (!view) note.why = 'gone';
    return view ? { status: 200, body: view } : GONE;
  }
  if (checked.action === 'person-link') {
    const state = await currentState(env, io);
    const t = state && personLinkTarget(state, link, checked.personId, today);
    if (!t || !t.ok) { note.why = 'gone'; return GONE; }
    if (await countLinks(env.DB, { shop: SHOP_DEFAULT, bookingId: t.bookingId, personId: t.personId }) >= PERSON_LINKS_MAX) {
      note.why = 'person-links';
      return { status: 429, body: { error: 'links' } };
    }
    const url = await mintLink(env.DB, { shop: SHOP_DEFAULT, bookingId: t.bookingId, personId: t.personId, expiresOn: link.expiresOn, at, base: origin });
    return { status: 200, body: { url } };
  }

  let problems = [];
  const saved = await changeRoster(env, io, s => {
    const out = applyLink(s, link, checked, { today, at });
    problems = out.problems;
    return { state: out.state };
  });
  if (!saved.ok) { note.why = `save-${saved.why}`; return { status: 503, body: { error: 'save' } }; }
  if (problems.includes('gone')) { note.why = 'gone'; return GONE; }
  note.problems = problems.length;
  return { status: 200, body: { problems, view: linkView(saved.state, link, today) } };
}

/* お店が予約のリンクを作る（Access の内）。作り直したら前のリンクは開けない */
export async function makeAskLink(given, env, io, note, origin) {
  const bookingId = given && typeof given.bookingId === 'string' && /^[\w-]{1,64}$/.test(given.bookingId) ? given.bookingId : '';
  if (!bookingId) { note.why = 'input'; return { status: 400, body: { error: 'input' } }; }
  const { today, at } = clockOf(io);
  const state = await currentState(env, io);
  const t = state && bookingLinkTarget(state, bookingId, today);
  if (!t || !t.ok) { note.why = 'no-booking'; return { status: 404, body: { error: 'booking' } }; }
  const url = await mintLink(env.DB, { shop: SHOP_DEFAULT, bookingId, personId: '', expiresOn: t.expiresOn, at, base: origin });
  return { status: 200, body: { url, expiresOn: t.expiresOn } };
}
