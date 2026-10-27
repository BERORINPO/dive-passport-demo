// 読めなかった予約メール（ジンのレビュー 2026-10-27 HIGH 6。plan/auto.md）を確かめる。
// 送り主の確かめを通ったお店のメールが名簿に入らなかったら、届いた時刻と理由だけを残し、お店の画面の口（/api/mail-unread）で読めて、「済んだ」で消せること。
// 送り主で断ったメールは残さないこと、件名や本文は残さないこと、30 日で消えること、1 日の上限、他のお店の行は見えないこと。
// 実行: node test/unread.test.mjs （Node 18 以上。依存なし。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { receiveMail } from '../worker/auto.mjs';
import { unreadWhy, UNREAD_WHY } from '../worker/auto-core.mjs';
import { fakeKv, fakeAccess, fakeAnthropic, fakeD1, checkRedirect } from '../worker/fakes.mjs';

const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-10-27T05:05:00Z');   // 日本では 10/27 の 14:05
const access = await fakeAccess(TEAM);
const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 365 * 86400, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
const PASS = 'mx.cloudflare.net; dkim=pass header.d=shop.example header.s=s1; spf=pass smtp.mailfrom=forward@shop.example; dmarc=pass';

const REAL_LOG = console.log;
const logs = [];
console.log = (line) => logs.push(String(line));

function setup() {
  resetAccessCache();
  const db = fakeD1();
  const api = fakeAnthropic();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, MAIL_SENDERS: 'forward@shop.example', SHOP_NAME: 'B マリン（見本）' };
  const io = {
    clock: NOW,
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => io.clock
  };
  return { db, api, env, io };
}
function message(body, from = 'forward@shop.example') {
  const raw = `From: Booking Site <noreply@booking.example>\r\nTo: forward@shop.example\r\nSubject: 見本 花子様のご予約\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  const bytes = new TextEncoder().encode(raw);
  return { from, to: 'yoyaku@shop.example', rawSize: bytes.byteLength, rejected: '', headers: new Headers({ 'authentication-results': PASS }),
    raw: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }), setReject(why) { this.rejected = why; } };
}
async function api(s, method, body) {
  const h = { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) };
  const res = await handle(new Request(`${ORIGIN}/api/mail-unread`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), s.env, s.io);
  return { status: res.status, body: await res.json() };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('理由の言葉: 送り主の確かめで断った物と設定の誤りは残さない。ほかは画面の言葉のどれかになる', () => {
  for (const why of ['inbox', 'sender', 'auth', 'config', '', undefined]) assert.equal(unreadWhy(why), null, String(why));
  const cases = { 'mail-daily': 'limit', size: 'size', 'no-text': 'text', 'input-text': 'text', 'no-date': 'no-date', 'add-full': 'full',
    'add-conflict': 'roster', crash: 'error', 'upstream-timeout': 'ai', answer: 'ai' };
  for (const [why, want] of Object.entries(cases)) assert.equal(unreadWhy(why), want, why);
  Object.values(cases).forEach(w => assert.ok(UNREAD_WHY.includes(w)));
});

test('日付の読めないメール・AI に届かないメールは、時刻と理由だけ残り、お店の画面の口で読めて、「済んだ」で消える。件名と本文は残さない', async () => {
  const s = setup();
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 三郎' }], booking: { people: 1 }, health_info_visible: false });
  await receiveMail(message('日付の無いメール 見本 三郎'), s.env, s.io);
  s.io.clock = NOW + 60000;
  s.api.status = 529;
  await receiveMail(message('AI に届かない'), s.env, s.io);
  const list = await api(s, 'GET');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items.map(x => x.why), ['ai', 'no-date'], '新しい順');
  assert.equal(list.body.items[1].at, '2026-10-27T05:05:00.000Z');
  const kept = JSON.stringify([...s.db.unread.values()]);
  assert.ok(!/見本|花子|三郎|予約|booking/.test(kept), '件名・本文・送り主は残さない');
  assert.equal((await api(s, 'POST', { id: list.body.items[0].id })).status, 200);
  assert.equal((await api(s, 'POST', { id: list.body.items[0].id })).status, 404, '2 回目は無い');
  assert.equal((await api(s, 'GET')).body.items.length, 1);
  for (const bad of [{}, { id: 'A B' }, { id: 'x', more: 1 }, { id: 1 }]) assert.equal((await api(s, 'POST', bad)).status, 400, JSON.stringify(bad));
});

test('送り主で断ったメールは残さない。名簿に入ったメールも残さない', async () => {
  const s = setup();
  const evil = message('予約です', 'evil@x.example');
  await receiveMail(evil, s.env, s.io);
  assert.ok(evil.rejected);
  s.api.answer = JSON.stringify({ participants: [{ name: '見本 次郎' }], booking: { date: '2026-11-05', start: '08:30', tour: '体験ダイビング', people: 1, lead_name: '見本 次郎' }, health_info_visible: false });
  await receiveMail(message('11/5 体験ダイビング 1 名'), s.env, s.io);
  assert.equal(JSON.parse(s.db.rows.get('default').state).bookings.length, 1);
  assert.equal(s.db.unread.size, 0);
});

test('30 日を過ぎた行は、次に足すときに消え、口も渡さない。1 日の上限を超えたら残さない。他のお店の行は見えない', async () => {
  const s = setup();
  s.db.unread.set('default\nold', { shop: 'default', id: 'old', at: '2026-09-20T00:00:00.000Z', why: 'ai' });
  s.db.unread.set('shop-b\nb1', { shop: 'shop-b', id: 'b1', at: '2026-10-27T00:00:00.000Z', why: 'ai' });
  assert.deepEqual((await api(s, 'GET')).body.items, [], '30 日を過ぎた行と、他のお店の行は渡さない');
  await receiveMail(message(''), s.env, s.io);   // 本文が空
  assert.ok(!s.db.unread.has('default\nold'), '足すときに消えた');
  assert.ok(s.db.unread.has('shop-b\nb1'), '他のお店の行には触らない');
  assert.deepEqual((await api(s, 'GET')).body.items.map(x => x.why), ['text']);
  s.env.BUDGET.put('unread:default:2026-10-27', '60');
  await receiveMail(message(''), s.env, s.io);
  await receiveMail(message(''), s.env, s.io);
  s.db.failing = true;
  await receiveMail(message(''), s.env, s.io);   // D1 の不調で書けなくても、次の 1 通でまた書く
  s.db.failing = false;
  await receiveMail(message(''), s.env, s.io);
  const mine = [...s.db.unread.values()].filter(u => u.shop === 'default');
  assert.deepEqual(mine.map(u => u.why).sort(), ['many', 'text'], '1 日 60 件を超えたら、「ほかにもあった」を 1 日 1 行だけ');
  assert.ok(logs.some(l => /"unread":"daily"/.test(l)));
});

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
