/* 済んだ便を名簿の本体から分ける決まり（core）。外のもの（通信・D1・時計）は使わない。計画は plan/server.md の「済んだ便を分けて置く」。
   名簿の本体（D1 の rosters、1 お店 1 行）には、日付の無い便・今と先の便・済んで ARCHIVE_DAYS 日までの便だけを置く。
   それより前の便は、便ごとに 1 つの「済んだ便」（便・予約・人・予定・送った連絡・その便の記録）にして、D1 の roster_past に 1 行ずつ置く。
   お店全体の記録（AI の読み取りなど。id が空）は、日ごとに 1 つにまとめて分ける。
   これで名簿の本体の大きさは、1 年分の予約でなく、先の予約の数で決まる（ジンのレビュー 2026-10-27 CRITICAL: 1 MB の上限に 3〜4 か月で届く）。
   分けるのはサーバーが名簿を書くときだけ（sync-core.mjs の checkPut）。済んだ便は読むだけで、画面からは直さない */
import '../js/roster-schema.js';
import '../js/roster-core.js';
import '../js/roster-auto.js';

const R = globalThis.REDUX;

/* 便の日から何日たったら分けるか。済んだ予定と連絡の本文を外す日（js/roster-auto.js の compactPast）と同じ */
export const ARCHIVE_DAYS = R.rosterAuto.KEEP_DONE_DAYS;
/* 済んだ便を一度に読む日数の上限と、行の数の上限 */
export const MAX_PAST_DAYS = 93;
export const MAX_PAST_ROWS = 400;
const LOG_PART = 'log:';
const TRIP_BODY_KEYS = ['v', 'trip', 'bookings', 'people', 'jobs', 'outbox', 'log'];
const LOG_BODY_KEYS = ['v', 'log'];

const isDay = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && R.roster.realDate(v);
const logDay = (e) => e.at.slice(0, 10);

/* 名簿を、本体（state）と済んだ便（parts）に分ける。parts の 1 つは { part, day, keepUntil, body }（body は JSON の文字）。
   part は便の id か 'log:YYYY-MM-DD'。keepUntil を過ぎた行は消す（名簿と同じ 1 年。js/roster-core.js の purgeExpired と同じ数え方） */
export function splitPast(state, { today }) {
  if (!isDay(today)) throw new Error(`splitPast: today は YYYY-MM-DD (${today})`);
  const cut = R.rosterAuto.dayAdd(today, -ARCHIVE_DAYS);
  const oldTrips = state.trips.filter(t => t.date !== '' && t.date < cut);
  const oldLog = state.log.filter(e => e.id === '' && logDay(e) < cut);
  if (!oldTrips.length && !oldLog.length) return { state, parts: [] };

  const moved = { trip: new Set(), booking: new Set(), person: new Set() };
  const parts = oldTrips.map(trip => {
    const bookings = state.bookings.filter(b => b.tripId === trip.id);
    const ids = new Set(bookings.map(b => b.id));
    const people = state.people.filter(p => ids.has(p.bookingId));
    const pids = new Set(people.map(p => p.id));
    const log = state.log.filter(e => (e.kind === 'trip' && e.id === trip.id) || (e.kind === 'booking' && ids.has(e.id)) || (e.kind === 'person' && pids.has(e.id)));
    moved.trip.add(trip.id);
    ids.forEach(id => moved.booking.add(id));
    pids.forEach(id => moved.person.add(id));
    const body = { v: R.roster.VERSION, trip, bookings, people,
      jobs: (state.jobs || []).filter(j => j.tripId === trip.id), outbox: (state.outbox || []).filter(o => o.tripId === trip.id), log };
    return { part: trip.id, day: trip.date, keepUntil: R.rosterCore.keepUntil(trip.date), body: JSON.stringify(body) };
  });
  const days = [...new Set(oldLog.map(logDay))].sort();
  days.forEach(day => {
    const body = { v: R.roster.VERSION, log: oldLog.filter(e => logDay(e) === day) };
    parts.push({ part: `${LOG_PART}${day}`, day, keepUntil: R.rosterCore.keepUntil(R.roster.nextDay(day)), body: JSON.stringify(body) });
  });

  const gone = (e) => (e.id === '' ? logDay(e) < cut : moved[e.kind] && moved[e.kind].has(e.id));
  const live = {
    ...state,
    trips: state.trips.filter(t => !moved.trip.has(t.id)),
    bookings: state.bookings.filter(b => !moved.booking.has(b.id)),
    people: state.people.filter(p => !moved.person.has(p.id)),
    log: state.log.filter(e => !gone(e)),
    ...(state.jobs ? { jobs: state.jobs.filter(j => !moved.trip.has(j.tripId)) } : {}),
    ...(state.outbox ? { outbox: state.outbox.filter(o => !moved.trip.has(o.tripId)) } : {})
  };
  return { state: live, parts };
}

