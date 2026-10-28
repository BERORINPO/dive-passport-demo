/* 見本の画面と本物の画面を、店員もお客さんも取り違えないようにする。
   見本（GitHub Pages。index.html に redux-worker の印が無い）: 画面の一番上に消せない帯、題に「（見本）」。
   本物（Worker 版。印がある）: 帯も「（見本）」も無く、上の帯には本物のお店の名前を出す（見本のお店の名前は出さない）。
   帯は index.html に直に書いてあり（JS が動かなくても見本には出る）、Worker 版を作るとき tools/build-site.mjs が外す。ここはその二重の守り。 */
(() => {
  'use strict';

  const R = window.REDUX;
  const BAND_ID = 'demoBand';
  const TITLE_MARK = '（見本）';
  const TEXT = {
    ja: '見本の画面です。入れた内容はこの端末の中だけに残り、お店には届きません。',
    en: 'This is a sample screen. What you enter stays on this device only and does not reach the shop.'
  };

  /* 題の「（見本）」を、見本の画面なら付け、本物なら外す（付け直しても 2 つにならない） */
  const titleFor = (title, demo) => {
    const base = String(title).split(TITLE_MARK).join('').trim();
    return demo ? `${base}${TITLE_MARK}` : base;
  };

  /* 上の帯の名前。worker: Worker 版か、staff: 店員の画面か。見本の名簿のお店の名前（sample）は、Worker 版では出さない。
     代わりにサーバーが決めたお店の id を出す（default は名前ではないので出さない）。お店の画面は「REDUX」の横に小さく、お客さんの画面は名前だけ */
  const brand = ({ worker, staff, shopName, sample, shopId }) => {
    const unreal = worker && (!shopName || shopName === sample);
    const label = unreal ? (shopId && shopId !== 'default' ? shopId : '') : shopName;
    return staff ? { name: 'REDUX', sub: label } : { name: label || 'REDUX', sub: '' };
  };

  /* 画面に付ける。見本なら帯を出して題に印を付け、本物なら帯を外す。見本の画面かどうかを返す */
  function mount(doc, win) {
    const demo = !R.isWorkerBuild();
    const band = doc.getElementById(BAND_ID);
    doc.title = titleFor(doc.title, demo);
    if (!band) return demo;
    if (!demo) { band.remove(); return demo; }
    const paint = () => { band.textContent = R.L(TEXT); };
    /* 帯は画面の上に貼り付く。その下に貼り付く上の帯（css/app.css の .bar）が重ならないよう、帯の高さを CSS に渡す */
    const measure = () => doc.documentElement.style.setProperty('--band-h', `${band.offsetHeight || 0}px`);
    paint();
    measure();
    R.onLang(() => { paint(); measure(); });
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(measure).observe(band);
    return demo;
  }

  R.demoBand = { TEXT, titleFor, brand, mount };
})();
