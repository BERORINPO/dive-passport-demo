/* お店の Worker の道（entry。入口は worker/index.mjs）。/api の道を分け、守りの順番どおりに部品をつなぐだけ。決まりは read-core.mjs、外との境目は access・budget・anthropic。
   入口は Cloudflare Access だけ（合言葉は 2026-10-22 に外した。spec/architecture.md の access-only）。
   画面のファイルは Static Assets が配る（wrangler.jsonc の run_worker_first で、ここに来るのは /api/* だけ）。
   守る順番: 道と method → 同じ場所からの呼び出し（Sec-Fetch-Site）→ 設定がそろっている → Access の JWT → 種類と大きさと形 → 上限（呼ぶ前）→ AI → 答えの形。
   ログは 1 要求 1 行。残すのは知っている道の名前・状態・doc・量・時間・外した行の数・健康が見えたか・止まった理由だけ
   （中身・メールアドレス・JWT は出さない）。
   /api/roster はお店の名簿の正本（D1）。決まりは sync-core.mjs、D1 との境目は roster-db.mjs、計画は plan/server.md。
   /api/roster/past は済んで 7 日を過ぎた便（読むだけ）。分ける決まりは past-core.mjs。
   /api/ask-link はお店がリンクを作る道で、/api/roster と同じく Access の内。中身は ask-route.mjs、計画は plan/meibo.md。
   /api/walkin-key・/api/walkins・/api/walkin-drop は店頭の QR のスタッフの道（Access の内。中身は walkin-route.mjs）。
   /api/api-keys は予約の受け口 API（POST /api/v1/bookings。redux-ask が受ける）の API キーを、スタッフが作る・作り直す・止める道（Access の内。中身は intake-route.mjs）。
   お客さんのリンク（/api/ask）とサイトの予約フォーム（/api/bookings）は Access の外で、置いた形では redux-ask（worker/ask-index.mjs）が受ける。その道は
   public-handler.mjs にあり、この Worker の束にも入るのは手元の確かめ（tools/serve-dist.mjs）で同じ場所から呼べるように残しているだけ
   （ここでは SHOP を同じ Worker の ShopService にする。置いた形では Access の中なので外からは届かない）。redux-ask の束にはこのファイルは入らない */
import { checkRequest, periods, limitsFrom, MAX_BODY, MODEL } from './read-core.mjs';
import { SHOP_PAGES, servePage } from './page-serve.mjs';
import { checkGuestRequest, guestAnswerFrom, guestLimits, MAX_GUEST_BODY } from './guest-ai-core.mjs';
import { checkPut, readStored, shrinkProblem, serverOwned, MAX_PUT_BODY } from './sync-core.mjs';
import { liveOf, checkPastRange, readPast, MAX_PAST_ROWS } from './past-core.mjs';
import { verifyAccess } from './access.mjs';
import { remaining } from './budget.mjs';
import { askModel } from './ask.mjs';
import { getRoster, putRoster, getPast } from './roster-db.mjs';
import { listUnread, dropUnread } from './unread-db.mjs';
import { UNREAD_KEEP_DAYS, UNREAD_SHOW_MAX } from './auto-core.mjs';
import { makeAskLink } from './ask-route.mjs';
import { makeWalkinKey, listWalkinsFor, dropWalkinFor } from './walkin-route.mjs';
import { listKeysFor, changeKeysFor } from './intake-route.mjs';
import { json, readCapped } from './api-http.mjs';
import { ask, bookings } from './public-handler.mjs';
import { ShopService } from './shop-service.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';
import { shopForEmail, nameOf, withShopName } from './shop-core.mjs';

/* どれか欠けたら置き方の誤り。欠けた名前はログにだけ出す。直し方は docs/deploy.md */
const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS'];
const REQUIRED_VARS = ['DAILY_LIMIT', 'MONTHLY_USD'];
const ROUTES = { '/api/healthz': ['GET'], '/api/read': ['POST'], '/api/roster': ['GET', 'PUT'], '/api/roster/past': ['GET'], '/api/mail-unread': ['GET', 'POST'], '/api/bookings': ['POST', 'OPTIONS'],
  '/api/ask': ['POST'], '/api/ask-link': ['POST'], '/api/walkin-key': ['POST'], '/api/walkins': ['GET'], '/api/walkin-drop': ['POST'], '/api/api-keys': ['GET', 'POST'],
  '/api/guest-ai': ['POST'] };

const WALKIN_ROUTES = ['/api/walkin-key', '/api/walkins', '/api/walkin-drop'];
const NEEDS_DB = ['/api/roster', '/api/roster/past', '/api/mail-unread', '/api/ask-link', '/api/read', '/api/guest-ai', '/api/healthz', '/api/api-keys', ...WALKIN_ROUTES];

