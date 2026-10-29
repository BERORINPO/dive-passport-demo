/* 書類の自動化をサーバーで動かす決まり（core）。外のもの（通信・D1・時計・暗号）は使わない。今日と今の時刻は受け取る。
   予定を動かすのは画面と同じ js/roster-auto.js。ここでは、サイトの予約フォームから届く本文（POST /api/bookings）と、
   届いた予約メールの本文（email()）を確かめて、名簿を直す関数（名簿 → 名簿）にする。計画は plan/auto.md */
import '../js/roster-schema.js';
import '../js/health-redact.js';
import '../js/roster-core.js';
import '../js/roster-share.js';
import '../js/roster-guest.js';
import '../js/roster-auto.js';
import { MAX_ROSTER_BYTES } from './sync-core.mjs';

const R = globalThis.REDUX;

/* 予約フォームの本文の上限（plan/auto.md）と、届いたメールの上限（これより大きいメールは読まない） */
export const MAX_BOOKING_BODY = 4096;
export const MAX_MAIL_BYTES = 256 * 1024;
/* 予約を受ける先の日: 今日から 1 年と少し先まで */
export const MAX_DAYS_AHEAD = 400;
/* 外から入る予約（サイトのフォーム・届いたメール）の守り（ザクのレビュー 2026-10-27 H-1・M-5）:
   1 件の人数、1 日の件数、名簿がこの割合を超えたら外からは入れない（お店自身の書き込みの分を残す） */
export const SITE_MAX_PEOPLE = 10;
export const SITE_DAILY_MAX = 30;
export const MAIL_DAILY_MAX = 30;
/* 全店あわせた 1 日の上限。メールは AI を呼ぶので、AI の 1 日の回数（DAILY_LIMIT 200）より十分小さく（ザクのレビュー 2026-10-27） */
export const SITE_DAILY_MAX_ALL = 300;
export const MAIL_DAILY_MAX_ALL = 60;
const PUBLIC_FILL = 0.7;
export const roomForPublic = (text) => new TextEncoder().encode(text).byteLength <= MAX_ROSTER_BYTES * PUBLIC_FILL;

/* js/data.js の R.TOURS のうち、予約を名簿に入れるのに使う所だけ（test/auto-worker.test.mjs が data.js とそろっているか確かめる） */
export const TOURS = [
  { id: 'dive', diving: true, start: '08:30', name: { ja: '体験ダイビング（ボート・2 本）' } },
  { id: 'snorkel', diving: false, start: '09:00', name: { ja: 'ボートスノーケル（1 回）' } }
];
/* js/data.js の R.SWIM・R.WORRIES の id と日本語、R.EXP の id（同じテストが確かめる）。泳ぎと心配なことは、予約のメモの頭に残す */
export const SWIM_JA = { none: '泳げない', shallow: '足のつく所なら泳げる', '25m': '25 m くらい泳げる', good: '泳ぎは得意' };
export const WORRY_JA = { face: '水に顔をつけるのが苦手', deep: '深い所が怖い', ears: '耳抜きが心配', seasick: '船酔いしやすい' };
export const SWIM = Object.keys(SWIM_JA);
export const EXP = ['first', 'few', 'card'];
export const WORRIES = Object.keys(WORRY_JA);

