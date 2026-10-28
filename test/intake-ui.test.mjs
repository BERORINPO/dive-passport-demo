// 予約の受け口 API の鍵のお店の画面（js/api-keys-staff.js・js/booking.js。決定ログ 2026-10-28 intake-api）を、
// 小さな作り物の DOM（要素の木・押す・文字を読む）と、index.html と同じ順で読み込んだ本物の画面の部品で確かめる。
// 通信（js/roster-sync.js）だけを差し替える。作った鍵が 1 回だけ出ること、作り直す・止めるは 2 回押すこと、説明書へのリンク。
// 実行: node test/intake-ui.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ---------- 作り物の DOM ---------- */
class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.dataset = {};
    this.own = '';
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  append(...kids) { this.children.push(...kids); }

  replaceChildren(...kids) { this.children = kids; }

  set textContent(v) { this.children = []; this.own = String(v); }

  get textContent() { return this.own + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }

  closest() { return null; }

  querySelector(sel) { return all(this, sel)[0] || null; }

  /* 押す。onclick はイベントを受ける */
  async click() { for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() {} }); }

  /* 入力欄に打ち込む（onchange） */
  async type(value) { for (const fn of this.listeners.change || []) await fn({ target: { value } }); }
}
const kids = (n) => n.children.filter(c => typeof c !== 'string');
function all(root, sel) {
  const hit = [];
  const test = (n) => (sel.startsWith('.') ? String(n.className).split(/\s+/).includes(sel.slice(1)) : n.tagName === sel.toUpperCase());
  const walk = (n) => { kids(n).forEach(c => { if (test(c)) hit.push(c); walk(c); }); };
  walk(root);
  return hit;
}
const buttons = (root, text) => [...all(root, 'button'), ...all(root, 'a')].filter(b => b.textContent.includes(text));

/* ---------- 画面の部品を index.html と同じ順で読む ---------- */
const SCRIPTS = ['core.js', 'data.js', 'data-sipe.js', 'qr.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-guest.js', 'roster-day.js', 'roster-share.js',
  'roster-auto.js', 'data-samples.js', 'data-big-sample.js', 'photo-mask.js', 'photo-prep.js', 'ai-reader.js', 'roster-sync.js', 'day-roster.js', 'past-trips.js', 'share-roster.js',
  'partner-photo.js', 'intake-photo.js', 'auto-flow.js', 'contact-link.js', 'person-links.js', 'walkin-staff.js', 'api-keys-staff.js', 'booking-add.js', 'booking-edit.js', 'booking.js'];
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), raw: m }; };
const DOCS = 'https://docs.example/api.md';

function boot({ docs = DOCS, clipboard = null } = {}) {
  const nodes = {};
  const body = new FNode('body');
  const meta = (content) => { const m = new FNode('meta'); m.setAttribute('content', content); return m; };
  const document = {
    body, documentElement: new FNode('html'), activeElement: null,
    createElement: (tag) => new FNode(tag),
    getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')),
    querySelector: (sel) => (sel === 'meta[name="redux-worker"]' ? meta('1') : sel === 'meta[name="redux-api-docs"]' && docs ? meta(docs) : null)
  };
  const qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: (r, c) => (r + c) % 3 === 0 });
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://dive-passport-demo.example.workers.dev', pathname: '/', hash: '' },
    navigator: { language: 'ja', ...(clipboard ? { clipboard } : {}) }, localStorage: memory(), sessionStorage: memory(), setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => 0,
    AbortController, TextEncoder, URL, btoa, console, CompressionStream, Blob, Response, qrcode, printed: 0, listeners: {}, CSS: { escape: (s) => s } });
  ctx.addEventListener = (type, fn) => { ctx.listeners[type] = fn; };
  ctx.print = () => {};
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.rosterStore.synced = () => true;
  R.rosterStore.pending = () => 0;
  R.rosterSync.walkins = async () => ({ ok: true, items: [], keyAt: '' });
  R.rosterSync.flushWalkinDrops = async () => 0;
  return { R, ctx, root: document.getElementById('booking') };
}

