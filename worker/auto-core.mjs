/* 書類の自動化をサーバーで動かす決まり（core）。外のもの（通信・D1・時計・暗号）は使わない。今日と今の時刻は受け取る。
   予定を動かすのは画面と同じ js/roster-auto.js。ここでは、サイトの予約フォームから届く本文（POST /api/bookings）と、
   届いた予約メールの本文（email()）を確かめて、名簿を直す関数（名簿 → 名簿）にする。計画は plan/auto.md */
import '../js/roster-schema.js';
import '../js/health-redact.js';
import '../js/roster-core.js';
import '../js/roster-share.js';
import '../js/roster-guest.js';
import '../js/roster-auto.js';

const R = globalThis.REDUX;

/* 予約フォームの本文の上限（plan/auto.md）と、届いたメールの上限（これより大きいメールは読まない） */
export const MAX_BOOKING_BODY = 4096;
export const MAX_MAIL_BYTES = 256 * 1024;
/* 予約を受ける先の日: 今日から 1 年と少し先まで */
const MAX_DAYS_AHEAD = 400;

/* js/data.js の R.TOURS のうち、予約を名簿に入れるのに使う所だけ（test/auto-worker.test.mjs が data.js とそろっているか確かめる） */
export const TOURS = [
  { id: 'dive', diving: true, start: '08:30', name: { ja: '体験ダイビング（ボート・2 本）' } },
  { id: 'snorkel', diving: false, start: '09:00', name: { ja: 'ボートスノーケル（1 回）' } }
];
/* js/data.js の R.SWIM・R.EXP・R.WORRIES の id（同じテストが確かめる） */
export const SWIM = ['none', 'shallow', '25m', 'good'];
export const EXP = ['first', 'few', 'card'];
export const WORRIES = ['face', 'deep', 'ears', 'seasick'];

const BOOKING_KEYS = ['tour', 'date', 'people', 'name', 'email', 'lang', 'swim', 'exp', 'dives', 'worries', 'phone', 'note'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length <= max;
const PHONE = /^[0-9+()\- ]{0,30}$/;

/* 予約フォームの本文を確かめる。返すのは { ok, booking } か { ok: false, error }（error はログに出す短い名前だけ） */
export function checkBooking(given, { today }) {
  if (!isObj(given)) return { ok: false, error: 'shape' };
  if (!Object.keys(given).every(k => BOOKING_KEYS.includes(k))) return { ok: false, error: 'keys' };
  const g = given;
  const tour = TOURS.find(t => t.id === g.tour);
  const last = R.rosterAuto.dayAdd(today, MAX_DAYS_AHEAD);
  const name = typeof g.name === 'string' ? g.name.trim() : '';
  const email = typeof g.email === 'string' ? g.email.trim() : '';
  const problems = [
    !tour && 'tour',
    !(str(g.date, 10) && /^\d{4}-\d{2}-\d{2}$/.test(g.date) && g.date >= today && g.date <= last) && 'date',
    !(Number.isInteger(g.people) && g.people >= 1 && g.people <= R.roster.MAX_PEOPLE) && 'people',
    !(name && name.length <= 60) && 'name',
    !(email && R.roster.emailOk(email)) && 'email',
    g.lang !== undefined && !R.roster.LANGS.includes(g.lang) && 'lang',
    g.swim !== undefined && !SWIM.includes(g.swim) && 'swim',
    g.exp !== undefined && !EXP.includes(g.exp) && 'exp',
    g.dives !== undefined && !(str(g.dives, 5) && /^\d{0,5}$/.test(g.dives)) && 'dives',
    g.worries !== undefined && !(Array.isArray(g.worries) && g.worries.length <= WORRIES.length && g.worries.every(w => WORRIES.includes(w))) && 'worries',
    g.phone !== undefined && !(str(g.phone, 30) && PHONE.test(g.phone)) && 'phone',
    g.note !== undefined && !str(g.note, 400) && 'note'
  ].filter(Boolean);
  if (problems.length) return { ok: false, error: problems.slice(0, 3).join(',') };
  /* 健康のことはサイトでは聞かない。メモに書かれていたら、名簿に入れる前に外す（AI に送る前と同じ決まり） */
  const note = g.note ? R.healthRedact.redact(g.note).text.slice(0, 400) : '';
  return {
    ok: true,
    booking: {
      tour, phone: (g.phone || '').trim(), note,
      intake: { tour: tour.id, date: g.date, people: g.people, name, email, lang: g.lang || 'ja', exp: g.exp || '', dives: g.dives || '' }
    }
  };
}

/* 確かめた予約を名簿に入れ、予定を作る直し。{ state, bookingId } */
export function addSiteBooking(state, { booking, at, nowJst, newId }) {
  const out = R.rosterAuto.addFromForm(state, { intake: booking.intake, tour: booking.tour, at, nowJst, newId });
  const patch = { ...(booking.phone ? { leadPhone: booking.phone } : {}), ...(booking.note ? { note: booking.note } : {}) };
  if (!Object.keys(patch).length) return out;
  return { ...out, state: { ...out.state, bookings: out.state.bookings.map(b => (b.id === out.bookingId ? { ...b, ...patch } : b)) } };
}

/* ---------- 届いたメール（MIME）から本文の文字を取り出す ---------- */

/* 見出しと本文を分ける。見出しは小文字の名前 → 値（折り返しをつなぐ） */
function splitPart(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = {};
  head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/).forEach(line => {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in headers)) headers[k] = line.slice(i + 1).trim(); }
  });
  return { headers, body };
}

