/* お客さま画面の AI（聞けば答える・まとめて書けば入る）の契約（shared）。画面（ai-reader.js）と Worker（guest-ai-core.mjs）が同じ物を読む。
   - 聞けば答える（faq）: AI はお店の答えを 1 つ選び、日本語以外ならその答えを聞いた言葉に訳すだけ。答えを作らない。体のことは選ばない
   - まとめて書けば入る（fill）: 書いた文から申し込みの欄を読む。健康の欄は読まない（健康に触れていそうな所は送る前に外す）
   体のことに触れているかは、使う側（ai-reader.js と guest-ai-core.mjs）が health-redact.js で見る。
   ブラウザでも Node（テスト・Worker）でも動くように、globalThis.REDUX に足す */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const KINDS = ['faq', 'fill'];
  const LANGS = ['ja', 'en', 'zh', 'ko'];
  const MAX_QUESTION = 200;      // 聞く欄の上限（chat.js の maxlength と同じ）
  const MAX_FILL = 600;          // まとめて書く欄の上限（intake.js の maxlength と同じ）
  const MAX_FAQ = 30;            // 送るよく聞かれることの数
  const MAX_FAQ_Q = 120;
  const MAX_FAQ_A = 400;
  const MAX_ANSWER = 1200;       // 訳した答えの上限（元の答え 400 字の訳でも収まる）
  const MAX_NAME = 60;
  const MAX_PEOPLE = 10;
  /* 申し込みの欄の選択肢。js/data.js の R.TOURS・R.SWIM・R.EXP・R.WORRIES と同じ id（test/guest-ai.test.mjs が確かめる） */
  const TOURS = ['dive', 'snorkel'];
  const SWIM = ['none', 'shallow', '25m', 'good'];
  const EXP = ['first', 'few', 'card'];
  const WORRIES = ['face', 'deep', 'ears', 'seasick'];
  const FLIGHT = ['set', 'unknown', 'none'];

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const ID = /^[a-z0-9-]{1,32}$/;
  const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
  const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const LINKISH = /https?:|www\.|[<>{}\\]/i;
  /* 本当にある日付か（時計を使わずに数える） */
  const realDate = (s) => {
    const m = YMD.exec(s);
    if (!m) return false;
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
    return Boolean(days) && d >= 1 && d <= days;
  };

  /* 画面から送る物の形。faq: { kind, question, faqs: [{ id, q, a }] } / fill: { kind, text } */
  function checkAsk(given) {
    const errors = [];
    if (!isObj(given) || !KINDS.includes(given.kind)) return { ok: false, errors: ['kind'] };
    if (given.kind === 'faq') {
      if (!isStr(given.question, MAX_QUESTION) || !given.question.trim()) errors.push('question');
      const list = given.faqs;
      if (!Array.isArray(list) || !list.length || list.length > MAX_FAQ) errors.push('faqs');
      else {
        const ids = new Set();
        list.forEach((f, i) => {
          if (!isObj(f) || !ID.test(f.id || '') || ids.has(f.id) || !isStr(f.q, MAX_FAQ_Q) || !f.q.trim() || !isStr(f.a, MAX_FAQ_A) || !f.a.trim()) errors.push(`faqs[${i}]`);
          else ids.add(f.id);
        });
      }
    } else if (!isStr(given.text, MAX_FILL) || !given.text.trim()) errors.push('text');
    return { ok: errors.length === 0, errors };
  }

  /* 送る中身を組み直す（決まった項目だけ。ほかの物は送らない） */
  function askBody(given) {
    if (given.kind === 'faq') return { kind: 'faq', question: given.question.trim(), faqs: given.faqs.map(f => ({ id: f.id, q: f.q, a: f.a })) };
    return { kind: 'fill', text: given.text.trim() };
  }

  /* 画面の lang の印（中国語は字で分ける。lang="zh" だけだと、どちらの字形で描くかが端末まかせになる）。
     繁体字にだけある字と簡体字にだけある字を数え、多い方。どちらも無ければ zh のまま。ほかの言葉はそのまま */
  const HANT = '這個們會時說來為對嗎請參與後習潛費錢點開關車門問現體兒難場臺灣';
  const HANS = '这个们会时说来为对吗请参与后习潜费钱点开关车门问现体儿难场台湾';
  function langTag(lang, text) {
    if (lang !== 'zh') return lang;
    const count = (set) => [...String(text || '')].filter(c => set.includes(c)).length;
    const t = count(HANT);
    const s = count(HANS);
    return t > s ? 'zh-Hant' : s > t ? 'zh-Hans' : 'zh';
  }

  /* 聞けば答えるの答え。{ lang, faq, answer, health }。faq は送った一覧の id か null。体のことなら faq は null にし、訳も捨てる。
     日本語の質問には訳を使わない（画面はお店の文をそのまま出す） */
  function faqAnswer(x, ids) {
    if (!isObj(x)) return { ok: false, errors: ['shape'] };
    const lang = LANGS.includes(x.lang) ? x.lang : 'en';
    const health = x.health === true;
    const faq = !health && typeof x.faq === 'string' && ids.includes(x.faq) ? x.faq : null;
    if (x.faq !== null && x.faq !== undefined && !health && faq === null) return { ok: false, errors: ['faq'] };
    const answer = faq && lang !== 'ja' && isStr(x.answer, MAX_ANSWER) ? x.answer.trim() : '';
    if (faq && lang !== 'ja' && !answer) return { ok: false, errors: ['answer'] };
    return { ok: true, answer: { lang, faq, answer, health } };
  }

  /* まとめて書けば入るの答え。形に合わない欄は捨てる（ほかの欄は使う）。入れた欄の名前を fields に。
     today（YYYY-MM-DD）より前の日付は捨てる */
  function fillAnswer(x, today) {
    if (!isObj(x)) return { ok: false, errors: ['shape'] };
    const out = {};
    const okDate = (v) => typeof v === 'string' && realDate(v) && (!today || v >= today);
    if (TOURS.includes(x.tour)) out.tour = x.tour;
    if (okDate(x.date)) out.date = x.date;
    if (Number.isInteger(x.people) && x.people >= 1 && x.people <= MAX_PEOPLE) out.people = x.people;
    if (isStr(x.name, MAX_NAME) && x.name.trim() && !LINKISH.test(x.name)) out.name = x.name.trim();
    if (SWIM.includes(x.swim)) out.swim = x.swim;
    if (EXP.includes(x.exp)) out.exp = x.exp;
    if (Array.isArray(x.worries)) {
      const w = WORRIES.filter(id => x.worries.includes(id));
      if (w.length) out.worries = w;
    }
    if (FLIGHT.includes(x.flight_mode)) {
      out.flightMode = x.flight_mode;
      if (x.flight_mode === 'set') {
        if (okDate(x.flight_date)) out.flightDate = x.flight_date;
        if (typeof x.flight_time === 'string' && HM.test(x.flight_time)) out.flightTime = x.flight_time;
      }
    }
    return { ok: true, fill: out, fields: Object.keys(out), healthSeen: x.health_info_visible === true };
  }

  R.guestAi = { KINDS, LANGS, MAX_QUESTION, MAX_FILL, TOURS, SWIM, EXP, WORRIES, FLIGHT, checkAsk, askBody, faqAnswer, fillAnswer, langTag };
})();
