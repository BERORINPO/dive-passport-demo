// 名簿の毎日の控えと警報（worker/backup-core.mjs・worker/backup.mjs。ジンのレビュー 2026-10-27 CRITICAL 2）を確かめる。
// 1 日 1 つ控えを取り 1 年残すこと、同じ日には取り直さないこと、済んだ便の行を 1 回だけ写すこと、人数が急に減ったら運営に知らせること、
// 済んだ便に移った分は減ったと数えないこと、知らせに名前を入れないこと、控えの置き場所が無ければ何もしないこと。
// 実行: node test/backup.test.mjs （Node 18 以上。依存なし。本物の Cloudflare は呼ばない）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scheduled } from '../worker/auto.mjs';
import { dropAlert, snapshotOf, dayKey } from '../worker/backup-core.mjs';
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

test('core: 5 人より多く、かつ 3 割より多く減ったら警報。済んだ便に移った人は数えない。読めない控えとは比べない', () => {
  const snap = (people) => ({ people });
  assert.equal(dropAlert(snap(30), snap(24), 0), null, '6 人減は 3 割に届かない');
  assert.deepEqual(dropAlert(snap(30), snap(5), 0), { before: 30, after: 5, moved: 0, gone: 25 });
  assert.equal(dropAlert(snap(30), snap(5), 25), null, '済んだ便に移った分');
  assert.equal(dropAlert(null, snap(0), 0), null);
  assert.equal(dropAlert(snap(-1), snap(0), 0), null);
  assert.equal(snapshotOf('{broken', { version: 1, at: 'x' }).people, -1);
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
  /* 翌日までに、何かの事故で 25 人が消えた */
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

test('済んだ便に移った人は、減ったと数えない。移った行は 1 回だけ、消える日まで写す', async () => {
  const s = setup();
  s.io.clock = Date.parse('2026-10-02T15:30:00Z');   // 日本で 10/3
  store(s, big('2026-10-01'), { today: '2026-10-03' });
  await scheduled(s.env, s.io);
  /* 10/9 に便が済んで 7 日を過ぎ、済んだ便へ移った */
  s.io.clock = Date.parse('2026-10-08T15:30:00Z');   // 日本で 10/9
  const prevDay = JSON.parse(s.kv.peek(dayKey('default', '2026-10-03')));
  store(s, JSON.parse(prevDay.text), { version: 2, today: '2026-10-09' });
  s.kv.put(dayKey('default', '2026-10-08'), JSON.stringify(prevDay));   // 前の日の控えがある形（間の日は Cron が動いていた）
  await scheduled(s.env, s.io);
  assert.equal(s.mail.sent.length, 0, '移った分は警報にしない');
  const pasts = s.kv.puts.filter(p => p.k.startsWith('past:default:trip:'));
  assert.equal(pasts.length, 1);
  assert.ok(pasts[0].opts.expiration >= Date.parse('2027-10-01T00:00:00Z') / 1000, '消える日まで残す');
  s.io.clock += DAY;
  await scheduled(s.env, s.io);
  assert.equal(s.kv.puts.filter(p => p.k.startsWith('past:default:trip:')).length, 1, '2 回は写さない');
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
  assert.equal(s.mail.sent.filter(m => m.subject.includes('急に減りました')).length, 0);
});

test('控えから戻す（tools/restore.mjs）: 控えの名簿を検査してから、D1 に戻す 1 文を作る。本物の SQLite で流すと版が進んで名簿が戻る。壊れた控えは止める', async () => {
  const { restoreBody } = await import('../tools/restore.mjs');
  const { sqliteD1 } = await import('./d1-sqlite.mjs');
  const s = setup();
  store(s, big('2026-11-05'));
  await scheduled(s.env, s.io);
  const snapText = s.kv.peek(dayKey('default', '2026-10-28'));
  const body = restoreBody(snapText, { shop: 'default', at: '2026-10-29T00:00:00.000Z' });
  assert.equal(body.people, 30);
  assert.ok(!body.sql.includes('見本'), '名簿は SQL に埋めない');
  const db = await sqliteD1();
  if (db) {
    db.raw.prepare("INSERT INTO rosters (shop, version, state, updated_at) VALUES ('default', 7, '{}', 'x')").run();
    await db.prepare(body.sql).bind(...body.params).run();
    const row = await db.prepare('SELECT version, state FROM rosters WHERE shop = ?1').bind('default').first();
    assert.equal(row.version, 8, '版が進む（開いている画面は戻した名簿を受け取る）');
    assert.equal(JSON.parse(row.state).people.length, 30);
  }
  assert.throws(() => restoreBody('{broken', { shop: 'default', at: 'x' }), /JSON/);
  assert.throws(() => restoreBody(JSON.stringify({ text: '{"v":1}' }), { shop: 'default', at: '2026-10-29T00:00:00.000Z' }), /検査/);
  assert.throws(() => restoreBody(snapText, { shop: "x'; DROP", at: 'x' }), /id/);
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
