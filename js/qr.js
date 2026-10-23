/* QR を描く（外とのつなぎ）。中の計算は qrcode-generator 1.4.4（MIT、cdnjs から読む）に任せ、
   絵は黒と白の SVG で自分で描く（画面が暗い設定でも読めるように、背景は必ず白） */
(() => {
  'use strict';

  const R = window.REDUX;
  const MARGIN = 4;

  /* 描けたら SVG の要素、部品が読めていない・入りきらないときは null */
  R.qrSvg = (text) => {
    if (typeof window.qrcode !== 'function') return null;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      const size = n + MARGIN * 2;
      let d = '';
      for (let r = 0; r < n; r += 1) {
        for (let c = 0; c < n; c += 1) {
          if (qr.isDark(r, c)) d += `M${c + MARGIN} ${r + MARGIN}h1v1h-1z`;
        }
      }
      const box = document.createElement('div');
      box.className = 'qr__img';
      box.innerHTML = `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` + // arch-allow: 数字だけで作った SVG
        `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
      return box;
    } catch (e) {
      // 文字が多すぎて QR に入らないとき。呼ぶ側が URL の文字を代わりに出す
      return null;
    }
  };
})();