function missingConfig(env) {
  const miss = [...REQUIRED_SECRETS, ...REQUIRED_VARS].filter(k => typeof env[k] !== 'string' || env[k].trim() === '');
  if (!env.BUDGET || typeof env.BUDGET.get !== 'function' || typeof env.BUDGET.put !== 'function') miss.push('BUDGET');
  return miss;
}

/* お店の一覧が読めない・使えないときの 503（2026-10-28 shops-fail-closed）。理由の名前はログだけに出す（中身は出さない）。
   D1 の不調は 'db'、一覧の問題（空・表が無い・形が壊れている・重なり）は shops-… */
function shopsDown(e, note) {
  note.why = shopsWhy(e, 'db');
  return json(503, { error: note.why === 'db' ? 'db' : 'shops' });
}

/* ログインしたスタッフのお店。{ shops, shop } か、そのまま返す { res }（一覧が使えない 503・どのお店にもいない 403） */
async function staffShop(env, note, who) {
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { return { res: shopsDown(e, note) }; }
  const shop = shopForEmail(shops, who.email);
  if (!shop) { note.why = 'no-shop'; return { res: json(403, { error: 'shop' }) }; }
  note.shop = shop;
  return { shops, shop };
}

async function healthz(env, io, shop) {
  try {
    const left = await remaining(env.BUDGET, { ...periods(io.now()), shop }, limitsFrom(env));
    return json(200, { ok: true, model: MODEL, left: { today: left.day, monthUsd: Math.floor(left.monthMicro / 1e4) / 100 } });
  } catch (e) {
    return json(503, { ok: false, error: 'kv' });
  }
}

async function read(request, env, io, note, shop) {
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

  const got = await askModel(ask, env, io, note, shop);
  if (got.ok) return json(200, got.reading);
  if (got.error === 'limit') return json(429, { error: 'limit', which: got.which });
  return json(got.status, got.error === 'answer' ? { error: 'answer', healthSeen: got.healthSeen } : { error: got.error });
}

/* お客さま画面の AI（聞けば答える・まとめて書けば入る）。決まりは guest-ai-core.mjs。上限は予約メールの読み取りと別に、お店ごとに数える
   （キーのお店は「<お店>~guest」。お客さんの質問で、メールの読み取りの上限を使い切らない）。体のことに触れた質問は AI を呼ばずに返す */
async function guestAi(request, env, io, note, shop) {
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, MAX_GUEST_BODY);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const checked = checkGuestRequest(given, periods(io.now()).day);
  if (!checked.ok) { note.why = checked.error.slice(0, 40); return json(400, { error: 'input' }); }
  if (checked.stop) { note.why = 'health-stop'; return json(200, { lang: 'ja', faq: null, answer: '', health: true }); }
  const ask = checked.ask;
  Object.assign(note, { doc: ask.doc, size: ask.size, redacted: ask.redacted });
  const got = await askModel(ask, env, io, note, shop, { budgetShop: `${shop}~guest`, limits: guestLimits(env), parse: (text) => guestAnswerFrom(text, ask) });
  if (got.ok) return json(200, got.reading);
  if (got.error === 'limit') return json(429, { error: 'limit', which: got.which });
  return json(got.status, { error: got.error });
}

/* お店の名簿（plan/server.md）。GET は今の名簿、PUT は版を確かめて書く。版が違えば最新を返す（画面が当て直して送り直す）。
   どのお店の名簿かは、Access でログインしたメールをお店の一覧（D1 の shops）で引いて決める。一覧が空なら 503（SINGLE_SHOP を明示したときだけ 1 店） */
async function roster(request, env, io, note, who) {
  const now = io.now();
  const at = new Date(now).toISOString();
  const today = periods(now).day;
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shops, shop } = mine;
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
  let raw;
  try { raw = await readCapped(request, MAX_PUT_BODY, { gzip: true }); } catch (e) { note.why = 'gzip'; return json(400, { error: 'input' }); }
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
  /* 送る連絡と予定の動きはサーバーの物。画面が足した・書き換えた連絡は、今の名簿の物に戻してから検査にかける
     （ログインした端末から任意の宛先・本文のメールを送らせない。ジンのレビュー 2026-10-28 H2。js/roster-auto.js の serverOwned）。
     記録の新しい行には、サーバーが受けた時刻 rx とログインしたメール by を付ける（sync-core.mjs の keepLog。メールは名簿の中だけで、ログには出さない） */
  if (given && typeof given === 'object' && given.state && typeof given.state === 'object' && Number.isInteger(given.base)) {
    let base = null;
    try {
      if (given.base > 0) {
        const now = await current();
        /* 版は合うのに保存済みの名簿が読めないときは、空の名簿を元にせず断る（画面の連絡と予定をそのまま通さない。ザクのレビュー 2026-10-28 LOW） */
        if (now.version === given.base && !now.state) { note.why = 'stored'; return json(500, { error: 'stored' }); }
        if (now.version === given.base) base = now.state;
      }
    } catch (e) { note.why = 'db'; return json(503, { error: 'db' }); }
    given = { ...given, state: serverOwned(base, given.state, { fresh: given.base === 0, rx: at, by: who.email }) };
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
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shops, shop } = mine;
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
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shop } = mine;
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

