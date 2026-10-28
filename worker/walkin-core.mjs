/* 店頭の QR の決まり（core）。外のもの（通信・D1・時計・暗号）は使わない。今日は受け取る。
   お客さんが店頭で入れた項目は、お客さんのリンクと同じ検査と整形（js/roster-guest.js の guestProblems・guestPatch。名前は NAME_BAD、長さは名簿の形）に通す。
   お客さんに見せる便は「日付・開始時刻・ツアーの名前」だけで、ほかの人の名前も人数も出さない。受けた物は名簿の本体に入れず、
   お店が押すまで walkin_pending に置く（個人情報なので、押したら消す・受けて 2 日で消す）。決定ログ 2026-10-28 walkin-qr */
import '../js/roster-schema.js';
import '../js/roster-core.js';
import '../js/roster-guest.js';
import '../js/roster-auto.js';

const R = globalThis.REDUX;

/* 1 日に受ける件数の上限（お店ごと・全店あわせ）。店頭に貼る QR は誰でも読めるので、鍵を知る人が無限に送れないようにする */
export const WALKIN_DAILY_MAX = 60;
export const WALKIN_DAILY_MAX_ALL = 300;
/* 受けてから消すまでの日数、お店の画面に出す件数の上限、1 組の人数の上限（サイトの予約と同じ 10 人） */
export const WALKIN_KEEP_DAYS = 2;
export const WALKIN_LIST_MAX = 100;
export const WALKIN_MAX_PEOPLE = 10;

const ASK = ['name', 'birthDate', 'address', 'emergency'];
const ID = /^[\w-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const walkinExpiry = (today) => R.rosterAuto.dayAdd(today, WALKIN_KEEP_DAYS);

/* お客さんに見せる便: 今日と明日の、中止していない自分の店の便。日付・開始時刻・ツアーの名前・種類だけ（人数も名前も出さない） */
export function walkinTrips(state, today) {
  const last = R.rosterAuto.dayAdd(today, 1);
  return R.rosterCore.tripList(state)
    .filter(t => t.date >= today && t.date <= last && !t.cancel && !t.host)
    .map(t => ({ id: t.id, date: t.date, start: t.start, tour: t.tour, kind: t.kind }));
}

/* 届いた本文（形は ask-input.mjs の checkWalkin が見た）を名簿と同じ検査にかける。
   { ok: true, tripId, record } か { ok: false, problems }（problems は直してほしい項目の名前だけ。入れた値は返さない）。
   record は置く形: { name, people, email, birthDate, address, emergency: { name, relation, phone }, day } */
export function checkWalkinInput(req, { today }) {
  const x = { name: req.name, birthDate: req.birthDate, address: req.address, emergency: req.emergency };
  const email = typeof req.email === 'string' ? req.email.trim() : '';
  const problems = [
    ...R.rosterGuest.guestProblems(x, ASK),
    /* 生年月日は今日より後にならない */
    ...(typeof x.birthDate === 'string' && DAY.test(x.birthDate) && x.birthDate > today ? ['birthDate'] : []),
    !(Number.isInteger(req.people) && req.people >= 1 && req.people <= WALKIN_MAX_PEOPLE) && 'people',
    !R.roster.emailOk(email) && 'email',
    !(req.tripId === '' || ID.test(req.tripId)) && 'trip'
  ].filter(Boolean);
  if (problems.length) return { ok: false, problems: [...new Set(problems)] };
  const patch = R.rosterGuest.guestPatch(x, ASK, today);
  const { name, birthDate, address, emergency } = patch;
  return { ok: true, tripId: req.tripId, record: { name, people: req.people, email, birthDate, address, emergency, day: today } };
}

/* D1 の行（body は JSON の文字）を、お店の画面に出す形にする。形が合わない行は null（壊れた行を画面に広げない） */
export function walkinItem(row) {
  let b;
  try { b = JSON.parse(row.body); } catch (e) { return null; }
  const e = isObj(b) && isObj(b.emergency) ? b.emergency : null;
  const ok = e && ['name', 'address', 'birthDate', 'email', 'day'].every(k => typeof b[k] === 'string') && Number.isInteger(b.people) && DAY.test(b.day) &&
    ['name', 'relation', 'phone'].every(k => typeof e[k] === 'string');
  if (!ok) return null;
  return { id: row.id, tripId: row.tripId, at: row.at, name: b.name, people: b.people, email: b.email, birthDate: b.birthDate, address: b.address,
    emergency: { name: e.name, relation: e.relation, phone: e.phone }, day: b.day };
}
