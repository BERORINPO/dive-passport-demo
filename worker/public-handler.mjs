/* Access を付けない Worker（redux-ask。入口は worker/ask-index.mjs）の道（entry）。受けるのは 6 つだけで、ほかの /api は 404:
   - /api/ask（お客さんのリンク。ask.html から同じ場所で呼ぶ）
   - /api/walkin（店頭の QR。walkin.html から同じ場所で呼ぶ。鍵は店頭に貼った QR の # の後ろ）
   - /api/bookings（お店のサイトの予約フォーム。別の origin から CORS で）
   - /api/v1/bookings（予約の受け口 API。お店のサイト・WordPress・Zapier など別のシステムのサーバーから。Authorization: Bearer の API キー。
     CORS は付けず、ブラウザの Origin 付きの要求は 403 で断る。決定ログ 2026-10-28 intake-api）
   - /api/health（外の死活監視。Cron が最後に動いた時刻を KV の BUDGET から読む）
   - /api/trial（実在のお店の試し版 trial.html。鍵は本文で送る。AI はお店の Worker の ShopRpc.trialAsk）
   この Worker は D1 を持たない（SEC-13）。名簿・鍵の行・お店の一覧は、Service Binding の SHOP（お店の Worker の ShopRpc。shop-client.mjs）の
   7 つの口の向こうにあり、ここに残すのは道・Sec-Fetch-Site・許した origin（CORS）・Turnstile・1 つの IP の回数・本文の種類と大きさと形・鍵の SHA-256 だけ。
   お店の画面・名簿の道（/api/roster）・リンクを作る道（/api/ask-link）・AI の読み取りは、この束に入れない（test/ask-link.test.mjs が import をたどって確かめる）。
   守りの順番  ask: 道と method → Sec-Fetch-Site → 設定 → 種類 → 1 つの IP の回数 → 大きさ → 形 → （お店の Worker で）鍵の行と鍵ごとの回数。
   bookings: 道と method → 許した origin（お店の Worker に聞く）→ 設定 → 種類 → 1 つの IP の回数 → 大きさ → Turnstile → （お店の Worker で）形。
   /api/v1/bookings: 道と method → ブラウザの要求を断る（Origin・Sec-Fetch-Site） → 設定 → 1 つの IP の回数 → API キーの形 → 種類 → 大きさ → 本文と Idempotency-Key の形 →
   （お店の Worker で）鍵の行・同じ予約の 2 回目・本文の検査・鍵ごとの 1 日の件数。
   お店の Worker の handler.mjs も、手元の確かめ（tools/serve-dist.mjs）のために ask と bookings をここから使う（SHOP は同じ Worker の ShopService）。
   ログは 1 要求 1 行（道の名前・状態・短い理由・量・時間だけ。鍵・名前・メールアドレスは出さない） */
import { json, isJson, readCapped } from './api-http.mjs';
import { shopClient } from './shop-client.mjs';
import { keyHash } from './ask-key.mjs';
import { checkAsk, MAX_ASK_BODY, checkWalkin, MAX_WALKIN_BODY, MAX_INTAKE_BODY, bearerOf, idemKeyOf } from './ask-input.mjs';
import { verifyTurnstile, underLimit } from './site-guard.mjs';
import { MAX_BOOKING_BODY, cronFresh, CRON_STALE_MS } from './auto-core.mjs';
import { checkTrial, MAX_TRIAL_BODY } from './trial-core.mjs';

const PUBLIC_ROUTES = { '/api/ask': ['POST'], '/api/walkin': ['POST'], '/api/bookings': ['POST', 'OPTIONS'], '/api/v1/bookings': ['POST'], '/api/health': ['GET'],
  '/api/trial': ['POST'] };
const BOOKING_NEEDS = ['TURNSTILE_SECRET'];

const hasLimiter = (l) => Boolean(l && typeof l.limit === 'function');

/* 外の死活監視（Cloudflare と別の系統）が 5 分ごとに見る口。返すのは Cron が最後に動いた時刻だけ。止まっていれば 503 */
async function cronHealth(env, io, note) {
  try {
    const got = cronFresh(env.BUDGET ? await env.BUDGET.get('cron:last') : null, new Date(io.now() - CRON_STALE_MS).toISOString());
    if (!got.ok) note.why = 'cron-stale';
    return json(got.ok ? 200 : 503, { ok: got.ok, cronAt: got.at });
  } catch (e) {
    note.why = 'kv';
    return json(503, { ok: false, cronAt: '' });
  }
}

