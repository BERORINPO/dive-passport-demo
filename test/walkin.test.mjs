// 店頭の QR（worker/walkin-*.mjs・js/roster-guest.js の walkin・js/contact-link.js。決定ログ 2026-10-28 walkin-qr・contact-links）を、
// 外との境目を見本に差し替えて確かめる。
// 1. 鍵: 作る・作り直す。D1 には SHA-256 だけ。違う鍵・作り直して古い鍵・お店が一覧に無いは 404
// 2. お客さんの画面: 今日と明日の便の日付・時刻・ツアーの名前だけ。ほかの人の名前も人数も出ない
// 3. 入れた物: 名簿と同じ検査（名前・生年月日・住所・緊急時の連絡先・メール・人数）、件数の上限（IP・お店・全店）、大きさ。名簿の本体には入らない
// 4. お店の画面の道: 一覧・消す。他のお店の行は見えず、消せない。期限（2 日）と Cron
// 5. 名簿に入れる直し（その予約にまとめる・便を選んで入れる）と、op log を通ること。入れない
// 6. RPC の口（redux-ask の束には 6 つだけ）
// 7. SMS・LINE で送る URL（エンコード・お店の名前のほかの名前が入らない・その予約のリンクだけ）
// 実行: node test/walkin.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handlePublic } from '../worker/public-handler.mjs';
import { ShopService } from '../worker/shop-service.mjs';
import { SHOP_METHODS } from '../worker/shop-client.mjs';
import { scheduled } from '../worker/auto.mjs';
import { keyHash } from '../worker/ask-key.mjs';
import { WALKIN_DAILY_MAX, WALKIN_DAILY_MAX_ALL, walkinItem } from '../worker/walkin-core.mjs';
import { checkWalkin, checkWalkinApply, MAX_WALKIN_BODY } from '../worker/ask-input.mjs';
import { fakeRateLimit, fakeShopBinding } from '../worker/fakes.mjs';
import '../js/contact-link.js';
import { setup, staffCall, putState, stored, jwtFor, STAFF, ASK_ORIGIN, AT, NOW, logs, runTests } from './kit.mjs';

const R = globalThis.REDUX;
const DAY = 86400000;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ---------- 見本の名簿: 今日（10/27）の便 2 つ、明日の便、あさっての便、中止した便、他のお店が船を出す便 ---------- */
let seq = 0;
const newId = () => `w${(seq += 1)}`;
function roster() {
  let st = R.roster.blankState('B マリン（見本）');
  const trip = (date, start, kind, tour, extra = {}) => {
    const made = R.rosterCore.addTrip(st, { trip: { date, start, kind, tour, ...extra }, at: AT, newId });
    st = made.state;
    return made.trip;
  };
  const book = (t, lead, people = 1, extra = {}) => {
    const want = { date: t.date, start: t.start, tour: t.tour, kind: t.kind };
    st = R.rosterCore.addBookingToTrip(st, { tripId: t.id, want, booking: { source: 'phone', leadName: lead, leadPhone: '090-1234-5678', people, ...extra }, reading: null, src: 'staff', at: AT, newId }).state;
    return st.bookings[st.bookings.length - 1];
  };
  const out = {
    morning: trip('2026-10-27', '08:30', 'dive', '体験ダイビング'), noon: trip('2026-10-27', '13:00', 'snorkel', 'ボートスノーケル'),
    tomorrow: trip('2026-10-28', '09:00', 'dive', '体験ダイビング'), later: trip('2026-10-29', '08:30', 'dive', '体験ダイビング'),
    off: trip('2026-10-27', '15:00', 'snorkel', '夕方のスノーケル'), partner: trip('2026-10-27', '10:30', 'dive', '乗り合いの便', { host: 'C ダイブ' }), book, get state() { return st; }
  };
  st = R.rosterCore.cancelTrip(st, { tripId: out.off.id, reason: 'wind', at: AT });
  return out;
}
const withKey = async (s, sample = roster()) => {
  putState(s, sample.state);
  const made = await staffCall(s, 'POST', '/api/walkin-key', {});
  assert.equal(made.status, 200);
  const { url } = await made.json();
  return { sample, url, key: url.split('#w=')[1] };
};

/* お客さんの Worker（Access なし。D1 は持たず、回数の binding と SHOP だけ）に、walkin.html が送る要求 */
const publicEnv = (s, limit = fakeRateLimit(100)) => ({ ASK_LIMIT: limit, SHOP: fakeShopBinding(new ShopService(s.env, s.io)) });
const walkinCall = (s, body, { env = publicEnv(s), ip = '198.51.100.7', site = 'same-origin', method = 'POST', raw } = {}) => handlePublic(new Request(`${ASK_ORIGIN}/api/walkin`, {
  method, headers: { 'content-type': 'application/json', 'sec-fetch-site': site, 'cf-connecting-ip': ip }, body: method === 'POST' ? raw || JSON.stringify(body) : undefined }), env, s.io);

const GOOD = (over = {}) => ({ action: 'submit', tripId: '', name: '見本 太郎', people: 2, email: 'taro@mail.example', birthDate: '1990-05-01', address: '沖縄県那覇市見本 1-2-3',
  emergency: { name: '見本 花子', relation: '妻', phone: '090-9999-0000' }, ...over });
const submit = (s, key, over, opts) => walkinCall(s, { k: key, ...GOOD(over) }, opts);
const pendingRows = (s) => [...s.db.walkins.values()];

