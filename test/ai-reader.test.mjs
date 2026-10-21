// AI の窓口 (js/ai-reader.js) を、ブラウザの道具を差し替えて確かめる。
// 送る中身が決まった項目だけか、失敗しても送った量が残るか、見本が壊れていても止まらないか。
// 実行: node test/ai-reader.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const memory = () => {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) };
};
globalThis.window = globalThis;
globalThis.localStorage = memory();
globalThis.sessionStorage = memory();
let calls = [];
let reply = null;
globalThis.fetch = async (url, init) => {
  // 本物のブラウザと同じく、ヘッダに入れられない文字があればここで例外になる
  calls.push({ url, init, headers: new Headers(init.headers), body: JSON.parse(init.body) });
  return reply();
};
const json = (status, data) => ({ type: 'basic', status, ok: status >= 200 && status < 300, json: async () => data });

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/roster-schema.js');
load('../js/data-samples.js');
load('../js/health-redact.js');
load('../js/ai-reader.js');
const { aiReader: A, SAMPLE_READINGS } = globalThis.REDUX;
/* 写真は photo-prep.js が作った物だけ送れる。ここでは作った印だけを差し替える（canvas は Node に無い） */
const preparedSet = new WeakSet();
globalThis.REDUX.photoPrep = { isPrepared: (r) => preparedSet.has(r) };
const P = (r) => { preparedSet.add(r); return r; };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const rejectsKind = async (p, kind) => {
  try { await p; } catch (e) { assert.equal(e.kind, kind); return e; }
  throw new Error(`例外にならなかった (${kind} のはず)`);
};

test('見本: 答えと送った量が返る。sampleId は記録に入らない', async () => {
  A.setMode('sample');
  const { reading, sent } = await A.read({ doc: 'mail', text: 'abc', sampleId: 'e1' });
  assert.deepEqual(reading, SAMPLE_READINGS.e1);
  assert.deepEqual(sent, { doc: 'mail', size: 3, masked: false, mode: 'sample', healthSeen: false, redacted: 0 });
});

test('見本: 知らない id や prototype の名前でも止まらず、空の答えになる', async () => {
  for (const id of ['zz', 'toString', '__proto__']) {
    const { reading } = await A.read(P({ doc: 'ccard', image: 'QUJD', sampleId: id }));
    assert.deepEqual(reading, { booking: null, people: [], healthSeen: false });
  }
});

test('見本: 答えが形に合わないと、待ち続けずに bad で終わる', async () => {
  SAMPLE_READINGS.broken = { people: 'x' };
  const e = await rejectsKind(A.read({ doc: 'mail', text: 'abc', sampleId: 'broken' }), 'bad');
  assert.equal(e.sent.doc, 'mail');
  delete SAMPLE_READINGS.broken;
});

test('本物: 送る中身は決まった項目だけ。メールの健康の行は外れる', async () => {
  A.setMode('real');
  A.setCode('合言葉');
  calls = [];
  reply = () => json(200, SAMPLE_READINGS.e1);
  const { sent } = await A.read({ doc: 'mail', text: '予約です\n持病: 喘息', sampleId: 'e1' });
  assert.deepEqual(calls[0].body, { doc: 'mail', text: `予約です\n${globalThis.REDUX.healthRedact.REDACTED_LINE}` });
  assert.equal(calls[0].url, '/api/read');
  assert.equal(calls[0].headers.get('x-redux-code'), Buffer.from('合言葉').toString('base64url'), '日本語の合言葉でも送れる');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(sent.redacted, 1);
  await rejectsKind(A.read({ doc: 'mail', text: '予約です', history: '喘息' }), 'input');
  assert.equal(calls.length, 1, '形に合わない物は送らない');
});

test('本物: 申込書は塗った印付きで送り、健康が見えたら sent に残る', async () => {
  calls = [];
  reply = () => json(200, { ...SAMPLE_READINGS.f1, healthSeen: true });
  const { sent } = await A.read(P({ doc: 'paper', image: 'QUJD', masked: true }));
  assert.deepEqual(calls[0].body, { doc: 'paper', image: 'QUJD', masked: true });
  assert.deepEqual([sent.masked, sent.healthSeen, sent.size], [true, true, 4]);
  await rejectsKind(A.read(P({ doc: 'paper', image: 'QUJD' })), 'input');
});

test('本物: 失敗の種類を分け、送ったあとの失敗には送った量が付く', async () => {
  reply = () => json(429, {});
  assert.equal((await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'limit')).sent.size, 4);
  reply = () => json(403, {});
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'auth');
  reply = () => ({ type: 'opaqueredirect', status: 0, ok: false, json: async () => ({}) });
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'auth');
  reply = () => json(500, {});
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'offline');
  reply = () => json(200, { booking: null, people: [{ name: 'x', health: '喘息' }], healthSeen: false });
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'bad');
  reply = () => { throw new TypeError('Failed to fetch'); };
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'offline');
  reply = () => json(400, {});
  await rejectsKind(A.read(P({ doc: 'ccard', image: 'QUJD' })), 'input');
});

test('写真は photo-prep.js が作った物だけ送る（masked: true と書いただけの物は送らない）', async () => {
  calls = [];
  await rejectsKind(A.read({ doc: 'paper', image: 'QUJD', masked: true }), 'input');
  await rejectsKind(A.read({ doc: 'ccard', image: 'QUJD' }), 'input');
  assert.equal(calls.length, 0);
  assert.throws(() => A.preview({ doc: 'ccard', image: 'QUJD' }), /input/);
});

test('C カードを塗って送れば、記録にも塗った印が残る', async () => {
  reply = () => json(200, SAMPLE_READINGS.c1);
  const { sent } = await A.read(P({ doc: 'ccard', image: 'QUJD', masked: true }));
  assert.equal(sent.masked, true);
});

test('健康の行を外した印で上限を超える本文は、送らずに断る', async () => {
  calls = [];
  const text = Array(3000).fill('喘息').join('\n');
  await rejectsKind(A.read({ doc: 'mail', text }), 'input');
  assert.equal(calls.length, 0);
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.message}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
