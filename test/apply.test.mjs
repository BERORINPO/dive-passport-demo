// 案内ページの申し込みフォーム（worker/apply-core.mjs・apply-mail.mjs・public-handler.mjs の trialApply）を確かめる。
// 守ること: 届けるのは運営者の 1 アドレスだけ。保存しない。見出しへの差し込みを通さない。罠の欄・他のサイトからの送信・回数の上限で止める。
// 実行: node test/apply.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { checkApply, applyMail, APPLY_DONE, APPLY_FAILED } from '../worker/apply-core.mjs';
import { handlePublic } from '../worker/public-handler.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const form = (o) => new URLSearchParams(o);
const io = { now: () => Date.parse('2026-11-02T12:00:00Z'), fetch: async () => { throw new Error('外へは出ない'); } };
const quiet = async (fn) => { const real = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = real; } };

function envWith({ limit = true, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    env: {
      APPLY_MAIL: { send: async (m) => { if (fail) throw new Error('down'); sent.push(m); } },
      APPLY_FROM: 'yoyaku@reduxdive.com', APPLY_TO: 'owner@example.test',
      APPLY_LIMIT: { limit: async () => ({ success: limit }) }
    }
  };
}
const post = (body, headers = {}) => new Request('https://ask.example.test/api/trial-apply', {
  method: 'POST', body: typeof body === 'string' ? body : form(body).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': '192.0.2.1', ...headers }
});
const where = (res) => new URL(res.headers.get('location')).pathname + new URL(res.headers.get('location')).hash;

test('checkApply: お店の名前とアドレスだけを受ける。改行は空白にし、形の違うアドレス・長すぎる名前は断る', () => {
  assert.deepEqual(checkApply(form({ shop: ' B マリン\r\nBcc: x@evil.test ', email: 'shop@example.test' })), { ok: true, shop: 'B マリン Bcc: x@evil.test', email: 'shop@example.test' });
  for (const email of ['', 'no-at', 'a@b', 'a b@example.test', 'a@example.test\r\nBcc: x@evil.test', '"q"@example.test', 'a<b>@example.test']) {
    assert.equal(checkApply(form({ shop: 'B', email })).error, 'email', email);
  }
  assert.equal(checkApply(form({ shop: '', email: 'a@example.test' })).error, 'shop');
  assert.equal(checkApply(form({ shop: 'あ'.repeat(81), email: 'a@example.test' })).error, 'shop');
  assert.equal(checkApply(form({ shop: 'B', email: 'a@example.test', website: 'http://spam.test' })).error, 'trap');
});

test('applyMail: 件名にお店の名前、本文に 2 つと時刻。返信先は申し込んだお店', () => {
  const m = applyMail({ shop: 'B マリン', email: 'shop@example.test' }, '2026-11-02T12:00:00.000Z');
  assert.equal(m.subject, '[REDUX] 試用の申し込み（B マリン）');
  assert.equal(m.replyTo, 'shop@example.test');
  assert.ok(m.text.includes('お店の名前: B マリン') && m.text.includes('返事を受け取るアドレス: shop@example.test') && m.text.includes('2026-11-02T12:00:00.000Z'));
});

test('送れたら運営者の 1 アドレスへ 1 通送り、ページの #sent へ 303 で戻す', async () => {
  const { env, sent } = envWith();
  const res = await quiet(() => handlePublic(post({ shop: 'B マリン', email: 'shop@example.test', website: '' }), env, io));
  assert.equal(res.status, 303);
  assert.equal(where(res), APPLY_DONE);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@example.test', '宛先はフォームから選べない');
  assert.equal(sent[0].from.email, 'yoyaku@reduxdive.com');
  assert.equal(sent[0].replyTo, 'shop@example.test');
});

test('止める: 罠の欄は送らずに #sent・入力の誤り・回数の上限・送信の失敗・設定なしは #apply-error', async () => {
  const cases = [
    [{}, { shop: 'B', email: 'a@example.test', website: 'x' }, APPLY_DONE],
    [{}, { shop: 'B', email: 'bad' }, APPLY_FAILED],
    [{ limit: false }, { shop: 'B', email: 'a@example.test' }, APPLY_FAILED],
    [{ fail: true }, { shop: 'B', email: 'a@example.test' }, APPLY_FAILED]
  ];
  for (const [opt, body, to] of cases) {
    const { env, sent } = envWith(opt);
    const res = await quiet(() => handlePublic(post(body), env, io));
    assert.equal(where(res), to, JSON.stringify(body));
    assert.equal(sent.length, 0);
  }
  const { env } = envWith();
  delete env.APPLY_TO;
  assert.equal(where(await quiet(() => handlePublic(post({ shop: 'B', email: 'a@example.test' }), env, io))), APPLY_FAILED);
});

test('他のサイトからの送信は 403、form の形でない本文は 415、GET は 405、大きすぎる本文は #apply-error', async () => {
  const { env, sent } = envWith();
  assert.equal((await quiet(() => handlePublic(post({ shop: 'B', email: 'a@example.test' }, { 'sec-fetch-site': 'cross-site' }), env, io))).status, 403);
  assert.equal((await quiet(() => handlePublic(post('{"shop":"B"}', { 'content-type': 'application/json' }), env, io))).status, 415);
  assert.equal((await quiet(() => handlePublic(new Request('https://ask.example.test/api/trial-apply'), env, io))).status, 405);
  assert.equal(where(await quiet(() => handlePublic(post(`shop=${'a'.repeat(3000)}&email=a%40example.test`), env, io))), APPLY_FAILED);
  assert.equal(sent.length, 0);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
