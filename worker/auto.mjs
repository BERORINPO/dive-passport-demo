/* 書類の自動化の入口（entry）。Cron（scheduled）・届いた予約メール（email()）・サイトの予約フォーム（POST /api/bookings の中身）を、
   名簿の正本（D1）につなぐだけ。決まりは auto-core.mjs と js/roster-auto.js、外との境目は roster-db・mail・site-guard・ask。計画は plan/auto.md。
   ログは 1 回 1 行で、道の名前・数・止まった理由だけ（宛先・名前・本文は出さない） */
import { getRoster, putRoster } from './roster-db.mjs';
import { checkPut, readStored, SHOP_DEFAULT } from './sync-core.mjs';
import { checkRequest, periods } from './read-core.mjs';
import { checkBooking, addSiteBooking, mailText, senderAllowed, authPassed, queuedOf, markResults, runDue, roomForPublic,
  MAX_MAIL_BYTES, SITE_DAILY_MAX, MAIL_DAILY_MAX, SITE_DAILY_MAX_ALL, MAIL_DAILY_MAX_ALL } from './auto-core.mjs';
import { takeDaily } from './budget.mjs';
import { listShops, rosterShops } from './shop-db.mjs';
import { shopForRecipient, sendersOf, knownShop, nameOf, withShopName } from './shop-core.mjs';
import { mailReady, sendOne } from './mail.mjs';
import { askModel } from './ask.mjs';
import { mintLink, dropExpired } from './ask-db.mjs';
import { linkExpiry } from './ask-core.mjs';

const R = globalThis.REDUX;
const JST_MS = 9 * 3600 * 1000;
/* 名簿を書くとき、別の端末と同時になったら読み直して当て直す回数 */
const TRIES = 3;

export function clockOf(io) {
  const now = io.now();
  return { at: new Date(now).toISOString(), nowJst: new Date(now + JST_MS).toISOString().slice(0, 16), today: periods(now).day };
}
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dbReady = (env) => Boolean(env.DB && typeof env.DB.prepare === 'function');
/* お客さんへの連絡のリンクの所は印（LINK_MARK）のまま名簿に残し、送る直前に予約ごとの鍵のリンクを作って差し替える。
   作り直すと前のリンクは開けなくなる（2 日前の連絡を送ったら、最初の連絡のリンクは止まる） */
async function withLink(env, io, state, item, shop) {
  const mark = R.rosterAuto.LINK_MARK;
  if (!mailReady(env) || !item.body.includes(mark)) return item;
  const { today, at } = clockOf(io);
  const trip = state.trips.find(t => t.id === item.tripId);
  const url = await mintLink(env.DB, { shop, bookingId: item.bookingId, personId: '', expiresOn: linkExpiry(trip, today), at, base: env.ASK_ORIGIN || env.APP_URL });
  return { ...item, body: item.body.split(mark).join(url) };
}

/* 名簿を読み、直し（名簿 → { state, … }）を当てて、版を確かめて書く。ぶつかったら読み直して当て直す。
   書く前に、画面から届いた名簿と同じ検査（sync-core.mjs の checkPut）にかける。返すのは { ok, state, out } か { ok: false, why }。
   fromOutside（サイトの予約・届いたメール）のときは、名簿が上限の 7 割を超えたら書かない（why: 'full'。お店自身の書き込みの分を残す）。
   shop はどのお店の名簿か（一覧が空なら default）、name はお店の一覧の名前（名簿がまだ無いときと、名前をそろえるときに使う） */
export async function changeRoster(env, io, change, { fromOutside = false, shop = SHOP_DEFAULT, name = '' } = {}) {
  const { at, today } = clockOf(io);
  for (let i = 0; i < TRIES; i += 1) {
    const got = await getRoster(env.DB, shop);
    const current = got.text === null ? R.roster.blankState(name || env.SHOP_NAME || '') : readStored(got.text, { today, at });
    if (!current) return { ok: false, why: 'stored' };
    const out = change(current);
    if (out.state === current) return { ok: true, state: current, out };
    const checked = checkPut({ base: got.version, state: withShopName(out.state, name) }, { today, at });
    if (!checked.ok) return { ok: false, why: checked.error.slice(0, 40) };
    if (fromOutside && !roomForPublic(checked.text)) return { ok: false, why: 'full' };
    const put = await putRoster(env.DB, shop, got.version, checked.text, at);
    if (put.ok) return { ok: true, state: checked.state, out };
  }
  return { ok: false, why: 'conflict' };
}

