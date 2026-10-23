// 写真の塗りつぶし（js/photo-mask.js）を確かめる。送る写真に健康の欄が 1 画素も残らないこと。
// canvas は Node に無いので、画面が canvas から受け取るのと同じ画素の並び（RGBA）で確かめる。
// 実行: node test/photo-mask.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../js/photo-mask.js', import.meta.url), 'utf8'));
const M = globalThis.REDUX.photoMask;

/* 白い紙に、健康の欄の場所だけ「字」（灰色）を書いた見本の画素 */
function page(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const box = { x0: Math.round(60 / 1240 * width), y0: Math.round(1150 / 1754 * height), x1: Math.round(1180 / 1240 * width), y1: Math.round(1560 / 1754 * height) };
  for (let y = box.y0; y < box.y1; y += 1) {
    for (let x = box.x0; x < box.x1; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 90; data[i + 1] = 90; data[i + 2] = 90;
    }
  }
  return { data, box };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('見本の申込書の大きさがどれでも、健康の欄の字は 1 画素も残らない', () => {
  for (const [w, h] of [[1240, 1754], [1131, 1600], [620, 877], [999, 1413], [300, 424]]) {
    const { data, box } = page(w, h);
    const out = M.maskRGBA(data, w, h, [M.SAMPLE_FORM_HEALTH]);
    for (let y = box.y0; y < box.y1; y += 1) {
      for (let x = box.x0; x < box.x1; x += 1) {
        const i = (y * w + x) * 4;
        assert.deepEqual([out[i], out[i + 1], out[i + 2]], [0, 0, 0], `${w}x${h} の (${x},${y})`);
      }
    }
    assert.ok(M.covered(out, w, h, M.SAMPLE_FORM_HEALTH));
  }
});

test('見本の四角は、上の欄（身長などの行、約 845）を隠さず、斜めに撮った見本 f3 の健康の欄の頭（約 0.58）まで届く', () => {
  const r = M.SAMPLE_FORM_HEALTH;
  assert.ok(r.y0 * 1754 > 845 + 40, `上の欄に近すぎる (${Math.round(r.y0 * 1754)})`);
  assert.ok(r.y0 < 0.575, `f3 の健康の欄の頭に届かない (${r.y0.toFixed(3)})`);
  assert.ok(r.y1 * 1754 >= 1560 && r.y1 < 0.92, '下は健康の欄の下まで。署名（約 0.92）は隠さない');
});

test('塗るのは四角の中だけ。受け取った画素は変えない', () => {
  const w = 200; const h = 100;
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  const rect = { x0: 0.25, y0: 0.5, x1: 0.5, y1: 1 };
  const out = M.maskRGBA(data, w, h, [rect]);
  let black = 0;
  for (let i = 0; i < out.length; i += 4) if (out[i] === 0) black += 1;
  assert.equal(black, 50 * 50);
  assert.ok(data.every(v => v === 255), '元の画素はそのまま');
  assert.equal(M.covered(data, w, h, rect), false);
});

test('割合を画素に直すときは外側へ丸める（元の範囲を必ず含む）', () => {
  const p = M.toPixels({ x0: 0.101, y0: 0.2, x1: 0.399, y1: 0.7001 }, 1000, 1000);
  assert.deepEqual(p, { x0: 101, y0: 200, x1: 399, y1: 701 });
  assert.deepEqual(M.toPixels({ x0: -1, y0: 0, x1: 2, y1: 1 }, 10, 10), { x0: 0, y0: 0, x1: 10, y1: 10 });
  assert.throws(() => M.toPixels({ x0: 'a' }, 10, 10), /形が合わない/);
});

test('なぞった 2 点から四角を作る。小さすぎる四角は使わない', () => {
  assert.deepEqual(M.rectFrom({ x: 0.8, y: 0.9 }, { x: 0.1, y: -0.2 }), { x0: 0.1, y0: 0, x1: 0.8, y1: 0.9 });
  assert.equal(M.usable({ x0: 0.1, y0: 0.1, x1: 0.12, y1: 0.5 }), false);
  assert.equal(M.usable(M.SAMPLE_FORM_HEALTH), true);
});

test('写真の外の四角は使わない。写真にした後は、縁を除いて四角の中が暗いかで確かめる', () => {
  assert.equal(M.usable({ x0: 1.2, y0: 0.1, x1: 1.5, y1: 0.5 }), false, '写真の外');
  assert.equal(M.usable({ x0: 0.97, y0: 0.1, x1: 1.5, y1: 0.5 }), false, '写真の中に残るのが細すぎる');
  const w = 100; const h = 100;
  const rect = { x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.6 };
  const jpegish = M.maskRGBA(new Uint8ClampedArray(w * h * 4).fill(255), w, h, [rect]);
  const p = M.toPixels(rect, w, h);
  jpegish[(p.y0 * w + p.x0) * 4] = 120;               // 縁のにじみは見ない
  jpegish[((p.y0 + 5) * w + p.x0 + 5) * 4] = 30;       // JPEG の小さな揺れは許す
  assert.equal(M.darkInside(jpegish, w, h, rect), true);
  jpegish[((p.y0 + 8) * w + p.x0 + 8) * 4] = 120;     // 赤のにじみ（明るさは 36）は許す
  assert.equal(M.darkInside(jpegish, w, h, rect), true);
  jpegish[((p.y0 + 10) * w + p.x0 + 10) * 4 + 1] = 200;   // 中に明るい画素があれば塗れていない
  assert.equal(M.darkInside(jpegish, w, h, rect), false);
});

test('暗い写真を塗らずに出しても、塗ったとはみなさない（平均で見分ける）', () => {
  const w = 60; const h = 60;
  const dim = new Uint8ClampedArray(w * h * 4).fill(40);   // 紙が明るさ 40 の暗い写真
  for (let i = 0; i < dim.length; i += 4 * 7) { dim[i] = 5; dim[i + 1] = 5; dim[i + 2] = 5; }   // 字
  const rect = { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 };
  assert.equal(M.darkInside(dim, w, h, rect), false);
  assert.equal(M.darkInside(M.maskRGBA(dim, w, h, [rect]), w, h, rect), true);
});

test('大きい写真は長い辺を 1600 まで縮め、小さい写真は大きくしない', () => {
  assert.deepEqual(M.fitSize(3024, 4032), { width: 1200, height: 1600 });
  assert.deepEqual(M.fitSize(856, 540), { width: 856, height: 540 });
  assert.throws(() => M.maskRGBA(new Uint8ClampedArray(4), 2, 2, []), /画素の数/);
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
