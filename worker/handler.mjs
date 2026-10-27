/* Worker の入口（entry）。/api の道を分け、守りの順番どおりに部品をつなぐだけ。決まりは read-core.mjs、外との境目は access・budget・anthropic。
   入口は Cloudflare Access だけ（合言葉は 2026-10-22 に外した。spec/architecture.md の access-only）。
   画面のファイルは Static Assets が配る（wrangler.jsonc の run_worker_first で、ここに来るのは /api/* だけ）。
   守る順番: 道と method → 同じ場所からの呼び出し（Sec-Fetch-Site）→ 設定がそろっている → Access の JWT → 種類と大きさと形 → 上限（呼ぶ前）→ AI → 答えの形。
   ログは 1 要求 1 行。残すのは知っている道の名前・状態・doc・量・時間・外した行の数・健康が見えたか・止まった理由だけ
   （中身・メールアドレス・JWT は出さない）。
   /api/roster はお店の名簿の正本（D1）。決まりは sync-core.mjs、D1 との境目は roster-db.mjs、計画は plan/server.md。
   /api/roster/past は済んで 7 日を過ぎた便（読むだけ）。分ける決まりは past-core.mjs。
   /api/bookings は Access の外（お店のサイトの予約フォームから）。守りの順番: 許した origin（CORS）→ method → 設定 → 種類 → 1 つの IP の回数 → 大きさ
   → Turnstile → 形。中身は auto.mjs、計画は plan/auto.md。
   /api/ask もお客さんのリンク（ask.html）から Access の外で呼ぶ。守りの順番: 道と method → Sec-Fetch-Site → 設定 → 種類 → 1 つの IP の回数 → 大きさ → 形 → 鍵
   （鍵の回数は ask-route.mjs）。/api/ask-link はお店がリンクを作る道で、/api/roster と同じく Access の内。中身は ask-route.mjs、計画は plan/meibo.md */
import { checkRequest, periods, limitsFrom, MAX_BODY, MODEL } from './read-core.mjs';
import { checkPut, readStored, shrinkProblem, MAX_PUT_BODY } from './sync-core.mjs';
import { liveOf, checkPastRange, readPast, MAX_PAST_ROWS } from './past-core.mjs';
import { verifyAccess } from './access.mjs';
import { remaining } from './budget.mjs';
import { askModel } from './ask.mjs';
import { takeSiteBooking } from './auto.mjs';
import { verifyTurnstile, underLimit } from './site-guard.mjs';
import { MAX_BOOKING_BODY } from './auto-core.mjs';
import { getRoster, putRoster, getPast } from './roster-db.mjs';
import { listUnread, dropUnread } from './unread-db.mjs';
import { UNREAD_KEEP_DAYS, UNREAD_SHOW_MAX } from './auto-core.mjs';
import { takeAsk, makeAskLink } from './ask-route.mjs';
import { MAX_ASK_BODY } from './ask-core.mjs';
import { listShops } from './shop-db.mjs';
import { shopForEmail, shopForOrigin, sitesOf, nameOf, withShopName } from './shop-core.mjs';

/* どれか欠けたら置き方の誤り。欠けた名前はログにだけ出す。直し方は docs/deploy.md */
const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS'];
const REQUIRED_VARS = ['DAILY_LIMIT', 'MONTHLY_USD'];
const ROUTES = { '/api/healthz': ['GET'], '/api/read': ['POST'], '/api/roster': ['GET', 'PUT'], '/api/roster/past': ['GET'], '/api/mail-unread': ['GET', 'POST'], '/api/bookings': ['POST', 'OPTIONS'],
  '/api/ask': ['POST'], '/api/ask-link': ['POST'] };

const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'cross-origin-resource-policy': 'same-origin'
};
const json = (status, data, extra) => new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...(extra || {}) } });

function missingConfig(env) {
  const miss = [...REQUIRED_SECRETS, ...REQUIRED_VARS].filter(k => typeof env[k] !== 'string' || env[k].trim() === '');
  if (!env.BUDGET || typeof env.BUDGET.get !== 'function' || typeof env.BUDGET.put !== 'function') miss.push('BUDGET');
  return miss;
}