/* 時刻が来た予定を動かし、送る物を送って、結果を名簿に付ける。呼ぶのは Cron だけ（外からの入口では送らない。
   重なって走ると同じ連絡を 2 回送り、リンクも作り直されるため。ザクのレビュー 2026-10-27 M-1）。
   送ったあとに結果を書けなかったときは、次の回にもう一度送る（送り損ねるより、重なる方を選ぶ） */
export async function runAutomation(env, io, note, shop = SHOP_DEFAULT) {
  const { at, nowJst } = clockOf(io);
  const moved = await changeRoster(env, io, s => ({ state: runDue(s, { nowJst, at, newId, askBase: '' }) }), { shop });
  if (!moved.ok) { note.why = `due-${moved.why}`; return; }
  const queued = queuedOf(moved.state);
  note.queued = queued.length;
  if (!queued.length) return;
  const results = [];
  for (const item of queued) results.push(await sendOne(env, await withLink(env, io, moved.state, item, shop), moved.state.shop.name));
  note.sent = results.filter(r => r.result === 'sent').length;
  const marked = await changeRoster(env, io, s => ({ state: markResults(s, { results, at }) }), { shop });
  if (!marked.ok) note.why = `mark-${marked.why}`;
}

const logLine = (note, io, started) => console.log(JSON.stringify({ ...note, ms: io.now() - started }));

/* Cron（wrangler.jsonc の triggers）。名簿の正本が無ければ何もしない */
export async function scheduled(env, io) {
  const started = io.now();
  const note = { route: 'cron' };
  try {
    if (!dbReady(env)) note.why = 'config:DB';
    else {
      /* 名簿があるお店を 1 つずつ回る。1 店が失敗しても、ほかのお店は止めない */
      const directory = await listShops(env.DB);
      const shops = (await rosterShops(env.DB)).filter(shop => knownShop(directory, shop));
      note.shops = shops.length;
      note.queued = 0;
      note.sent = 0;
      for (const shop of shops) {
        const one = {};
        try { await runAutomation(env, io, one, shop); } catch (e) { one.why = 'crash'; }
        note.queued += one.queued || 0;
        note.sent += one.sent || 0;
        if (one.why) note.why = `${note.why ? `${note.why},` : ''}${shop}:${one.why}`.slice(0, 120);
      }
      await dropExpired(env.DB, clockOf(io).today);
    }
  } catch (e) {
    note.why = 'crash';
  }
  logLine(note, io, started);
}

/* 届いたメールの生の中身を、上限まで読む。バイトは 1 文字ずつ（latin1）にする。超えたら null */
async function readRaw(stream, max) {
  const reader = stream.getReader();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    for (let i = 0; i < value.length; i += 8192) text += String.fromCharCode.apply(null, value.subarray(i, i + 8192));
  }
  return text;
}

/* 届いた予約メールを AI に読ませ、名簿の便に入れて、お願いを送る。送り主は MAIL_SENDERS に書いた物だけ（封筒の From で見る）。
   読めなかったメールは断らない（予約サイトに戻ると困る）。ログに理由を残す */
export async function receiveMail(message, env, io) {
  const started = io.now();
  const note = { route: 'mail' };
  try {
    await takeMail(message, env, io, note);
  } catch (e) {
    note.why = 'crash';
  }
  logLine(note, io, started);
}

