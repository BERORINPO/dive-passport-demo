/* 写真の塗りつぶし（純ロジック）。画面の canvas から受け取った画素（RGBA の並び）を、決まった四角で黒く塗った写しを返す。
   四角は写真の幅と高さに対する割合（0〜1）で持つ（写真の大きさに左右されない）。
   画素に直すときは外側へ丸める（塗り残しを 1 画素も作らない）。
   見本の申込書（自分たちの見本の書式）の健康の欄の位置もここに置く。お店ごとの書式は、まだ作っていない */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  /* 見本の申込書の健康の欄（紙の 1240 × 1754 の中の 60,1150 〜 1180,1560。tools/make-photo-samples.py の元の書式） */
  const SAMPLE_FORM_HEALTH = Object.freeze({ x0: 60 / 1240, y0: 1150 / 1754, x1: 1180 / 1240, y1: 1560 / 1754 });
  const MAX_SIDE = 1600;   // 送る写真の長い辺（これより大きい写真は縮める）

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const isRect = (r) => r && [r.x0, r.y0, r.x1, r.y1].every(v => typeof v === 'number' && Number.isFinite(v));

  /* 2 点から四角を作る（ドラッグの向きは問わない）。割合は 0〜1 に収める */
  function rectFrom(a, b) {
    return { x0: clamp01(Math.min(a.x, b.x)), y0: clamp01(Math.min(a.y, b.y)), x1: clamp01(Math.max(a.x, b.x)), y1: clamp01(Math.max(a.y, b.y)) };
  }

  /* 割合の四角を画素の四角に直す。外側へ丸めるので、元の範囲を必ず含む */
  function toPixels(rect, width, height) {
    if (!isRect(rect)) throw new Error('photo-mask: 四角の形が合わない');
    return {
      x0: Math.max(0, Math.floor(clamp01(rect.x0) * width)), y0: Math.max(0, Math.floor(clamp01(rect.y0) * height)),
      x1: Math.min(width, Math.ceil(clamp01(rect.x1) * width)), y1: Math.min(height, Math.ceil(clamp01(rect.y1) * height))
    };
  }

  /* 写真を縮める大きさ（長い辺を MAX_SIDE まで。大きくはしない） */
  function fitSize(width, height, maxSide = MAX_SIDE) {
    const scale = Math.min(1, maxSide / Math.max(width, height));
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  }

  /* 四角を黒く塗った写しを返す（受け取った画素は変えない） */
  function maskRGBA(data, width, height, rects) {
    if (data.length !== width * height * 4) throw new Error('photo-mask: 画素の数が合わない');
    const out = new Uint8ClampedArray(data);
    rects.forEach(rect => {
      const p = toPixels(rect, width, height);
      for (let y = p.y0; y < p.y1; y += 1) {
        for (let x = p.x0; x < p.x1; x += 1) {
          const i = (y * width + x) * 4;
          out[i] = 0;
          out[i + 1] = 0;
          out[i + 2] = 0;
          out[i + 3] = 255;
        }
      }
    });
    return out;
  }

  /* 四角の中が全部黒か（塗ったあと、写真にする前に確かめる） */
  function covered(data, width, height, rect) {
    const p = toPixels(rect, width, height);
    for (let y = p.y0; y < p.y1; y += 1) {
      for (let x = p.x0; x < p.x1; x += 1) {
        const i = (y * width + x) * 4;
        if (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0) return false;
      }
    }
    return true;
  }

  /* 塗る四角として使えるか（小さすぎる四角は、押しまちがいとみなす） */
  const usable = (rect) => isRect(rect) && rect.x1 - rect.x0 >= 0.05 && rect.y1 - rect.y0 >= 0.03;

  R.photoMask = { SAMPLE_FORM_HEALTH, MAX_SIDE, rectFrom, toPixels, fitSize, maskRGBA, covered, usable };
})();
