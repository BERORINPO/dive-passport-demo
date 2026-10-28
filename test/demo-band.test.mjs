// 見本の画面と本物の画面の取り違えを防ぐ決まり（js/demo-band.js・js/core.js・tools/build-site.mjs・index.html）を確かめる。
// 見本の帯は redux-worker の印が無い画面（GitHub Pages）だけ。本物（Worker 版）には帯も「（見本）」も見本のお店の名前も見本の受付も出ない。
// DOM を持たず、作り物の document と、本物の js を vm で読んで確かめる。色の比は test/design.check.mjs。
// 実行: node test/demo-band.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { workerIndex } from '../tools/build-site.mjs';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const SENTENCE = '見本の画面です。入れた内容はこの端末の中だけに残り、お店には届きません。';

/* vm の中で作った物は prototype が違うので、deepEqual の前に普通の物に写す */
const plain = (x) => JSON.parse(JSON.stringify(x));
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

/* worker: redux-worker の印があるか。band: index.html に帯があるか。title: 題 */
function boot({ worker, band = true, title = 'REDUX 受付 試作（見本）', storage = memory() }) {
  const bandNode = { id: 'demoBand', textContent: SENTENCE, removed: false, offsetHeight: 52, remove() { this.removed = true; } };
  const styles = {};
  const document = {
    title, documentElement: { style: { setProperty: (k, v) => { styles[k] = v; } } },
    getElementById: (id) => (id === 'demoBand' && band ? bandNode : null),
    querySelector: (sel) => (worker && sel === 'meta[name="redux-worker"]' ? {} : null)
  };
  const ctx = vm.createContext({ document, localStorage: storage, setTimeout, clearTimeout, console, Node: class {} });
  ctx.window = ctx;
  ['core.js', 'data.js', 'demo-band.js'].forEach(f => vm.runInContext(read(`js/${f}`), ctx, { filename: f }));
  return { R: ctx.REDUX, document, bandNode, styles, ctx };
}

test('見本（印なし）: 帯を残して文を出し、題に（見本）が付き、上の帯の位置に高さを渡す', () => {
  const { R, document, bandNode, styles, ctx } = boot({ worker: false });
  assert.equal(R.demoBand.mount(document, ctx), true);
  assert.equal(bandNode.removed, false);
  assert.equal(bandNode.textContent, SENTENCE);
  assert.equal(document.title, 'REDUX 受付 試作（見本）');
  assert.equal(styles['--band-h'], '52px');
});

test('見本: 英語にすると帯も英語に変わる（消えず、日本語のまま残らない）', () => {
  const { R, document, bandNode, ctx } = boot({ worker: false });
  R.demoBand.mount(document, ctx);
  R.setLang('en');
  assert.match(bandNode.textContent, /^This is a sample screen\./);
  R.setLang('ja');
  assert.equal(bandNode.textContent, SENTENCE);
});

test('本物（印あり）: 帯を外し、題から（見本）を外す。帯は作らず、高さも渡さない', () => {
  const { R, document, bandNode, styles, ctx } = boot({ worker: true });
  assert.equal(R.demoBand.mount(document, ctx), false);
  assert.equal(bandNode.removed, true);
  assert.equal(document.title, 'REDUX 受付 試作');
  assert.deepEqual(plain(styles), {});
});

test('本物: 帯が無くても（build-site が外した後）題だけ直して止まらない。見本: 帯が無くても題には印を付ける', () => {
  const real = boot({ worker: true, band: false });
  assert.equal(real.R.demoBand.mount(real.document, real.ctx), false);
  assert.equal(real.document.title, 'REDUX 受付 試作');
  const demo = boot({ worker: false, band: false, title: 'REDUX 受付 試作' });
  assert.equal(demo.R.demoBand.mount(demo.document, demo.ctx), true);
  assert.equal(demo.document.title, 'REDUX 受付 試作（見本）');
});

test('titleFor: 何度かけても（見本）は 1 つ。本物では付かない', () => {
  const { R } = boot({ worker: false });
  const f = R.demoBand.titleFor;
  assert.equal(f('A', true), 'A（見本）');
  assert.equal(f('A（見本）', true), 'A（見本）');
  assert.equal(f('A（見本）', false), 'A');
});

test('index.html（見本の元）: 帯の文は決まりの 1 文、題に（見本）、redux-worker の印は無い', () => {
  const html = read('index.html');
  assert.ok(html.includes(`<p class="demo-band" id="demoBand" role="note">${SENTENCE}</p>`));
  assert.match(html, /<title>[^<]*（見本）<\/title>/);
  assert.ok(!html.includes('redux-worker'));
  assert.ok(html.indexOf('demoBand') < html.indexOf('<header'), '帯は画面の一番上（上の帯より前）');
  assert.ok(html.indexOf('js/demo-band.js') < html.indexOf('js/app.js'));
});