/* サイトの予約フォーム。許すのはお店の一覧に書いたサイト（origin）だけで、その origin にだけ CORS のヘッダを返す。
   どのお店の予約かは、送ってきたサイトをお店の Worker が一覧で引いて決める（一覧が空なら、SINGLE_SHOP を明示したときだけ 1 店） */
export async function bookings(request, env, io, note) {
  const shop = shopClient(env.SHOP);
  if (!shop) { note.why = 'config:SHOP'; return json(503, { error: 'config' }); }
  const origin = request.headers.get('origin') || '';
  const site = await shop.siteHosts(origin);
  Object.assign(note, site.note);
  if (!site.ok) return json(site.status, site.body);
  const cors = { 'access-control-allow-origin': origin, vary: 'Origin', 'cross-origin-resource-policy': 'cross-origin' };
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type, cf-turnstile-response',
      'access-control-max-age': '600', 'cache-control': 'no-store' } });
  }
  const miss = BOOKING_NEEDS.filter(k => typeof env[k] !== 'string' || env[k].trim() === '');
  if (!hasLimiter(env.BOOKING_LIMIT)) miss.push('BOOKING_LIMIT');
  if (miss.length) { note.why = `config:${miss.join('+')}`; return json(503, { error: 'config' }, cors); }
  if (!isJson(request)) return json(415, { error: 'type' }, cors);
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await underLimit(env.BOOKING_LIMIT, ip))) { note.why = 'rate'; return json(429, { error: 'limit' }, cors); }
  const raw = await readCapped(request, MAX_BOOKING_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }, cors); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }, cors); }
  const human = await verifyTurnstile(env, request.headers.get('cf-turnstile-response'), ip, io, site.hosts);
  if (!human.ok) { note.why = human.why; return json(403, { error: 'turnstile' }, cors); }
  const got = await shop.siteBooking(origin, given);
  Object.assign(note, got.note);
  return json(got.status, got.body, cors);
}

/* 予約の受け口 API。サーバーからサーバーへ送る口で、CORS は付けない。ブラウザは Origin（と Sec-Fetch-Site）を必ず付けるので、付いていたら 403 で断る
   （API キーを、ウェブページの中に書かせない）。鍵は SHA-256 にしてから、お店の Worker に渡す。鍵が無い・形が違う・止めた・知らないは同じ 401 */