const param = (value, name) => {
  const m = String(value || '').match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i'));
  return m ? (m[1] ?? m[2]) : '';
};

/* 送るときの符号（base64・quoted-printable）を外し、文字の符号（charset）で読む。読めない charset は UTF-8 で読む */
function decodeBody(body, headers) {
  const enc = String(headers['content-transfer-encoding'] || '').toLowerCase();
  let bytes;
  if (enc === 'base64') {
    try { bytes = Uint8Array.from(atob(body.replace(/[^A-Za-z0-9+/=]/g, '')), c => c.charCodeAt(0)); } catch (e) { return ''; }
  } else if (enc === 'quoted-printable') {
    const soft = body.replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < soft.length; i += 1) {
      if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) { out.push(parseInt(soft.slice(i + 1, i + 3), 16)); i += 2; } else out.push(soft.charCodeAt(i) & 0xFF);
    }
    bytes = Uint8Array.from(out);
  } else {
    bytes = Uint8Array.from(body, c => c.charCodeAt(0) & 0xFF);
  }
  const charset = param(headers['content-type'], 'charset') || 'utf-8';
  try { return new TextDecoder(charset).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
}

const fromHtml = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
  .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/* 1 つの部分から文字を探す。text/plain を先に、無ければ text/html の字だけ。添付は読まない。入れ子は 3 段まで */
function textOf(part, depth) {
  const type = String(part.headers['content-type'] || 'text/plain').toLowerCase();
  if (/^attachment/i.test(part.headers['content-disposition'] || '')) return null;
  if (type.startsWith('multipart/')) {
    const boundary = param(part.headers['content-type'], 'boundary');
    if (!boundary || depth >= 3) return null;
    const parts = part.body.split(`--${boundary}`).slice(1).filter(p => !p.startsWith('--')).map(p => splitPart(p.replace(/^\r?\n/, '')));
    const found = parts.map(p => ({ p, t: String(p.headers['content-type'] || 'text/plain').toLowerCase() }));
    const plain = found.find(x => x.t.startsWith('text/plain'));
    if (plain) return textOf(plain.p, depth + 1);
    for (const x of found) { const t = textOf(x.p, depth + 1); if (t) return t; }
    return null;
  }
  if (type.startsWith('text/plain')) return decodeBody(part.body, part.headers);
  if (type.startsWith('text/html')) return fromHtml(decodeBody(part.body, part.headers));
  return null;
}

/* 届いたメール（見出しつきの生の文字。バイトは latin1 で 1 文字ずつ）から、AI に読ませる本文を取り出す。{ ok, text } か { ok: false, error } */
export function mailText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'empty' };
  const text = (textOf(splitPart(raw), 0) || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return { ok: false, error: 'no-text' };
  return { ok: true, text: text.slice(0, R.roster.MAX_TEXT) };
}

/* 届いたメールの送り主（封筒の From）を、許した送り主の表と比べる。表は「,」区切り。大文字小文字は見ない */
export function senderAllowed(from, list) {
  const allowed = String(list || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(String(from || '').trim().toLowerCase());
}

/* ---------- 時刻が来た予定と、送る連絡 ---------- */

/* 送る物（status が queued のもの）。1 回に送る数の上限つき */
export const MAX_SEND_PER_RUN = 50;
export const queuedOf = (state) => (state.outbox || []).filter(o => o.status === 'queued' && o.to).slice(0, MAX_SEND_PER_RUN);

/* 送った結果を名簿に付ける直し。results は [{ id, result, why }] */
export function markResults(state, { results, at }) {
  return results.reduce((s, r) => R.rosterAuto.markSent(s, { id: r.id, result: r.result, why: r.why, at }), state);
}

/* 時刻が来た予定を動かす直し（js/roster-auto.js の runDue） */
export const runDue = (state, opts) => R.rosterAuto.runDue(state, opts).state;