/* 名簿の本体だけ（済んだ便を除いた物）。人が大きく消える書き込みを比べるときに、今の名簿にもかける */
export const liveOf = (state, today) => splitPast(state, { today }).state;

/* 済んだ便を読む範囲（GET /api/roster/past?from=&to=）。返すのは { ok, from, to } か { ok: false, error } */
export function checkPastRange(from, to, { today }) {
  if (!isDay(from) || !isDay(to)) return { ok: false, error: 'day' };
  if (from > to || to > today) return { ok: false, error: 'order' };
  if (R.rosterAuto.dayAdd(from, MAX_PAST_DAYS - 1) < to) return { ok: false, error: 'range' };
  return { ok: true, from, to };
}

/* D1 の 1 行（{ part, day, body }）を読み直す。形が合わなければ null。読んだ物は、名簿の形の検査に通る 1 つの名簿にまとめて確かめる */
function partOf(row, shopName) {
  let body;
  try { body = JSON.parse(String(row.body)); } catch (e) { return null; }
  if (!body || typeof body !== 'object' || body.v !== R.roster.VERSION) return null;
  const isLog = String(row.part).startsWith(LOG_PART);
  const keys = isLog ? LOG_BODY_KEYS : TRIP_BODY_KEYS;
  if (Object.keys(body).length !== keys.length || !keys.every(k => Object.prototype.hasOwnProperty.call(body, k))) return null;
  if (isLog ? !(row.part === `${LOG_PART}${row.day}` && Array.isArray(body.log) && body.log.every(e => e && e.id === ''))
    : !(body.trip && body.trip.id === row.part && body.trip.date === row.day)) return null;
  return joinPast([body], shopName).ok ? body : null;
}

/* 済んだ便をつないで、読むだけの名簿にする。返すのは { ok, state } か { ok: false }（名簿の形の検査に落ちた） */
export function joinPast(bodies, shopName) {
  const all = (key) => bodies.flatMap(b => b[key] || []);
  const state = { ...R.roster.blankState(shopName), trips: bodies.filter(b => b.trip).map(b => b.trip), bookings: all('bookings'), people: all('people'),
    log: all('log').sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)), jobs: all('jobs'), outbox: all('outbox') };
  return R.roster.validateState(state).ok ? { ok: true, state } : { ok: false };
}

/* D1 から読んだ行を、読むだけの名簿にする。返すのは { state, skipped }（skipped は形が合わずに外した行の数） */
export function readPast(rows, shopName) {
  const bodies = [];
  let skipped = 0;
  rows.forEach(row => { const b = partOf(row, shopName); if (b) bodies.push(b); else skipped += 1; });
  const joined = joinPast(bodies, shopName);
  /* 1 行ずつは通るのに、つなぐと通らない（id が重なる、など）ときは、何も渡さない */
  return joined.ok ? { state: joined.state, skipped } : { state: R.roster.blankState(shopName), skipped: rows.length };
}
