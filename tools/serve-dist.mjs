// 置く物（dist/）を手元で配って確かめる。Static Assets と同じく dist/_headers のヘッダ（CSP など）を付ける。
// /api/* は Worker（worker/handler.mjs）に渡し、外との境目は見本（worker/fakes.mjs）にする: Access の JWT はこの道具が付け、
// Claude API は見本の答え（予約メールは見本の読み取りと同じ答え、写真は空の答え）を返す。本物の Cloudflare と Claude API は呼ばない。
// 実行: node tools/build-site.mjs && node tools/serve-dist.mjs [port]   → http://127.0.0.1:8106
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, extname, normalize, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../worker/handler.mjs';
import { scheduled } from '../worker/auto.mjs';
import { fakeKv, fakeAccess, fakeAnthropic, fakeD1, fakeTurnstile, fakeRateLimit, checkRedirect } from '../worker/fakes.mjs';
import '../js/data-samples.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.argv[2]) || 8106;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '': 'text/plain; charset=utf-8' };

/* _headers を読む（「/path」か「/dir/*」の行と、その下の字下げした「名前: 値」） */
const rules = [];
for (const line of readFileSync(join(root, '_headers'), 'utf8').split('\n')) {
  if (/^\S/.test(line)) rules.push({ path: line.trim(), headers: [] });
  else if (line.trim() && rules.length) { const i = line.indexOf(':'); rules[rules.length - 1].headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
}
const headersFor = (path) => Object.fromEntries(rules.filter(r => r.path === path || (r.path.endsWith('/*') && path.startsWith(r.path.slice(0, -1))))
  .flatMap(r => r.headers));

const TEAM = 'local-team.cloudflareaccess.com';
const AUD = 'local-aud';
const EMAIL = 'local@example.com';
const access = await fakeAccess(TEAM);
const api = fakeAnthropic();
const kv = fakeKv();
const env = { ANTHROPIC_API_KEY: 'local-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
  DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: kv, DB: fakeD1(), SINGLE_SHOP: 'default',   // お店の名簿は、この道具が動いている間だけ覚える（止めると消える）
  /* 書類の自動化（plan/auto.md）。サイトの予約フォームは SITE_ORIGINS に書いた origin から（例: SITE_ORIGINS=http://localhost:5173）。
     Turnstile はどの答えも通す見本、メールは送らずにこの画面（端末）に出すだけの見本 */
  SITE_ORIGINS: process.env.SITE_ORIGINS || '', TURNSTILE_SECRET: 'local-not-real', BOOKING_LIMIT: fakeRateLimit(30), ASK_LIMIT: fakeRateLimit(300),
  EMAIL: { send: async (m) => { console.log(`[メールの見本・送っていない] 宛先 ${m.to} / 件名 ${m.subject}
${m.text}
`); return { messageId: 'local' }; } },
  MAIL_FROM: 'yoyaku@local.example', APP_URL: `http://localhost:${port}`, SHOP_NAME: 'B マリン（見本）' };
const turnstile = fakeTurnstile();
turnstile.hostname = 'localhost';   // 手元のサイト（SITE_ORIGINS の http://localhost:…）で解いた答えとして返す
/* 見本の答え: 予約メールは見本の読み取り（data-samples.js）を、モデルの形（snake_case）に戻して返す */
const SAMPLES = globalThis.REDUX.SAMPLE_READINGS;
const MAILS = globalThis.REDUX.SAMPLE_MAILS;
const toModel = (r) => ({
  participants: r.people.map(p => ({ name: p.name, birth_date: p.birthDate, phone: p.phone, address: p.address,
    emergency_name: p.emergency.name, emergency_relation: p.emergency.relation, emergency_phone: p.emergency.phone,
    cert_course: p.cert.course, cert_date: p.cert.date, dive_count: p.dives === '' ? null : p.dives, last_dive: p.lastDive, unsure: [] })),
  booking: r.booking && { site: r.booking.site, ref: r.booking.ref, date: r.booking.date, start: r.booking.start, tour: r.booking.tour,
    people: r.booking.people, lead_name: r.booking.leadName, lead_phone: r.booking.leadPhone, unsure: [] },
  health_info_visible: r.healthSeen
});
const io = {
  now: () => Date.now(),
  fetch: async (url, init) => {
    checkRedirect(init);   // Workers と同じく、redirect: 'error' は例外にする
    if (String(url).endsWith('/turnstile/v0/siteverify')) return turnstile.respond(init);
    if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }));
    const body = JSON.parse(init.body);
    const text = body.messages[0].content.map(c => c.text || '').join('');
    const hit = Object.keys(MAILS).find(id => text.includes(MAILS[id].text.split('\n').find(l => l.trim().length > 8)));
    api.answer = JSON.stringify(hit ? toModel(SAMPLES[hit]) : { participants: [], health_info_visible: false });
    return api.respond(init);
  }
};

/* dist/ の中のファイルだけ。%2f などで ../ を作っても、dist で始まる別のフォルダ（dist-old など）でも外に出ない */
function fileFor(pathname) {
  let rel;
  try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); } catch (e) { return null; }
  if (/^[\w-]+$/.test(rel)) rel = `${rel}.html`;   // Static Assets と同じく /ask で ask.html を配る
  const file = normalize(join(root, rel));
  const inside = relative(root, file);
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.startsWith('_')) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}
const HOSTS = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

async function serve(req, res) {
  /* 手元だけ。ほかの名前で来た要求（DNS rebinding）は断る */
  if (!HOSTS.has(req.headers.host || '')) { res.writeHead(403); res.end('Forbidden'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);   // 開いた名前のまま（localhost か 127.0.0.1）。リンクの頭が画面と同じ場所になる
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: now + 600, iat: now, type: 'app' });
    const headers = { ...req.headers, 'cf-access-jwt-assertion': jwt };
    const out = await handle(new Request(url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined }), env, io);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }
  const file = fileFor(url.pathname);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', ...headersFor(url.pathname) });
  res.end(readFileSync(file));
}

/* 壊れた要求で道具ごと止まらないように、どの失敗も 400 で返す */
createServer((req, res) => serve(req, res).catch(() => {
  if (!res.headersSent) res.writeHead(400);
  res.end('Bad request');
})).listen(port, '127.0.0.1', () => console.log(`dist/ を http://127.0.0.1:${port} で配っています`));
/* Cron の代わり。1 分ごとに時刻が来た予定を動かす（置いた Worker は 15 分ごと） */
setInterval(() => { scheduled(env, io).catch(() => {}); }, 60 * 1000);
