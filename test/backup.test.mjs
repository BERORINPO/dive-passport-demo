// 名簿の毎日の控えと警報（worker/backup-core.mjs・worker/backup.mjs。ジンのレビュー 2026-10-27 CRITICAL 2）を確かめる。
// 1 日 1 つ控えを取り 1 年残すこと、同じ日には取り直さないこと、済んだ便の行を 1 回だけ写すこと、人数が急に減ったら運営に知らせること、
// 済んだ便に移った分は減ったと数えないこと、知らせに名前を入れないこと、控えの置き場所が無ければ何もしないこと。
// 実行: node test/backup.test.mjs （Node 18 以上。依存なし。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scheduled } from '../worker/auto.mjs';
import { handlePublic } from '../worker/handler.mjs';
import { cronFresh } from '../worker/auto-core.mjs';
import { dropAlert, snapshotOf, baseOf, dayKey } from '../worker/backup-core.mjs';
import { checkPut } from '../worker/sync-core.mjs';
import { fakeKv, fakeD1, fakeMail } from '../worker/fakes.mjs';

vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterShare: X } = R;
const REAL_LOG = console.log;
const logs = [];
console.log = (line) => logs.push(String(line));

const DAY = 86400000;
const T0 = Date.parse('2026-10-27T15:30:00Z');   // 日本で 10/28 の 0:30
let n = 0;
const newId = () => `id${(n += 1)}`;

function setup({ backup = true } = {}) {
  const db = fakeD1();
  const kv = fakeKv();
  const mail = fakeMail();
  const env = { DB: db, BUDGET: fakeKv(), EMAIL: mail, MAIL_FROM: 'yoyaku@shop.example', APP_URL: 'https://app.shop.example', ALERT_TO: 'ops@shop.example', ...(backup ? { BACKUP: kv } : {}) };
  const io = { clock: T0, now: () => io.clock, fetch: async () => { throw new Error('no fetch'); } };
  return { db, kv, mail, env, io };
}
/* 名簿を D1 に直に置く（サーバーが書いた形。済んだ便は分ける） */
function store(s, state, { version = 1, today = '2026-10-28' } = {}) {
  const c = checkPut({ base: version - 1, state }, { today, at: new Date(s.io.clock).toISOString() });
  assert.ok(c.ok, c.error);
  s.db.rows.set('default', { version, state: c.text, updated_at: 'x' });
  c.parts.forEach(p => s.db.past.set(`default\n${p.part}`, { shop: 'default', part: p.part, day: p.day, keep_until: p.keepUntil, body: p.body, moved_at: new Date(s.io.clock).toISOString() }));
  return c.state;
}
const big = (day) => X.addBigSample(S.blankState('B マリン（見本）'), { day, at: '2026-10-20T01:00:00.000Z', newId }).state;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('core: 直近でいちばん多い日と比べる。5 人より多く、かつ 3 割より多く減ったら。名簿が無い・読めない・0 人なら数に関係なく。済んだ便に移った人は数えない', () => {
  const snap = (people) => ({ people, at: 'x' });
  assert.equal(dropAlert(snap(30), snap(24), 0), null, '6 人減は 3 割に届かない');
  assert.deepEqual(dropAlert(snap(30), snap(5), 0), { kind: 'drop', before: 30, after: 5, moved: 0, gone: 25 });
  assert.equal(dropAlert(snap(30), snap(5), 25), null, '済んだ便に移った分');
  assert.equal(dropAlert(null, snap(0), 0), null, '比べる控えが無い');
  assert.equal(dropAlert(snap(5), snap(0), 0).kind, 'empty', '小さいお店でも 0 人は警報');
  assert.equal(dropAlert(snap(5), null, 0).kind, 'missing', '名簿の行が消えた');
  assert.equal(dropAlert(snap(5), snap(-1), 0).kind, 'unreadable');
  assert.equal(baseOf([snap(20), null, snap(-1), snap(30), snap(25)]).people, 30, 'じわじわ減っても、直近でいちばん多い日と比べる');
  assert.equal(snapshotOf('{broken', { shop: 'default', version: 1, at: 'x' }).people, -1);
  assert.equal(snapshotOf('{"people":[]}', { shop: 'shop-a', version: 1, at: 'x' }).shop, 'shop-a');
});

