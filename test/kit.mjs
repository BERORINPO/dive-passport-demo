// test/e2e.test.mjs と test/guards.test.mjs が使う道具（テストではない。見本の env・要求の作り方・届いたメールの見本）。
// 外との境目はすべて worker/fakes.mjs の見本。時計は io.clock（日本では 10/27 の 10:00）。console.log は取り込み、結果の表示は REAL_LOG で出す
import assert from 'node:assert/strict';
import { handle, handlePublic } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { fakeKv, fakeAccess, fakeAnthropic, fakeD1, fakeMail, fakeTurnstile, fakeRateLimit, checkRedirect } from '../worker/fakes.mjs';

export const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
export const ASK_ORIGIN = 'https://redux-ask.example.workers.dev';
export const SITE = 'https://aquagate.example.com';
export const TEAM = 'mihon-team.cloudflareaccess.com';
export const AUD = 'aud-0123456789abcdef';
export const STAFF = 'mihon.member@example.com';
export const NOW = Date.parse('2026-10-27T01:00:00Z');   // 日本では 10/27 の 10:00
export const AT = new Date(NOW).toISOString();
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const REAL_LOG = console.log;
export const logs = [];
console.log = (line) => logs.push(String(line));

export const access = await fakeAccess(TEAM);
/* スタッフの JWT（Access を通った印）。exp は秒、既定は 1 時間先 */
export const jwtFor = (email = STAFF, over = {}) => access.sign({ iss: `https://${TEAM}`, aud: [AUD], email, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10,
  nbf: NOW / 1000 - 10, type: 'app', ...over });

/* 見本の env 一式。over で上書き・消す（undefined を入れる） */
export function setup(over = {}) {
  resetAccessCache();
  const db = fakeD1();
  const mail = fakeMail();
  const turnstile = fakeTurnstile();
  const api = fakeAnthropic();
  const env = {
    SITE_ORIGINS: SITE, TURNSTILE_SECRET: 'turnstile-test-secret', DB: db, BOOKING_LIMIT: fakeRateLimit(100), ASK_LIMIT: fakeRateLimit(100),
    ANTHROPIC_API_KEY: 'sk-test-not-real', DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), SHOP_NAME: 'B マリン（見本）',
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: STAFF,
    EMAIL: mail, MAIL_FROM: 'yoyaku@shop.example', APP_URL: ORIGIN, ASK_ORIGIN, MAIL_SENDERS: 'forward@shop.example', SINGLE_SHOP: 'default', ...over
  };
  const io = {
    clock: NOW,
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      if (url === SITEVERIFY) return io.turnstileOverride ? io.turnstileOverride(init) : turnstile.respond(init);
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  return { db, mail, turnstile, api, env, io };
}

export const GOOD = { tour: 'dive', date: '2026-11-03', people: 2, name: '見本 花子', email: 'hanako@mail.example', lang: 'ja', swim: 'shallow', exp: 'first',
  dives: '', worries: ['ears'], phone: '090-0000-0000', note: '' };

/* サイトの予約フォーム（POST /api/bookings。お店の Worker） */
export function siteBooking(s, body = GOOD, { ip = '203.0.113.5', origin = SITE } = {}) {
  return handle(new Request(`${ORIGIN}/api/bookings`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-turnstile-response': 'ok-token', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), s.env, s.io);
}

/* お店のスタッフの要求（Access の内）。jwt を null にすると Access の印なし */
export async function staffCall(s, method, path, body, { jwt, site = 'same-origin' } = {}) {
  const token = jwt === undefined ? await jwtFor() : jwt;
  return handle(new Request(ORIGIN + path, { method, headers: { 'content-type': 'application/json', ...(site ? { 'sec-fetch-site': site } : {}),
    ...(token ? { 'cf-access-jwt-assertion': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), s.env, s.io);
}

/* お客さんの Worker（Access なし。D1 と回数の binding だけを持つ）に、お客さんが ask.html から送る要求 */
export const publicEnv = (s) => ({ DB: s.env.DB, ASK_LIMIT: s.env.ASK_LIMIT, SINGLE_SHOP: s.env.SINGLE_SHOP });
export function guestCall(s, body, { ip = '198.51.100.7', env = publicEnv(s) } = {}) {
  return handlePublic(new Request(`${ASK_ORIGIN}/api/ask`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': ip }, body: JSON.stringify(body) }), env, s.io);
}
/* メールの本文にあるお客さんのリンクから鍵を取り出す */
export function keyOfMail(msg) {
  const m = msg.text.match(/https:\/\/\S+\/ask#k=([A-Za-z0-9_-]{43})/);
  assert.ok(m, 'メールの本文にお客さんのリンクがある');
  return { url: m[0], key: m[1] };
}

export const stored = (s, shop = 'default') => JSON.parse(s.db.rows.get(shop).state);

/* 届いたメール（Email Routing が渡す形）の見本 */
export const PASS = 'mx.cloudflare.net; dkim=pass header.d=shop.example header.s=s1; spf=pass smtp.mailfrom=forward@shop.example; dmarc=pass';
export function message(raw, from = 'forward@shop.example', auth = PASS, { to = 'yoyaku@shop.example', rawSize } = {}) {
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  const headers = new Headers();
  if (auth !== null) headers.set('authentication-results', auth);
  return {
    from, to, rawSize: rawSize === undefined ? bytes.byteLength : rawSize, rejected: '', headers,
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
    setReject(why) { this.rejected = why; }
  };
}
export const MAIL_RAW = (body) => `From: Booking Site <noreply@booking.example>\r\nTo: forward@shop.example\r\nSubject: =?UTF-8?B?5LqI57SE?=\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;

/* AI が読んだ予約メールの答え（日付・メールが本文にある 1 名の予約） */
export const READING = (over = {}) => JSON.stringify({ participants: [{ name: '見本 次郎' }], health_info_visible: false,
  booking: { site: '予約サイト', date: '2026-11-05', start: '08:30', tour: '体験ダイビング', people: 1, lead_name: '見本 次郎', lead_email: 'jiro@mail.example', ...over } });
export const MAIL_BODY = '予約サイトからのお知らせ\r\n11/5 体験ダイビング 1 名\r\n見本 次郎 様\r\n連絡先: jiro@mail.example';

/* 名簿の行を D1 の見本に直接置く（Cron や入口を通さずに状態を作る） */
export function putState(s, state, { shop = 'default', version = 1 } = {}) {
  s.db.rows.set(shop, { version, state: JSON.stringify(state), updated_at: AT });
}

export function runTests(tests) {
  return (async () => {
    let failed = 0;
    for (const t of tests) {
      try {
        await t.fn();
        REAL_LOG(`ok   ${t.name}`);
      } catch (e) {
        failed += 1;
        REAL_LOG(`FAIL ${t.name}\n     ${e.stack || e.message}`);
      }
    }
    REAL_LOG(`${tests.length - failed}/${tests.length} passed`);
    if (failed) process.exit(1);
  })();
}