const BOOKING_KEYS = ['tour', 'date', 'people', 'name', 'email', 'lang', 'swim', 'exp', 'dives', 'worries', 'phone', 'note'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length <= max;
export const PHONE = /^[0-9+()\- ]{0,30}$/;
/* 名前はお客さんへのメールの 1 行目に入る。改行・制御文字・URL やドメインらしい字は断る（お店の名前で釣りのメールを出させない。ザクのレビュー 2026-10-27 M-2） */
export const NAME_BAD = /[\u0000-\u001f\u007f\u2028\u2029]|:\/\/|www\.|[a-z0-9-]+\.[a-z]{2,}/i;

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
    !(Number.isInteger(g.people) && g.people >= 1 && g.people <= SITE_MAX_PEOPLE) && 'people',
    !(name && name.length <= 60 && !NAME_BAD.test(name)) && 'name',
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
  /* 健康のことはサイトでは聞かない。メモに書かれていたら、名簿に入れる前に外す（AI に送る前と同じ決まり）。
     泳ぎと心配なこと（船酔いなど）は、お店が当日に気づけるようにメモの頭に残す */
  const told = [g.swim && `泳ぎ: ${SWIM_JA[g.swim]}`, g.worries && g.worries.length && `心配: ${g.worries.map(w => WORRY_JA[w]).join('・')}`].filter(Boolean).join('／');
  const typed = g.note ? R.healthRedact.redact(g.note).text : '';
  const note = [told, typed].filter(Boolean).join('\n').slice(0, 400);
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

/* ---------- 届いたメールの送り主の確かめ（ザクのレビュー 2026-10-28 SEC-01・02・04） ----------
   見出しの Authentication-Results は message.headers からは読まない（同じ名前が何本あっても「, 」でつながり、送り主が足した行と見分けがつかない）。
   生のメールの見出しを自分で切り出し、一番上の Authentication-Results のうち authserv-id が MAIL_AUTHSERV_ID（Cloudflare の名前）の 1 本だけを使う。
   そのうえで、次を全部満たしたときだけ受ける。
   1. 転送の書き換え（Gmail の +caf_=、Microsoft 365 の +SRS=）を戻した封筒の From が、許した送り主の表にある
   2. SPF が pass で、smtp.mailfrom が封筒の From と完全に同じ（その送り主のサーバーから来た証拠。DKIM だけでは流し直せるので受けない）
   3. 見出しの From（1 本だけ・アドレス 1 つ）が、次のどちらか
      a. 書き換えのない封筒で、見出しの From のドメインが封筒のドメインと同じ（送り主が自分で書いたメール）
      b. そのドメインで DKIM が pass（header.d が完全に同じ）で、表に「@ドメイン」と書いてある（転送された予約サイトの通知）
   Cloudflare の文書は、受信時に送り主の Authentication-Results を消すかも、付ける名前も書いていない。分からない所は通さない側に倒した */

const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();
const HEADER_NAME = /^[\x21-\x39\x3b-\x7e]+$/;   // 印字できる ASCII（「:」以外）
const ADDRESS = /^[^@\s]+@[a-z0-9][a-z0-9.-]*$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/;

/* 見出しを上から並べる { name（小文字）, value }。見出しと本文の境は最初の空行。空白で始まる行は前の見出しの続き（つなぐ）。
   見出しの形でない行は捨て、その続きの行も前の見出しにはつなげない（Cloudflare が付けた行の直後に、送り主の行を継ぎ足させない） */
export function headerList(raw) {
  const text = String(raw || '');
  const cut = text.match(/\r?\n\r?\n/);
  const out = [];
  let last = null;
  for (const line of (cut ? text.slice(0, cut.index) : text).split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) { if (last) last.value += ` ${line.trim()}`; continue; }
    const i = line.indexOf(':');
    const name = i > 0 ? line.slice(0, i).replace(/[ \t]+$/, '') : '';
    last = HEADER_NAME.test(name) ? { name: name.toLowerCase(), value: line.slice(i + 1).trim() } : null;
    if (last) out.push(last);
  }
  return out;
}

/* 「;」で区切る。引用符の中とコメント（括弧、入れ子あり）の中では区切らず、コメントは空白にする。引用符・括弧が閉じていなければ null */
function authSegments(text) {
  const segs = [];
  let cur = '';
  let quote = false;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === '\\') { i += 1; if (i >= text.length) return null; cur += text[i]; } else if (c === '"') quote = false;
    } else if (depth) {
      if (c === '\\') i += 1; else if (c === '(') depth += 1; else if (c === ')') depth -= 1;
    } else if (c === '"') { quote = true; cur += c; } else if (c === '(') { depth = 1; cur += ' '; } else if (c === ';') { segs.push(cur); cur = ''; } else cur += c;
  }
  if (quote || depth) return null;
  segs.push(cur);
  return segs;
}