test('Cron: 1 日 1 つ控えを取り、1 年残す。同じ日にはもう取らない', async () => {
  const s = setup();
  store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  const put = s.kv.puts.find(p => p.k === dayKey('default', '2026-10-28'));
  assert.ok(put, '今日の控え');
  assert.equal(put.opts.expirationTtl, 366 * 86400);
  const snap = JSON.parse(put.v);
  assert.equal(snap.people, 30);
  assert.equal(snap.shop, 'default');
  assert.equal(JSON.parse(snap.text).people.length, 30, '名簿の本体をそのまま');
  const count = s.kv.puts.length;
  s.io.clock = T0 + 15 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(s.kv.puts.length, count, '同じ日には取らない');
});

test('人数が急に減ったら、運営にメールで知らせ、警報を残す。知らせに名前を入れない', async () => {
  const s = setup();
  const st = store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  s.io.clock = T0 + DAY;
  store(s, { ...st, people: st.people.slice(0, 5) }, { version: 2, today: '2026-10-29' });
  await scheduled(s.env, s.io);
  assert.ok(s.kv.peek('alert:default:2026-10-29'), '警報を残す');
  const m = s.mail.sent.find(x => x.to === 'ops@shop.example');
  assert.ok(m, '運営に知らせる');
  assert.ok(m.subject.includes('名簿の人数が急に減りました'));
  assert.ok(!/見本/.test(m.subject + m.text), '名前を入れない');
  assert.ok(logs.some(l => /"alerts":1/.test(l)));
});

test('ジンのレビュー: 名簿の行が消えた・じわじわ減った・Cron が止まっていた、でも気付く。同じ日に何度も鳴らさない', async () => {
  /* 行が消えた（一覧が空なので default を回る） */
  const a = setup();
  store(a, big('2026-11-05'));
  await scheduled(a.env, a.io);
  a.db.rows.delete('default');
  a.io.clock = T0 + DAY;
  await scheduled(a.env, a.io);
  assert.equal(JSON.parse(a.kv.peek('alert:default:2026-10-29')).kind, 'missing');
  const sent = a.mail.sent.length;
  a.io.clock += 15 * 60000;
  await scheduled(a.env, a.io);
  assert.equal(a.mail.sent.length, sent, '同じ日は 1 回だけ');
  /* 3 日かけて 30 → 24 → 19 → 15。1 日ずつは小さいが、直近でいちばん多い日（30）とは 15 人減 */
  const b = setup();
  let st = store(b, big('2026-11-05'));
  await scheduled(b.env, b.io);
  for (const [i, keep] of [[1, 24], [2, 19], [3, 15]]) {
    b.io.clock = T0 + i * DAY;
    st = store(b, { ...st, people: st.people.slice(0, keep) }, { version: i + 1, today: `2026-10-${28 + i}` });
    await scheduled(b.env, b.io);
  }
  assert.ok(b.kv.peek('alert:default:2026-10-31'), 'じわじわ減っても気付く');
  /* Cron が 3 日止まっていた後でも、残っている控えと比べる */
  const c = setup();
  const st2 = store(c, big('2026-11-05'));
  await scheduled(c.env, c.io);
  c.io.clock = T0 + 4 * DAY;
  store(c, { ...st2, people: st2.people.slice(0, 3) }, { version: 2, today: '2026-11-01' });
  await scheduled(c.env, c.io);
  assert.ok(c.kv.peek('alert:default:2026-11-01'));
});