/* 本文を上限まで読む。超えたら null（全部は読まない） */
async function readCapped(request, max) {
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function healthz(env, io) {
  try {
    const left = await remaining(env.BUDGET, periods(io.now()), limitsFrom(env));
    return json(200, { ok: true, model: MODEL, left: { today: left.day, monthUsd: Math.floor(left.monthMicro / 1e4) / 100 } });
  } catch (e) {
    return json(503, { ok: false, error: 'kv' });
  }
}

async function read(request, env, io, note) {
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, MAX_BODY);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const keys = periods(io.now());
  const checked = checkRequest(given, keys.day);
  if (!checked.ok) { note.why = checked.error.slice(0, 40); return json(400, { error: 'input' }); }
  const ask = checked.ask;
  Object.assign(note, { doc: ask.doc, size: ask.size, redacted: ask.redacted });

  const got = await askModel(ask, env, io, note);
  if (got.ok) return json(200, got.reading);
  if (got.error === 'limit') return json(429, { error: 'limit', which: got.which });
  return json(got.status, got.error === 'answer' ? { error: 'answer', healthSeen: got.healthSeen } : { error: got.error });
}

/* お店の名簿（plan/server.md）。GET は今の名簿、PUT は版を確かめて書く。版が違えば最新を返す（画面が当て直して送り直す）。
   どのお店の名簿かは、Access でログインしたメールをお店の一覧（D1 の shops）で引いて決める。一覧が空なら 1 店（default） */