async function takeMail(message, env, io, note) {
  if (!dbReady(env) || !env.ANTHROPIC_API_KEY || !env.BUDGET) { note.why = 'config'; return; }
  /* どのお店の予約かは、届いた宛先（封筒の To）をお店の一覧で引いて決める。送り主はそのお店の送り主の表で確かめる
     （一覧が空なら MAIL_SENDERS。あるお店の転送元が、別のお店の受け口に予約を入れられないように。ザクのレビュー 2026-10-27） */
  const shops = await listShops(env.DB);
  const shop = shopForRecipient(shops, message.to);
  if (!shop) { note.why = 'inbox'; message.setReject('Unknown recipient'); return; }
  note.shop = shop;
  if (!senderAllowed(message.from, sendersOf(shops, shop, env.MAIL_SENDERS))) { note.why = 'sender'; message.setReject('Sender not accepted'); return; }
  const results = message.headers.get('authentication-results') || message.headers.get('arc-authentication-results') || '';
  if (!authPassed(results, message.from)) { note.why = 'auth'; message.setReject('Sender not authenticated'); return; }
  if (Number(message.rawSize) > MAX_MAIL_BYTES) { note.why = 'size'; return; }
  /* メールからの予約の 1 日の上限（全店あわせてと、お店ごと）。AI を呼ぶ前に数える（お店の読み取り /api/read の上限を食い尽くさせない） */
  const day = clockOf(io).today;
  if (!(await takeDaily(env.BUDGET, `mail:${day}`, MAIL_DAILY_MAX_ALL)) || !(await takeDaily(env.BUDGET, `mail:${shop}:${day}`, MAIL_DAILY_MAX))) {
    note.why = 'mail-daily';
    return;
  }
  const raw = await readRaw(message.raw, MAX_MAIL_BYTES);
  if (raw === null) { note.why = 'size'; return; }
  const mail = mailText(raw);
  if (!mail.ok) { note.why = mail.error; return; }
  const { today } = clockOf(io);
  const checked = checkRequest({ doc: 'mail', text: mail.text }, today);
  if (!checked.ok) { note.why = `input-${checked.error}`.slice(0, 40); return; }
  Object.assign(note, { size: checked.ask.size, redacted: checked.ask.redacted });
  const got = await askModel(checked.ask, env, io, note);
  if (!got.ok) return;
  /* 画面の「メールを貼る」と同じく、日付が読めた予約だけを自動で入れる（日付が無いものはお店が画面で入れる） */
  if (!got.reading.booking || !got.reading.booking.date) { note.why = 'no-date'; return; }
  const { at, nowJst } = clockOf(io);
  const added = await changeRoster(env, io, s => R.rosterAuto.addFromReading(s, { reading: got.reading, lang: '', at, nowJst, newId }),
    { fromOutside: true, shop, name: nameOf(shops, shop, '') });
  if (!added.ok) { note.why = `add-${added.why}`; return; }
  note.added = 1;   // お願いの連絡は次の Cron で送る
}

/* サイトの予約フォームから届いた本文（守りは handler.mjs が先にかける）。返すのは { status, body }。
   お願いの連絡は次の Cron（15 分ごと）で送る */
export async function takeSiteBooking(given, env, io, note, shop = SHOP_DEFAULT, name = '') {
  const { at, nowJst, today } = clockOf(io);
  const checked = checkBooking(given, { today });
  if (!checked.ok) { note.why = `input-${checked.error}`.slice(0, 40); return { status: 400, body: { error: 'input' } }; }
  if (!(await takeDaily(env.BUDGET, `site:${today}`, SITE_DAILY_MAX_ALL)) || !(await takeDaily(env.BUDGET, `site:${shop}:${today}`, SITE_DAILY_MAX))) {
    note.why = 'site-daily';
    return { status: 429, body: { error: 'limit' } };
  }
  const added = await changeRoster(env, io, s => addSiteBooking(s, { booking: checked.booking, at, nowJst, newId }), { fromOutside: true, shop, name });
  if (!added.ok) {
    note.why = `add-${added.why}`;
    return { status: added.why === 'conflict' || added.why === 'full' ? 503 : 500, body: { error: added.why === 'full' ? 'full' : 'roster' } };
  }
  note.added = 1;
  return { status: 202, body: { ok: true } };
}