test('済んだ便に移った人は、減ったと数えない。移った行は続きから 1 回だけ、消える日まで写す。Cron を動かす前からの行も写す', async () => {
  const s = setup();
  s.io.clock = Date.parse('2026-10-08T15:30:00Z');   // 日本で 10/9。10/01 の便は Cron を動かす前に済んだ便へ移っている
  store(s, big('2026-10-01'), { today: '2026-10-09' });
  s.db.past.forEach(p => { p.moved_at = '2026-10-05T00:00:00.000Z'; });
  await scheduled(s.env, s.io);
  const pasts = () => s.kv.puts.filter(p => p.k.startsWith('past:default:trip:'));
  assert.equal(pasts().length, 1, '前からの行も写す');
  assert.ok(pasts()[0].opts.expiration >= Date.parse('2027-10-01T00:00:00Z') / 1000, '消える日まで残す');
  s.io.clock += DAY;
  await scheduled(s.env, s.io);
  assert.equal(pasts().length, 1, '2 回は写さない');
  /* 前の日の控え（30 人）のあとで 30 人が済んだ便に移った */
  const t = setup();
  t.io.clock = Date.parse('2026-10-07T15:30:00Z');   // 日本で 10/8
  const st = store(t, big('2026-10-01'), { today: '2026-10-08' });
  await scheduled(t.env, t.io);
  t.io.clock = Date.parse('2026-10-08T15:30:00Z');   // 10/9: 移る
  store(t, st, { version: 2, today: '2026-10-09' });
  await scheduled(t.env, t.io);
  assert.equal(t.mail.sent.length, 0, '移った分は警報にしない');
});

test('控えの置き場所（BACKUP）が無ければ何もしない。メールの設定が無ければ警報は KV とログだけ', async () => {
  const off = setup({ backup: false });
  store(off, big('2026-11-05'));
  await scheduled(off.env, off.io);
  assert.ok(logs.some(l => /"route":"cron"/.test(l)));
  const s = setup();
  delete s.env.ALERT_TO;
  const st = store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  s.io.clock = T0 + DAY;
  store(s, { ...st, people: [] }, { version: 2, today: '2026-10-29' });
  await scheduled(s.env, s.io);
  assert.ok(s.kv.peek('alert:default:2026-10-29'));
  assert.equal(s.mail.sent.filter(m => m.subject.includes('REDUX')).length, 0);
});

test('点検 2026-10-28 運用 C3: 警報のメールが送れなかったら、次の Cron でもう一度送る。送れたら二度は送らない', async () => {
  const s = setup();
  const st = store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  s.io.clock = T0 + DAY;
  store(s, { ...st, people: st.people.slice(0, 5) }, { version: 2, today: '2026-10-29' });
  s.mail.fail = 'E_DELIVERY_FAILED';
  await scheduled(s.env, s.io);
  assert.equal(JSON.parse(s.kv.peek('alert:default:2026-10-29')).mailed, 'pending');
  s.mail.fail = '';
  s.io.clock += 15 * 60000;
  await scheduled(s.env, s.io);
  const toOps = () => s.mail.sent.filter(m => m.to === 'ops@shop.example').length;
  assert.equal(toOps(), 1, '次の回に送れた');
  assert.equal(JSON.parse(s.kv.peek('alert:default:2026-10-29')).mailed, 'sent');
  s.io.clock += 15 * 60000;
  await scheduled(s.env, s.io);
  assert.equal(toOps(), 1, '送れた後は鳴らし直さない');
});

