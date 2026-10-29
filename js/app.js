/* 画面の切り替え（お客さま / パスポート / お店 / 予約）と言語の切り替え */
(() => {
  'use strict';

  const R = window.REDUX;
  const ORDER = ['guest', 'pass', 'shop', 'booking'];
  const tabs = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`tab-${k}`)]));
  const views = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`view-${k}`)]));
  const renderers = { pass: () => R.renderPassport(), shop: () => R.renderShop(), booking: () => R.renderBooking() };
  /* 店員画面（浜と船で使う）。暗い画面設定に合わせず、明るいまま（css/app.css と design.md の 2 層） */
  const STAFF = ['shop', 'booking'];

  /* 見本の画面なら帯と題の印を付け、本物（Worker 版）なら外す（js/demo-band.js）。上の帯の名前も、見本のお店か本物のお店かで分ける */
  R.demoBand.mount(document, window);
  const live = R.isWorkerBuild();
  /* 上の帯の名前: お客さんの画面はお店の名前、店員の画面は REDUX とお店の名前（design.md の形: お客さんの帯にタブを出さない）。
     本物のお店の名前はサーバーの名簿から来るので、名簿が変わるたびに描き直す */
  function paintBrand() {
    const { name, sub } = R.demoBand.brand({ worker: live, staff: document.documentElement.dataset.layer === 'staff', shopName: R.rosterStore.get().shop.name,
      sample: R.SAMPLE_SHOP, shopId: R.rosterStore.shopId() });
    document.getElementById('brandName').textContent = name;
    document.getElementById('brandSub').textContent = sub;
  }

  R.showTab = (name) => {
    document.body.classList.remove('print-roster');   // 名簿の紙を出したまま別の画面に移っても、印刷が白紙にならないように（予約の画面に戻れば付け直す）
    document.documentElement.dataset.layer = STAFF.includes(name) ? 'staff' : 'guest';
    /* お客さんに聞く画面の #ask= は、ほかの画面に移ったら外す（残すと、読み込み直したときにお客さんの画面へ戻る。小禄さんの不具合さがし 2026-10-27） */
    if (name !== 'guest' && location.hash.startsWith('#ask=')) history.replaceState(null, '', location.pathname + location.search);
    paintBrand();
    closeDemo();
    ORDER.forEach(k => {
      const on = k === name;
      tabs[k].setAttribute('aria-selected', String(on));
      tabs[k].tabIndex = on ? 0 : -1;
      views[k].hidden = !on;
    });
    if (renderers[name]) renderers[name]();
    window.scrollTo({ top: 0 });
  };

  ORDER.forEach((name, i) => {
    tabs[name].addEventListener('click', () => R.showTab(name));
    tabs[name].addEventListener('keydown', (e) => {
      const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      const next = ORDER[(i + step + ORDER.length) % ORDER.length];
      R.showTab(next);
      tabs[next].focus();
    });
  });

  /* 画面の切り替え（点線の札）。開くと 4 つの画面のタブと注意が出る。お客さんの画面にはタブを出さないので、4 つの画面を行き来する道はこの札だけ。
     本物の画面でもこの札で店員の画面へ移るので、本物では「デモの画面」とは呼ばない（名前だけ変える。js/data.js の screenSwitch） */
  const bar = document.querySelector('.bar');
  const demoSwitch = document.getElementById('demoSwitch');
  function closeDemo() { bar.classList.remove('is-open'); demoSwitch.setAttribute('aria-expanded', 'false'); }
  demoSwitch.addEventListener('click', () => {
    const open = !bar.classList.contains('is-open');
    bar.classList.toggle('is-open', open);
    demoSwitch.setAttribute('aria-expanded', String(open));
  });
  const markAi = () => { document.documentElement.dataset.ai = R.aiReader.mode(); };
  /* 札を開いたときの注意。見本は「デモです」、本物は「デモです」とは書かず、本物の AI に送るときだけ送る先を言う */
  const noteText = () => {
    const real = R.aiReader.mode() === 'real';
    return R.L(live ? (real ? R.T.aiLiveNote : '') : (real ? R.T.demoNoteReal : R.T.demoNote));
  };

  function relabel() {
    const { L, T, TP } = R;
    demoSwitch.textContent = L(live ? T.screenSwitch : T.demoSwitch);
    document.getElementById('demoNote').textContent = noteText();
    document.getElementById('lang').textContent = L(T.langBtn);
    tabs.guest.textContent = L(T.tabGuest);
    tabs.pass.textContent = L(TP.tab);
    tabs.shop.textContent = L(T.tabShop);
    tabs.booking.textContent = L(T.tabBooking);
    R.renderChat();
    R.renderIntake();
    if (!views.pass.hidden) R.renderPassport();
  }

  document.getElementById('lang').addEventListener('click', () => R.setLang(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(relabel);
  relabel();
  /* 最初の画面はお客さんの画面（showTab を通らないので、層とお店の名前をここで付ける） */
  if (!document.documentElement.dataset.layer) document.documentElement.dataset.layer = 'guest';
  paintBrand();
  R.rosterStore.subscribe(paintBrand);
  /* 本物の AI は、Worker 版で /api/healthz が通ったときだけ選べる。上の注意書きも、送るかどうかに合わせる */
  R.aiReader.onChange(() => { document.getElementById('demoNote').textContent = noteText(); markAi(); });
  markAi();
  /* /api/healthz を確かめるのは Worker 版だけ（置く物を作る tools/build-site.mjs が meta を足す）。
     GitHub Pages では berorinpo.github.io の一番上が同じ場所なので、そこへは聞かない（ザクのレビュー） */
  if (document.querySelector('meta[name="redux-worker"]')) {
    R.aiReader.probe();
    /* お店の名簿をサーバーとそろえる（plan/server.md）。D1 がまだ無い Worker では答えず、端末だけで続ける。
       つながらないときは、直しを端末に貯めながら試し直す（core.js。電波が戻った online でもすぐ試す）。
       画面に戻ってきたら、つながっていなければつなぎ直し、つながっていれば別の端末の直しを取り込む（refresh） */
    R.rosterStore.startSync();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') R.rosterStore.refresh(); });
    /* 開いたままの画面にも、届いた予約メールとお客さんの答えを 30 秒ごとに取り込む（見えている間だけ） */
    R.rosterStore.keepFresh(() => document.visibilityState === 'visible');
    /* 電波の無い所（船の上）でも、画面そのものを開けるようにする（sw.js。登録できなくても画面はそのまま動く） */
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
