/* 写真を AI に送れる形にする（外との境目のひとつ。canvas を使う）。
   どの写真も canvas に描き直してから送る（撮った場所などの情報が消える）。申込書は、健康の欄を黒く塗ってから送る。
   予約の一覧（乗り合いの他のお店が撮る）は、お店が黒く塗った所があれば塗ってから送る。
   塗れたかは 2 回確かめる: 写真にする前の画素と、写真（JPEG）にした後の画素。
   ここで作った物だけが、ai-reader.js で送れる（isPrepared） */
(() => {
  'use strict';

  const R = window.REDUX;
  const M = () => R.photoMask;
  const QUALITY = 0.85;
  const prepared = new WeakSet();

  /* 写真を読み込む。src はファイル（お店が撮った写真）か、見本の写真の場所 */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const url = typeof src === 'string' ? src : URL.createObjectURL(src);
      const img = new Image();
      img.onload = () => resolve({ img, done: () => { if (typeof src !== 'string') URL.revokeObjectURL(url); } });
      img.onerror = () => { if (typeof src !== 'string') URL.revokeObjectURL(url); reject(new Error('photo-prep: 写真を読めない')); };
      img.src = url;
    });
  }

  /* 写真にした後の画素を読み直す（img.decode() は終わらないブラウザがあるので、onload で待つ） */
  async function pixelsOf(dataUrl, width, height) {
    const img = await new Promise((resolve, reject) => {
      const x = new Image();
      x.onload = () => resolve(x);
      x.onerror = () => reject(new Error('photo-prep: 作った写真を読み直せない'));
      x.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }

  /* 描き直した写真に、四角（割合）を黒く塗り、送る形にする。sampleId は見本の読み取りだけが使う。
     area（お店の読む範囲）を渡した申込書は、その中だけを切り出して送る（塗る四角は要らない。外の健康の欄は写真に入らない） */
  async function prepare({ doc, src, rects, sampleId, area = null }) {
    if (!['paper', 'ccard', 'list'].includes(doc)) throw new Error(`photo-prep: 写真の種類が違う (${doc})`);
    const boxes = (rects || []).filter(M().usable);
    if (boxes.length !== (rects || []).length) throw new Error('photo-prep: 使えない四角がある（写真の外か、小さすぎる）');
    if (area && (doc !== 'paper' || boxes.length)) throw new Error('photo-prep: 切り出すのは申込書だけで、塗る四角とは一緒に使わない');
    if (doc === 'paper' && !boxes.length && !area) throw new Error('photo-prep: 申込書は健康の欄を塗るか、読む範囲を切り出してから送る');
    const { img, done } = await loadImage(src);
    try {
      const cut = area ? M().cropPixels(area, img.naturalWidth, img.naturalHeight) : { x0: 0, y0: 0, x1: img.naturalWidth, y1: img.naturalHeight };
      const { width, height } = M().fitSize(cut.x1 - cut.x0, cut.y1 - cut.y0);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, cut.x0, cut.y0, cut.x1 - cut.x0, cut.y1 - cut.y0, 0, 0, width, height);
      const masked = M().maskRGBA(ctx.getImageData(0, 0, width, height).data, width, height, boxes);
      ctx.putImageData(new ImageData(masked, width, height), 0, 0);
      const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
      const after = await pixelsOf(dataUrl, width, height);
      if (!boxes.every(b => M().darkInside(after, width, height, b))) throw new Error('photo-prep: 写真にした後、塗った所が暗くない');
      const req = Object.freeze({ doc, image: dataUrl.slice(dataUrl.indexOf(',') + 1), masked: boxes.length > 0 || !!area, ...(sampleId ? { sampleId } : {}) });
      prepared.add(req);
      return { req, dataUrl, width, height };
    } finally {
      done();
    }
  }

  R.photoPrep = { loadImage, prepare, isPrepared: (req) => prepared.has(req) };
})();
