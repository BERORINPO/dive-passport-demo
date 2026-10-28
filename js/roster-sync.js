/* お店の名簿をサーバー（同じ場所の Worker の /api/roster）とやりとりする（adapter）。決まりは plan/server.md。
   ここは送ると受けるだけ。版の番号・当て直し・電波が無いときの貯め方は js/core.js の rosterStore が持つ。
   受け取った名簿は画面でも形を確かめてから渡す（通信の途中で壊れた物を名簿にしない）。
   GitHub Pages や手元の http.server には /api/roster が無いので、pull が ok: false を返し、端末だけで続ける */
(() => {
  'use strict';

  const R = window.REDUX;
  const URL_PATH = '/api/roster';
  const TIMEOUT_MS = 10000;
  /* これより大きい名簿は gzip で縮めて送る（船の上の回線で、直し 1 回ごとに名簿まるごとを送るため。JSON は 1/5〜1/10 ほどになる。ジンのレビュー MEDIUM 10）。
     受け取る名簿は Cloudflare が縮めて返す。縮められないブラウザ（CompressionStream が無い）はそのまま送る */
  const GZIP_FROM = 8192;
  async function packed(text) {
    if (text.length < GZIP_FROM || typeof CompressionStream !== 'function' || typeof Blob !== 'function' || typeof Response !== 'function') return null;
    try { return await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer(); } catch (e) { return null; }
  }

  async function call(method, body, path = URL_PATH) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const text = body === undefined ? undefined : JSON.stringify(body);
      const gz = method === 'PUT' && text !== undefined ? await packed(text) : null;
      const res = await fetch(path, {
        method, credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: ctl.signal,
        headers: text === undefined ? {} : { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) },
        body: gz || text
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

  /* 版と名簿とお店の組。名簿は null（まだ無い）か、形の検査に通る物だけ。shop はサーバーが決めたお店の id（無ければ default） */
  function shapeOf(data) {
    if (!data || !Number.isInteger(data.version) || data.version < 0) return null;
    const shop = typeof data.shop === 'string' && data.shop ? data.shop : 'default';
    if (data.state === null) return data.version === 0 ? { version: 0, state: null, shop } : null;
    return data.state && typeof data.state === 'object' && R.roster.validateState(data.state).ok ? { version: data.version, state: data.state, shop } : null;
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

  /* 店頭の QR の鍵のリンク（お客さんの Worker の https、手元では localhost）。/walkin と # の後ろの鍵だけ */
  function walkinLinkOk(u) {
    try {
      const x = new URL(u);
      return (x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname)))
        && x.pathname === '/walkin' && !x.search && /^#w=[A-Za-z0-9_-]{43}$/.test(x.hash);
    } catch (e) {
      return false;
    }
  }

  /* 店頭で入れた人の 1 行（サーバーが名簿と同じ検査を通した物。通信の途中で壊れた物は画面に出さない） */
  function walkinOk(x) {
    const e = x && x.emergency;
    return !!x && typeof x.id === 'string' && /^[a-z0-9]{1,40}$/.test(x.id) && typeof x.tripId === 'string' && typeof x.at === 'string' && typeof x.day === 'string' &&
      ['name', 'email', 'birthDate', 'address'].every(k => typeof x[k] === 'string') && Number.isInteger(x.people) && !!e && typeof e === 'object' &&
      ['name', 'relation', 'phone'].every(k => typeof e[k] === 'string');
  }

  /* 予約の受け口 API の鍵（スタッフの画面。js/api-keys-staff.js）。サーバーが返した形を確かめてから画面に渡す。
     鍵は「rdx_」と 43 字、受け口の住所は /api/v1/bookings だけ（置いた形では redux-ask の https、手元では localhost） */
  const API_KEY_FORM = /^rdx_[A-Za-z0-9_-]{43}$/;
  const API_KEY_ID = /^[a-z0-9]{1,40}$/;
  function endpointOk(u) {
    try {
      const x = new URL(u);
      return (x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(x.hostname))) && x.pathname === '/api/v1/bookings' && !x.search && !x.hash;
    } catch (e) {
      return false;
    }
  }
  const apiKeyItemOk = (x) => !!x && API_KEY_ID.test(String(x.id)) && ['label', 'at', 'revokedAt'].every(k => typeof x[k] === 'string');
  /* 作った・作り直した返事（鍵つき）。通信の途中で壊れた物は画面に出さない */
  const apiKeyMade = (d) => !!d && API_KEY_ID.test(String(d.id)) && typeof d.key === 'string' && API_KEY_FORM.test(d.key)
    && typeof d.endpoint === 'string' && endpointOk(d.endpoint);

  /* 「入れた」「入れない」を押した行は、まずこの端末で隠し、サーバーで消せたら忘れる（電波が無いときは貯めて、あとで消す）。
     入れた物は、名簿の直しがサーバーに届いてから消す（mustSync。届く前に消すと、端末が壊れたときに個人情報が両方から無くなる） */
  const DROPPED_KEY = 'redux-walkin-dropped';
  const WALKIN_ID = /^[a-z0-9]{1,40}$/;
  function droppedMap() {
    try {
      const o = JSON.parse(localStorage.getItem(DROPPED_KEY) || '{}');
      if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
      return Object.fromEntries(Object.entries(o).filter(([id]) => WALKIN_ID.test(id)).slice(0, 200).map(([id, v]) => [id, v === true]));
    } catch (e) {
      return {};
    }
  }
  function setDropped(map) {
    try {
      if (Object.keys(map).length) localStorage.setItem(DROPPED_KEY, JSON.stringify(map));
      else localStorage.removeItem(DROPPED_KEY);
    } catch (e) { /* 書けなければ、次に開いたときに一覧にまた出る */ }
  }

  R.rosterSync = {
    /* { ok: true, version, state } か { ok: false, why } */
    async pull() {
      const r = await call('GET');
      if (r.status === 200 && r.data && R.roster.isNewer(r.data.state)) return { ok: false, why: 'newer' };   // サーバーの名簿がこの画面より新しい版
      const got = r.status === 200 ? shapeOf(r.data) : null;
      if (got) return { ok: true, ...got };
      /* local: この場所には名簿の口が無い（GitHub Pages の 404・D1 がまだ無い Worker の 503 config）。試し直しても変わらないので、端末だけで続ける */
      const noRoster = r.status === 404 || (r.status === 503 && !!r.data && r.data.error === 'config');
      return { ok: false, why: r.status || 'network', ...(noRoster ? { local: true } : {}) };
    },
    /* { ok: true, version, state }（書けた。state はサーバーが直した後）/ { conflict: true, version, state }（先に別の端末が書いた）/
       { shrink: true, version, state }（人が大きく消えるので、サーバーが断った）/ { ok: false, why }。
       why: 'login'（ログイン切れ）・400 / 413（サーバーが中身を断った。送り直しても通らない）・それ以外（届かない・サーバーの誤り） */
    async push(base, state, { allowShrink = false, shop } = {}) {
      const body = { base, state, ...(allowShrink ? { allowShrink: true } : {}), ...(shop ? { shop } : {}) };
      const r = await call('PUT', body);
      if (r.status === 409 && r.data && r.data.error === 'shop') return { ok: false, why: 'shop' };   // ログインしたお店が変わった
      /* 426: この画面が古い版（サーバーが断った）。409 で返ってきた名簿が新しい版のときも同じ */
      if (r.status === 426 || ((r.status === 409 || r.status === 200) && r.data && R.roster.isNewer(r.data.state))) return { ok: false, why: 'newer' };
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
    /* 読めなかった予約メール（同じ場所の /api/mail-unread。ジンのレビュー HIGH 6）。{ ok: true, items: [{ id, at, why }] } か { ok: false, why } */
    async unread() {
      const r = await call('GET', undefined, '/api/mail-unread');
      const items = r.status === 200 && r.data && Array.isArray(r.data.items) ? r.data.items : null;
      const itemOk = (x) => x && typeof x.id === 'string' && typeof x.at === 'string' && typeof x.why === 'string';
      return items && items.every(itemOk) ? { ok: true, items } : { ok: false, why: r.status || 'network' };
    },
    /* お店が「済んだ」を押した。消せた（か、もう無い）ら true */
    async doneUnread(id) {
      const r = await call('POST', { id }, '/api/mail-unread');
      return r.status === 200 || r.status === 404;
    },
    /* お客さんに送るリンクを作る（同じ場所の /api/ask-link。Access の内）。作り直すと前のリンクは開けない。
       { ok: true, url, expiresOn } か { ok: false, why }（why 404 = サーバーにまだこの予約が無い） */
    async askLink(bookingId) {
      const r = await call('POST', { bookingId }, '/api/ask-link');
      const d = r.data;
      if (r.status === 200 && d && typeof d.url === 'string' && linkOk(d.url)) return { ok: true, url: d.url, expiresOn: String(d.expiresOn || '') };
      return { ok: false, why: r.status || 'network' };
    },
    /* 店頭の QR を作る・作り直す（同じ場所の /api/walkin-key。Access の内）。作り直すと前の QR は開けない。
       { ok: true, url, at } か { ok: false, why }。鍵つきの URL が出るのはこの 1 回だけ（サーバーは SHA-256 しか持たない） */
    async walkinKey() {
      const r = await call('POST', {}, '/api/walkin-key');
      const d = r.data;
      if (r.status === 200 && d && typeof d.url === 'string' && walkinLinkOk(d.url)) return { ok: true, url: d.url, at: String(d.at || '') };
      return { ok: false, why: r.status || 'network' };
    },
    /* 店頭で入れた人の一覧（同じ場所の /api/walkins）。この端末で「入れた」「入れない」を押した行は除く。{ ok: true, items, keyAt } か { ok: false, why } */
    async walkins() {
      const r = await call('GET', undefined, '/api/walkins');
      const d = r.data;
      if (r.status === 200 && d && Array.isArray(d.items) && d.items.every(walkinOk)) {
        const hidden = droppedMap();
        return { ok: true, items: d.items.filter(x => !Object.prototype.hasOwnProperty.call(hidden, x.id)), keyAt: String(d.keyAt || '') };
      }
      return { ok: false, why: r.status || 'network' };
    },
    /* 予約の受け口 API の鍵の一覧（同じ場所の /api/api-keys。Access の内）。止めた鍵も含む。鍵そのものは来ない。{ ok: true, items, endpoint, max } か { ok: false, why } */
    async apiKeys() {
      const r = await call('GET', undefined, '/api/api-keys');
      const d = r.data;
      if (r.status === 200 && d && Array.isArray(d.items) && d.items.every(apiKeyItemOk) && typeof d.endpoint === 'string' && endpointOk(d.endpoint) && Number.isInteger(d.max)) {
        return { ok: true, items: d.items, endpoint: d.endpoint, max: d.max };
      }
      return { ok: false, why: r.status || 'network' };
    },
    /* 鍵を作る。{ ok: true, id, key, at, endpoint } か { ok: false, why }（why 409 = 鍵の数の上限）。鍵が出るのはこの 1 回だけ */
    async apiKeyCreate(label) {
      const r = await call('POST', { action: 'create', label }, '/api/api-keys');
      return apiKeyMade(r.data) ? { ok: true, id: r.data.id, key: r.data.key, at: String(r.data.at || ''), endpoint: r.data.endpoint } : { ok: false, why: r.status || 'network' };
    },
    /* 鍵を作り直す（同じ id・名前。前の鍵はすぐ開けなくなる）。返事は apiKeyCreate と同じ */
    async apiKeyRotate(id) {
      const r = await call('POST', { action: 'rotate', id }, '/api/api-keys');
      return apiKeyMade(r.data) ? { ok: true, id: r.data.id, key: r.data.key, at: String(r.data.at || ''), endpoint: r.data.endpoint } : { ok: false, why: r.status || 'network' };
    },
    /* 鍵を止める。止められた（か、もう止めてある・無い）ら { ok: true } */
    async apiKeyRevoke(id) {
      const r = await call('POST', { action: 'revoke', id }, '/api/api-keys');
      return r.status === 200 || r.status === 404 ? { ok: true } : { ok: false, why: r.status || 'network' };
    },
    /* 押した行をこの端末で隠す。mustSync が true（入れた）なら、名簿の直しがサーバーに届いてからサーバーの行を消す */
    hideWalkin(id, mustSync) {
      if (!WALKIN_ID.test(String(id))) return;
      setDropped({ ...droppedMap(), [id]: mustSync === true });
    },
    /* 隠した行を、サーバーで消す。synced が false のときは、名簿の直しを待っている行は残す。消せた（か、もう無い）行は忘れる。残った数を返す */
    async flushWalkinDrops({ synced }) {
      const map = droppedMap();
      for (const [id, mustSync] of Object.entries(map)) {
        if (mustSync && !synced) continue;
        const r = await call('POST', { id }, '/api/walkin-drop');
        if (r.status === 200 || r.status === 404) delete map[id];
      }
      setDropped(map);
      return Object.keys(map).length;
    }
  };
})();
