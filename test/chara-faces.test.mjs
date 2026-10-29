// 案内役の場面ごとの表情（決定ログ 2026-10-29 chara-faces）。
// 守ること: 5 枚は 40 KB 以下の PNG で、左右を返さない（返すのは元の chara.png だけ）。手順の行は進み中は「考え中」、終われば呼ぶ側が決めた表情。
// 表情を替えるときだけフェードの印を付ける。お客さまの画面と試し版は、元の chara.png を使わない。
// 実行: node test/chara-faces.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import vm from 'node:vm';

class FNode {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.className = ''; this.own = ''; this.listeners = {};
    const set = new Set(); this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  append(...k) { this.children.push(...k); }
  replaceChildren(...k) { this.children = k; }
  get firstChild() { return this.children[0] || null; }
  get offsetWidth() { return 0; }
  set textContent(v) { this.children = []; this.own = String(v); }
  get textContent() { return this.own + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }
}
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
function boot() {
  const document = { body: new FNode('body'), documentElement: new FNode('html'), createElement: (t) => new FNode(t), getElementById: () => new FNode('div'), querySelector: () => null };
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://x.test', pathname: '/', hash: '' }, navigator: { language: 'ja' },
    localStorage: memory(), sessionStorage: memory(), setTimeout: (fn) => { fn(); return 0; }, clearTimeout() {}, setInterval: () => 0, console, URL });
  ctx.window = ctx;
  ctx.matchMedia = () => ({ matches: false });
  ['core.js', 'guest-steps.js'].forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  return ctx.REDUX;
}
const img = (node) => node.children.find(c => c.tagName === 'IMG');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('絵: 5 枚とも assets にあり、40 KB 以下の PNG', () => {
  const R = boot();
  assert.deepEqual(Object.keys(R.CHARA), ['hello', 'thinking', 'answer', 'sorry', 'done']);
  for (const src of Object.values(R.CHARA)) {
    const file = new URL(`../${src}`, import.meta.url);
    assert.ok(statSync(file).size <= 40 * 1024, `${src} が重い`);
    assert.deepEqual([...readFileSync(file).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `${src} は PNG`);
  }
});

test('手順の行: 進み中は考え中。終われば渡した表情（無ければ答えた）。into は考え中で始まり face で替わり、替わるときだけフェードの印', () => {
  const R = boot();
  const S = R.guestSteps;
  assert.equal(img(S.view([{ kind: 'doing', text: 'a' }], 'done')).getAttribute('src'), R.CHARA.thinking);
  assert.equal(img(S.view([{ kind: 'done', text: 'a' }], 'done')).getAttribute('src'), R.CHARA.done);
  assert.equal(img(S.view([{ kind: 'done', text: 'a' }])).getAttribute('src'), R.CHARA.answer);
  const host = new FNode('div');
  const steps = S.into(host);
  const face = img(host.children[0]);
  assert.equal(face.getAttribute('src'), R.CHARA.thinking);
  assert.ok(!face.classList.contains('face-in'));
  steps.face('sorry');
  assert.equal(face.getAttribute('src'), R.CHARA.sorry);
  assert.ok(face.classList.contains('face-in'));
  assert.equal(face.getAttribute('alt'), '', '飾りの絵なので alt は空');
});

test('向きと使う所: 左右を返すのは元の chara.png だけ。画面の部品は元の chara.png を使わない。フェードは「動きを減らす」で止める', () => {
  const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.faq__chara\[src\$="\/chara\.png"\], \.faq__mark\[src\$="\/chara\.png"\], \.gsteps__chara\[src\$="\/chara\.png"\] \{ transform: scaleX\(-1\); \}/);
  assert.ok(!/^\.faq__chara, \.faq__mark, \.gsteps__chara \{ transform/m.test(css), '5 枚には返しをかけない');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.face-in \{ animation: none; \} \}/);
  for (const f of ['chat.js', 'intake.js', 'guest-steps.js', 'trial-page.js']) {
    assert.ok(!readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8').includes("'assets/chara.png'"), `${f} は表情の絵を使う`);
  }
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