/* ---------- 1. 鍵 ---------- */
test('鍵: 店頭の QR の URL は <ASK_ORIGIN>/walkin#w=<43 字>、D1 には SHA-256 だけ。作り直すと前の鍵は 404。Access が要る', async () => {
  const s = setup();
  putState(s, roster().state);
  assert.equal((await staffCall(s, 'POST', '/api/walkin-key', {}, { jwt: null })).status, 403, 'Access の無い要求は断る');
  assert.equal((await staffCall(s, 'GET', '/api/walkin-key')).status, 405);
  const first = await (await staffCall(s, 'POST', '/api/walkin-key', {})).json();
  assert.match(first.url, new RegExp(`^${ASK_ORIGIN}/walkin#w=[A-Za-z0-9_-]{43}$`));
  const key1 = first.url.split('#w=')[1];
  assert.equal(s.db.walkinKeys.size, 1);
  const [shop, row] = [...s.db.walkinKeys.entries()][0];
  assert.equal(shop, 'default');
  assert.equal(row.hash, await keyHash(key1));
  assert.match(row.hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify([...s.db.walkinKeys]).includes(key1), '鍵そのものは置かない');
  assert.equal((await walkinCall(s, { k: key1, action: 'view' })).status, 200);
  const second = await (await staffCall(s, 'POST', '/api/walkin-key', {})).json();
  const key2 = second.url.split('#w=')[1];
  assert.notEqual(key1, key2);
  assert.equal(s.db.walkinKeys.size, 1, 'お店に鍵は 1 つ（作り直したら置き換わる）');
  assert.equal((await walkinCall(s, { k: key1, action: 'view' })).status, 404, '作り直して古くなった鍵は開けない');
  assert.equal((await submit(s, key1)).status, 404, '古い鍵では入れられない');
  assert.equal((await walkinCall(s, { k: key2, action: 'view' })).status, 200);
  const list = await (await staffCall(s, 'GET', '/api/walkins')).json();
  assert.equal(list.keyAt, AT, '鍵を作った時刻が分かる（作り直しの確かめに使う）');
});

test('鍵: 違う鍵・形の違う鍵・ASK_ORIGIN が無い手元・お店が一覧から消えた鍵は、同じ 404 / 400。D1 が無ければ 503', async () => {
  const s = setup();
  const { key } = await withKey(s);
  assert.equal((await walkinCall(s, { k: 'A'.repeat(43), action: 'view' })).status, 404, '知らない鍵');
  assert.equal((await walkinCall(s, { k: 'short', action: 'view' })).status, 400);
  assert.equal((await walkinCall(s, { k: key, action: 'nope' })).status, 400);
  const local = setup({ ASK_ORIGIN: undefined });
  putState(local, roster().state);
  const url = (await (await staffCall(local, 'POST', '/api/walkin-key', {})).json()).url;
  assert.ok(url.startsWith('https://dive-passport-demo.example.workers.dev/walkin#w='), 'ASK_ORIGIN が無ければ同じ場所');
  /* お店の一覧にあるお店だけ。鍵の行が残っていても、一覧から消えたお店の鍵は開けない */
  const gone = setup({ SINGLE_SHOP: undefined });
  gone.db.addShop({ id: 'shop-a', name: 'A ダイブ', members: ['mihon.member@example.com'] });
  putState(gone, roster().state, { shop: 'shop-a' });
  const goneKey = (await (await staffCall(gone, 'POST', '/api/walkin-key', {})).json()).url.split('#w=')[1];
  assert.equal((await walkinCall(gone, { k: goneKey, action: 'view' })).status, 200);
  gone.db.shops.delete('shop-a');
  gone.db.addShop({ id: 'shop-b', name: 'B', members: ['other@example.com'] });
  assert.equal((await walkinCall(gone, { k: goneKey, action: 'view' })).status, 404);
  const down = setup({ DB: undefined });
  const none = await new ShopService(down.env, down.io).walkinView('0'.repeat(64));
  assert.equal(none.status, 503);
});

