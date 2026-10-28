/* 予約の受け口 API の決まり（core。決定ログ 2026-10-28 intake-api）。外のもの（通信・D1・時計・暗号）は使わない。今日と今の時刻は受け取る。
   POST /api/v1/bookings の本文を、サイトの予約フォーム（auto-core.mjs の checkBooking）と同じ決まりで確かめ（名前は NAME_BAD、電話は PHONE、
   メモは健康の行を外す。健康の項目は受けない）、名簿を直す関数（名簿 → 名簿）にする。API キーの管理（作る・作り直す・止める）の本文の形もここ。
   誤りは、項目の名前（API の名前。date・lead_name など）の一覧で返す */
import { NAME_BAD, PHONE, MAX_DAYS_AHEAD } from './auto-core.mjs';

const R = globalThis.REDUX;

/* 1 本の鍵の 1 日の件数（お店の Worker の env INTAKE_DAILY_MAX で 1〜1000 に変えられる）、1 つのお店の鍵の数、同じ Idempotency-Key を覚えておく日数、
   「受け付け中」の行を引き継げるまでの時間 */
export const INTAKE_DAILY_MAX = 100;
export const MAX_API_KEYS = 10;
export const IDEM_KEEP_DAYS = 7;
export const IDEM_PENDING_MS = 120000;
export const LABEL_MAX = 40;

const FIELDS = ['date', 'start', 'tour', 'people', 'lead_name', 'lead_email', 'lead_phone', 'lang', 'note', 'external_id'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const LINKISH = /:\/\/|www\./i;
const EXTERNAL_RE = /^[\x21-\x7e]{1,60}$/;
const MAX_FIELDS_SHOWN = 12;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export const dailyMax = (env) => {
  const n = Number(env && env.INTAKE_DAILY_MAX);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : INTAKE_DAILY_MAX;
};

/* WordPress（Contact Form 7）や Zapier は空の項目を '' で、数を文字で送る。空は「無い」と見なし、人数は数の文字も受ける */
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/* 付いてきた項目の名前をそのまま返さない（長い・変な文字の名前は 'unknown'） */
const shownName = (k) => (k.length <= 40 && /^[\w.-]+$/.test(k) ? k : 'unknown');

/* external_id は文字か整数。Idempotency-Key が無いときの代わりに使うので、呼ぶ側（intake-route.mjs）も使う。無い・形が合わなければ '' */
export function externalIdOf(given) {
  const v = isObj(given) ? given.external_id : undefined;
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v.trim() : '';
  return EXTERNAL_RE.test(s) ? s : '';
}

/* 本文を確かめる。{ ok: true, booking } か { ok: false, fields: [項目の名前…] } */
export function checkIntake(given, { today }) {
  if (!isObj(given)) return { ok: false, fields: ['body'] };
  const g = given;
  const last = R.rosterAuto.dayAdd(today, MAX_DAYS_AHEAD);
  const people = typeof g.people === 'string' && /^\d{1,2}$/.test(g.people.trim()) ? Number(g.people.trim()) : g.people;
  const name = text(g.lead_name);
  const tour = text(g.tour);
  const email = text(g.lead_email);
  const phone = text(g.lead_phone);
  const ext = blank(g.external_id) ? '' : externalIdOf(g);
  const bad = {
    date: !(typeof g.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.date) && R.roster.realDate(g.date) && g.date >= today && g.date <= last),
    start: !blank(g.start) && !(typeof g.start === 'string' && TIME_RE.test(g.start.trim())),
    tour: !(tour && tour.length <= 80 && !CTRL.test(tour) && !LINKISH.test(tour)),
    people: !(Number.isInteger(people) && people >= 1 && people <= R.roster.MAX_PEOPLE),
    lead_name: !(name && name.length <= 60 && !NAME_BAD.test(name)),
    lead_email: !blank(g.lead_email) && !(typeof g.lead_email === 'string' && email && R.roster.emailOk(email)),
    lead_phone: !blank(g.lead_phone) && !(typeof g.lead_phone === 'string' && phone.length <= 30 && PHONE.test(phone)),
    lang: !blank(g.lang) && !(typeof g.lang === 'string' && R.roster.LANGS.includes(g.lang.trim())),
    note: !blank(g.note) && !(typeof g.note === 'string' && g.note.length <= 400),
    external_id: !blank(g.external_id) && !ext
  };
  const fields = [...FIELDS.filter(k => bad[k]), ...new Set(Object.keys(g).filter(k => !FIELDS.includes(k)).map(shownName))].slice(0, MAX_FIELDS_SHOWN);
  if (fields.length) return { ok: false, fields };
  /* 健康のことはここでは受けない。メモに書かれていたら、名簿に入れる前に外す（サイトの予約フォームと同じ決まり） */
  const note = blank(g.note) ? '' : R.healthRedact.redact(g.note).text.slice(0, 400);
  return {
    ok: true,
    booking: { date: g.date, start: blank(g.start) ? '' : g.start.trim(), tour: tour.slice(0, 80), people, leadName: name, leadEmail: email, leadPhone: phone,
      lang: blank(g.lang) ? 'ja' : g.lang.trim(), note, externalId: ext }
  };
}