/* お店が予約のリンクを作る（Access の後）。作れるのは、ログインしたスタッフのお店の予約だけ */
async function askLink(request, env, io, url, note, who) {
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shop } = mine;
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, 1024);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  /* 置いた形では、お客さんのリンクは Access の無い別の Worker（ASK_ORIGIN）で開く。手元（serve-dist）は同じ場所 */
  const got = await makeAskLink(given, env, io, note, env.ASK_ORIGIN || url.origin, shop);
  return json(got.status, got.body);
}

/* 店頭の QR（Access の内。決定ログ 2026-10-28 walkin-qr）。POST /api/walkin-key は鍵を作る・作り直す（URL は返事に 1 回だけ）、GET /api/walkins は
   「店頭で入れた人」の一覧、POST /api/walkin-drop { id } は「入れた」「入れない」を押した行を消す。お店はログインしたメールで決める */
async function walkinStaff(request, env, io, url, note, who) {
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shop } = mine;
  if (url.pathname === '/api/walkins') {
    const got = await listWalkinsFor(env, io, note, shop);
    return json(got.status, got.body);
  }
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, 256);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const got = url.pathname === '/api/walkin-key' ? await makeWalkinKey(env, io, note, shop, env.ASK_ORIGIN || url.origin) : await dropWalkinFor(env, io, note, shop, given);
  return json(got.status, got.body);
}

/* 予約の受け口 API の鍵（Access の内）。GET は一覧（止めた鍵も。鍵そのものは出ない）、POST { action: 'create' | 'rotate' | 'revoke', … } は作る・作り直す・止める。
   鍵は作った返事に 1 回だけ出る（D1 には SHA-256 だけ）。お店はログインしたメールで決める */
async function apiKeysStaff(request, env, io, url, note, who) {
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  const { shop } = mine;
  const origin = env.ASK_ORIGIN || url.origin;
  if (request.method === 'GET') {
    const got = await listKeysFor(env, io, note, shop, origin);
    return json(got.status, got.body);
  }
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '')) return json(415, { error: 'type' });
  const raw = await readCapped(request, 512);
  if (raw === null) return json(413, { error: 'size' });
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const got = await changeKeysFor(env, io, note, shop, given, origin);
  return json(got.status, got.body);
}

/* /api/ask と /api/bookings 用の env。SHOP はこの Worker の ShopService（D1 が無ければ SHOP も無く、503 config） */
const withShop = (env, io) => (env.DB && typeof env.DB.prepare === 'function' ? { ...env, SHOP: new ShopService(env, io) } : env);

async function route(request, env, io, url, note) {
  /* ここに来た /api 以外は、Static Assets に無いファイル */
  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const methods = ROUTES[url.pathname];
  if (!methods) return json(404, { error: 'path' });
  const wrongMethod = !methods.includes(request.method);
  if (url.pathname === '/api/bookings') return wrongMethod ? json(405, { error: 'method' }, { allow: methods.join(', ') }) : bookings(request, withShop(env, io), io, note);
  if (wrongMethod) return json(405, { error: 'method' }, { allow: methods.join(', ') });   // OPTIONS も断る（CORS のヘッダは出さない）
  if (request.headers.get('sec-fetch-site') !== 'same-origin') { note.why = 'site'; return json(403, { error: 'site' }); }
  if (url.pathname === '/api/ask') return ask(request, withShop(env, io), io, url, note);

  const miss = missingConfig(env);
  /* お店ごとの名簿・上限の道は D1（お店の一覧）が要る。AI の読み取りと /api/healthz も、上限をお店ごとに数えるので同じ */
  if (NEEDS_DB.includes(url.pathname) && !(env.DB && typeof env.DB.prepare === 'function')) miss.push('DB');
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
  if (WALKIN_ROUTES.includes(url.pathname)) return walkinStaff(request, env, io, url, note, who);
  if (url.pathname === '/api/api-keys') return apiKeysStaff(request, env, io, url, note, who);
  const mine = await staffShop(env, note, who);
  if (mine.res) return mine.res;
  if (url.pathname === '/api/guest-ai') return guestAi(request, env, io, note, mine.shop);
  return url.pathname === '/api/healthz' ? healthz(env, io, mine.shop) : read(request, env, io, note, mine.shop);
}

export async function handle(request, env, io) {
  const started = io.now();
  const url = new URL(request.url);
  /* お客さまの画面のページ（/）は、計測のスクリプトを国で出し分けて返す（決定ログ 2026-10-29 analytics-country） */
  if (SHOP_PAGES[url.pathname]) return servePage(request, env, SHOP_PAGES[url.pathname]);
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
