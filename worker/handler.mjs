/* Worker の入口（entry）。/api の道を分け、守りの順番どおりに部品をつなぐだけ。決まりは read-core.mjs、外との境目は access・budget・anthropic。
   入口は Cloudflare Access だけ（合言葉は 2026-10-22 に外した。spec/architecture.md の access-only）。
   画面のファイルは Static Assets が配る（wrangler.jsonc の run_worker_first で、ここに来るのは /api/* だけ）。
   守る順番: 道と method → 同じ場所からの呼び出し（Sec-Fetch-Site）→ 設定がそろっている → Access の JWT → 種類と大きさと形 → 上限（呼ぶ前）→ AI → 答えの形。
   ログは 1 要求 1 行。残すのは知っている道の名前・状態・doc・量・時間・外した行の数・健康が見えたか・止まった理由だけ
   （中身・メールアドレス・JWT は出さない） */
import { checkRequest, readingFrom, costMicro, periods, limitsFrom, WORST_MICRO, MAX_BODY, MODEL } from './read-core.mjs';
import { verifyAccess } from './access.mjs';
import { reserve, spend, remaining } from './budget.mjs';
import { callModel } from './anthropic.mjs';

/* どれか欠けたら置き方の誤り。欠けた名前はログにだけ出す。直し方は docs/deploy.md */
const REQUIRED_SECRETS = ['ANTHROPIC_API_KEY', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'ALLOWED_EMAILS'];
const REQUIRED_VARS = ['DAILY_LIMIT', 'MONTHLY_USD'];
const ROUTES = { '/api/healthz': 'GET', '/api/read': 'POST' };

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

  try {
    const got = await reserve(env.BUDGET, keys, limitsFrom(env));
    if (!got.ok) { note.why = got.why; return json(429, { error: 'limit', which: got.why }); }
  } catch (e) {
    note.why = 'kv';
    return json(503, { error: 'kv' });
  }

  let answer;
  try {
    answer = await callModel(ask, env, io);
  } catch (e) {
    note.why = `upstream-${e.kind || 'error'}${e.status ? `-${e.status}` : ''}`;
    /* 時間切れ・届かないときも、Anthropic 側では請求されうるので最大の見込みで数える */
    const micro = e.usage ? costMicro(e.usage) : e.kind === 'network' ? WORST_MICRO : 0;
    if (micro) await spend(env.BUDGET, keys, micro).catch(() => { note.why += ',spend-kv'; });
    return json(502, { error: 'upstream' });
  }
  note.stop = answer.stopReason;
  await spend(env.BUDGET, keys, costMicro(answer.usage)).catch(() => { note.why = 'spend-kv'; });

  const reading = readingFrom(answer.text, ask.doc);
  if (!reading.ok) { note.why = `answer-${reading.error}`.slice(0, 40); return json(502, { error: 'answer' }); }
  note.seen = reading.reading.healthSeen;
  return json(200, reading.reading);
}

async function route(request, env, io, url, note) {
  /* ここに来た /api 以外は、Static Assets に無いファイル */
  if (!url.pathname.startsWith('/api/')) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const method = ROUTES[url.pathname];
  if (!method) return json(404, { error: 'path' });
  if (request.method !== method) return json(405, { error: 'method' }, { allow: method });   // OPTIONS も断る（CORS のヘッダは出さない）
  if (request.headers.get('sec-fetch-site') !== 'same-origin') { note.why = 'site'; return json(403, { error: 'site' }); }

  const miss = missingConfig(env);
  if (miss.length) { note.why = `config:${miss.join('+')}`; return json(503, { error: 'config' }); }
  const who = await verifyAccess(request, env, io);
  if (!who.ok) {
    note.why = `access-${who.why}`;
    return who.why === 'certs' ? json(503, { error: 'access-keys' }) : json(403, { error: 'access' });
  }

  return url.pathname === '/api/healthz' ? healthz(env, io) : read(request, env, io, note);
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
