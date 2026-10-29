/* AI の読み取り（外との境目はここだけ）。本物は同じ場所の Worker（/api/read）、見本は試験の答え（data-samples.js）を返す。
   どちらも roster-schema.js の validateReading を通った答えだけを返す。
   健康の情報は送らない: 送る中身は requestBody で決まった項目だけに組み直す。申込書は健康の欄を塗った写真だけ（masked: true）、
   予約メールは健康に触れていそうな行を外してから送る */
(() => {
  'use strict';

  const R = window.REDUX;
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

  /* 選んだ読み方（見本 / 本物）。本物になるのは、同じ場所の /api/healthz が通ったときだけ（GitHub Pages 版から本文を外に送らない）。
     開くたびに見本から始める（前に選んだ本物を残すと、healthz が返る前に描いた「送らない」の画面のまま、返ったあとに送ってしまう。ジンのレビュー）。
     入口は Cloudflare Access だけ（合言葉は 2026-10-22 に外した） */
  let chosen = 'sample';
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
        let healthSeen = false;
        try { ({ error: why, healthSeen } = await res.json()); } catch (e) { why = null; }
        /* 答えは使えないが、AI が「健康の情報が見えた」と答えていたら、送った記録に残す */
        throw Object.assign(new ReadError(why === 'answer' ? 'bad' : 'offline', '502'), { healthSeen: healthSeen === true });
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
    const table = { ...(R.SAMPLE_READINGS || {}), ...(R.SAMPLE_LIST_READINGS || {}) };   // 予約の一覧の見本は data-big-sample.js
    const hit = req.sampleId && Object.prototype.hasOwnProperty.call(table, req.sampleId) ? table[req.sampleId] : null;
    /* 見本のメールは、画面に出した文面と同じだけ予約の日付をずらす（data-samples.js の R.sampleMail） */
    if (hit && req.doc === 'mail' && R.SAMPLE_MAILS && R.SAMPLE_MAILS[req.sampleId] && R.today) return accept(R.sampleMail(req.sampleId, R.today()).reading);
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
      err.sent = { ...sent, healthSeen: err.healthSeen === true };
      /* 上限に達したら見本に戻す（続きは見本の読み取りでできる） */
      if (err.kind === 'limit' && used === 'real') { chosen = 'sample'; changed(); }
      throw err;
    }
  }

  /* 送る前にお店に見せる文面。read が送るのと同じ組み立てを通す（見せた文面と送る文面を同じにする） */
  function preview(req) {
    const { body, redacted } = prepare(req);
    return { text: body.doc === 'mail' ? body.text : '', redacted };
  }

  /* ---------- お客さま画面の AI（聞けば答える・まとめて書けば入る）。契約は guest-ai-schema.js ----------
     本物は同じ場所の /api/guest-ai（Access の内。上限は予約メールの読み取りと別）、見本は決まった計算で返す。
     体のことに触れた質問は送らない（答えは { health: true }）。まとめて書いた文は、健康に触れていそうな所を外してから送る */
  const G = () => R.guestAi;
  /* お客さま画面は、お店が選ぶ読み方（見本 / 本物）に合わせず、Worker 版で /api/healthz が通っていれば本物にする
     （送るのはお客さんの質問か、健康の所を外した文だけ。お店の名簿や写真は送らない） */
  const guestMode = () => (server ? 'real' : 'sample');
  /* 体のことに触れているか（health-redact.js の言葉で見る。外しすぎは構わない） */
  const touchesHealth = (text) => R.healthRedact.redact(String(text)).redacted > 0;

  async function postGuest(body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch('/api/guest-ai', {
          method: 'POST', credentials: 'same-origin', redirect: 'manual', signal: ctl.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
      } catch (e) {
        throw new ReadError('offline', e.name);
      }
      if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new ReadError('auth', String(res.status));
      if (res.status === 429) throw new ReadError('limit');
      if (res.status === 400 || res.status === 413) throw new ReadError('input', String(res.status));
      if (!res.ok) throw new ReadError(res.status === 502 ? 'bad' : 'offline', String(res.status));
      try { return await res.json(); } catch (e) { throw new ReadError('bad', 'json'); }
    } finally {
      clearTimeout(timer);
    }
  }

  /* 見本の言葉の見分け（本物は AI が見分ける） */
  const langOf = (t) => (/[가-힯]/.test(t) ? 'ko' : /[぀-ヿ]/.test(t) ? 'ja' : /[一-鿿]/.test(t) ? 'zh' : /[a-z]/i.test(t) ? 'en' : 'ja');

  /* 見本の「聞けば答える」: 決まった計算（match.js）で 1 つ選べたときだけ答える。訳は data.js の英語の答え（見本は日本語と英語だけ） */
  function faqSample(question) {
    const lang = langOf(question);
    const r = R.matchFaq ? R.matchFaq(question) : { status: 'none' };
    if (r.status !== 'hit' || (lang !== 'ja' && lang !== 'en')) return { lang, faq: null, answer: '', health: false };
    return { lang, faq: r.item.id, answer: lang === 'en' ? (r.item.a.en || '') : '', health: false };
  }

  /* 見本の「まとめて書けば入る」: 決まった形の言い方だけ拾う（本物は AI が読む） */
  function fillSample(text, today) {
    const year = today.slice(0, 4);
    const ymd = (m, d) => {
      const s = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return s >= today ? s : `${Number(year) + 1}${s.slice(4)}`;
    };
    const out = { worries: [] };
    const flight = text.match(/(?:帰り|飛行機)[^。\n]*?(\d{1,2})\s*[月/]\s*(\d{1,2})\s*日?[^\d。\n]*(\d{1,2})\s*(?:時|:(\d{2}))/);
    const rest = flight ? text.replace(flight[0], '') : text;
    const md = rest.match(/(\d{1,2})\s*[月/]\s*(\d{1,2})/);
    if (md) out.date = ymd(md[1], md[2]);
    const ppl = rest.match(/(\d{1,2})\s*(?:人|名)/);
    if (ppl) out.people = Number(ppl[1]);
    const nm = rest.match(/(?:^|[。、\s])([^\s、。\d]{1,12}?)(?:です|と申します)/);
    if (nm && !/泳|初め|酔|ダイビ|スノ|怖|苦手/.test(nm[1])) out.name = nm[1];
    if (/スノーケル|シュノーケル/.test(text)) out.tour = 'snorkel'; else if (/ダイビング/.test(text)) out.tour = 'dive';
    const swim = [['none', /泳げな/], ['shallow', /足のつく/], ['25m', /25\s*m/i], ['good', /泳ぎ[はが]得意/]].find(([, re]) => re.test(text));
    if (swim) out.swim = swim[0];
    if (/初めて|はじめて/.test(text)) out.exp = 'first'; else if (/数回/.test(text)) out.exp = 'few'; else if (/C\s*カード|ライセンス/i.test(text)) out.exp = 'card';
    if (/船酔い/.test(text)) out.worries.push('seasick');
    if (/深い/.test(text)) out.worries.push('deep');
    if (/顔をつけ/.test(text)) out.worries.push('face');
    if (flight) Object.assign(out, { flight_mode: 'set', flight_date: ymd(flight[1], flight[2]), flight_time: `${flight[3].padStart(2, '0')}:${flight[4] || '00'}` });
    else if (/飛行機(?:に|は)乗らない/.test(text)) out.flight_mode = 'none';
    return out;
  }

  /* 聞けば答える。faqs は [{ id, q, a }]（お店の日本語の文）。{ lang, faq, answer, health, mode } を返す */
  async function guestFaq(question, faqs) {
    const body = { kind: 'faq', question, faqs };
    const v = G().checkAsk(body);
    if (!v.ok) throw new ReadError('input', v.errors.join(','));
    const sent = G().askBody(body);
    if (touchesHealth(sent.question)) return { lang: langOf(sent.question), faq: null, answer: '', health: true, mode: 'none' };
    const used = guestMode();
    let got;
    if (used === 'real') got = await postGuest(sent);
    else { await new Promise(resolve => setTimeout(resolve, SAMPLE_MS)); got = faqSample(sent.question); }
    const a = G().faqAnswer(got, sent.faqs.map(f => f.id));
    if (!a.ok) throw new ReadError('bad', a.errors.join(','));
    return { ...a.answer, mode: used };
  }

  /* まとめて書けば入る。{ fill, fields, healthSeen, mode } を返す。fill の欄は intake.js の下書きの名前 */
  async function guestFill(text) {
    const body = { kind: 'fill', text };
    const v = G().checkAsk(body);
    if (!v.ok) throw new ReadError('input', v.errors.join(','));
    const red = R.healthRedact.redact(G().askBody(body).text);
    const today = R.today();
    const used = guestMode();
    let raw;
    if (used === 'real') {
      const got = await postGuest({ kind: 'fill', text: red.text });
      const f = got && got.fill && typeof got.fill === 'object' ? got.fill : null;
      if (!f) throw new ReadError('bad', 'shape');
      raw = { tour: f.tour, date: f.date, people: f.people, name: f.name, swim: f.swim, exp: f.exp, worries: f.worries,
        flight_mode: f.flightMode, flight_date: f.flightDate, flight_time: f.flightTime, health_info_visible: got.healthSeen === true };
    } else {
      await new Promise(resolve => setTimeout(resolve, SAMPLE_MS));
      raw = fillSample(red.text, today);
    }
    const f = G().fillAnswer(raw, today);
    if (!f.ok) throw new ReadError('bad', f.errors.join(','));
    return { fill: f.fill, fields: f.fields, healthSeen: f.healthSeen || red.redacted > 0, mode: used };
  }

  R.aiReader = {
    ReadError,
    guestFaq,
    guestFill,
    read,
    preview,
    mode,
    probe,
    available: () => !!server,
    left: () => (server ? { ...server } : null),
    setMode: (next) => { chosen = next === 'real' ? 'real' : 'sample'; changed(); },
    onChange: (fn) => { listeners.push(fn); }
  };
})();
