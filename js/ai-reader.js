/* AI の読み取り（外との境目はここだけ）。本物は同じ場所の Worker（/api/read）、見本は試験の答え（data-samples.js）を返す。
   どちらも roster-schema.js の validateReading を通った答えだけを返す。
   健康の情報は送らない: 送る中身は requestBody で決まった項目だけに組み直す。申込書は健康の欄を塗った写真だけ（masked: true）、
   予約メールは健康に触れていそうな行を外してから送る */
(() => {
  'use strict';

  const R = window.REDUX;
  const CODE_KEY = 'redux-code';       // 合言葉。開いているタブの中だけに置く
  const MODE_KEY = 'redux-ai-mode';
  const TIMEOUT_MS = 30000;
  const SAMPLE_MS = 700;               // 見本でも「読んでいる」間が分かるように少し待つ

  /* kind: input（送る物が形に合わない）/ auth（合言葉か本人確認）/ limit（今日か今月の上限）/ offline（届かない）/ bad（答えが形に合わない）。
     送ったあとの失敗には、送った量（sent）を付ける */
  class ReadError extends Error {
    constructor(kind, detail) {
      super(detail ? `${kind}: ${detail}` : kind);
      this.kind = kind;
      this.sent = null;
    }
  }

  /* 保存場所を止めているブラウザでは、localStorage という名前に触れるだけで例外になる */
  const getItem = (store, key, fallback) => {
    try { return store().getItem(key) || fallback; } catch (e) { return fallback; }
  };
  const setItem = (store, key, value) => {
    try { if (value) store().setItem(key, value); else store().removeItem(key); } catch (e) { /* 保存できなくても、開いている間は動く */ }
  };
  const local = () => localStorage;
  const session = () => sessionStorage;

  let mode = getItem(local, MODE_KEY, 'sample') === 'real' ? 'real' : 'sample';

  /* HTTP のヘッダには日本語を入れられないので、合言葉は UTF-8 を base64url にして送る（Worker で戻す） */
  function codeHeader(code) {
    let bin = '';
    new TextEncoder().encode(code).forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function accept(x) {
    const v = R.roster.validateReading(x);
    if (!v.ok) throw new ReadError('bad', v.errors.join(','));
    return x;
  }

  async function readReal(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch('/api/read', {
          method: 'POST', credentials: 'same-origin', redirect: 'manual', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-redux-code': codeHeader(getItem(session, CODE_KEY, '')) },
          body: JSON.stringify(body)
        });
      } catch (e) {
        throw new ReadError('offline', e.name);
      }
      // Access の期限切れは、別の場所のログイン画面への移動として返る
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new ReadError('auth', String(res.status));
      if (res.status === 429) throw new ReadError('limit');
      if (!res.ok) throw new ReadError('offline', String(res.status));
      let json;
      try { json = await res.json(); } catch (e) { throw new ReadError(e.name === 'AbortError' ? 'offline' : 'bad', 'json'); }
      return accept(json);
    } finally {
      clearTimeout(timer);
    }
  }

  async function readSample(req) {
    await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
    const table = R.SAMPLE_READINGS || {};
    const hit = req.sampleId && Object.prototype.hasOwnProperty.call(table, req.sampleId) ? table[req.sampleId] : null;
    return accept(JSON.parse(JSON.stringify(hit || { booking: null, people: [], healthSeen: false })));
  }

  /* 送る中身を組み立てる。予約メールは健康に触れていそうな行を外す */
  function prepare(req) {
    const v = R.roster.validateRequest(req);
    if (!v.ok) throw new ReadError('input', v.errors.join(','));
    const body = R.roster.requestBody(req);
    if (body.doc !== 'mail') return { body, redacted: 0 };
    const { text, redacted } = R.roster.redactHealthLines(body.text);
    return { body: { ...body, text }, redacted };
  }

  async function read(req) {
    const { body, redacted } = prepare(req);
    const used = mode;
    const sent = { doc: body.doc, size: body.doc === 'mail' ? body.text.length : body.image.length,
      masked: body.doc === 'paper' && body.masked === true, mode: used, healthSeen: false, redacted };
    try {
      const reading = used === 'real' ? await readReal(body) : await readSample(req);
      return { reading, sent: { ...sent, healthSeen: reading.healthSeen } };
    } catch (e) {
      const err = e instanceof ReadError ? e : new ReadError('bad', e.message);
      err.sent = sent;
      throw err;
    }
  }

  R.aiReader = {
    ReadError,
    read,
    mode: () => mode,
    setMode: (next) => { mode = next === 'real' ? 'real' : 'sample'; setItem(local, MODE_KEY, mode); },
    setCode: (code) => setItem(session, CODE_KEY, String(code || '').trim()),
    hasCode: () => getItem(session, CODE_KEY, '') !== ''
  };
})();
