/* 画面の切り替え（お客さま / パスポート / お店）と言語の切り替え */
(() => {
  'use strict';

  const R = window.REDUX;
  const ORDER = ['guest', 'pass', 'shop'];
  const tabs = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`tab-${k}`)]));
  const views = Object.fromEntries(ORDER.map(k => [k, document.getElementById(`view-${k}`)]));
  const renderers = { pass: () => R.renderPassport(), shop: () => R.renderShop() };

  R.showTab = (name) => {
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
    document.getElementById('demoNote').textContent = L(T.demoNote);
    document.getElementById('lang').textContent = L(T.langBtn);
    tabs.guest.textContent = L(T.tabGuest);
    tabs.pass.textContent = L(TP.tab);
    tabs.shop.textContent = L(T.tabShop);
    R.renderChat();
    R.renderIntake();
    if (!views.pass.hidden) R.renderPassport();
  }

  document.getElementById('logo').innerHTML = R.TURTLE;
  document.getElementById('lang').addEventListener('click', () => R.setLang(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(relabel);
  relabel();
})();