export async function intake(request, env, io, note) {
  if (request.headers.get('origin') !== null || request.headers.get('sec-fetch-site') !== null) { note.why = 'origin'; return json(403, { error: 'origin' }); }
  const shop = shopClient(env.SHOP);
  if (!shop || !hasLimiter(env.INTAKE_LIMIT)) { note.why = 'config:intake'; return json(503, { error: 'config' }); }
  if (!(await underLimit(env.INTAKE_LIMIT, request.headers.get('cf-connecting-ip') || ''))) { note.why = 'rate'; return json(429, { error: 'limit' }); }
  const auth = request.headers.get('authorization');
  const bearer = bearerOf(auth);
  if (!bearer) { note.why = auth ? 'auth-format' : 'auth-missing'; return json(401, { error: 'auth' }, { 'www-authenticate': 'Bearer' }); }
  if (!isJson(request)) return json(415, { error: 'type' });
  const raw = await readCapped(request, MAX_INTAKE_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const idem = idemKeyOf(request.headers.get('idempotency-key'));
  if (!idem.ok) { note.why = 'input-idem'; return json(400, { error: 'input', fields: ['idempotency_key'] }); }
  const got = await shop.intakeBooking(await keyHash(bearer), given, idem.key);
  Object.assign(note, got.note);
  return json(got.status, got.body, got.status === 401 ? { 'www-authenticate': 'Bearer' } : undefined);
}

/* お客さんのリンク（Access の外）。同じ場所（ask.html）からの呼び出しだけ。鍵は SHA-256 にしてから、お店の Worker に渡す */
export async function ask(request, env, io, url, note) {
  const shop = shopClient(env.SHOP);
  if (!shop || !hasLimiter(env.ASK_LIMIT)) { note.why = 'config:ask'; return json(503, { error: 'config' }); }
  if (!isJson(request)) return json(415, { error: 'type' });
  if (!(await underLimit(env.ASK_LIMIT, request.headers.get('cf-connecting-ip') || ''))) { note.why = 'rate'; return json(429, { error: 'limit' }); }
  const raw = await readCapped(request, MAX_ASK_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const checked = checkAsk(given);
  if (!checked.ok) { note.why = `input-${checked.error}`; return json(400, { error: 'input' }); }
  note.action = checked.action;
  const hash = await keyHash(checked.k);
  const { ok, k, ...req } = checked;
  const got = checked.action === 'view' ? await shop.askView(hash) : await shop.askApply(hash, req, url.origin);
  Object.assign(note, got.note);
  return json(got.status, got.body);
}

/* 店頭の QR（walkin.html。Access の外）。同じ場所（walkin.html）からの呼び出しだけ。鍵は SHA-256 にしてから、お店の Worker に渡す。
   守りの順番は ask と同じ（道と method → Sec-Fetch-Site → 設定 → 種類 → 1 つの IP の回数 → 大きさ → 形 → お店の Worker で鍵の行・名簿と同じ検査・1 日の件数） */
export async function walkin(request, env, io, note) {
  const shop = shopClient(env.SHOP);
  if (!shop || !hasLimiter(env.ASK_LIMIT)) { note.why = 'config:walkin'; return json(503, { error: 'config' }); }
  if (!isJson(request)) return json(415, { error: 'type' });
  if (!(await underLimit(env.ASK_LIMIT, request.headers.get('cf-connecting-ip') || ''))) { note.why = 'rate'; return json(429, { error: 'limit' }); }
  const raw = await readCapped(request, MAX_WALKIN_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const checked = checkWalkin(given);
  if (!checked.ok) { note.why = `input-${checked.error}`; return json(400, { error: 'input' }); }
  note.action = checked.action;
  const hash = await keyHash(checked.k);
  const got = checked.action === 'view' ? await shop.walkinView(hash) : await shop.walkinSubmit(hash, checked.req);
  Object.assign(note, got.note);
  return json(got.status, got.body);
}

/* 実在のお店の試し版（trial.html。Access の外。決定ログ 2026-10-29 trial-shops）。同じ場所からの呼び出しだけ。
   守りの順番は ask と同じ（道と method → Sec-Fetch-Site → 設定 → 種類 → 1 つの IP の回数 → 大きさ → 形 → お店の Worker で鍵・AI の上限）。
   鍵はログに出さない */
export async function trial(request, env, io, note) {
  const shop = shopClient(env.SHOP);
  if (!shop || !hasLimiter(env.ASK_LIMIT)) { note.why = 'config:trial'; return json(503, { error: 'config' }); }
  if (!isJson(request)) return json(415, { error: 'type' });
  if (!(await underLimit(env.ASK_LIMIT, request.headers.get('cf-connecting-ip') || ''))) { note.why = 'rate'; return json(429, { error: 'limit' }); }
  const raw = await readCapped(request, MAX_TRIAL_BODY);
  if (raw === null) { note.why = 'size'; return json(413, { error: 'size' }); }
  let given;
  try { given = JSON.parse(raw); } catch (e) { return json(400, { error: 'json' }); }
  const checked = checkTrial(given);
  if (!checked.ok) { note.why = `input-${checked.error}`; return json(400, { error: 'input' }); }
  note.action = checked.req.kind;
  const got = checked.req.kind === 'view' ? await shop.trialView(checked.t) : await shop.trialAsk(checked.t, checked.req);
  Object.assign(note, got.note);
  return json(got.status, got.body);
}

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
    else if (url.pathname === '/api/v1/bookings') res = await intake(request, env, io, note);
    else if (url.pathname === '/api/health') res = await cronHealth(env, io, note);
    else if (request.headers.get('sec-fetch-site') !== 'same-origin') { note.why = 'site'; res = json(403, { error: 'site' }); }
    else if (url.pathname === '/api/walkin') res = await walkin(request, env, io, note);
    else if (url.pathname === '/api/trial') res = await trial(request, env, io, note);
    else res = await ask(request, env, io, url, note);
  } catch (e) {
    note.why = 'crash';
    res = json(500, { error: 'server' });
  }
  console.log(JSON.stringify({ ...note, status: res.status, ms: io.now() - started }));
  return res;
}
