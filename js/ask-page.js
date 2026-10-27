/* お客さんのリンクの画面（ask.html）の起動（entry）。URL の # の後ろの鍵で、聞く項目を /api/ask から受け取り、js/guest-ask.js の欄で答えてもらう。
   鍵は # の後ろだけに置き（サーバーの記録・Referer・履歴に残さない）、/api/ask へは本文で送る。聞く項目と答えの検査は Worker が持つ。
   計画は plan/meibo.md「お客さんのリンク」 */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('ask');
  const T = {
    sub: { ja: '名簿のお願い', en: 'Participant details' },
    loading: { ja: '読み込んでいます…', en: 'Loading…' },
    gone: { ja: 'このリンクは使えません。お店に聞いてください。', en: 'This link does not work. Please ask the shop.' },
    offline: { ja: 'つながりませんでした。電波を確かめて、開き直してください。', en: 'Could not connect. Check your connection and open the link again.' },
    limit: { ja: '今日はこのリンクを開ける回数を超えました。明日また開くか、お店に聞いてください。', en: 'This link has been opened too many times today. Try again tomorrow or ask the shop.' }
  };

  const m = /^#k=([A-Za-z0-9_-]{43})$/.exec(location.hash);
  const key = m ? m[1] : '';
  let view = null;
  let failed = null;

  const post = (body) => R.askApi.ask({ k: key, ...body });
  const isView = (v) => !!v && typeof v === 'object' && !!v.trip && Array.isArray(v.people);
  /* 送った答え。Worker が数えた問題（200）か、届かない・使えないの印 */
  function problemsOf(r) {
    if (r.status === 200 && r.data && Array.isArray(r.data.problems)) {
      if (isView(r.data.view)) view = r.data.view;
      return r.data.problems;
    }
    return [r.status === 0 ? 'network' : r.status === 404 ? 'gone' : 'save'];
  }

  const source = {
    view: () => view,
    send: async (personId, input) => ({ problems: problemsOf(await post({ action: 'send', personId, input })) }),
    today: async (personId, answer, consent) => ({ problems: problemsOf(await post({ action: 'today', personId, answer, consent: consent === true })) }),
    async personLink(personId) {
      const r = await post({ action: 'person-link', personId });
      const url = r.status === 200 && r.data && typeof r.data.url === 'string' ? r.data.url : '';
      return url.startsWith(`${location.origin}/ask#k=`) ? { url } : { why: r.status === 0 ? 'network' : 'gone' };
    }
  };

  function frame() {
    document.getElementById('brandSub').textContent = L(T.sub);
    document.getElementById('lang').textContent = L(R.T.langBtn);
    document.documentElement.lang = R.lang;
    if (failed) R.fill(root, el('p', { class: 'empty', text: L(failed) }));
  }

  async function start() {
    if (!key) { failed = T.gone; frame(); return; }
    R.fill(root, el('p', { class: 'note', text: L(T.loading) }));
    const r = await post({ action: 'view' });
    if (r.status !== 200 || !isView(r.data)) {
      failed = r.status === 0 ? T.offline : r.status === 429 ? T.limit : T.gone;
      frame();
      return;
    }
    view = r.data;
    R.guestAsk.remote(source);
  }

  document.getElementById('lang').addEventListener('click', () => R.setLang(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(frame);
  R.lang = (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  frame();
  /* 開いたまま別のリンクを開いたとき（# だけが変わってページは読み直されない） */
  window.addEventListener('hashchange', () => location.reload());
  start();
})();
