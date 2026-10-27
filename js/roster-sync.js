/* お店の名簿をサーバー（同じ場所の Worker の /api/roster）とやりとりする（adapter）。決まりは plan/server.md。
   ここは送ると受けるだけ。版の番号・当て直し・電波が無いときの貯め方は js/core.js の rosterStore が持つ。
   受け取った名簿は画面でも形を確かめてから渡す（通信の途中で壊れた物を名簿にしない）。
   GitHub Pages や手元の http.server には /api/roster が無いので、pull が ok: false を返し、端末だけで続ける */
(() => {
  'use strict';

  const R = window.REDUX;
  const URL_PATH = '/api/roster';
  const TIMEOUT_MS = 10000;

  async function call(method, body, path = URL_PATH) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(path, {
        method, credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: ctl.signal,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      /* Access のログインが切れると、ログインの画面への転送になる（redirect: 'manual' では中身の見えない答え）。電波なしと分けて知らせる */
      if (res.type === 'opaqueredirect') return { status: 'login', data: null };
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

  /* Worker が返したお客さんのリンクの形（置いた形では別の Worker の https、手元では localhost）。/ask と # の後ろの鍵だけ */
  function linkOk(u) {
    try {
      const x = new URL(u);
      return (x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname)))
        && x.pathname === '/ask' && !x.search && /^#k=[A-Za-z0-9_-]{43}$/.test(x.hash);
    } catch (e) {
      return false;
    }
  }

  R.rosterSync = {
    /* { ok: true, version, state } か { ok: false, why } */
    async pull() {
      const r = await call('GET');
      const got = r.status === 200 ? shapeOf(r.data) : null;
      return got ? { ok: true, ...got } : { ok: false, why: r.status || 'network' };
    },
    /* { ok: true, version, state }（書けた。state はサーバーが直した後）/ { conflict: true, version, state }（先に別の端末が書いた）/
       { shrink: true, version, state }（人が大きく消えるので、サーバーが断った）/ { ok: false, why }。
       why: 'login'（ログイン切れ）・400 / 413（サーバーが中身を断った。送り直しても通らない）・それ以外（届かない・サーバーの誤り） */
    async push(base, state, { allowShrink = false } = {}) {
      const r = await call('PUT', allowShrink ? { base, state, allowShrink: true } : { base, state });
      const got = (r.status === 200 || r.status === 409) ? shapeOf(r.data) : null;
      if (got && r.status === 200 && got.state) return { ok: true, ...got };
      if (got && r.status === 409) return r.data && r.data.error === 'shrink' ? { shrink: true, ...got } : { conflict: true, ...got };
      return { ok: false, why: r.status || 'network' };
    },
    /* 済んで 7 日を過ぎた便（読むだけ。同じ場所の /api/roster/past）。from・to は YYYY-MM-DD（93 日まで）。
       { ok: true, state, skipped, full }（state は済んだ便だけの名簿。skipped は形が合わずにサーバーが外した行の数、full は上限まで読んだ印）か { ok: false, why } */
    async past(from, to) {
      const r = await call('GET', undefined, `${URL_PATH}/past?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      const d = r.data;
      if (r.status === 200 && d && d.state && typeof d.state === 'object' && R.roster.validateState(d.state).ok && Number.isInteger(d.skipped)) {
        return { ok: true, state: d.state, skipped: d.skipped, full: d.full === true };
      }
      return { ok: false, why: r.status || 'network' };
    },
    /* お客さんに送るリンクを作る（同じ場所の /api/ask-link。Access の内）。作り直すと前のリンクは開けない。
       { ok: true, url, expiresOn } か { ok: false, why }（why 404 = サーバーにまだこの予約が無い） */
    async askLink(bookingId) {
      const r = await call('POST', { bookingId }, '/api/ask-link');
      const d = r.data;
      if (r.status === 200 && d && typeof d.url === 'string' && linkOk(d.url)) return { ok: true, url: d.url, expiresOn: String(d.expiresOn || '') };
      return { ok: false, why: r.status || 'network' };
    }
  };
})();