/* ---------- 2. お客さんの画面 ---------- */
test('見せる便: 今日と明日の、中止していない自分の店の便の日付・時刻・ツアーの名前・種類だけ。ほかの人の名前も人数も出ない', async () => {
  const s = setup();
  const sample = roster();
  sample.book(sample.morning, '見本 一郎', 3);
  sample.book(sample.noon, '見本 二郎', 5, { leadEmail: 'jiro@mail.example' });
  const { key } = await withKey(s, sample);
  const r = await walkinCall(s, { k: key, action: 'view' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const view = await r.json();
  assert.deepEqual(Object.keys(view).sort(), ['shop', 'today', 'trips']);
  assert.equal(view.shop, 'B マリン（見本）');
  assert.equal(view.today, '2026-10-27');
  assert.deepEqual(view.trips.map(t => `${t.date} ${t.start} ${t.tour}`), ['2026-10-27 08:30 体験ダイビング', '2026-10-27 13:00 ボートスノーケル', '2026-10-28 09:00 体験ダイビング']);
  view.trips.forEach(t => assert.deepEqual(Object.keys(t).sort(), ['date', 'id', 'kind', 'start', 'tour']));
  assert.ok(!view.trips.some(t => [sample.later.id, sample.off.id, sample.partner.id].includes(t.id)), 'あさって・中止・他のお店が船を出す便は出さない');
  const text = JSON.stringify(view);
  for (const leak of ['見本 一郎', '見本 二郎', 'jiro@mail.example', '090-1234-5678', 'people', 'booked', 'bookings', 'count', 'leadName']) assert.ok(!text.includes(leak), leak);
});

test('見せる便: 名簿がまだ無いお店は便なし（「スタッフに聞く」だけで入れられる）', async () => {
  const s = setup();
  const made = await staffCall(s, 'POST', '/api/walkin-key', {});
  const key = (await made.json()).url.split('#w=')[1];
  const view = await (await walkinCall(s, { k: key, action: 'view' })).json();
  assert.deepEqual(view.trips, []);
  assert.equal((await submit(s, key)).status, 202);
});

/* ---------- 3. 入れた物 ---------- */
test('入れる: 検査を通った物は 202 で walkin_pending に置く。名簿の本体は変わらない。名前・住所は整形して置く', async () => {
  const s = setup();
  const { key, sample } = await withKey(s);
  const before = s.db.rows.get('default').state;
  const r = await submit(s, key, { tripId: sample.morning.id, name: '  見本   太郎 ', email: ' taro@mail.example ', address: ' 沖縄県那覇市見本 1-2-3 ',
    emergency: { name: ' 見本 花子 ', relation: ' 妻 ', phone: ' 090-9999-0000 ' } });
  assert.equal(r.status, 202);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(s.db.rows.get('default').state, before, '名簿の本体には入らない');
  assert.equal(s.db.rows.get('default').version, 1);
  const [row] = pendingRows(s);
  assert.equal(row.shop, 'default');
  assert.equal(row.trip_id, sample.morning.id);
  assert.equal(row.expires_on, '2026-10-29', '受けて 2 日');
  assert.deepEqual(JSON.parse(row.body), { name: '見本 太郎', people: 2, email: 'taro@mail.example', birthDate: '1990-05-01', address: '沖縄県那覇市見本 1-2-3',
    emergency: { name: '見本 花子', relation: '妻', phone: '090-9999-0000' }, day: '2026-10-27' });
  assert.match(row.id, /^[a-z0-9]{20}$/);
  assert.equal((await submit(s, key, { email: '' })).status, 202, 'メールは任意');
  assert.equal(pendingRows(s).length, 2);
});

test('入れる: 名簿と同じ検査で断る（名前の URL・未来の生年月日・存在しない日・空の住所・緊急時の連絡先・人数・メール・便の id）。何も置かない', async () => {
  const s = setup();
  const { key } = await withKey(s);
  const bad = [
    ['name', { name: '見本 hanako.example.com' }], ['name', { name: 'http://evil.example/x' }], ['name', { name: '見本\n太郎' }], ['name', { name: '' }], ['name', { name: 'あ'.repeat(61) }],
    ['birthDate', { birthDate: '2026-10-28' }], ['birthDate', { birthDate: '1990-02-31' }], ['birthDate', { birthDate: '' }], ['birthDate', { birthDate: '1990/05/01' }],
    ['address', { address: '' }], ['address', { address: 'あ'.repeat(121) }],
    ['emergency', { emergency: { name: '', relation: '', phone: '090' } }], ['emergency', { emergency: { name: 'あ', relation: '', phone: '' } }],
    ['emergency', { emergency: { name: 'あ', relation: 'あ'.repeat(21), phone: '090' } }], ['emergency', { emergency: { name: 'あ', relation: '', phone: '0'.repeat(31) } }],
    ['people', { people: 0 }], ['people', { people: 11 }], ['email', { email: 'not-an-email' }], ['trip', { tripId: 'bad id/with space' }]
  ];
  for (const [field, over] of bad) {
    const r = await submit(s, key, over);
    assert.equal(r.status, 400, `${field}: ${JSON.stringify(over).slice(0, 50)}`);
    const body = await r.json();
    assert.ok(!JSON.stringify(body).includes('見本'), '入れた値は返さない');
    if (r.status === 400 && body.problems) assert.ok(body.problems.includes(field) || field === 'name', `${field} を知らせる: ${body.problems}`);
  }
  assert.equal(pendingRows(s).length, 0);
  assert.equal(s.db.daily.size, 0, '断った物は 1 日の件数に数えない');
});

test('入れる: 本文の形と大きさ。知らない項目・文字でない値・健康のような項目・4 KB 超・長すぎる文字は redux-ask で断る（お店の Worker まで届かない）', async () => {
  const s = setup();
  const { key } = await withKey(s);
  const env = publicEnv(s);
  const base = { k: key, ...GOOD() };
  for (const body of [{ ...base, health: { answers: [] } }, { ...base, name: 5 }, { ...base, people: '2' }, { ...base, people: 1.5 }, { ...base, emergency: 'x' },
    { ...base, emergency: { name: 'a', phone: 'b', extra: 'c' } }, { ...base, address: 'あ'.repeat(301) }, { k: key, ...GOOD(), action: 'send' }, { k: key, action: 'view', name: 'x' }]) {
    assert.equal((await walkinCall(s, body, { env })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const { tripId, ...noTrip } = base;
  assert.equal((await walkinCall(s, noTrip, { env })).status, 400, '便の欄は要る（スタッフに聞くは空の文字）');
  assert.equal((await walkinCall(s, null, { env, raw: 'x'.repeat(MAX_WALKIN_BODY + 1) })).status, 413);
  assert.equal((await walkinCall(s, null, { env, raw: '{bad' })).status, 400);
  assert.equal(env.SHOP.calls.length, 0, 'ここまでの断りは、お店の Worker を呼ばない');
  assert.equal((await walkinCall(s, base, { env, site: 'cross-site' })).status, 403);
  assert.equal((await walkinCall(s, base, { env, method: 'GET' })).status, 405);
  assert.equal(pendingRows(s).length, 0);
});

test('入れる: 1 つの IP の回数（ASK_LIMIT）・お店の 1 日の件数・全店あわせた件数の上限。翌日は戻る', async () => {
  const s = setup();
  const { key } = await withKey(s);
  const limited = publicEnv(s, fakeRateLimit(2));
  assert.equal((await submit(s, key, {}, { env: limited })).status, 202);
  assert.equal((await walkinCall(s, { k: key, action: 'view' }, { env: limited })).status, 200);
  assert.equal((await submit(s, key, {}, { env: limited })).status, 429, '3 回目は IP の回数で止まる');
  assert.equal((await submit(s, key, {}, { env: limited, ip: '203.0.113.9' })).status, 202, '別の IP は通る');
  assert.equal(pendingRows(s).length, 2);

  s.db.setCount('walkin', 'default', '2026-10-27', WALKIN_DAILY_MAX - 1);
  assert.equal((await submit(s, key)).status, 202, '上限の 1 つ手前は通る');
  const full = await submit(s, key);
  assert.equal(full.status, 429, 'お店の 1 日の上限ちょうどで止まる');
  assert.deepEqual(await full.json(), { error: 'limit' });
  assert.equal(s.db.daily.get('walkin\ndefault\n2026-10-27'), WALKIN_DAILY_MAX);
  assert.equal(pendingRows(s).length, 3);
  s.io.clock = NOW + DAY;
  assert.equal((await submit(s, key)).status, 202, '日が変われば戻る');

  const all = setup();
  const { key: key2 } = await withKey(all);
  all.db.setCount('walkin', '*', '2026-10-27', WALKIN_DAILY_MAX_ALL);
  assert.equal((await submit(all, key2)).status, 429, '全店あわせた上限でも止まる');
  assert.equal(all.db.walkins.size, 0);
});

test('入れる: D1 が答えないときは 503（上限に届いたと見分ける）。置けなかった物は残らない', async () => {
  const s = setup();
  const { key } = await withKey(s);
  s.db.failing = true;
  const r = await submit(s, key);
  assert.equal(r.status, 503);
  s.db.failing = false;
  assert.equal(pendingRows(s).length, 0);
});

/* ---------- 4. お店の画面の道 ---------- */
test('一覧と消す: Access の内。同じお店の行だけが見え、消せる。他のお店の行は見えず消せない。形の壊れた行は出さない', async () => {
  const s = setup();
  const { key, sample } = await withKey(s);
  assert.equal((await submit(s, key, { tripId: sample.morning.id, name: '見本 太郎' })).status, 202);
  s.io.clock = NOW + 60000;
  assert.equal((await submit(s, key, { name: '見本 次郎' })).status, 202);
  s.db.walkins.set('other\nzz', { shop: 'other', id: 'zz', trip_id: '', body: JSON.stringify({ name: '他店 三郎' }), created_at: AT, expires_on: '2026-10-29' });
  s.db.walkins.set('default\nbroken', { shop: 'default', id: 'broken', trip_id: '', body: '{oops', created_at: AT, expires_on: '2026-10-29' });
  assert.equal((await staffCall(s, 'GET', '/api/walkins', undefined, { jwt: null })).status, 403);
  const list = await (await staffCall(s, 'GET', '/api/walkins')).json();
  assert.deepEqual(list.items.map(x => x.name), ['見本 太郎', '見本 次郎'], '古い順。他のお店と壊れた行は出ない');
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['address', 'at', 'birthDate', 'day', 'email', 'emergency', 'id', 'name', 'people', 'tripId']);
  assert.equal(list.items[0].tripId, sample.morning.id);
  assert.equal(list.items[0].day, '2026-10-27');
  const id = list.items[0].id;
  for (const bad of [{}, { id: 5 }, { id: 'A B' }, { id, extra: 1 }, { id: 'x'.repeat(41) }]) assert.equal((await staffCall(s, 'POST', '/api/walkin-drop', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await staffCall(s, 'POST', '/api/walkin-drop', { id }, { jwt: null })).status, 403);
  assert.equal((await staffCall(s, 'POST', '/api/walkin-drop', { id: 'zz' })).status, 404, '他のお店の行は消せない');
  assert.ok(s.db.walkins.has('other\nzz'));
  assert.equal((await staffCall(s, 'POST', '/api/walkin-drop', { id })).status, 200);
  assert.equal((await staffCall(s, 'POST', '/api/walkin-drop', { id })).status, 404, '消した行は 404（画面は消えたものとして扱う）');
  assert.deepEqual((await (await staffCall(s, 'GET', '/api/walkins')).json()).items.map(x => x.name), ['見本 次郎']);
});

test('期限: 受けて 2 日。一覧は期限の日まで出して、過ぎたら出さない。Cron が過ぎた行を消す。押された行は個人情報ごと残らない', async () => {
  const s = setup();
  const { key } = await withKey(s);
  assert.equal((await submit(s, key)).status, 202);
  const listAt = async (clock) => {
    s.io.clock = clock;
    const jwt = await jwtFor(STAFF, { exp: NOW / 1000 + 10 * 86400 });
    return (await (await staffCall(s, 'GET', '/api/walkins', undefined, { jwt })).json()).items.length;
  };
  assert.equal(await listAt(NOW + DAY), 1);
  assert.equal(await listAt(NOW + 2 * DAY), 1, '期限の日（10/29）までは出る');
  assert.equal(await listAt(NOW + 3 * DAY), 0, '10/30 には出ない（Cron が止まっていても個人情報を見せない）');
  assert.equal(pendingRows(s).length, 1, 'まだ消えてはいない');
  await scheduled(s.env, s.io);
  assert.equal(pendingRows(s).length, 0, 'Cron が消す');
  s.io.clock = NOW;
  assert.equal((await submit(s, key)).status, 202);
  await scheduled(s.env, s.io);
  assert.equal(pendingRows(s).length, 1, '期限前の行は消さない');
});

test('ログに鍵も名前も住所も出ない', async () => {
  const s = setup();
  logs.length = 0;
  const { key } = await withKey(s);
  await walkinCall(s, { k: key, action: 'view' });
  await submit(s, key, { name: '見本 太郎', address: '沖縄県那覇市見本 1-2-3' });
  await submit(s, key, { name: 'x.example.com' });
  await staffCall(s, 'GET', '/api/walkins');
  const all = logs.join('\n');
  for (const leak of [key, '見本 太郎', '那覇', '1990-05-01', 'taro@mail.example', '090-9999-0000']) assert.ok(!all.includes(leak), leak);
  assert.ok(logs.some(l => l.includes('"route":"/api/walkin"') && l.includes('"action":"submit"') && l.includes('"added":1')));
  assert.ok(logs.some(l => l.includes('"route":"/api/walkins"')));
});

/* ---------- 5. 名簿に入れる直し ---------- */
const walkinOf = (over = {}) => ({ name: '見本 太郎', people: 2, email: 'taro@mail.example', birthDate: '1990-05-01', address: '沖縄県那覇市見本 1-2-3',
  emergency: { name: '見本 花子', relation: '妻', phone: '090-9999-0000' }, ...over });
const itemOf = (over = {}) => ({ id: 'a1', tripId: '', at: AT, day: '2026-10-27', ...walkinOf(), ...over });

test('その予約にまとめる: 同じ日・同じ名前の予約だけが候補（名前の空白・全角半角の違いは同じ人）。別の日・別の名前・乗り合いの他のお店の予約は候補にしない', () => {
  const sample = roster();
  const mine = sample.book(sample.morning, '見本　太郎', 2);
  sample.book(sample.noon, '見本 次郎', 1);
  sample.book(sample.tomorrow, '見本 太郎', 1);
  sample.book(sample.partner, '見本 太郎', 1, { source: 'partner', shop: 'C ダイブ' });
  const G = R.rosterGuest;
  assert.deepEqual(G.walkinMatches(sample.state, itemOf()).map(m => m.bookingId), [mine.id], '今日の「見本 太郎」だけ');
  assert.deepEqual(G.walkinMatches(sample.state, itemOf({ day: '2026-10-28' })).map(m => m.tripId), [sample.tomorrow.id], '受けた日が明日なら明日の予約');
  assert.deepEqual(G.walkinMatches(sample.state, itemOf({ tripId: sample.tomorrow.id })).map(m => m.tripId), [sample.tomorrow.id], '選んだ便があれば、その便の日');
  assert.deepEqual(G.walkinMatches(sample.state, itemOf({ name: '見本 三郎' })), []);
  assert.deepEqual(G.walkinMatches(roster().state, itemOf()), [], '予約が無ければ候補なし（「便を選んで入れる」になる）');
});

test('その予約にまとめる: 代表者の空の所だけを入れる。入っている所（お店や AI が入れた物）は書き換えない。全部入っていれば名簿は変わらない', () => {
  const sample = roster();
  const b = sample.book(sample.morning, '見本 太郎', 2);
  const lead = sample.state.people.find(p => p.bookingId === b.id);
  const named = R.rosterCore.editPerson(sample.state, { id: lead.id, patch: { name: '見本 太郎', birthDate: '1985-01-01' }, who: 'staff', at: AT });
  const merged = R.rosterGuest.mergeWalkin(named, { bookingId: b.id, walkin: walkinOf(), today: '2026-10-27', at: AT });
  assert.deepEqual(merged.problems, []);
  const after = merged.state.people.find(p => p.id === lead.id);
  assert.equal(after.birthDate, '1985-01-01', '入っていた生年月日は書き換えない');
  assert.equal(after.address, '沖縄県那覇市見本 1-2-3');
  assert.deepEqual(after.emergency, { name: '見本 花子', relation: '妻', phone: '090-9999-0000' });
  assert.equal(after.src.address, 'guest');
  assert.equal(merged.state.bookings.length, named.bookings.length, '予約は増えない');
  assert.equal(merged.state.people.length, named.people.length, '人は増えない');
  assert.ok(R.roster.validateState(merged.state).ok);
  const again = R.rosterGuest.mergeWalkin(merged.state, { bookingId: b.id, walkin: walkinOf(), today: '2026-10-27', at: AT });
  assert.deepEqual(again.problems, ['nothing']);
  assert.equal(again.state, merged.state, '入れる所が無ければ名簿は変わらない');
  assert.deepEqual(R.rosterGuest.mergeWalkin(named, { bookingId: 'nope', walkin: walkinOf(), today: '2026-10-27', at: AT }).problems, ['gone']);
});

test('便を選んで入れる: 選んだ便に新しい予約（出どころは自社のフォーム）を人数ぶん作り、代表者に入力を入れる。メールは予約に。便が無い・中止の便は入れない', () => {
  const sample = roster();
  const out = R.rosterGuest.addWalkin(sample.state, { tripId: sample.morning.id, walkin: walkinOf(), at: AT, newId });
  assert.deepEqual(out.problems, []);
  const b = out.state.bookings.find(x => x.id === out.bookingId);
  assert.equal(b.tripId, sample.morning.id);
  assert.equal(b.source, 'form');
  assert.equal(b.leadName, '見本 太郎');
  assert.equal(b.leadEmail, 'taro@mail.example');
  assert.equal(b.people, 2);
  const people = out.state.people.filter(p => p.bookingId === b.id);
  assert.equal(people.length, 2);
  assert.equal(people[0].name, '見本 太郎');
  assert.equal(people[0].birthDate, '1990-05-01');
  assert.equal(people[0].address, '沖縄県那覇市見本 1-2-3');
  assert.equal(people[0].emergency.phone, '090-9999-0000');
  assert.equal(people[1].name, '', '同行者は空の行（あとでお客さんのリンクで聞く）');
  assert.ok(out.state.log.some(e => e.who === 'guest' && e.kind === 'person' && e.act === 'edit'), 'お客さんの入力として記録に残る');
  assert.ok(R.roster.validateState(out.state).ok);
  assert.equal(R.rosterGuest.addWalkin(sample.state, { tripId: 'nope', walkin: walkinOf(), at: AT, newId }).state, sample.state);
  assert.deepEqual(R.rosterGuest.addWalkin(sample.state, { tripId: 'nope', walkin: walkinOf(), at: AT, newId }).problems, ['trip']);
  assert.deepEqual(R.rosterGuest.addWalkin(sample.state, { tripId: sample.off.id, walkin: walkinOf(), at: AT, newId }).problems, ['cancelled']);
  const noMail = R.rosterGuest.addWalkin(sample.state, { tripId: sample.noon.id, walkin: walkinOf({ email: '', people: 1 }), at: AT, newId });
  assert.equal(noMail.state.bookings[noMail.state.bookings.length - 1].leadEmail, undefined);
});

test('名簿の直しの記録（op log）を通る: 表にある op 名。同じ入力・同じ id・同じ時刻なら、いつ当て直しても同じ結果。入れない（消すだけ）は名簿を変えない', () => {
  const sample = roster();
  const b = sample.book(sample.morning, '見本 太郎', 1);
  assert.ok(R.rosterCore.ops.names.includes('guest.addWalkin') && R.rosterCore.ops.names.includes('guest.mergeWalkin'));
  const entry = { op: 'guest.addWalkin', args: JSON.parse(JSON.stringify({ tripId: sample.noon.id, walkin: walkinOf() })), id: 'op-1', at: AT };
  const one = R.rosterCore.ops.run(sample.state, entry);
  const two = R.rosterCore.ops.run(sample.state, entry);
  assert.deepEqual(one.state, two.state);
  assert.equal(one.bookingId, 'op-1-1', 'id は直しの id から決まる');
  const merge = R.rosterCore.ops.run(sample.state, { op: 'guest.mergeWalkin', args: { bookingId: b.id, walkin: walkinOf(), today: '2026-10-27' }, id: 'op-2', at: AT });
  assert.deepEqual(merge.problems, []);
  assert.ok(R.rosterCore.ops.touches(sample.state, merge.state).length > 0, '触った項目の前の値が残る（別の端末とぶつかったとき知らせる）');
  assert.throws(() => R.rosterCore.ops.run(sample.state, { op: 'guest.nope', args: {}, id: 'op-3', at: AT }));
  const staffSrc = readFileSync(new URL('../js/walkin-staff.js', import.meta.url), 'utf8');
  assert.match(staffSrc, /ui\.save\('guest\.mergeWalkin'/);
  assert.match(staffSrc, /ui\.save\('guest\.addWalkin'/);
  assert.ok(!/rosterStore\.update\(/.test(staffSrc), '名簿は update でなく op で直す');
});

test('入れない・入れたあとの消し方: 入れない物は名簿を変えず、サーバーの行を消す。入れた物は名簿の直しがサーバーに届いてから消す（画面の道具 roster-sync）', async () => {
  const calls = [];
  const store = new Map();
  const ctx = (await import('node:vm')).createContext({ localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    setTimeout, clearTimeout, AbortController, TextEncoder, URL, btoa, console, CompressionStream, Blob, Response, addEventListener: () => {},
    fetch: async (path, init) => { calls.push([init.method, path, init.body]); return new Response(JSON.stringify({ ok: true }), { status: ctx.reply }); } });
  ctx.window = ctx;
  ctx.reply = 200;
  const vm = await import('node:vm');
  ['core.js', 'roster-schema.js', 'roster-sync.js'].forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const sync = ctx.REDUX.rosterSync;
  sync.hideWalkin('rej1', false);
  sync.hideWalkin('acc1', true);
  sync.hideWalkin('bad id', true);
  assert.equal(await sync.flushWalkinDrops({ synced: false }), 1, '入れた行は、名簿の直しが届くまで残す。入れない行は消す');
  assert.deepEqual(calls.map(c => [c[0], c[1], c[2]]), [['POST', '/api/walkin-drop', '{"id":"rej1"}']]);
  ctx.reply = 503;
  assert.equal(await sync.flushWalkinDrops({ synced: true }), 1, '消せなければ残して、次に試す');
  ctx.reply = 404;
  assert.equal(await sync.flushWalkinDrops({ synced: true }), 0, 'もう無い（404）なら片付いた');
  assert.equal(store.get('redux-walkin-dropped'), undefined);
});

/* ---------- 6. RPC の口 ---------- */
test('RPC の口: walkinView・walkinSubmit は SHOP_METHODS の 7 つに入り、fakeShopBinding も ShopRpc も同じ。形の違う引数は 400、D1 が無ければ 503', async () => {
  const s = setup();
  const { key } = await withKey(s);
  const binding = fakeShopBinding(new ShopService(s.env, s.io));
  assert.deepEqual(SHOP_METHODS.slice(4, 6), ['walkinView', 'walkinSubmit']);
  assert.deepEqual(Object.keys(binding).filter(k => typeof binding[k] === 'function').sort(), [...SHOP_METHODS].sort());
  const rpc = readFileSync(new URL('../worker/shop-rpc.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...rpc.matchAll(/^ {2}(\w+)\(/gm)].map(m => m[1]).sort(), [...SHOP_METHODS].sort());
  const hash = await keyHash(key);
  const view = await binding.walkinView(hash);
  assert.equal(view.status, 200);
  assert.deepEqual(Object.keys(view.body).sort(), ['shop', 'today', 'trips']);
  const svc = new ShopService(s.env, s.io);
  assert.equal((await svc.walkinView('nope')).status, 400);
  assert.equal((await svc.walkinView(undefined)).status, 400);
  assert.equal((await svc.walkinSubmit('nope', GOOD())).status, 400);
  assert.equal((await svc.walkinSubmit(hash, { ...GOOD(), extra: 1 })).status, 400, '知らない項目');
  assert.equal((await svc.walkinSubmit(hash, { ...GOOD(), action: 'view' })).status, 400);
  assert.equal((await svc.walkinSubmit(hash, { ...GOOD(), name: 5 })).status, 400);
  assert.equal((await svc.walkinSubmit('0'.repeat(64), GOOD())).status, 404, '鍵の行が無ければ 404');
  assert.equal((await svc.walkinSubmit(hash, GOOD())).status, 202);
  assert.equal(pendingRows(s).length, 1);
  for (const f of ['walkinView', 'walkinSubmit']) assert.equal((await new ShopService({ ...s.env, DB: undefined }, s.io)[f](hash, GOOD())).status, 503, f);
  assert.deepEqual(checkWalkin({ k: key, action: 'view' }), { ok: true, k: key, action: 'view', req: {} });
  assert.equal(checkWalkinApply(GOOD()).ok, true);
  assert.equal(walkinItem({ id: 'a', tripId: '', at: AT, body: '{"name":1}' }), null);
});

test('向こうの答えは信用しない: walkin の口の答えが壊れていれば 500。ログに足す note は決まった名前の短い値だけ', async () => {
  const s = setup();
  const { key } = await withKey(s);
  const wrap = (fake) => ({ ...publicEnv(s), SHOP: { ...fakeShopBinding(new ShopService(s.env, s.io)), ...fake } });
  assert.equal((await walkinCall(s, { k: key, action: 'view' }, { env: wrap({ walkinView: async () => ({ status: '200', body: {}, note: {} }) }) })).status, 500);
  assert.equal((await submit(s, key, {}, { env: wrap({ walkinSubmit: async () => null }) })).status, 500);
  const down = { ...publicEnv(s), SHOP: undefined };
  assert.equal((await walkinCall(s, { k: key, action: 'view' }, { env: down })).status, 503);
});

test('redux-ask の束と配る物: /api/walkin 以外の道は増えない。walkin.html は redux-ask の dist-ask に入り、CSP は ask.html と同じ（同じ場所の /api だけ）', async () => {
  const s = setup();
  const env = publicEnv(s);
  for (const path of ['/api/walkins', '/api/walkin-key', '/api/walkin-drop', '/api/roster']) {
    const r = await handlePublic(new Request(`${ASK_ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: '{}' }), env, s.io);
    assert.equal(r.status, 404, `${path} は redux-ask に無い`);
  }
  const { askFiles, askHeaders } = await import('../tools/build-site.mjs');
  const files = askFiles();
  assert.deepEqual(files.slice(0, 2), ['ask.html', 'walkin.html']);
  for (const need of ['js/walkin-page.js', 'js/ask-api.js', 'js/core.js', 'css/app.css']) assert.ok(files.includes(need), need);
  for (const shopOnly of ['js/walkin-staff.js', 'js/roster-sync.js', 'js/booking.js', 'js/contact-link.js', 'index.html']) assert.ok(!files.includes(shopOnly), shopOnly);
  const h = askHeaders(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
  const csp = "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; connect-src 'self'";
  assert.ok(h.includes(`/walkin\n  ${csp}`) && h.includes(`/walkin.html\n  ${csp}`));
  const html = readFileSync(new URL('../walkin.html', import.meta.url), 'utf8');
  assert.ok(html.includes("connect-src 'self'") && !/font|https?:\/\//i.test(html.replace(/<!--[\s\S]*?-->/g, '')), '外を読まず、字体も読まない');
  const page = readFileSync(new URL('../js/walkin-page.js', import.meta.url), 'utf8');
  assert.ok(!/health|既往|answers/i.test(page.replace(/健康のことは、ここでは聞きません|We do not ask about health here/g, '')), '健康の質問はしない');
});

/* ---------- 7. SMS・LINE で送る ---------- */
const KEY43 = 'A1_-'.repeat(10) + 'xyz';
const LINK = `https://ask.reduxdive.com/ask#k=${KEY43}`;

test('SMS で送る: sms:<番号>?&body=<文>。番号は半角にそろえ、電話番号が無い・使えない予約には作らない', () => {
  const L = R.contactLink;
  const href = L.smsHref('090-1234-5678', 'B マリン', LINK);
  assert.ok(href.startsWith('sms:09012345678?&body='), href);
  assert.equal(decodeURIComponent(href.slice(href.indexOf('&body=') + 6)), `B マリン：${L.ASK_LINE}\n${LINK}`);
  assert.ok(!/[ \n!'()*]/.test(href), '空白・改行・! \' ( ) * は % にする');
  assert.ok(href.includes('%0A') && href.includes('%E3%81%94'), '改行と日本語は UTF-8 の % 表記');
  assert.ok(L.smsHref('０９０－１２３４－５６７８', 'B', LINK).startsWith('sms:09012345678?&body=B%EF%BC%9A'), '全角の番号も半角にそろえる');
  assert.ok(L.smsHref('+81 90 1234 5678', 'B', LINK).startsWith('sms:+819012345678?&body='));
  for (const phone of ['', '   ', '電話なし', '123', '090-1234-5678 内線 12', 'abc', undefined, null]) assert.equal(L.smsHref(phone, 'B', LINK), '', String(phone));
});

test('LINE で送る: 公式の URL scheme（https://line.me/R/share?text=<UTF-8 を % にした文>）。同じ文で作る', () => {
  const L = R.contactLink;
  const href = L.lineHref('B マリン', LINK);
  assert.ok(href.startsWith('https://line.me/R/share?text='));
  const text = decodeURIComponent(href.slice('https://line.me/R/share?text='.length));
  assert.equal(text, `B マリン：${L.ASK_LINE}\n${LINK}`);
  assert.equal(text, decodeURIComponent(L.smsHref('09012345678', 'B マリン', LINK).split('&body=')[1]), 'SMS と LINE は同じ文');
  assert.ok(!/[ \n!'()*]/.test(href.slice('https://line.me/R/share?text='.length)));
  assert.equal(new URL(href).searchParams.get('text'), text, 'ブラウザが読んでも同じ文');
});

test('SMS・LINE の文: 入るのはお店の名前・決まった 1 行・その予約のリンクだけ（お客さんの名前・電話番号・メールは入らない）。長いお店の名前は切る。リンクの形でない物は文にしない', () => {
  const L = R.contactLink;
  const text = L.messageText('B マリン', LINK);
  assert.equal(text, `B マリン：ご予約の前にお名前などの入力をお願いします\n${LINK}`);
  assert.equal(L.messageText('', LINK), `ご予約の前にお名前などの入力をお願いします\n${LINK}`);
  assert.equal(L.messageText('あ'.repeat(60), LINK).split('：')[0].length, 24);
  assert.equal([...L.ASK_LINE].length + 1 + LINK.length >= 70, true, 'リンクだけで 75 字あり、70 字には収まらない（PR に書く）');
  for (const bad of ['', 'https://evil.example/', `https://ask.reduxdive.com/ask#k=short`, `https://ask.reduxdive.com/other#k=${KEY43}`, `ftp://ask.reduxdive.com/ask#k=${KEY43}`,
    `${LINK}&x=1`, `${LINK}\nhttps://evil.example/`, `javascript:alert(1)//ask#k=${KEY43}`, `http://evil.example/ask#k=${KEY43}`, null, undefined, 5]) {
    assert.equal(L.messageText('B', bad), '', String(bad));
    assert.equal(L.smsHref('09012345678', 'B', bad), '');
    assert.equal(L.lineHref('B', bad), '');
  }
  assert.ok(L.askUrlOk(`http://localhost:8787/ask#k=${KEY43}`), '手元の確かめ（localhost）は通す');
});

test('その予約のリンクだけ: お店の Worker が予約ごとに作ったリンクから SMS・LINE の URL を作ると、本文のリンクはそのリンク自身（別の予約のリンクではない）', async () => {
  const s = setup();
  const sample = roster();
  const b1 = sample.book(sample.morning, '見本 太郎', 2);
  const b2 = sample.book(sample.noon, '見本 次郎', 1);
  putState(s, sample.state);
  const link = async (id) => (await (await staffCall(s, 'POST', '/api/ask-link', { bookingId: id })).json()).url;
  const [u1, u2] = [await link(b1.id), await link(b2.id)];
  assert.notEqual(u1, u2);
  const L = R.contactLink;
  const sms = L.smsHref(b1.leadPhone, stored(s).shop.name, u1);
  const line = L.lineHref(stored(s).shop.name, u1);
  for (const href of [sms, line]) {
    const body = decodeURIComponent(href.split(/&body=|\?text=/)[1]);
    assert.ok(body.endsWith(`\n${u1}`) && !body.includes(u2), 'その予約のリンクだけ');
    for (const person of ['見本 太郎', '見本 次郎', '090-1234-5678']) assert.ok(!body.includes(person), `${person} は文に入れない`);
    assert.ok(body.startsWith('B マリン（見本）：'), 'お店の名前は入る');
  }
});

runTests(tests);
