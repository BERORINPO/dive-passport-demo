/* AI の読み取り（外との境目はここだけ）。本物は同じ場所の Worker（/api/read）、見本は試験の答え（data-samples.js）を返す。
   どちらも roster-schema.js の validateReading を通った答えだけを返す。
   健康の情報は送らない: 送る中身は requestBody で決まった項目だけに組み直す。申込書は健康の欄を塗った写真だけ（masked: true）、
   予約メールは健康に触れていそうな行を外してから送る */
(() => {
  'use strict';

  const R = window.REDUX;
  const MODE_KEY = 'redux-ai-mode';
  const TIMEOUT_MS = 30000;
  const PROBE_MS = 5000;
  const SAMPLE_MS = 700;               // 見本でも「読んでいる」間が分かるように少し待つ

  /* kind: input（送る物が形に合わない）/ auth（Access のログインが切れた・通らない）/ limit（今日か今月の上限）/ offline（届かない）/ bad（答えが形に合わない）。
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

  /* 選んだ読み方（見本 / 本物）。本物になるのは、同じ場所の /api/healthz が通ったときだけ（GitHub Pages 版から本文を外に送らない）。
     入口は Cloudflare Access だけ（合言葉は 2026-10-22 に外した） */
  let chosen = getItem(local, MODE_KEY, 'sample') === 'real' ? 'real' : 'sample';
  let server = null;   // /api/healthz の答え { today, monthUsd }（今日と今月の残りの目安）。null は「本物を選べない」
  const listeners = [];
  const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { /* 画面の 1 つが失敗しても、ほかは知らせる */ } });
  const mode = () => (server && chosen === 'real' ? 'real' : 'sample');
  const count = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

  async function probe() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_MS);
    let next = null;
    try {
      const res = await fetch('/api/healthz', { credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: ctl.signal });
      const json = res.ok ? await res.json() : null;
      if (json && json.ok === true && json.left && typeof json.left === 'object') next = { today: count(json.left.today), monthUsd: count(json.left.monthUsd) };
    } catch (e) {
      next = null;   // 届かない・JSON でない（GitHub Pages や手元の http.server では 404）
    } finally {
      clearTimeout(timer);
    }
    server = next;
    changed();
    return server;
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
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        });
      } catch (e) {
        throw new ReadError('offline', e.name);
      }
      // Access の期限切れは、別の場所のログイン画面への移動として返る
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new ReadError('auth', String(res.status));
      if (res.status === 429) throw new ReadError('limit');
      if (res.status === 400 || res.status === 413) throw new ReadError('input', String(res.status));
      if (res.status === 502) {
        /* 502 は 2 通り: AI の答えが形に合わなかった（answer）か、AI に届かなかった（upstream） */
        let why = null;
        try { why = (await res.json()).error; } catch (e) { why = null; }
        throw new ReadError(why === 'answer' ? 'bad' : 'offline', '502');
      }
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
    /* 写真は photo-prep.js が描き直して（申込書は塗って）作った物だけ送る。masked: true と書いただけの物は送らない */
    if (req.doc !== 'mail' && !(R.photoPrep && R.photoPrep.isPrepared(req))) throw new ReadError('input', 'photo');
    const body = R.roster.requestBody(req);
    if (body.doc !== 'mail') return { body, redacted: 0 };
    const { text, redacted } = R.healthRedact.redact(body.text);
    if (text.length > R.roster.MAX_TEXT) throw new ReadError('input', 'text');   // 外した印で長くなることがある
    return { body: { ...body, text }, redacted };
  }

  async function read(req) {
    const { body, redacted } = prepare(req);
    const used = mode();
    const sent = { doc: body.doc, size: body.doc === 'mail' ? body.text.length : body.image.length,
      masked: body.doc !== 'mail' && body.masked === true, mode: used, healthSeen: false, redacted };
    try {
      const reading = used === 'real' ? await readReal(body) : await readSample(req);
      if (used === 'real' && server) { server = { ...server, today: Math.max(0, server.today - 1) }; changed(); }   // 残りは目安。数え直しは開き直したとき
      return { reading, sent: { ...sent, healthSeen: reading.healthSeen } };
    } catch (e) {
      const err = e instanceof ReadError ? e : new ReadError('bad', e.message);
      err.sent = sent;
      /* 上限に達したら見本に戻す（続きは見本の読み取りでできる） */
      if (err.kind === 'limit' && used === 'real') { chosen = 'sample'; setItem(local, MODE_KEY, chosen); changed(); }
      throw err;
    }
  }

  /* 送る前にお店に見せる文面。read が送るのと同じ組み立てを通す（見せた文面と送る文面を同じにする） */
  function preview(req) {
    const { body, redacted } = prepare(req);
    return { text: body.doc === 'mail' ? body.text : '', redacted };
  }

  R.aiReader = {
    ReadError,
    read,
    preview,
    mode,
    probe,
    available: () => !!server,
    left: () => (server ? { ...server } : null),
    setMode: (next) => { chosen = next === 'real' ? 'real' : 'sample'; setItem(local, MODE_KEY, chosen); changed(); },
    onChange: (fn) => { listeners.push(fn); }
  };
})();