async function roster(request, env, io, note, who) {
  const now = io.now();
  const at = new Date(now).toISOString();
  const today = periods(now).day;
  let shops;
  try { shops = await listShops(env.DB); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const shop = shopForEmail(shops, who.email);
  if (!shop) { note.why = 'no-shop'; return json(403, { error: 'shop' }); }
  note.shop = shop;
  const current = async () => {
    const got = await getRoster(env.DB, shop);
    return { version: got.version, state: got.text === null ? null : readStored(got.text, { today, at }) };
  };
  if (request.method === 'GET') {
    let got;
    try { got = await getRoster(env.DB, shop); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
    const state = got.text === null ? null : readStored(got.text, { today, at });
    if (got.text !== null && !state) { note.why = 'stored'; return json(500, { error: 'stored' }); }   // 壊れた物を画面に広げない
    note.version = got.version;
    return json(200, { version: got.version, state, shop });   // shop: 端末が、どのお店の名簿かを覚える（ジンのレビュー HIGH 8）
  }

  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, MAX_PUT_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  /* 画面は、どのお店の名簿を元に直したか（shop）を付けて送る。ログインから決めたお店と違えば断る（開いたままの画面で別のお店の人がログインし直したとき、
     前のお店の直しを、このお店の名簿に入れない。ジンのレビュー 2026-10-27 HIGH 8）。付けていない画面（前の版）は今までどおり */
  if (given && typeof given === 'object' && !Array.isArray(given) && Object.prototype.hasOwnProperty.call(given, 'shop')) {
    const { shop: sent, ...rest } = given;
    if (typeof sent !== 'string' || sent !== shop) { note.why = 'shop-changed'; return json(409, { error: 'shop', shop }); }
    given = rest;
  }
  const checked = checkPut(given, { today, at });
  if (!checked.ok) {
    note.why = checked.error.slice(0, 40);
    if (checked.error === 'old-version') return json(426, { error: 'version' });   // 画面が古い版。読み込み直してもらう
    return checked.error === 'size' ? json(413, { error: 'size' }) : json(400, { error: 'input' });
  }
  /* 一覧に名前があるお店は、名簿のお店の名前をその名前にそろえる */
  const state = withShopName(checked.state, nameOf(shops, shop, ''));
  const text = state === checked.state ? checked.text : JSON.stringify(state);
  note.size = text.length;
  try {
    /* 人が大きく消える書き込みは、わざと（allowShrink）でなければ断り、今の名簿を返す（端末が空の名簿を送った事故から守る） */
    if (checked.base > 0 && !checked.allowShrink) {
      const now = await current();
      /* 今の名簿からも済んだ便を除いてから比べる（済んだ便を分けた日の書き込みを、人が消えたと見ない） */
      if (now.version === checked.base && now.state && shrinkProblem(liveOf(now.state, today), state)) {
        note.why = 'shrink';
        note.version = now.version;
        return json(409, { error: 'shrink', version: now.version, state: now.state, shop });
      }
    }
    const put = await putRoster(env.DB, shop, checked.base, text, at, { parts: checked.parts, today });
    note.moved = checked.parts.length;
    if (put.ok) { note.version = put.version; return json(200, { version: put.version, state, shop }); }
    const latest = await current();
    if (latest.version !== 0 && !latest.state) { note.why = 'stored'; return json(500, { error: 'stored' }); }
    note.why = 'conflict';
    note.version = latest.version;
    return json(409, { error: 'conflict', version: latest.version, state: latest.state, shop });
  } catch (e) {
    note.why = 'db';
    return json(503, { error: 'db' });
  }
}

/* 済んだ便（plan/server.md の「済んだ便を分けて置く」）。GET ?from=YYYY-MM-DD&to=YYYY-MM-DD で、その日の範囲の済んだ便を、読むだけの 1 つの名簿にして返す。
   お店はログインしたメールで決める（/api/roster と同じ）。形が合わずに外した行の数は skipped で知らせる（黙って消さない） */
async function rosterPast(request, env, io, url, note, who) {
  const now = io.now();
  const today = periods(now).day;
  const range = checkPastRange(url.searchParams.get('from') || '', url.searchParams.get('to') || '', { today });
  if (!range.ok || [...url.searchParams.keys()].some(k => !['from', 'to'].includes(k))) { note.why = range.error || 'keys'; return json(400, { error: 'input' }); }
  let shops;
  try { shops = await listShops(env.DB); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const shop = shopForEmail(shops, who.email);
  if (!shop) { note.why = 'no-shop'; return json(403, { error: 'shop' }); }
  note.shop = shop;
  let rows;
  try { rows = await getPast(env.DB, shop, range.from, range.to, today, MAX_PAST_ROWS); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const name = nameOf(shops, shop, '');
  const got = readPast(rows, name);
  Object.assign(note, { rows: rows.length, skipped: got.skipped });
  return json(200, { from: range.from, to: range.to, state: got.state, skipped: got.skipped, full: rows.length >= MAX_PAST_ROWS });
}

/* 読めなかった予約メール（plan/auto.md。ジンのレビュー HIGH 6）。GET は新しい順の一覧 { items: [{ id, at, why }] }、
   POST { id } はお店が「済んだ」を押した行を消す。お店はログインしたメールで決める */
async function mailUnread(request, env, io, note, who) {
  let shops;
  try { shops = await listShops(env.DB); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const shop = shopForEmail(shops, who.email);
  if (!shop) { note.why = 'no-shop'; return json(403, { error: 'shop' }); }
  note.shop = shop;
  try {
    if (request.method === 'GET') {
      const items = await listUnread(env.DB, shop, new Date(io.now() - UNREAD_KEEP_DAYS * 86400000).toISOString(), UNREAD_SHOW_MAX);
      note.rows = items.length;
      return json(200, { items });
    }
    if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
    const raw = await readCapped(request, 256);
    if (raw === null) return json(413, { error: 'size' });
    let given;
    try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
    if (!given || typeof given !== 'object' || Object.keys(given).join() !== 'id' || typeof given.id !== 'string' || !/^[a-z0-9]{1,40}$/.test(given.id)) {
      note.why = 'input';
      return json(400, { error: 'input' });
    }
    return (await dropUnread(env.DB, shop, given.id)) ? json(200, { ok: true }) : json(404, { error: 'gone' });
  } catch (e) {
    note.why = 'db';
    return json(503, { error: 'db' });
  }
}

/* サイトの予約フォーム（Access の外）。許すのは SITE_ORIGINS に書いた origin だけで、その origin にだけ CORS のヘッダを返す */
const BOOKING_NEEDS = ['TURNSTILE_SECRET'];
function corsFor(origin) {
  return { 'access-control-allow-origin': origin, vary: 'Origin', 'cross-origin-resource-policy': 'cross-origin' };
}
/* どのお店の予約かは、送ってきたサイト（origin）をお店の一覧で引いて決める。一覧が空なら SITE_ORIGINS のサイトだけを 1 店へ */
async function bookings(request, env, io, note) {
  const origin = request.headers.get('origin') || '';
  if (!(env.DB && typeof env.DB.prepare === 'function')) { note.why = 'config:DB'; return json(503, { error: 'config' }); }
  let shops;
  try { shops = await listShops(env.DB); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const shop = shopForOrigin(shops, origin, env.SITE_ORIGINS);
  if (!shop) { note.why = 'origin'; return json(403, { error: 'origin' }); }
  note.shop = shop;
  const cors = corsFor(origin);
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, cf-turnstile-response',
      'access-control-max-age': '600', 'cache-control': 'no-store' } });
  }
  const miss = BOOKING_NEEDS.filter(k => typeof env[k] !== 'string' || env[k].trim() === '');
  if (!(env.BOOKING_LIMIT && typeof env.BOOKING_LIMIT.limit === 'function')) miss.push('BOOKING_LIMIT');
  if (!(env.BUDGET && typeof env.BUDGET.get === 'function')) miss.push('BUDGET');
  if (miss.length) { note.why = `config:${miss.join('+')}`; return json(503, { error: 'config' }, cors); }
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' }, cors);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await underLimit(env.BOOKING_LIMIT, ip))) { note.why = 'rate'; return json(429, { error: 'limit' }, cors); }
  const raw = await readCapped(request, MAX_BOOKING_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }, cors); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }, cors); }
  const hosts = sitesOf(shops, shop, env.SITE_ORIGINS).map(o => { try { return new URL(o).hostname.toLowerCase(); } catch (e) { return ''; } }).filter(Boolean);
  const human = await verifyTurnstile(env, request.headers.get('cf-turnstile-response'), ip, io, hosts);
  if (!human.ok) { note.why = human.why; return json(403, { error: 'turnstile' }, cors); }
  const got = await takeSiteBooking(given, env, io, note, shop, nameOf(shops, shop, ''));
  return json(got.status, got.body, cors);
}