const settle = () => new Promise(r => setImmediate(r));
const KEY = (c) => `rdx_${String(c).repeat(43)}`;
const ENDPOINT = 'https://ask.reduxdive.com/api/v1/bookings';
const AT = '2026-10-27T01:00:00.000Z';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* サーバーの代わり: 鍵の一覧を持ち、作る・作り直す・止めるに答える。鍵そのものは一覧に入れない（本物のサーバーと同じ） */
function fakeServer(R, { initial = [], createStatus = 200 } = {}) {
  const server = { items: [...initial], calls: [], seq: 0, lastKey: '' };
  const next = () => { server.seq += 1; server.lastKey = KEY(String.fromCharCode(96 + server.seq)); return server.lastKey; };
  R.rosterSync.apiKeys = async () => { server.calls.push(['list']); return { ok: true, items: server.items.map(x => ({ ...x })), endpoint: ENDPOINT, max: 3 }; };
  R.rosterSync.apiKeyCreate = async (label) => {
    server.calls.push(['create', label]);
    if (createStatus !== 200) return { ok: false, why: createStatus };
    const id = `k${server.seq + 1}`;
    server.items.push({ id, label, at: AT, revokedAt: '' });
    return { ok: true, id, key: next(), at: AT, endpoint: ENDPOINT };
  };
  R.rosterSync.apiKeyRotate = async (id) => { server.calls.push(['rotate', id]); return { ok: true, id, key: next(), at: AT, endpoint: ENDPOINT }; };
  R.rosterSync.apiKeyRevoke = async (id) => { server.calls.push(['revoke', id]); const x = server.items.find(i => i.id === id); if (x) x.revokedAt = AT; return { ok: true }; };
  return server;
}
const open = async (R, root) => { R.renderBooking(); await buttons(root, '別のシステムから予約を受ける')[0].click(); await settle(); };

test('予約の一覧に「API キー」の入口が出る（サーバーにつながる版だけ）。開くと鍵の一覧・作る欄・説明書へのリンクが出る', async () => {
  const { R, root } = boot();
  const server = fakeServer(R, { initial: [{ id: 'k1', label: '公式サイト', at: AT, revokedAt: '' }, { id: 'k0', label: '古い連携', at: AT, revokedAt: AT }] });
  R.renderBooking();
  assert.equal(buttons(root, '別のシステムから予約を受ける').length, 1);
  await open(R, root);
  assert.ok(server.calls.some(c => c[0] === 'list'));
  const text = root.textContent;
  assert.match(text, /公式サイト/);
  assert.match(text, /使える鍵 1 \/ 3 本/);
  assert.match(text, /止めた/);
  assert.equal(buttons(all(root, 'li').find(li => li.textContent.includes('古い連携')), '作り直す').length, 0, '止めた鍵に操作は出ない');
  const link = buttons(root, '説明書').find(b => b.tagName === 'A');
  assert.equal(link.getAttribute('href'), DOCS);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /noopener/);
  const local = boot();
  local.R.rosterStore.synced = () => false;
  local.R.renderBooking();
  assert.equal(buttons(local.root, '別のシステムから予約を受ける').length, 0, 'サーバーにつながらない版には出さない');
});

test('説明書の住所が無い版（手元）では、リンクを出さず場所を文字で示す', async () => {
  const { R, root } = boot({ docs: '' });
  fakeServer(R);
  await open(R, root);
  assert.equal(buttons(root, '説明書').filter(b => b.tagName === 'A').length, 0);
  assert.match(root.textContent, /docs\/api\.md/);
});