/* 確かめた予約を名簿に入れ、予定を作る直し。同じ日・同じ種類・同じ開始時刻の便があればそこへ、無ければ便を作る。label は鍵の名前（予約の「予約サイト」の欄に出る）。
   { state, bookingId } */
export function addIntakeBooking(state, { booking, label, at, nowJst, newId }) {
  const C = R.rosterCore;
  const want = { date: booking.date, start: booking.start, tour: booking.tour.slice(0, 40), kind: '' };
  const sug = C.suggestTrip(state, want);
  const given = { source: 'form', site: label.slice(0, 40), ref: booking.externalId, leadName: booking.leadName, leadPhone: booking.leadPhone, leadEmail: booking.leadEmail,
    lang: booking.lang, people: booking.people, note: booking.note };
  const added = C.addBookingToTrip(state, { tripId: sug.tripId || '', want: { ...want, kind: sug.kind }, booking: given, reading: null, src: 'guest', at, newId });
  const made = added.state.bookings[added.state.bookings.length - 1];
  const lead = added.state.people.find(p => p.bookingId === made.id);
  const named = C.editPerson(added.state, { id: lead.id, patch: { name: booking.leadName }, who: 'guest', src: 'guest', at });
  return { state: R.rosterAuto.planJobs(named, { bookingId: made.id, nowJst, newId }), bookingId: made.id };
}

/* ---------- API キーの管理（スタッフの画面。Access の内） ---------- */
const KEY_ID = /^[a-z0-9]{1,40}$/;

/* 連携先の名前。1〜40 字、制御文字と URL は不可。{ ok: true, label } か { ok: false } */
export function checkLabel(v) {
  const label = typeof v === 'string' ? v.trim() : '';
  return label && label.length <= LABEL_MAX && !CTRL.test(label) && !LINKISH.test(label) ? { ok: true, label } : { ok: false };
}

/* 本文は { action: 'create', label } | { action: 'rotate', id } | { action: 'revoke', id } のどれか 1 つだけ */
export function checkKeyAction(given) {
  if (!isObj(given) || typeof given.action !== 'string') return { ok: false, error: 'shape' };
  const keys = Object.keys(given).sort().join();
  if (given.action === 'create') {
    if (keys !== 'action,label') return { ok: false, error: 'keys' };
    const l = checkLabel(given.label);
    return l.ok ? { ok: true, action: 'create', label: l.label } : { ok: false, error: 'label' };
  }
  if (given.action === 'rotate' || given.action === 'revoke') {
    if (keys !== 'action,id') return { ok: false, error: 'keys' };
    return typeof given.id === 'string' && KEY_ID.test(given.id) ? { ok: true, action: given.action, id: given.id } : { ok: false, error: 'id' };
  }
  return { ok: false, error: 'action' };
}
