/* 画面の切り替え（お客さま / パスポート / お店 / 予約）と言語の切り替え */
(() => {
  'use strict';

  const R = window.REDUX;
  const ORDER = ['guest', 'pass', 'shop', 'booking'];
  const tabs = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`tab-${k}`)]));
  const views = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`view-${k}`)]));
  const renderers = { pass: () => R.renderPassport(), shop: () => R.renderShop(), booking: () => R.renderBooking() };

  R.showTab = (name) => {
    document.body.classList.remove('print-roster');   // 名簿の紙を出したまま別の画面に移っても、印刷が白紙にならないように（予約の画面に戻れば付け直す）
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

  function relabel() {
    const { L, T, TP } = R;
    document.getElementById('brandSub').textContent = L(T.brandSub);
    document.getElementById('demoNote').textContent = L(R.aiReader.mode() === 'real' ? T.demoNoteReal : T.demoNote);
    document.getElementById('lang').textContent = L(T.langBtn);
    tabs.guest.textContent = L(T.tabGuest);
    tabs.pass.textContent = L(TP.tab);
    tabs.shop.textContent = L(T.tabShop);
    tabs.booking.textContent = L(T.tabBooking);
    R.renderChat();
    R.renderIntake();
    if (!views.pass.hidden) R.renderPassport();
  }

  document.getElementById('logo').innerHTML = R.TURTLE; // arch-allow: 固定の SVG
  document.getElementById('lang').addEventListener('click', () => R.setLang(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(relabel);
  relabel();
  /* 本物の AI は、Worker 版で /api/healthz が通ったときだけ選べる。上の注意書きも、送るかどうかに合わせる */
  R.aiReader.onChange(() => { document.getElementById('demoNote').textContent = R.L(R.aiReader.mode() === 'real' ? R.T.demoNoteReal : R.T.demoNote); });
  R.aiReader.probe();
})();
