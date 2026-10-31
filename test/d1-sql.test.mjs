// D1 の文を本物の SQLite（node:sqlite）で流す（ジンのレビュー 2026-10-27 MEDIUM 11: fakeD1 は SQL を文字で照らすだけで、表を作る SQL も一度も流れていなかった）。
// 1. 同じ操作を fakeD1 と SQLite の両方に流し、答えが同じかを比べる（fakeD1 が本物とずれたら、ここで落ちる）
// 2. adapter（worker/*-db.mjs）の SQL が全部、SQLite で 1 回は流れたかを確かめる（文を足したのにここを足し忘れたら落ちる）
// 3. 名簿・済んだ便・読めなかった予約メールを、本物の handler から SQLite につないで通しで動かす
// 実行: node test/d1-sql.test.mjs （node:sqlite が無い Node では全部飛ばす）
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { sqliteD1 } from './d1-sqlite.mjs';
import { fakeD1, fakeKv, fakeAccess, checkRedirect } from '../worker/fakes.mjs';
import { getRoster, putRoster, getPast, getMovedSince } from '../worker/roster-db.mjs';
import { putLink, findLink, countLinks, useLink, dropExpired } from '../worker/ask-db.mjs';
import { listShops, rosterShops } from '../worker/shop-db.mjs';
import { addUnread, listUnread, dropUnread } from '../worker/unread-db.mjs';
import { takeDaily, takeDailyAll, dropOldCounts } from '../worker/limit-db.mjs';
import { putWalkinKey, findWalkinShop, walkinKeyAt, addWalkin, listWalkins, dropWalkin, dropExpiredWalkins } from '../worker/walkin-db.mjs';
import { putApiKey, findApiKey, countApiKeys, listApiKeys, rotateApiKey, revokeApiKey, claimIdem, readIdem, finishIdem, releaseIdem, dropOldIdem } from '../worker/intake-db.mjs';
import { changeKeysFor } from '../worker/intake-route.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { keyHash } from '../worker/ask-key.mjs';
import { checkPut } from '../worker/sync-core.mjs';
import { handle } from '../worker/handler.mjs';
import { resetAccessCache } from '../worker/access.mjs';

const first = await sqliteD1();
/* node:sqlite が無い Node では、何も確かめずに通さない（SKIP_SQLITE=1 を付けたときだけ飛ばす） */
if (!first) { console.log(process.env.SKIP_SQLITE === '1' ? 'skip (node:sqlite が無い)' : 'FAIL node:sqlite が無い（Node 22.5 以上で流す）'); process.exit(process.env.SKIP_SQLITE === '1' ? 0 : 1); }