/* 空白で区切る（引用符の中は区切らない） */
function tokensOf(seg) {
  const out = [];
  let cur = '';
  let quote = false;
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (quote) {
      cur += c;
      if (c === '\\') { i += 1; cur += seg[i] || ''; } else if (c === '"') quote = false;
    } else if (c === '"') { quote = true; cur += c; } else if (/\s/.test(c)) { if (cur) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const unquote = (v) => (/^".*"$/s.test(v) ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v);

/* Authentication-Results の値（RFC 8601）を { id, results: [{ method, result, props }] } にする。形が合わない物は丸ごと null（半端に読まない） */
export function parseAuthResults(value) {
  const text = String(value || '');
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text)) return null;
  const segs = authSegments(text);
  if (!segs) return null;
  const head = tokensOf(segs[0]);
  const id = lower(head[0]);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(id) || head.length > 2 || (head.length === 2 && !/^\d+$/.test(head[1]))) return null;
  const results = [];
  for (const seg of segs.slice(1)) {
    const t = tokensOf(seg);
    if (!t.length || (t.length === 1 && lower(t[0]) === 'none')) continue;
    const m = /^([a-z0-9][a-z0-9-]*)(?:\/\d+)?=([a-z]+)$/i.exec(t[0]);
    if (!m) return null;
    const props = Object.create(null);
    for (const p of t.slice(1)) {
      const kv = /^([a-z0-9][a-z0-9._-]*)=([^]*)$/i.exec(p);
      if (!kv) return null;
      if (!(lower(kv[1]) in props)) props[lower(kv[1])] = unquote(kv[2]);
    }
    results.push({ method: lower(m[1]), result: lower(m[2]), props });
  }
  return { id, results };
}

/* 使ってよい Authentication-Results の結果。一番上の 1 本が Cloudflare の名前で、同じ名前の物がほかに無いときだけ。
   { ok: true, results } か { ok: false, why }（why: config = 名前の設定が無い／no-header = 無い／top = 一番上が Cloudflare の物でない／dup = 同じ名前が 2 本以上） */
export function trustedAuth(raw, authservId) {
  const id = lower(authservId);
  if (!id) return { ok: false, why: 'config' };
  const found = headerList(raw).filter(h => h.name === 'authentication-results');
  if (!found.length) return { ok: false, why: 'no-header' };
  const top = parseAuthResults(found[0].value);
  if (!top || top.id !== id) return { ok: false, why: 'top' };
  if (found.slice(1).some(h => lower(h.value.split(';')[0]).split(/\s+/)[0] === id)) return { ok: false, why: 'dup' };
  return { ok: true, results: top.results };
}

/* 転送で書き換わった封筒の From を、転送した人のアドレスに戻す。決まった形だけ（Gmail: <人>+caf_=<宛先>@gmail.com、
   Microsoft 365: <人>+SRS=<hash>=<時刻>=<元のドメイン>=<元の名前>@<ドメイン>）。戻しても、SPF の確かめは書き換わった全体で行う */
export function forwarderOf(from) {
  const e = lower(from);
  const gmail = /^([^@\s+][^@\s]*?)\+caf_=[^@\s]+@gmail\.com$/.exec(e);
  if (gmail) return { forwarder: `${gmail[1]}@gmail.com`, rewritten: true };
  const srs = /^([^@\s+][^@\s]*?)\+srs=[^=@\s]+=[^=@\s]+=[^=@\s]+=[^@\s]+@([^@\s]+)$/.exec(e);
  if (srs) return { forwarder: `${srs[1]}@${srs[2]}`, rewritten: true };
  return { forwarder: e, rewritten: false };
}