test('点検 2026-10-28 運用 C2: Cron は最後に動いた時刻を残し、お客さん用の Worker の /api/health が 45 分より古ければ 503 を返す', async () => {
  const s = setup();
  store(s, big('2026-11-05'));
  const health = async () => handlePublic(new Request('https://ask.example/api/health'), { BUDGET: s.env.BUDGET }, s.io);
  assert.equal((await health()).status, 503, 'まだ一度も動いていない');
  await scheduled(s.env, s.io);
  const ok = await health();
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.deepEqual(Object.keys(body).sort(), ['cronAt', 'ok'], '返すのは時刻だけ');
  s.io.clock += 46 * 60000;
  assert.equal((await health()).status, 503, '45 分を過ぎたら止まっていると返す');
  assert.equal(cronFresh('{"at":"x"}', '2026-01-01T00:00:00.000Z').ok, false, '壊れた値は止まっている扱い');
});

test('控えから戻す（tools/restore.mjs）: お店が違えば止め、今の版でだけ書き、戻すと消える数を出す。本物の SQLite で流すと版が進んで名簿が戻る', async () => {
  const { restoreBody, currentOf } = await import('../tools/restore.mjs');
  const { sqliteD1 } = await import('./d1-sqlite.mjs');
  const s = setup();
  const st = store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  const snapText = s.kv.peek(dayKey('default', '2026-10-28'));
  const at = '2026-10-29T00:00:00.000Z';
  /* 今の名簿: 控えのあとに 1 人足され、その後に 20 人が消えた（版 7） */
  const extra = { ...st.people[0], id: 'later1', name: '見本 あと' };
  const now = { ...st, people: [...st.people.slice(0, 10), extra] };
  const current = currentOf(JSON.stringify({ result: [{ results: [{ shop: 'default', version: 7, state: JSON.stringify(now) }] }] }));
  assert.equal(current.version, 7);
  const body = restoreBody(snapText, { shop: 'default', at, current });
  assert.equal(body.people, 30);
  assert.deepEqual(body.lost, { bookings: 0, people: 1 }, '戻すと消える 1 人を知らせる');
  const answered = { ...now, people: now.people.map((x, i) => (i === 0 ? { ...x, checkedAt: '2026-10-28T09:00:00.000Z' } : x)) };
  const body2 = restoreBody(snapText, { shop: 'default', at, current: { ...current, state: answered } });
  assert.deepEqual(body2.changed, { bookings: 0, people: 1 }, '控えのあとで中身が変わった人も知らせる');
  assert.ok(!body.sql.includes('見本'), '名簿は SQL に埋めない');
  assert.throws(() => restoreBody(snapText, { shop: 'shop-b', at, current }), /お店/, '別のお店へは戻さない');
  assert.throws(() => restoreBody(snapText, { shop: 'default', at }), /current/);
  assert.throws(() => restoreBody(snapText, { shop: 'default', at, current: { ...current, shop: 'shop-b' } }), /書き出しのお店/, '別のお店の書き出しでは戻さない');
  assert.throws(() => currentOf(JSON.stringify({ result: [{ results: [{ version: 7, state: '{}' }] }] })), /お店/);
  assert.throws(() => restoreBody('{broken', { shop: 'default', at, current }), /JSON/);
  assert.throws(() => restoreBody(JSON.stringify({ shop: 'default', text: '{"v":1}' }), { shop: 'default', at, current }), /検査/);
  assert.throws(() => restoreBody(snapText, { shop: "x'; DROP", at, current }), /id/);
  const db = await sqliteD1();
  if (db) {
    db.raw.prepare("INSERT INTO rosters (shop, version, state, updated_at) VALUES ('default', 8, '{}', 'x')").run();
    const stale = await db.prepare(body.sql).bind(...body.params).run();
    assert.equal(stale.meta.changes, 0, '書き出したあとに版が進んでいたら書かない');
    db.raw.prepare("UPDATE rosters SET version = 7 WHERE shop = 'default'").run();
    await db.prepare(body.sql).bind(...body.params).run();
    const row = await db.prepare('SELECT version, state FROM rosters WHERE shop = ?1').bind('default').first();
    assert.equal(row.version, 8, '版が進む（開いている画面は戻した名簿を受け取る）');
    assert.equal(JSON.parse(row.state).people.length, 30);
  }
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