vm.runInThisContext(readFileSync(new URL('../js/data-big-sample.js', import.meta.url), 'utf8'));
const R = globalThis.REDUX;
const { roster: S, rosterShare: X } = R;
const TODAY = '2026-10-27';
const AT = '2026-10-27T01:00:00.000Z';
let n = 0;
const newId = () => `id${(n += 1)}`;
const sample = () => {
  n = 0;
  let st = X.addBigSample(S.blankState('B マリン（見本）'), { day: '2026-10-01', at: '2026-09-30T01:00:00.000Z', newId }).state;
  st = X.addBigSample(st, { day: '2026-10-29', at: AT, newId }).state;
  return st;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* fakeD1 と SQLite に同じ操作を流し、答えを並べる */
async function scenario(db) {
  const out = [];
  const log = async (label, p) => { try { out.push([label, await p]); } catch (e) { out.push([label, 'throw']); } };
  await log('shops-empty', listShops(db));
  db.addShop({ id: 'shop-a', name: 'A ダイブ', members: ['a@example.com'], sites: ['https://a.example.com'], inbox: '', senders: [], replyTo: 'info@a.example.com' });
  await log('shops', listShops(db));
  await log('roster-none', getRoster(db, 'shop-a'));
  const c1 = checkPut({ base: 0, state: sample() }, { today: TODAY, at: AT });
  await log('put-0', putRoster(db, 'shop-a', 0, c1.text, AT, { parts: c1.parts, today: TODAY }));
  await log('put-0-again', putRoster(db, 'shop-a', 0, c1.text, AT, { parts: c1.parts, today: TODAY }));
  await log('put-stale', putRoster(db, 'shop-a', 5, c1.text, AT));
  await log('put-1', putRoster(db, 'shop-a', 1, c1.text, AT));
  await log('roster', getRoster(db, 'shop-a').then(r => ({ version: r.version, size: r.text.length })));
  await log('roster-shops', rosterShops(db));
  await log('past', getPast(db, 'shop-a', '2026-09-27', TODAY, TODAY, 400).then(rows => rows.map(r => [r.part.split(':')[0], r.day, r.body.length])));
  await log('past-other-shop', getPast(db, 'shop-b', '2026-09-27', TODAY, TODAY, 400));
  await log('past-limit', getPast(db, 'shop-a', '2026-09-27', TODAY, TODAY, 1).then(rows => rows.length));
  await log('moved-since', getMovedSince(db, 'shop-a', '2026-10-26T00:00:00.000Z', 100).then(rows => rows.map(r => [r.part.split(':')[0], r.day, r.keepUntil])));
  await log('moved-later', getMovedSince(db, 'shop-a', '2026-10-28T00:00:00.000Z', 100));
  await log('link-put', putLink(db, { hash: 'h1', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-put-again', putLink(db, { hash: 'h2', shop: 'shop-a', bookingId: 'b1', personId: '', expiresOn: '2026-10-30', at: AT }));
  await log('link-person', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-dup', putLink(db, { hash: 'h3', shop: 'shop-a', bookingId: 'b1', personId: 'p1', expiresOn: '2026-10-26', at: AT }));
  await log('link-staff', putLink(db, { hash: 'h4', shop: 'shop-a', bookingId: 'b1', personId: 'p2', expiresOn: '2026-10-30', at: AT, mintedBy: 'staff' }));
  await log('link-find-staff', findLink(db, 'h4'));
  await log('link-find-booking', findLink(db, 'h3'));
  await log('link-find-old', findLink(db, 'h1'));
  await log('link-find', findLink(db, 'h2'));
  await log('link-count', countLinks(db, { shop: 'shop-a', bookingId: 'b1', personId: '', today: '2026-10-01' }));
  for (let i = 0; i < 4; i += 1) await log(`link-use-${i}`, useLink(db, 'h2', TODAY, 3));
  await log('link-use-next-day', useLink(db, 'h2', '2026-10-28', 3));
  await log('link-drop', dropExpired(db, TODAY));
  await log('link-after-drop', findLink(db, 'h3'));
  await log('unread-add', addUnread(db, 'shop-a', { id: 'u1', at: '2026-10-27T01:00:00.000Z', why: 'ai', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-add-2', addUnread(db, 'shop-a', { id: 'u2', at: '2026-10-27T02:00:00.000Z', why: 'text', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-same-id', addUnread(db, 'shop-a', { id: 'u2', at: '2026-10-27T03:00:00.000Z', why: 'many', before: '2026-09-27T00:00:00.000Z' }));
  await log('unread-list', listUnread(db, 'shop-a', '2026-09-27T00:00:00.000Z', 50));
  await log('unread-other', listUnread(db, 'shop-b', '2026-09-27T00:00:00.000Z', 50));
  await log('unread-drop', dropUnread(db, 'shop-a', 'u1'));
  await log('unread-drop-again', dropUnread(db, 'shop-a', 'u1'));
  await log('unread-old-gone', addUnread(db, 'shop-a', { id: 'u3', at: '2026-10-27T04:00:00.000Z', why: 'ai', before: '2026-10-27T03:00:00.000Z' }).then(() => listUnread(db, 'shop-a', '', 50)));
  for (let i = 0; i < 4; i += 1) await log(`daily-${i}`, takeDaily(db, { scope: 'site', shop: 'shop-a', day: TODAY, max: 3 }));
  await log('daily-other-shop', takeDaily(db, { scope: 'site', shop: 'shop-b', day: TODAY, max: 3 }));
  await log('daily-other-scope', takeDaily(db, { scope: 'mail', shop: 'shop-a', day: TODAY, max: 3 }));
  await log('daily-next-day', takeDaily(db, { scope: 'site', shop: 'shop-a', day: '2026-10-28', max: 3 }));
  await log('daily-zero-max', takeDaily(db, { scope: 'site', shop: 'shop-c', day: TODAY, max: 0 }));
  for (let i = 0; i < 3; i += 1) await log(`daily-all-${i}`, takeDailyAll(db, { scope: 'mail', shop: 'shop-b', day: TODAY, max: 2, maxAll: 1 }));
  await log('daily-all-shop-full', takeDaily(db, { scope: 'mail', shop: 'shop-b', day: TODAY, max: 2 }));
  await log('daily-drop', dropOldCounts(db, '2026-10-28'));
  await log('daily-after-drop', takeDaily(db, { scope: 'site', shop: 'shop-a', day: TODAY, max: 1 }));
  await log('daily-keep-today', takeDaily(db, { scope: 'site', shop: 'shop-a', day: '2026-10-28', max: 1 }));
  /* 店頭の QR（0007）: 鍵の SHA-256 は 1 つのお店に 1 つ、作り直すと前の鍵は開けない。同じ SHA-256 を別のお店には置けない */
  await log('walkin-key-none', findWalkinShop(db, 'w1'));
  await log('walkin-key-at-none', walkinKeyAt(db, 'shop-a'));
  await log('walkin-key-put', putWalkinKey(db, { shop: 'shop-a', hash: 'w1', at: AT }));
  await log('walkin-key-find', findWalkinShop(db, 'w1'));
  await log('walkin-key-at', walkinKeyAt(db, 'shop-a'));
  await log('walkin-key-rotate', putWalkinKey(db, { shop: 'shop-a', hash: 'w2', at: '2026-10-27T02:00:00.000Z' }));
  await log('walkin-key-old', findWalkinShop(db, 'w1'));
  await log('walkin-key-new', findWalkinShop(db, 'w2'));
  await log('walkin-key-other-shop-dup', putWalkinKey(db, { shop: 'shop-b', hash: 'w2', at: AT }));
  await log('walkin-add-1', addWalkin(db, { shop: 'shop-a', id: 'x1', tripId: 't1', body: '{"a":1}', at: AT, expiresOn: '2026-10-29' }));
  await log('walkin-add-2', addWalkin(db, { shop: 'shop-a', id: 'x2', tripId: '', body: '{"a":2}', at: '2026-10-27T02:00:00.000Z', expiresOn: '2026-10-27' }));
  await log('walkin-add-dup', addWalkin(db, { shop: 'shop-a', id: 'x1', tripId: '', body: '{}', at: AT, expiresOn: '2026-10-29' }));
  await log('walkin-list', listWalkins(db, 'shop-a', TODAY, 50));
  await log('walkin-list-limit', listWalkins(db, 'shop-a', TODAY, 1));
  await log('walkin-list-later', listWalkins(db, 'shop-a', '2026-10-28', 50));
  await log('walkin-list-other', listWalkins(db, 'shop-b', TODAY, 50));
  await log('walkin-drop', dropWalkin(db, 'shop-a', 'x1'));
  await log('walkin-drop-again', dropWalkin(db, 'shop-a', 'x1'));
  await log('walkin-drop-other-shop', dropWalkin(db, 'shop-b', 'x2'));
  await log('walkin-expire', dropExpiredWalkins(db, '2026-10-28').then(() => listWalkins(db, 'shop-a', '2000-01-01', 50)));
  /* 予約の受け口 API（0008）: 鍵の SHA-256 から引く・数える・並べる・作り直す・止める */
  const LATER = '2026-10-27T02:00:00.000Z';
  await log('apikey-find-none', findApiKey(db, 'h1'));
  await log('apikey-put', putApiKey(db, { id: 'k1', shop: 'shop-a', hash: 'h1', label: 'WordPress', at: AT }));
  await log('apikey-put-dup-hash', putApiKey(db, { id: 'k9', shop: 'shop-a', hash: 'h1', label: 'x', at: AT }));
  await log('apikey-put-dup-id', putApiKey(db, { id: 'k1', shop: 'shop-a', hash: 'h9', label: 'x', at: AT }));
  await log('apikey-put-2', putApiKey(db, { id: 'k2', shop: 'shop-a', hash: 'h2', label: 'Zapier', at: LATER }));
  await log('apikey-put-other-shop', putApiKey(db, { id: 'k3', shop: 'shop-b', hash: 'h3', label: 'B', at: AT }));
  await log('apikey-find', findApiKey(db, 'h1'));
  await log('apikey-count', countApiKeys(db, 'shop-a'));
  await log('apikey-list', listApiKeys(db, 'shop-a', 50));
  await log('apikey-list-limit', listApiKeys(db, 'shop-a', 1));
  await log('apikey-rotate', rotateApiKey(db, { shop: 'shop-a', id: 'k1', hash: 'h1b', at: LATER }));
  await log('apikey-rotate-old-hash', findApiKey(db, 'h1'));
  await log('apikey-rotate-new-hash', findApiKey(db, 'h1b'));
  await log('apikey-rotate-other-shop', rotateApiKey(db, { shop: 'shop-b', id: 'k1', hash: 'h1c', at: LATER }));
  await log('apikey-rotate-dup-hash', rotateApiKey(db, { shop: 'shop-a', id: 'k1', hash: 'h2', at: LATER }));
  await log('apikey-revoke-other-shop', revokeApiKey(db, { shop: 'shop-b', id: 'k2', at: LATER }));
  await log('apikey-revoke', revokeApiKey(db, { shop: 'shop-a', id: 'k2', at: LATER }));
  await log('apikey-revoke-again', revokeApiKey(db, { shop: 'shop-a', id: 'k2', at: '2026-10-28T00:00:00.000Z' }));
  await log('apikey-revoked-find', findApiKey(db, 'h2'));
  await log('apikey-rotate-revoked', rotateApiKey(db, { shop: 'shop-a', id: 'k2', hash: 'h2b', at: LATER }));
  await log('apikey-count-after', countApiKeys(db, 'shop-a'));
  await log('apikey-list-after', listApiKeys(db, 'shop-a', 50));
  /* 同じ予約を 2 回入れない: 受け付ける・受け付け中は引き継げない・古ければ引き継ぐ・結果を書く・消す */
  const claim = (keyId, idem, at, stale, expired) => claimIdem(db, { keyId, idem, at, staleBefore: stale, expiredBefore: expired });
  const T1 = '2026-10-27T01:00:00.000Z';
  const T2 = '2026-10-27T01:05:00.000Z';
  await log('idem-read-none', readIdem(db, { keyId: 'k1', idem: 'i1' }));
  await log('idem-claim', claim('k1', 'i1', T1, '2026-10-27T00:58:00.000Z', '2026-10-20T01:00:00.000Z'));
  await log('idem-claim-pending', claim('k1', 'i1', T2, '2026-10-27T00:59:00.000Z', '2026-10-20T01:00:00.000Z'));
  await log('idem-read-pending', readIdem(db, { keyId: 'k1', idem: 'i1' }));
  await log('idem-claim-stale', claim('k1', 'i1', T2, '2026-10-27T01:03:00.000Z', '2026-10-20T01:00:00.000Z'));
  await log('idem-finish', finishIdem(db, { keyId: 'k1', idem: 'i1', bookingId: 'b1' }));
  await log('idem-read-done', readIdem(db, { keyId: 'k1', idem: 'i1' }));
  await log('idem-claim-done', claim('k1', 'i1', '2026-10-27T03:00:00.000Z', '2026-10-27T02:58:00.000Z', '2026-10-20T01:00:00.000Z'));
  await log('idem-finish-again', finishIdem(db, { keyId: 'k1', idem: 'i1', bookingId: 'b2' }).then(() => readIdem(db, { keyId: 'k1', idem: 'i1' })));
  await log('idem-release-done', releaseIdem(db, { keyId: 'k1', idem: 'i1' }).then(() => readIdem(db, { keyId: 'k1', idem: 'i1' })));
  await log('idem-other-key', claim('k2', 'i1', T1, '2026-10-27T00:58:00.000Z', '2026-10-20T01:00:00.000Z'));
  await log('idem-release-pending', releaseIdem(db, { keyId: 'k2', idem: 'i1' }).then(() => readIdem(db, { keyId: 'k2', idem: 'i1' })));
  await log('idem-claim-expired', claim('k1', 'i1', '2026-11-05T01:00:00.000Z', '2026-11-05T00:58:00.000Z', '2026-10-29T01:00:00.000Z').then(async ok => [ok, await readIdem(db, { keyId: 'k1', idem: 'i1' })]));
  await log('idem-drop-old', claim('k1', 'i2', T1, '2026-10-27T00:58:00.000Z', '2026-10-20T01:00:00.000Z')
    .then(() => dropOldIdem(db, '2026-11-01T00:00:00.000Z')).then(async () => [await readIdem(db, { keyId: 'k1', idem: 'i2' }), await readIdem(db, { keyId: 'k1', idem: 'i1' })]));
  return out;
}

test('fakeD1 と本物の SQLite に同じ操作を流すと、答えが全部同じ', async () => {
  const fake = fakeD1();
  const real = await sqliteD1();
  const a = await scenario(fake);
  const b = await scenario(real);
  assert.equal(a.length, b.length);
  a.forEach(([label, got], i) => assert.deepEqual(got, b[i][1], `${label}: fakeD1 と SQLite で答えが違う`));
});

test('1 日の回数（0006）: 上限ちょうどで止め、お店・scope・日で別に数える。同時に何件来ても上限を超えない', async () => {
  const db = await sqliteD1();
  const take = (shop, max = 30, day = TODAY) => takeDaily(db, { scope: 'site', shop, day, max });
  const burst = await Promise.all(Array.from({ length: 50 }, () => take('shop-a')));
  assert.equal(burst.filter(Boolean).length, 30, '50 件を一度に呼んでも通るのは 30 件（読んでから書く 2 手ではなく 1 文なので、間に別の呼び出しが入っても超えない）');
  assert.equal(db.raw.prepare("SELECT n FROM daily_counts WHERE scope = 'site' AND shop = 'shop-a'").get().n, 30, '数えた値は上限と同じ（超えて書かない）');
  assert.equal(await take('shop-b'), true, '別のお店は別に数える');
  assert.equal(await take('shop-a', 30, '2026-10-28'), true, '日が変われば戻る');
  assert.equal(await take('shop-a', 31), true, '上限が上がれば通る');
  assert.equal(await take('shop-a', 31), false);
  assert.equal(await take('shop-z', 0), false, '上限 0 は何も通さず、行も作らない');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_counts WHERE shop = 'shop-z'").get().n, 0);
  const failing = fakeD1();
  failing.failing = true;
  await assert.rejects(takeDaily(failing, { scope: 'site', shop: 'x', day: TODAY, max: 1 }), /d1 down/, 'D1 の不調は「上限に届いた」と見分けて例外にする');
});

test('migration 0006: 2 店が同じ受け口（大文字小文字・空白違いも）を持つ行は入らない。空の受け口は何店でもよい', async () => {
  const db = await sqliteD1();
  db.addShop({ id: 'shop-a', name: 'A', inbox: 'a@yoyaku.example' });
  db.addShop({ id: 'shop-b', name: 'B', inbox: '' });
  db.addShop({ id: 'shop-c', name: 'C', inbox: '  ' });
  assert.throws(() => db.addShop({ id: 'shop-d', name: 'D', inbox: ' A@Yoyaku.example' }), /UNIQUE/);
  assert.equal((await listShops(db, {})).length, 3);
});

test('migration 0010: 前からあるお店は返信先が空。tools/shop.mjs の 3 つの文（add・上書き・set-reply-to）を本物の SQLite で流し、Worker が読める', async () => {
  const sqlite = await import('node:sqlite');
  const raw = new sqlite.DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.includes('0010_shops_reply_to.sql'));
  files.filter(f => f < '0010').forEach(f => raw.exec(readFileSync(new URL(f, dir), 'utf8')));
  raw.prepare("INSERT INTO shops (id, name) VALUES ('old-shop', '前からあるお店')").run();
  raw.exec(readFileSync(new URL('0010_shops_reply_to.sql', dir), 'utf8'));
  assert.equal(raw.prepare("SELECT reply_to FROM shops WHERE id = 'old-shop'").get().reply_to, '', '前からある行は空（1 店だけなら REPLY_TO、2 店以上なら付けない）');
  /* 前の版の Worker が使う文は、欄を足したあとも動く（migration を先に流してよい） */
  assert.equal(raw.prepare('SELECT id, name, members, sites, inbox, senders FROM shops').all().length, 1);
  const { shopSql, parseArgs } = await import('../tools/shop.mjs');
  const db = await sqliteD1();
  const sql = (...argv) => db.raw.exec(shopSql(parseArgs(argv)));
  sql('add', '--id', 'shop-a', '--name', "A's ダイブ", '--member', 'a@example.com', '--reply-to', 'Info@A.example.com');
  sql('add', '--id', 'shop-b', '--name', 'B マリン', '--member', 'b@example.com');
  assert.deepEqual((await listShops(db, {})).map(x => [x.id, x.replyTo]), [['shop-a', 'info@a.example.com'], ['shop-b', '']]);
  sql('set-reply-to', '--id', 'shop-b', '--reply-to', 'info@b.example.com');
  assert.deepEqual((await listShops(db, {})).map(x => [x.id, x.name, x.members, x.replyTo]),
    [['shop-a', "A's ダイブ", ['a@example.com'], 'info@a.example.com'], ['shop-b', 'B マリン', ['b@example.com'], 'info@b.example.com']], 'set-reply-to は他の欄を変えない');
  sql('add', '--id', 'shop-a', '--name', "A's ダイブ", '--member', 'a@example.com');
  assert.equal((await listShops(db, {}))[0].replyTo, '', 'add は上書きなので、--reply-to を付けないと空に戻る');
  db.raw.prepare("UPDATE shops SET reply_to = 'a@b.co, c@d.co' WHERE id = 'shop-b'").run();
  assert.equal((await listShops(db, {}))[1].replyTo, '', 'D1 のコンソールで形の合わない値を入れても、読むときに空にする（行は捨てない）');
});

test('migration 0009: 前からある鍵は staff、前からある 1 人ずつの鍵（お客さんが予約のリンクから作った物）は booking。作った人の欄は staff か booking だけを返す', async () => {
  const sqlite = await import('node:sqlite');
  const raw = new sqlite.DatabaseSync(':memory:');
  const dir = new URL('../worker/migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.ok(files.includes('0009_ask_links_minted_by.sql'));
  files.filter(f => f < '0009').forEach(f => raw.exec(readFileSync(new URL(f, dir), 'utf8')));
  const put = raw.prepare("INSERT INTO ask_links (hash, shop, booking_id, person_id, expires_on, created_at, day, uses) VALUES (?1, 'shop-a', 'b1', ?2, '2026-10-30', '', '', 0)");
  put.run('old-booking', '');
  put.run('old-person', 'p1');
  raw.exec(readFileSync(new URL('0009_ask_links_minted_by.sql', dir), 'utf8'));
  const by = (h) => raw.prepare('SELECT minted_by FROM ask_links WHERE hash = ?1').get(h).minted_by;
  assert.deepEqual([by('old-booking'), by('old-person')], ['staff', 'booking']);
  raw.prepare("INSERT INTO ask_links (hash, shop, booking_id, person_id, expires_on, created_at, day, uses) VALUES ('new', 's', 'b', '', '2026-10-30', '', '', 0)").run();
  assert.equal(by('new'), 'staff', '欄を指定しない行は staff');
  const db = await sqliteD1();
  await putLink(db, { hash: 'x1', shop: 's', bookingId: 'b', personId: 'p', expiresOn: '2026-10-30', at: AT });
  await putLink(db, { hash: 'x2', shop: 's', bookingId: 'b', personId: 'p', expiresOn: '2026-10-30', at: AT, mintedBy: 'staff' });
  assert.deepEqual([(await findLink(db, 'x1')).mintedBy, (await findLink(db, 'x2')).mintedBy], ['booking', 'staff'], 'mintedBy を渡さない鍵は booking（見せる側に倒さない）');
  await assert.rejects(putLink(db, { hash: 'x3', shop: 's', bookingId: 'b', personId: 'p', expiresOn: '2026-10-30', at: AT, mintedBy: 'admin' }), /mintedBy/);
  db.raw.prepare("UPDATE ask_links SET minted_by = 'weird' WHERE hash = 'x2'").run();
  assert.equal((await findLink(db, 'x2')).mintedBy, 'booking', '知らない値は booking');
});

test('adapter（worker/*-db.mjs）の SQL は、全部 SQLite で流れた', async () => {
  const real = await sqliteD1();
  await scenario(real);
  const dir = new URL('../worker/', import.meta.url);
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const ran = new Set([...real.executed].map(norm));
  /* adapter のファイルの、prepare に渡した文字（直書きと、上で名前を付けた定数） */
  const missing = [];
  readdirSync(dir).filter(f => f.endsWith('-db.mjs')).forEach(f => {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const consts = Object.fromEntries([...src.matchAll(/const (\w+) = (`[^`]*`|'[^']*')/g)].map(m => [m[1], m[2].slice(1, -1)]));
    for (const m of src.matchAll(/prepare\((?:'((?:[^'\\]|\\.)*)'|(\w+))\)/g)) {
      const sql = norm(m[1] !== undefined ? m[1].replace(/\\'/g, "'") : consts[m[2]] || '');
      if (sql && !ran.has(sql)) missing.push(`${f}: ${sql.slice(0, 70)}`);
    }
  });
  assert.deepEqual(missing, [], '流れていない SQL がある（scenario に足す）');
});

test('名簿・済んだ便・読めなかった予約メールを、本物の handler から SQLite につないで通しで動かす', async () => {
  resetAccessCache();
  const TEAM = 'mihon-team.cloudflareaccess.com';
  const AUD = 'aud-0123456789abcdef';
  const EMAIL = 'mihon.member@example.com';
  const NOW = Date.parse('2026-10-27T01:00:00Z');
  const access = await fakeAccess(TEAM);
  const jwt = await access.sign({ iss: `https://${TEAM}`, aud: [AUD], email: EMAIL, exp: NOW / 1000 + 3600, iat: NOW / 1000 - 10, nbf: NOW / 1000 - 10, type: 'app' });
  const db = await sqliteD1();
  const env = { ANTHROPIC_API_KEY: 'sk-test-not-real', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ALLOWED_EMAILS: EMAIL, DAILY_LIMIT: '200', MONTHLY_USD: '5', BUDGET: fakeKv(), DB: db, SINGLE_SHOP: 'default' };
  const io = { fetch: async (url, init) => { checkRedirect(init); return new Response(JSON.stringify({ keys: access.keys }), { status: 200 }); }, now: () => NOW };
  const call = async (method, path, body) => {
    const h = { 'sec-fetch-site': 'same-origin', 'cf-access-jwt-assertion': jwt, ...(body ? { 'content-type': 'application/json' } : {}) };
    const res = await handle(new Request(`https://x.example${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env, io);
    return { status: res.status, body: await res.json() };
  };
  const st = sample();
  const put = await call('PUT', '/api/roster', { base: 0, state: st, shop: 'default' });
  assert.equal(put.status, 200);
  assert.ok(put.body.state.trips.every(t => t.date !== '2026-10-01'));
  const got = await call('GET', '/api/roster');
  assert.equal(got.body.version, 1);
  const past = await call('GET', '/api/roster/past?from=2026-09-27&to=2026-10-27');
  assert.equal(past.body.state.trips.length, 1);
  assert.equal(past.body.skipped, 0);
  const stale = await call('PUT', '/api/roster', { base: 0, state: st });
  assert.equal(stale.status, 409);
  db.raw.prepare("INSERT INTO mail_unread (shop, id, at, why) VALUES ('default', 'u1', '2026-10-27T00:00:00.000Z', 'ai')").run();
  assert.equal((await call('GET', '/api/mail-unread')).body.items.length, 1);
  assert.equal((await call('POST', '/api/mail-unread', { id: 'u1' })).status, 200);
});

test('予約の受け口 API（migration 0008）を本物の SQLite につないで通しで動かす: 鍵 → 予約 → 同じ Idempotency-Key の 2 回目 → 1 日の上限 → 止めると断る', async () => {
  const db = await sqliteD1();
  const env = { DB: db, SINGLE_SHOP: 'default', INTAKE_DAILY_MAX: '2' };
  const io = { now: () => Date.parse('2026-10-27T01:00:00Z') };
  const shop = new ShopService(env, io);
  const made = await changeKeysFor(env, io, {}, 'default', { action: 'create', label: 'WordPress' }, 'https://ask.example');
  assert.equal(made.status, 200);
  const hash = await keyHash(made.body.key);
  assert.equal(db.raw.prepare('SELECT hash FROM api_keys WHERE id = ?').get(made.body.id).hash, hash, 'D1 には SHA-256 だけ');
  const body = { date: '2026-11-03', tour: '体験ダイビング', people: 2, lead_name: '見本 花子' };
  const first = await shop.intakeBooking(hash, body, 'order-1');
  const replay = await shop.intakeBooking(hash, body, 'order-1');
  assert.deepEqual([first.status, replay.status, replay.body.booking_id], [201, 200, first.body.booking_id]);
  assert.equal(JSON.parse(db.raw.prepare("SELECT state FROM rosters WHERE shop = 'default'").get().state).bookings.length, 1);
  assert.equal((await shop.intakeBooking(hash, body, 'order-2')).status, 201);
  assert.equal((await shop.intakeBooking(hash, body, 'order-3')).status, 429);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM api_idempotency WHERE booking_id = ''").get().n, 0, '断った要求の印は残らない');
  assert.equal((await revokeApiKey(db, { shop: 'default', id: made.body.id, at: '2026-10-27T02:00:00.000Z' })), true);
  assert.equal((await shop.intakeBooking(hash, body, 'order-4')).status, 401);
});

test('試用のお店は健康を紙で始める（tools/shop.mjs paper。決定ログ 2026-11-01 trial-health-paper）: 名簿がまだ無いお店だけに紙の名簿を置き、もうある名簿は消さない。見本の default には使えない', async () => {
  const { shopSql, parseArgs } = await import('../tools/shop.mjs');
  const db = await sqliteD1();
  const sql = (...argv) => db.raw.exec(shopSql(parseArgs(argv)));
  sql('paper', '--id', 'shop-a', '--name', "A's ダイブ");
  const got = await getRoster(db, 'shop-a');
  assert.equal(got.version, 1);
  const state = checkPut({ base: 1, state: JSON.parse(got.text) }, { today: '2026-11-01', at: '2026-11-01T00:00:00.000Z' });
  assert.ok(state.ok, 'サーバーの厳しい検査が通す');
  assert.ok(R.rosterCore.paperOf(state.state), '紙の印が付く');
  assert.equal(state.state.log.at(-1).after.health, 'paper', '切り替えが記録に残る');
  await putRoster(db, 'shop-b', 0, JSON.stringify(R.roster.blankState('B マリン')), '2026-11-01T00:00:00.000Z');
  const before = await getRoster(db, 'shop-b');
  sql('paper', '--id', 'shop-b', '--name', 'B マリン');
  assert.deepEqual(await getRoster(db, 'shop-b'), before, 'もうある名簿は変えない（画面で切り替える）');
  assert.throws(() => shopSql(parseArgs(['paper', '--id', 'default', '--name', '見本'])), /default/);
  assert.throws(() => shopSql(parseArgs(['paper', '--id', 'shop-c'])), /--name/);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