/* お客さんのリンク（Access の外）。同じ場所（ask.html）からの呼び出しだけ */
async function ask(request, env, io, url, note) {
  if (!(env.DB && typeof env.DB.prepare === 'function') || !(env.ASK_LIMIT && typeof env.ASK_LIMIT.limit === 'function')) {
    note.why = 'config:ask';
    return json(503, { error: 'config' });
  }
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  if (!(await underLimit(env.ASK_LIMIT, request.headers.get('cf-connecting-ip') || ''))) { note.why = 'rate'; return json(429, { error: 'limit' }); }
  const raw = await readCapped(request, MAX_ASK_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const got = await takeAsk(given, env, io, note, url.origin);
  return json(got.status, got.body);
}

/* お店が予約のリンクを作る（Access の後）。作れるのは、ログインしたスタッフのお店の予約だけ */
async function askLink(request, env, io, url, note, who) {
  let shops;
  try { shops = await listShops(env.DB); } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
  const shop = shopForEmail(shops, who.email);
  if (!shop) { note.why = 'no-shop'; return json(403, { error: 'shop' }); }
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, 1024);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  /* 置いた形では、お客さんのリンクは Access の無い別の Worker（ASK_ORIGIN）で開く。手元（serve-dist）は同じ場所 */
  const got = await makeAskLink(given, env, io, note, env.ASK_ORIGIN || url.origin, shop);
  return json(got.status, got.body);
}

