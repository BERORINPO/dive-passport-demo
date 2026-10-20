// パスポートの中身を文字にして戻すと同じになるか、QR 用の URL が長すぎないかを確かめる。
// 実行: node test/pass.roundtrip.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const load = (path) => vm.runInThisContext(readFileSync(new URL(path, import.meta.url), 'utf8'));
load('../js/pass-schema.js');
load('../js/pass-codec.js');
const { pass, codec } = globalThis.REDUX;

const BASE = 'https://example.github.io/redux/m1-lite/index.html';
const URL_LIMIT = 1000;

const full = {
  ...pass.blank(),
  name: 'Emily Catherine Carter-Fitzgerald', lang: 'en', swim: '25m',
  certs: [
    { agency: 'PADI', level: 'Open Water Diver', no: '2401A23456', date: '2024-05' },
    { agency: 'SSI', level: 'Advanced Adventurer', no: '9876543210', date: '2025-02' },
    { agency: 'NAUI', level: 'Rescue Diver', no: 'N-123456', date: '2026-01' }
  ],
  dives: 85, lastDive: '2026-03',
  medical: { form: pass.FORM, answeredAt: '2026-10-20', answers: ['no', 'yes', 'no', 'yes', 'no'] },
  insurance: { name: 'DAN Asia-Pacific', no: 'AP-00012345' },
  sizes: { suit: 'M', fins: '24-25' },
  flight: { date: '2026-10-24', time: '18:30' },
  updatedAt: '2026-10-20T09:00:00.000Z'
};
const small = { ...pass.blank(), name: '佐藤 美咲', updatedAt: '2026-10-20T09:00:00.000Z' };
const partial = {
  ...pass.blank(), name: '王 小明', lang: 'zh', swim: 'good', dives: 12,
  medical: { form: pass.FORM, answeredAt: '2025-08-01', answers: ['no', 'no', null, 'no', null] }
};
const ALL = { medical: true, certNo: true, insurance: true, insuranceNo: true, sizes: true, flight: true };
const NONE = { medical: false, certNo: false, insurance: false, insuranceNo: false, sizes: false, flight: false };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('見本のパスポートは形に合う', () => {
  [full, small, partial].forEach(p => assert.deepEqual(pass.validate(p), { ok: true, errors: [] }));
});

test('形に合わないパスポートは弾く', () => {
  assert.equal(pass.validate({ ...full, v: 2 }).ok, false);
  assert.equal(pass.validate({ ...full, lang: 'fr' }).ok, false);
  assert.equal(pass.validate({ ...full, dives: -1 }).ok, false);
  assert.equal(pass.validate({ ...full, certs: [...full.certs, full.certs[0]] }).ok, false);
  assert.equal(pass.validate({ ...full, medical: { ...full.medical, answers: ['no'] } }).ok, false);
});

test('見せる中身を文字にして戻すと同じ（全部の項目）', async () => {
  for (const p of [full, small, partial]) {
    const share = pass.toShare(p, ALL);
    assert.deepEqual(pass.validateShare(share), { ok: true, errors: [] });
    const back = await codec.decode(await codec.encode(share));
    assert.deepEqual(back, share);
  }
});

test('健康は答えた日と「はい」の番号と未回答の数だけ', () => {
  assert.deepEqual(pass.toShare(full).med, { form: pass.FORM, at: '2026-10-20', yes: [1, 3], open: 0 });
  assert.deepEqual(pass.toShare(partial).med, { form: pass.FORM, at: '2025-08-01', yes: [], open: 2 });
});

test('選ばなかった項目は入らない', () => {
  const s = pass.toShare(full, NONE);
  assert.equal(s.med, null);
  assert.equal(s.ins, null);
  assert.equal(s.sizes, null);
  assert.equal(s.flight, null);
  assert.ok(s.certs.every(c => c.no === ''));
  assert.equal(pass.toShare(full).ins.no, '');
});

test(`QR 用の URL は ${URL_LIMIT} 文字以下`, async () => {
  const url = codec.passUrl(await codec.encode(pass.toShare(full, ALL)), BASE);
  assert.ok(url.length <= URL_LIMIT, `URL が ${url.length} 文字`);
  assert.equal(codec.codeFromHash(new URL(url).hash), url.split('#p=')[1]);
});

test('壊れた文字は例外になり、版の違う中身は検査で弾ける', async () => {
  await assert.rejects(codec.decode('zzz!!'));
  await assert.rejects(codec.decode(''));
  await assert.rejects(codec.decode('z' + 'A'.repeat(codec.MAX_CODE)));
  const other = await codec.decode(await codec.encode({ v: 2, k: 'share' }));
  assert.equal(pass.validateShare(other).ok, false);
  assert.equal(codec.codeFromHash('#p=abc<script>'), null);
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