test('Worker 版の index.html（workerIndex）: 帯・題の（見本）・帯の注釈が無く、redux-worker の印がある', () => {
  const html = workerIndex(read('index.html'));
  assert.ok(html.includes('<meta name="redux-worker" content="1">'));
  assert.ok(!html.includes('demo-band"') && !html.includes('id="demoBand"') && !html.includes(SENTENCE) && !html.includes('見本の帯'));
  assert.match(html, /<title>REDUX 受付 試作<\/title>/);
  assert.ok(!/<title>[^<]*見本/.test(html));
});

test('workerIndex: 外す物の形が変わったら黙って通さず例外にする（帯が残ったまま本物に出るのを防ぐ）', () => {
  const html = read('index.html');
  assert.throws(() => workerIndex(html.replace('id="demoBand"', 'id="band"').replace(/<p class="demo-band"/, '<p class="x"')), /見本の帯/);
  assert.throws(() => workerIndex(html.replace('（見本）</title>', '</title>')), /見本の帯/);
});

test('上の帯の名前: 見本は見本のお店の名前、本物は見本のお店の名前を出さずサーバーのお店の id か REDUX', () => {
  const { R } = boot({ worker: false });
  const brand = R.demoBand.brand;
  const sample = R.SAMPLE_SHOP;
  assert.equal(sample, 'B マリン（見本）');
  assert.deepEqual(plain(brand({ worker: false, staff: false, shopName: sample, sample, shopId: null })), { name: sample, sub: '' });
  assert.deepEqual(plain(brand({ worker: false, staff: true, shopName: sample, sample, shopId: null })), { name: 'REDUX', sub: sample });
  assert.deepEqual(plain(brand({ worker: true, staff: false, shopName: 'AQUA GATE', sample, shopId: 'aqua' })), { name: 'AQUA GATE', sub: '' });
  assert.deepEqual(plain(brand({ worker: true, staff: true, shopName: 'AQUA GATE', sample, shopId: 'aqua' })), { name: 'REDUX', sub: 'AQUA GATE' });
  /* 本物でまだ名簿が来ていない・サーバーに名簿が無い間は、名簿の見本の名前を出さない */
  for (const staff of [true, false]) {
    const idShown = brand({ worker: true, staff, shopName: sample, sample, shopId: 'aqua' });
    assert.ok(!JSON.stringify(idShown).includes('見本'));
    assert.ok(JSON.stringify(idShown).includes('aqua'));
    assert.ok(!JSON.stringify(brand({ worker: true, staff, shopName: sample, sample, shopId: 'default' })).includes('見本'));
    assert.ok(!JSON.stringify(brand({ worker: true, staff, shopName: '', sample, shopId: null })).includes('見本'));
  }
  assert.deepEqual(plain(brand({ worker: true, staff: false, shopName: sample, sample, shopId: 'default' })), { name: 'REDUX', sub: '' });
});

test('受付の見本（seed）: 見本の画面には入り、本物には入らない。本物では、前に端末に残った見本も外す', () => {
  const demo = boot({ worker: false });
  assert.ok(demo.R.store.get().intakes.length >= 4 && demo.R.store.get().intakes.every(x => /^seed\d+$/.test(x.id)));
  const real = boot({ worker: true });
  assert.deepEqual(plain(real.R.store.get().intakes), []);
  /* 見本の画面で保存した端末の中身（見本の受付 + 本物の受付 1 件）を、本物の画面が読む */
  const storage = memory();
  const seeded = boot({ worker: false, storage });
  seeded.R.store.update(s => ({ ...s, intakes: [...s.intakes, { id: 'u1', name: '本物の予約', at: '2026-10-28T00:00:00.000Z', date: '2026-11-01', tour: 'dive', people: 1 }] }));
  const after = boot({ worker: true, storage });
  assert.deepEqual(plain(after.R.store.get().intakes.map(x => x.id)), ['u1']);
});

test('本物の画面の文: 「デモの画面」の札は「画面の切り替え」になり、デモ・見本の言葉を使わない', () => {
  const { R } = boot({ worker: true });
  for (const key of ['screenSwitch', 'aiLiveNote', 'sentReal']) {
    for (const lang of ['ja', 'en']) assert.ok(!/デモ|見本|[Dd]emo|[Ss]ample/.test(R.T[key][lang]), `${key}.${lang}`);
  }
  assert.equal(R.T.screenSwitch.ja, '画面の切り替え');
});

test('ask.html・walkin.html は帯も見本の題も持たない（お客さんのページは本物）', () => {
  for (const f of ['ask.html', 'walkin.html']) {
    const html = read(f);
    assert.ok(!/demo-band|（見本）/.test(html), f);
  }
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