test('鍵を作る: 名前を入れて押すと、鍵が 1 回だけ出る。写せる。閉じる・画面を離れて戻る・読み直すと、二度と出ない', async () => {
  const copied = [];
  const { R, root } = boot({ clipboard: { writeText: async (t) => { copied.push(t); } } });
  const server = fakeServer(R);
  await open(R, root);
  /* 名前が空では作らない */
  await buttons(root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  assert.deepEqual(server.calls.filter(c => c[0] === 'create'), []);
  assert.match(root.textContent, /連携先の名前を/);
  await all(root, 'input')[0].type('  公式サイト ');
  await buttons(root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  await settle();
  assert.deepEqual(server.calls.filter(c => c[0] === 'create'), [['create', '公式サイト']], '前後の空白は取る');
  const key = server.lastKey;
  assert.equal(all(root, '.url').filter(n => n.textContent === key).length, 1, '鍵が出る');
  assert.match(root.textContent, /いま 1 回だけ出ます/);
  assert.match(root.textContent, new RegExp(ENDPOINT.replace(/[./]/g, '\\$&')), '送り先も出る');
  assert.match(root.textContent, /使える鍵 1 \/ 3 本/, '一覧は作ったあとに読み直す');
  assert.ok(!all(root, 'li').some(li => li.textContent.includes(key)), '一覧の行に鍵は出ない');
  await buttons(root, '鍵を写す')[0].click();
  await settle();
  assert.deepEqual(copied, [key]);
  assert.match(root.textContent, /鍵を写しました/);
  /* 閉じると消える */
  await buttons(root, '閉じる')[0].click();
  assert.ok(!root.textContent.includes(key));
  assert.ok(!root.textContent.includes('いま 1 回だけ出ます'));
  /* 画面を離れて戻っても、読み直しても出ない（もう一度作ると、別の鍵になる） */
  await buttons(root, '読み直す')[0].click();
  await settle();
  assert.ok(!root.textContent.includes(key));
  await buttons(root, '予約の一覧に戻る')[0].click();
  await open(R, root);
  assert.ok(!root.textContent.includes(key));
});

test('鍵を作ったまま画面を離れて戻ると、鍵は消えている', async () => {
  const { R, root } = boot();
  const server = fakeServer(R);
  await open(R, root);
  await all(root, 'input')[0].type('Zapier');
  await buttons(root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  await settle();
  const key = server.lastKey;
  assert.ok(root.textContent.includes(key));
  await buttons(root, '予約の一覧に戻る')[0].click();
  assert.ok(!root.textContent.includes(key));
  await open(R, root);
  assert.ok(!root.textContent.includes(key), '戻っても出ない');
});

test('写せなかったときは、長押しで写すよう知らせる（クリップボードが無い端末）', async () => {
  const { R, root } = boot();
  fakeServer(R);
  await open(R, root);
  await all(root, 'input')[0].type('CF7');
  await buttons(root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  await settle();
  await buttons(root, '鍵を写す')[0].click();
  await settle();
  assert.match(root.textContent, /写せませんでした/);
});

test('作り直す: 2 回押して実行する。1 回目は警告だけ。新しい鍵が 1 回だけ出て、名前は同じ。前の鍵は使えないと知らせる', async () => {
  const { R, root } = boot();
  const server = fakeServer(R, { initial: [{ id: 'k1', label: '公式サイト', at: AT, revokedAt: '' }] });
  await open(R, root);
  await buttons(root, '作り直す')[0].click();
  assert.deepEqual(server.calls.filter(c => c[0] === 'rotate'), [], '1 回目では実行しない');
  assert.match(root.textContent, /もう一度押すと作り直す/);
  await buttons(root, 'もう一度押すと作り直す')[0].click();
  await settle();
  assert.deepEqual(server.calls.filter(c => c[0] === 'rotate'), [['rotate', 'k1']]);
  assert.equal(all(root, '.url').filter(n => n.textContent === server.lastKey).length, 1);
  assert.match(root.textContent, /「公式サイト」の鍵を作り直しました。前の鍵は使えません/);
  assert.match(root.textContent, /公式サイト の鍵/);
});

test('止める: 2 回押して実行する。止めた鍵は「止めた」と出て、操作は消える。出ていた鍵も消える', async () => {
  const { R, root } = boot();
  const server = fakeServer(R, { initial: [{ id: 'k1', label: '公式サイト', at: AT, revokedAt: '' }, { id: 'k2', label: 'Zapier', at: AT, revokedAt: '' }] });
  await open(R, root);
  const row = (name) => all(root, 'li').find(li => li.textContent.includes(name));
  await buttons(row('公式サイト'), '作り直す')[0].click();
  await settle();
  await buttons(root, 'もう一度押すと作り直す')[0].click();
  await settle();
  const key = server.lastKey;
  assert.ok(root.textContent.includes(key));
  await buttons(row('公式サイト'), '止める')[0].click();
  assert.deepEqual(server.calls.filter(c => c[0] === 'revoke'), [], '1 回目では実行しない');
  assert.match(root.textContent, /もう一度押すと止める/);
  /* 別の鍵の「止める」を押しても、前の 1 回目は引き継がない */
  await buttons(row('Zapier'), '止める')[0].click();
  assert.deepEqual(server.calls.filter(c => c[0] === 'revoke'), []);
  await buttons(row('Zapier'), 'もう一度押すと止める')[0].click();
  await settle();
  assert.deepEqual(server.calls.filter(c => c[0] === 'revoke'), [['revoke', 'k2']]);
  assert.match(row('Zapier').textContent, /止めた/);
  assert.equal(buttons(row('Zapier'), '止める').length, 0);
  await buttons(row('公式サイト'), '止める')[0].click();
  await buttons(row('公式サイト'), 'もう一度押すと止める')[0].click();
  await settle();
  assert.ok(!root.textContent.includes(key), '止めた鍵が出たままにならない');
  assert.match(root.textContent, /使える鍵 0 \/ 3 本/);
});

test('作れなかったとき: 鍵の数が上限なら止めるよう知らせ、通信の失敗は押し直しを促す。どちらも鍵は出ない', async () => {
  const full = boot();
  const s1 = fakeServer(full.R, { createStatus: 409 });
  await open(full.R, full.root);
  await all(full.root, 'input')[0].type('11 本目');
  await buttons(full.root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  await settle();
  assert.match(full.root.textContent, /鍵は 3 本までです/);
  assert.equal(all(full.root, '.url').length, 0);
  assert.equal(s1.calls.filter(c => c[0] === 'create').length, 1);
  const down = boot();
  fakeServer(down.R, { createStatus: 0 });
  await open(down.R, down.root);
  await all(down.root, 'input')[0].type('x');
  await buttons(down.root, 'API キーを作る').filter(b => b.tagName === 'BUTTON')[0].click();
  await settle();
  assert.match(down.root.textContent, /鍵を作れませんでした/);
  assert.equal(all(down.root, '.url').length, 0);
});

test('一覧を読めないとき: 描き直すたびに読みに行かない。ログイン切れは別の文', async () => {
  const { R, root } = boot();
  let reads = 0;
  let why = 'network';
  R.rosterSync.apiKeys = async () => { reads += 1; return { ok: false, why }; };
  await open(R, root);
  R.renderBooking();
  await settle();
  assert.equal(reads, 1);
  assert.match(root.textContent, /一覧を読めませんでした/);
  why = 'login';
  await buttons(root, '読み直す')[0].click();
  await settle();
  assert.equal(reads, 2);
  assert.match(root.textContent, /ログインが切れました/);
});

test('通信の部品（js/roster-sync.js）: 形の合わない返事は画面に渡さない。鍵は「rdx_」と 43 字だけ、送り先は /api/v1/bookings だけ', async () => {
  const { R, ctx } = boot();
  const replies = [];
  ctx.fetch = async (path, init) => { replies.push({ path, init }); const r = replies.next; return new Response(JSON.stringify(r.body), { status: r.status }); };
  const reply = (status, body) => { replies.next = { status, body }; };
  const good = { id: 'k1', key: KEY('a'), at: AT, endpoint: ENDPOINT };
  reply(200, good);
  const plain = (v) => JSON.parse(JSON.stringify(v));   // vm の中の object は別の realm なので、形だけで比べる
  assert.deepEqual(plain(await R.rosterSync.apiKeyCreate('x')), { ok: true, ...good });
  assert.equal(replies[0].path, '/api/api-keys');
  assert.deepEqual(JSON.parse(replies[0].init.body), { action: 'create', label: 'x' });
  for (const bad of [{ ...good, key: 'rdx_short' }, { ...good, key: `xxx_${'a'.repeat(43)}` }, { ...good, endpoint: 'https://evil.example/other' }, { ...good, endpoint: 'javascript:1' }, { ...good, id: 'K 1' }, null]) {
    reply(200, bad);
    assert.equal((await R.rosterSync.apiKeyRotate('k1')).ok, false, JSON.stringify(bad));
  }
  reply(409, { error: 'limit' });
  assert.deepEqual(plain(await R.rosterSync.apiKeyCreate('x')), { ok: false, why: 409 });
  reply(200, { items: [{ id: 'k1', label: 'a', at: AT, revokedAt: '' }], endpoint: ENDPOINT, max: 10 });
  assert.equal((await R.rosterSync.apiKeys()).ok, true);
  reply(200, { items: [{ id: 'k1', label: 'a' }], endpoint: ENDPOINT, max: 10 });
  assert.equal((await R.rosterSync.apiKeys()).ok, false);
  reply(200, { ok: true });
  assert.deepEqual(plain(await R.rosterSync.apiKeyRevoke('k1')), { ok: true });
  reply(404, { error: 'gone' });
  assert.deepEqual(plain(await R.rosterSync.apiKeyRevoke('k1')), { ok: true });
  reply(503, { error: 'db' });
  assert.deepEqual(plain(await R.rosterSync.apiKeyRevoke('k1')), { ok: false, why: 503 });
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