/* 見出しの From のドメイン。From が 1 本で、アドレスが 1 つだけのときだけ（複数・グループ・解釈が分かれる形は ''）。表示名とコメントは見ない */
export function headerFromDomain(headers) {
  const froms = headers.filter(h => h.name === 'from');
  if (froms.length !== 1) return '';
  let t = froms[0].value.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/\([^()]*\)/g, ' '); }
  const m = /^[^<>@,;:"()\\]*<([^<>\s,;:"()\\]+)>\s*$/.exec(t) || /^\s*([^<>\s,;:"()\\]+)\s*$/.exec(t);
  const at = m ? m[1].lastIndexOf('@') : -1;
  const domain = at > 0 ? lower(m[1].slice(at + 1)) : '';
  return DOMAIN.test(domain) ? domain : '';
}

const senderList = (list) => String(list || '').split(',').map(lower).filter(Boolean);

/* 届いたメールが、許した送り主から本当に来たか。{ ok: true, via: 'own' | 'relay' } か { ok: false, why }。
   raw は見出しつきの生のメール、envelope は封筒の From、senders は表（「,」区切り。「a@b」は送り主、「@d」は転送を受ける予約サイトのドメイン） */
export function senderVerdict({ raw, envelope, senders, authservId }) {
  const auth = trustedAuth(raw, authservId);
  if (!auth.ok) return auth;
  const env = lower(envelope);
  const { forwarder, rewritten } = forwarderOf(env);
  const list = senderList(senders);
  if (!ADDRESS.test(env) || !list.includes(forwarder)) return { ok: false, why: 'sender' };
  const fromDomain = headerFromDomain(headerList(raw));
  if (!fromDomain) return { ok: false, why: 'from' };
  /* SPF は封筒の送り主（smtp.mailfrom）の結果だけを見る。Cloudflare は helo の結果（spf=none smtp.helo=…）も同じ見出しに並べる
     （2026-10-28、本番に届いた Gmail の 1 通で確かめた: dkim, dmarc, spf=none, spf=pass, arc）。mailfrom の結果が 1 つでなければ断る */
  const spf = auth.results.filter(r => r.method === 'spf' && r.props['smtp.mailfrom'] !== undefined);
  if (spf.length !== 1 || spf[0].result !== 'pass' || lower(spf[0].props['smtp.mailfrom']) !== env) return { ok: false, why: 'spf' };
  if (!rewritten && fromDomain === env.split('@')[1]) return { ok: true, via: 'own' };
  const signed = auth.results.some(r => r.method === 'dkim' && r.result === 'pass' && lower(r.props['header.d']) === fromDomain);
  if (signed && list.includes(`@${fromDomain}`)) return { ok: true, via: 'relay' };
  return { ok: false, why: 'origin' };
}

/* 届いたメールの送り主（封筒の From）を、許した送り主の表と比べる。表は「,」区切り。大文字小文字は見ない（「@ドメイン」の行は送り主ではない） */
export function senderAllowed(from, list) {
  return senderList(list).filter(s => !s.startsWith('@')).includes(lower(from));
}

/* ---------- 時刻が来た予定と、送る連絡 ---------- */

/* 送る物（status が queued のもの）。1 回に送る数の上限つき */
export const MAX_SEND_PER_RUN = 50;
export const queuedOf = (state) => (state.outbox || []).filter(o => o.status === 'queued' && o.to && !o.why.startsWith(SENDING)).slice(0, MAX_SEND_PER_RUN);

/* 送る前の印（ジンのレビュー 2026-10-27 MEDIUM 10）。送る前に why を「sending:<時刻>#<この回の印>」にして名簿に書き、送った後で結果を書く。
   結果を書けなかった連絡は、印が残ったまま queuedOf に選ばれないので、もう一度は送らない。SENDING_STALE_MS を過ぎても印が残っている物は
   「送れたか分からない」（failed / maybe-sent）にして、お店に確かめてもらう（2 回送るより、お店に見せる方を選ぶ） */
export const SENDING = 'sending:';
export const SENDING_STALE_MS = 30 * 60 * 1000;
/* 1 回に印を付ける数。途中で Worker が止まると、印を付けた物は全部「送れたか分からない」になるので、小さく区切る（残りは次の回。ジンのレビュー） */
export const CLAIM_MAX = 10;
export function claimQueued(state, { token }) {
  const ids = new Set(queuedOf(state).slice(0, CLAIM_MAX).map(o => o.id));
  if (!ids.size) return state;
  return { ...state, outbox: state.outbox.map(o => (ids.has(o.id) ? { ...o, why: `${SENDING}${token}` } : o)) };
}
export const claimedBy = (state, token) => (state.outbox || []).filter(o => o.status === 'queued' && o.why === `${SENDING}${token}`);
/* before は「YYYY-MM-DDTHH:MM:SSZ」。印の時刻（同じ形）がそれより前の物を、送れたか分からないにする（core は時計を使わないので、文字のまま比べる） */
export function releaseStale(state, { before, at }) {
  const stale = (state.outbox || []).filter(o => o.status === 'queued' && o.why.startsWith(SENDING) &&
    o.why.slice(SENDING.length, SENDING.length + 20) < before);
  return stale.reduce((s, o) => R.rosterAuto.markSent(s, { id: o.id, result: 'failed', why: 'maybe-sent', at }), state);
}

/* 送った結果を名簿に付ける直し。results は [{ id, result, why }] */
export function markResults(state, { results, at }) {
  return results.reduce((s, r) => R.rosterAuto.markSent(s, { id: r.id, result: r.result, why: r.why, at }), state);
}

/* 時刻が来た予定を動かす直し（js/roster-auto.js の runDue） */
export const runDue = (state, opts) => R.rosterAuto.runDue(state, opts).state;

/* ---------- 読めなかった予約メール（plan/auto.md。ジンのレビュー 2026-10-27 HIGH 6） ---------- */

/* 残す日数・画面に出す数・1 お店で 1 日に残す数の上限（同じ送り主から大量に届いても、表が育たないように） */
export const UNREAD_KEEP_DAYS = 30;
export const UNREAD_SHOW_MAX = 50;
export const UNREAD_DAILY_MAX = 60;
/* 画面に出す理由の言葉 */
export const UNREAD_WHY = ['limit', 'size', 'text', 'no-date', 'full', 'roster', 'error', 'ai', 'many'];   // many: その日は上限を超えて、ほかにもあった

/* 届いたメールを名簿に入れられなかった理由（ログの note.why）を、画面に出す短い言葉にする。
   宛先・送り主・送り主のドメインの確かめで断ったメールと、設定の誤りは残さない（null。お店のメールとは限らないため） */
/* 外の死活監視が見る「Cron が最後に動いた時刻」。45 分より古い（Cron は 1 分ごと。15 分ごとだった頃の 3 回分のまま）・無い・壊れていれば止まっている（点検 2026-10-28 運用 C2）。
   時計は読まない: 呼ぶ側が「これより新しければ良い」時刻（since、ISO）を渡す */
export const CRON_STALE_MS = 45 * 60 * 1000;
const ISO_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export function cronFresh(text, since) {
  let last = null;
  try { last = text ? JSON.parse(text) : null; } catch (e) { last = null; }
  const at = last && typeof last.at === 'string' && ISO_AT.test(last.at) ? last.at : '';
  return { ok: Boolean(at) && at >= since, at };
}

export function unreadWhy(why) {
  if (!why || ['inbox', 'sender', 'auth', 'config'].includes(why)) return null;
  if (why === 'mail-daily') return 'limit';
  if (why === 'size') return 'size';
  if (why === 'empty' || why === 'no-text' || why.startsWith('input-')) return 'text';
  if (why === 'no-date') return 'no-date';
  if (why === 'add-full') return 'full';
  if (why.startsWith('add-')) return 'roster';
  if (why === 'crash') return 'error';
  return 'ai';   // AI の上限・答えの形・届かない
}
