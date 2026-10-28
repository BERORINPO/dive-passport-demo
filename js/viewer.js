/* 見るだけの画面: QR の URL の # の後ろからパスポートの中身を読み、読み取り専用で見せる。
   読んだらすぐ URL から中身を消す（お店のスマホの履歴に残さない）。どこにも送らない */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('viewer');

  let share = null;
  let status = 'empty';   // 'ok' | 'bad' | 'empty'

  async function read() {
    const hash = window.location.hash;
    const code = R.codec.codeFromHash(hash);
    if (hash) window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!code) { status = hash ? 'bad' : 'empty'; return; }
    try {
      const data = await R.codec.decode(code);
      if (R.pass.validateShare(data).ok) {
        share = data;
        status = 'ok';
      } else {
        status = 'bad';
      }
    } catch (e) {
      // 壊れた QR や、途中で切れた URL
      status = 'bad';
    }
  }

  function render() {
    const tp = R.TP;
    document.getElementById('brandSub').textContent = L(tp.viewerTitle);
    document.getElementById('lang').textContent = L(R.T.langBtn);
    if (status !== 'ok') {
      root.replaceChildren(el('div', { class: 'card' },
        el('p', { class: 'lead', text: L(status === 'bad' ? tp.viewerBad : tp.viewerEmpty) })));
      return;
    }
    root.replaceChildren(
      el('div', { class: 'card' },
        el('h1', { class: 'h2', text: L(tp.viewerTitle) }),
        R.rowsList(R.shareRows(share)),
        el('p', { class: 'note', text: L(tp.selfDeclared) }),
        el('p', { class: 'note', text: L(tp.viewerNote) })),
      el('div', { class: 'card card--cta' },
        el('p', { class: 'cta__text', text: L(tp.viewerCta) }),
        el('a', { class: 'btn btn--ghost btn--small', href: 'index.html', text: L(tp.viewerCtaLink) })));
  }

  document.getElementById('lang').addEventListener('click', () => R.setLang(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(render);
  R.lang = (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  document.documentElement.lang = R.lang;
  read().then(render);
  // 開いたままの画面で別の QR を読んだとき（# だけが変わってページは読み直されない）
  window.addEventListener('hashchange', () => {
    if (window.location.hash) { share = null; read().then(render); }
  });
})();