async function route(request, env, io, url, note) {
  /* ここに来た /api 以外は、Static Assets に無いファイル */
  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const methods = ROUTES[url.pathname];
  if (!methods) return json(404, { error: 'path' });
  if (url.pathname === '/api/bookings') return methods.includes(request.method) ? bookings(request, env, io, note) : json(405, { error: 'method' }, { allow: methods.join(', ') });
  if (!methods.includes(request.method)) return json(405, { error: 'method' }, { allow: methods.join(', ') });   // OPTIONS も断る（CORS のヘッダは出さない）
  if (request.headers.get('sec-fetch-site') !== 'same-origin') { note.why = 'site'; return json(403, { error: 'site' }); }
  if (url.pathname === '/api/ask') return ask(request, env, io, url, note);

  const miss = missingConfig(env);
  /* D1 は名簿の道だけが使う。無くても読み取り（/api/read）と /api/healthz は止めない */
  if (['/api/roster', '/api/roster/past', '/api/mail-unread', '/api/ask-link'].includes(url.pathname) && !(env.DB && typeof env.DB.prepare === 'function')) miss.push('DB');
  if (miss.length) { note.why = `config:${miss.join('+')}`; return json(503, { error: 'config' }); }
  const who = await verifyAccess(request, env, io);
  if (!who.ok) {
    note.why = `access-${who.why}`;
    return who.why === 'certs' ? json(503, { error: 'access-keys' }) : json(403, { error: 'access' });
  }

  if (url.pathname === '/api/roster') return roster(request, env, io, note, who);
  if (url.pathname === '/api/roster/past') return rosterPast(request, env, io, url, note, who);
  if (url.pathname === '/api/mail-unread') return mailUnread(request, env, io, note, who);
  if (url.pathname === '/api/ask-link') return askLink(request, env, io, url, note, who);
  return url.pathname === '/api/healthz' ? healthz(env, io) : read(request, env, io, note);
}

/* Access を付けない Worker（worker/ask-index.mjs）の入口。お客さんのリンク（/api/ask の POST）と、お店のサイトの予約フォーム（/api/bookings。
   守りは bookings と同じ: 許した origin・回数・Turnstile）だけを受け、ほかの /api は 404。
   お店の画面・名簿の道（/api/roster）・リンクを作る道（/api/ask-link）・AI の読み取りは、この Worker には無い */
const PUBLIC_ROUTES = { '/api/ask': ['POST'], '/api/bookings': ['POST', 'OPTIONS'] };
export async function handlePublic(request, env, io) {
  const started = io.now();
  const url = new URL(request.url);
  const methods = PUBLIC_ROUTES[url.pathname];
  const note = { worker: 'public', route: methods ? url.pathname : url.pathname.startsWith('/api/') ? '/api/other' : 'other' };
  let res;
  try {
    if (!methods) res = json(404, { error: 'path' });
    else if (!methods.includes(request.method)) res = json(405, { error: 'method' }, { allow: methods.join(', ') });
    else if (url.pathname === '/api/bookings') res = await bookings(request, env, io, note);
    else if (request.headers.get('sec-fetch-site') !== 'same-origin') { note.why = 'site'; res = json(403, { error: 'site' }); }
    else res = await ask(request, env, io, url, note);
  } catch (e) {
    note.why = 'crash';
    res = json(500, { error: 'server' });
  }
  console.log(JSON.stringify({ ...note, status: res.status, ms: io.now() - started }));
  return res;
}

export async function handle(request, env, io) {
  const started = io.now();
  const url = new URL(request.url);
  /* 道は知っている名前だけを残す（知らない道の文字に、何が入っているか分からないため） */
  const note = { route: ROUTES[url.pathname] ? url.pathname : url.pathname.startsWith('/api/') ? '/api/other' : 'other' };
  let res;
  try {
    res = await route(request, env, io, url, note);
  } catch (e) {
    note.why = 'crash';
    res = json(500, { error: 'server' });
  }
  console.log(JSON.stringify({ ...note, status: res.status, ms: io.now() - started }));
  return res;
}
