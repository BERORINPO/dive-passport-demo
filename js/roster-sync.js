/* お店の名簿をサーバー（同じ場所の Worker の /api/roster）とやりとりする（adapter）。決まりは plan/server.md。
   ここは送ると受けるだけ。版の番号・当て直し・電波が無いときの貯め方は js/core.js の rosterStore が持つ。
   受け取った名簿は画面でも形を確かめてから渡す（通信の途中で壊れた物を名簿にしない）。
   GitHub Pages や手元の http.server には /api/roster が無いので、pull が ok: false を返し、端末だけで続ける */
(() => {
  'use strict';

  const R = window.REDUX;
  const URL_PATH = '/api/roster';
  const TIMEOUT_MS = 10000;

  async function call(method, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(URL_PATH, {
        method, credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: ctl.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { status: res.status, data };
    } catch (e) {
      return { status: 0, data: null };   // 電波が無い・時間切れ
    } finally {
      clearTimeout(timer);
    }
  }

  /* 版と名簿の組。名簿は null（まだ無い）か、形の検査に通る物だけ */
  function shapeOf(data) {
    if (!data || !Number.isInteger(data.version) || data.version < 0) return null;
    if (data.state === null) return data.version === 0 ? { version: 0, state: null } : null;
    return data.state && typeof data.state === 'object' && R.roster.validateState(data.state).ok ? { version: data.version, state: data.state } : null;
  }

  R.rosterSync = {
    /* { ok: true, version, state } か { ok: false, why } */
    async pull() {
      const r = await call('GET');
      const got = r.status === 200 ? shapeOf(r.data) : null;
      return got ? { ok: true, ...got } : { ok: false, why: r.status || 'network' };
    },
    /* { ok: true, version, state }（書けた。state はサーバーが直した後）/ { conflict: true, version, state }（先に別の端末が書いた）/ { ok: false, why } */
    async push(base, state) {
      const r = await call('PUT', { base, state });
      const got = (r.status === 200 || r.status === 409) ? shapeOf(r.data) : null;
      if (got && r.status === 200 && got.state) return { ok: true, ...got };
      if (got && r.status === 409) return { conflict: true, ...got };
      return { ok: false, why: r.status || 'network' };
    }
  };
})();
