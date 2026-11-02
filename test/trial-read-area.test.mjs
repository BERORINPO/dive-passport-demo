// 試用のお店の守り（決定ログ 2026-11-02 trial-read-area）を確かめる。
// 守ること: 申込書は、お店の読む範囲だけを切り出して送り、範囲の外（健康の欄）は 1 画素も入れない。
// 試用のお店（健康を紙で聞く）では、メールの文とお客さんが打った文を AI に送らない（Worker が 409 で断り、AI は呼ばない）。
// 実行: node test/trial-read-area.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import '../worker/sync-core.mjs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';
import { putRoster, paperShop } from '../worker/roster-db.mjs';
import { fakeKv, fakeD1, fakeAccess, fakeAnthropic, checkRedirect } from '../worker/fakes.mjs';
import { paperSql, parseArgs } from '../tools/shop.mjs';

vm.runInThisContext(readFileSync(new URL('../js/photo-mask.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const M = R.photoMask;
const AREA = { x0: 0.04, y0: 0.08, x1: 0.96, y1: 0.5 };
const AT = '2026-11-02T03:00:00.000Z';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('名簿の形: 読む範囲は 0〜1 の 4 つで、幅 0.2・高さ 0.1 以上。ほかの欄や外れた値は断る', () => {
  assert.ok(R.roster.areaOk(AREA));
  for (const bad of [{ ...AREA, x1: 1.2 }, { ...AREA, y0: -0.1 }, { ...AREA, x1: 0.1 }, { ...AREA, y1: 0.12 }, { ...AREA, z: 1 }, { x0: 0, y0: 0, x1: 1 }, { ...AREA, x0: '0' }]) {
    assert.equal(R.roster.areaOk(bad), false, JSON.stringify(bad));
  }
  const s = R.rosterCore.setReadArea(R.roster.blankState('A ダイブ'), { area: AREA, at: AT });
  assert.ok(R.roster.validateState(s).ok);
  assert.deepEqual(R.rosterCore.readAreaOf(s), AREA);
  assert.deepEqual(s.log.at(-1).fields, ['readArea'], '変えたら記録に残す');
  assert.equal(R.roster.validateState({ ...s, shop: { ...s.shop, readArea: { ...AREA, x1: 2 } } }).ok, false);
  assert.equal(R.rosterCore.readAreaOf(R.rosterCore.setReadArea(s, { area: null, at: AT })), null, 'null で外せる');
  assert.throws(() => R.rosterCore.setReadArea(s, { area: { ...AREA, x1: 0.05 }, at: AT }));
});

test('同期: 読む範囲の入った名簿を、サーバーが書き込みとして受ける（お店の欄の許可に入っている）', async () => {
  const { checkPut } = await import('../worker/sync-core.mjs');
  const s = R.rosterCore.setReadArea(R.rosterCore.setHealthPaper(R.roster.blankState('A ダイブ'), { paper: true, at: AT }), { area: AREA, at: AT });
  const got = checkPut({ base: 0, state: s }, { today: '2026-11-02', at: AT });
  assert.ok(got.ok, JSON.stringify(got));
  assert.equal(checkPut({ base: 0, state: { ...s, shop: { ...s.shop, other: 1 } } }, { today: '2026-11-02', at: AT }).ok, false, 'ほかの欄は今まで通り断る');
});

test('切り出し: 範囲の画素は内側へ丸め、範囲の外を 1 画素も含めない。小さすぎる範囲は止める', () => {
  const p = M.cropPixels({ x0: 0.101, y0: 0.2, x1: 0.899, y1: 0.4999 }, 1000, 1000);
  assert.deepEqual(p, { x0: 101, y0: 200, x1: 899, y1: 499 });
  assert.ok(p.x0 / 1000 >= 0.101 && p.x1 / 1000 <= 0.899 && p.y1 / 1000 <= 0.4999);
  assert.throws(() => M.cropPixels({ x0: 0.5, y0: 0.5, x1: 0.5004, y1: 0.6 }, 1000, 1000));
  assert.throws(() => M.cropPixels({ x0: 0, y0: 0, x1: 1 }, 10, 10));
});

test('お店を作る道具: --read-area を付けると、紙の名簿に読む範囲が入る。形の違う範囲は止める', () => {
  const sql = paperSql(parseArgs(['paper', '--id', 'shop-a', '--name', 'A ダイブ', '--read-area', '0.04,0.08,0.96,0.5']), AT);
  const state = JSON.parse(sql.match(/VALUES \('shop-a', 1, '(.*)', '2026/)[1].replace(/''/g, "'"));
  assert.equal(state.shop.health, 'paper');
  assert.deepEqual(state.shop.readArea, AREA);
  assert.ok(!('readArea' in JSON.parse(paperSql(parseArgs(['paper', '--id', 'shop-b', '--name', 'B']), AT).match(/VALUES \('shop-b', 1, '(.*)', '2026/)[1]).shop));
  assert.throws(() => parseArgs(['paper', '--id', 'shop-a', '--name', 'A', '--read-area', '0.1,0.1,0.2']));
  assert.throws(() => parseArgs(['paper', '--id', 'shop-a', '--name', 'A', '--read-area', '0,0,1,0.05']));
});

/* ---------- Worker: 試用のお店では文を AI に送らない ---------- */
const ORIGIN = 'https://dive-passport-demo.example.workers.dev';
const TEAM = 'mihon-team.cloudflareaccess.com';
const AUD = 'aud-0123456789abcdef';
const EMAIL = 'mihon.member@example.com';
const NOW = Date.parse('2026-11-02T01:00:00Z');
const access = await fakeAccess(TEAM);
const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });

async function setup({ paper }) {
  resetAccessCache();
  const api = fakeAnthropic();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL,
    DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: fakeD1(), SINGLE_SHOP: 'default' };
  const blank = R.roster.blankState('見本');
  const state = paper ? R.rosterCore.setHealthPaper(blank, { paper: true, at: AT }) : blank;
  await putRoster(env.DB, 'default', 0, JSON.stringify(state), AT);
  const io = {
    fetch: async (url, init) => {
      checkRedirect(init);
      if (url === access.certsUrl) return new Response(JSON.stringify({ keys: access.keys }), { status: 200 });
      if (url === 'https://api.anthropic.com/v1/messages') return api.respond(init);
      throw new Error(`unexpected fetch ${url}`);
    },
    now: () => NOW
  };
  return { api, env, io };
}
const post = (path, body) => new Request(`${ORIGIN}${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt }, body: JSON.stringify(body) });
const quiet = async (fn) => { const real = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = real; } };
const MAIL = { doc: 'mail', text: '件名: ご予約\n11 月 20 日 午前の体験ダイビング 2 名でお願いします。代表 見本 太郎' };

test('試用のお店か: 名簿の shop.health が paper のときだけ。名簿が無ければ違う、読めなければ試用として扱う', async () => {
  assert.equal(await paperShop((await setup({ paper: true })).env.DB, 'default'), true);
  assert.equal(await paperShop((await setup({ paper: false })).env.DB, 'default'), false);
  assert.equal(await paperShop(fakeD1(), 'nobody'), false);
  const s = await setup({ paper: false });
  await putRoster(s.env.DB, 'broken', 0, '{not json', AT);
  assert.equal(await paperShop(s.env.DB, 'broken'), true);
});

test('試用のお店: メールの文の読み取りとお客さまの画面の AI は 409 で、AI は呼ばない', async () => {
  const s = await setup({ paper: true });
  const mail = await quiet(() => handle(post('/api/read', MAIL), s.env, s.io));
  assert.equal(mail.status, 409);
  assert.deepEqual(await mail.json(), { error: 'paper' });
  const guest = await quiet(() => handle(post('/api/guest-ai', { kind: 'fill', text: '見本 太郎、11 月 20 日に 2 人で' }), s.env, s.io));
  assert.equal(guest.status, 409);
  assert.equal(s.api.calls.length, 0, 'AI に届いていない');
});

test('試用でないお店（見本の default）: メールの文は今まで通り AI に送る', async () => {
  const s = await setup({ paper: false });
  const res = await quiet(() => handle(post('/api/read', MAIL), s.env, s.io));
  assert.notEqual(res.status, 409);
  assert.equal(s.api.calls.length, 1);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
