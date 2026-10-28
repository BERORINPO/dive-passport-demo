/* お客さんのリンクの決まり（core）。外のもの（通信・D1・時計・暗号）は使わない。今日は受け取る。
   聞く項目は Worker が自分の名簿から計算し、お客さんから届いた ask や patch は信じない（js/roster-guest.js の guestProblems・guestPatch をここでかける）。
   予約 1 件のリンクは健康以外、1 人ずつのリンクはその人の健康（既往症と当日の体調）だけ。計画は plan/meibo.md「お客さんのリンク」 */
import '../js/roster-schema.js';
import '../js/roster-core.js';
import '../js/roster-guest.js';
import '../js/roster-auto.js';

const R = globalThis.REDUX;
const G = () => R.rosterGuest;

/* 鍵 1 つあたり 1 日に受ける回数（鍵と本文の形は ask-input.mjs）。聞く項目の名前で、健康は 'history' だけ */
export const USES_PER_DAY = 30;
const HEALTH = ['history'];

/* リンクの期限: 便の翌日まで。日付の無い便は作った日から 14 日 */
export const linkExpiry = (trip, today) => R.rosterAuto.dayAdd(trip && trip.date ? trip.date : today, trip && trip.date ? 1 : 14);

/* リンクで開ける予約と人。期限切れ・予約が無い・人が別の予約、はどれも null（呼ぶ側は同じ 404 を返す） */
function target(state, link, today) {
  if (!link || link.expiresOn < today) return null;
  const v = G().guestView(state, link.bookingId);
  if (!v || !v.trip) return null;
  const people = link.personId ? v.people.filter(e => e.person.id === link.personId) : v.people;
  if (!people.length) return null;
  return { v, people };
}

/* 1 人分の「まだ」の所を、リンクの種類で分ける */
function split(entry, link, isDay) {
  const forHealth = !!link.personId;
  const ask = forHealth ? entry.ask.filter(k => HEALTH.includes(k)) : entry.ask.filter(k => !HEALTH.includes(k));
  const healthOpen = entry.ask.some(k => HEALTH.includes(k)) || entry.needsToday;
  return { ask, needsToday: forHealth && entry.needsToday, todayOpen: forHealth && entry.needsToday && isDay, healthOpen };
}

/* お客さんに見せる物。名簿の中身は出さない（名前・聞く項目の名前・入っている項目の名前・C カードの講習の名前だけ）。
   例外は予約のリンクの confirm だけ: AI が読んだまま確かめていない値を、その予約の人の分だけ出す（決定ログ 2026-10-28 unconfirmed-marks。確かめると消える） */
export function linkView(state, link, today) {
  const t = target(state, link, today);
  if (!t) return null;
  const { v } = t;
  const booking = v.booking;
  const isDay = v.trip.date === today;
  return {
    shop: R.rosterCore.isPartnerBooking(booking) ? booking.shop : state.shop.name,
    kind: link.personId ? 'person' : 'booking',
    trip: { date: v.trip.date, start: v.trip.start, tour: v.trip.tour, kind: v.trip.kind, cancel: v.trip.cancel ? { reason: v.trip.cancel.reason } : null },
    isDay,
    people: t.people.map(e => {
      const s = split(e, link, isDay);
      return {
        person: { id: e.person.id, name: e.person.name },
        ask: s.ask, needsToday: s.needsToday, todayOpen: s.todayOpen, healthOpen: s.healthOpen, known: e.known, consented: e.consented,
        /* 「この内容で合っていますか」: AI が読んだまま確かめていない値（予約のリンクだけ。1 人ずつの健康のリンクには出さない）。確かめるとこの一覧から消える */
        confirm: link.personId ? [] : e.confirm,
        parts: { emergency: e.parts.emergency, cert: e.parts.cert, course: e.parts.course, date: '', hasDate: !!e.parts.date }
      };
    })
  };
}

/* リンクから入れる直し。{ state, problems }。problems に 'gone' があれば 404 と同じ扱い */
export function applyLink(state, link, req, { today, at }) {
  const t = target(state, link, today);
  if (!t) return { state, problems: ['gone'] };
  const entry = t.people.find(e => e.person.id === req.personId);
  if (!entry) return { state, problems: ['gone'] };
  if (t.v.trip.cancel) return { state, problems: ['cancelled'] };
  if (req.action === 'confirm') {
    if (link.personId) return { state, problems: ['not-allowed'] };
    return G().confirmGuest(state, { id: entry.person.id, agree: req.agree, fix: req.fix, at });
  }
  if (req.action === 'send') {
    const only = link.personId ? HEALTH : entry.ask.filter(k => !HEALTH.includes(k));
    return G().applyGuest(state, { id: entry.person.id, input: req.input, today, at, only });
  }
  /* 当日の体調は、1 人ずつのリンクで、Worker の日付が便の日のときだけ。答えたあとは「少し調子が悪い」への変更だけ受ける
     （潜るかの判断にかかわる答えを、リンクを持つ人が軽い方へ書き換えられないように。変更は名簿の記録に残る。ザクのレビュー 2026-10-27 M-3） */
  if (!link.personId || t.v.trip.date !== today) return { state, problems: ['not-today'] };
  if (!entry.needsToday && req.answer !== 'unwell') return { state, problems: ['answered'] };
  return G().answerToday(state, { id: entry.person.id, answer: req.answer, day: today, consent: req.consent === true, today, demo: false, at });
}

/* 予約のリンクから、その予約の 1 人の健康のリンクを作ってよいか。{ ok, bookingId, personId } */
export function personLinkTarget(state, link, personId, today) {
  if (link.personId) return { ok: false };
  const t = target(state, link, today);
  if (!t) return { ok: false };
  const entry = t.people.find(e => e.person.id === personId);
  if (!entry || t.v.trip.cancel) return { ok: false };
  return { ok: true, bookingId: link.bookingId, personId, trip: t.v.trip };
}

/* お店が作る予約のリンク（/api/ask-link）。予約があり、便がまだ終わっていないときだけ */
export function bookingLinkTarget(state, bookingId, today) {
  const b = state.bookings.find(x => x.id === bookingId);
  const trip = b ? state.trips.find(x => x.id === b.tripId) : null;
  if (!b || !trip) return { ok: false };
  const expiresOn = linkExpiry(trip, today);
  return expiresOn < today ? { ok: false } : { ok: true, trip, expiresOn };
}
