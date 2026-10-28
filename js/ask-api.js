/* お客さんのリンクの画面（ask.html）と店頭の QR の画面（walkin.html）から、同じ場所の Worker の /api/ask と /api/walkin だけを呼ぶ（adapter）。お店の名簿の道（/api/roster）は読まない。
   鍵は本文で送る（path に入れると、記録・Referer・履歴に残る）。決まりは plan/meibo.md「お客さんのリンク」、Worker 側は worker/ask-route.mjs */
(() => {
  'use strict';

  const R = window.REDUX;
  const TIMEOUT_MS = 15000;

  /* { status, data }。届かない・時間切れは status 0 */
  const ask = (body) => post('/api/ask', body);

  async function post(path, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method: 'POST', credentials: 'omit', redirect: 'manual', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    } catch (e) {
      return { status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  /* 店頭の QR（walkin.html）は同じ場所の /api/walkin だけ。{ status, data } */
  const walkin = (body) => post('/api/walkin', body);

  R.askApi = { ask, walkin };
})();
