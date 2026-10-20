/* パスポートの形（版 1）。ダイバーの画面・予約前の確認・見るだけの画面が共通で使う契約。
   ブラウザでも Node（テスト）でも動くように、globalThis.REDUX に足す。依存なし */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const VERSION = 1;
  const FORM = 'sample-1';           // 自作のサンプルの健康の質問。正式な質問票に替えたら名前を変える
  const QUESTIONS = 5;
  const MAX_CERTS = 3;
  const LANGS = ['ja', 'en', 'zh', 'ko'];
  const SWIM = ['', 'none', 'shallow', '25m', 'good'];

  /* QR で見せるときに、最初から入れておく項目。番号のたぐいは、ダイバーが選んだときだけ */
  const SHARE_DEFAULT = { medical: true, certNo: false, insurance: true, insuranceNo: false, sizes: true, flight: true };

  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isDate = (v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v));
  const isTime = (v) => v === '' || (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v));
  const isAnswer = (a) => a === 'yes' || a === 'no' || a === null;
  const isDives = (v) => v === '' || (Number.isInteger(v) && v >= 0 && v < 100000);
  const isObj = (v) => v !== null && typeof v === 'object';

  function blank() {
    return {
      v: VERSION, name: '', lang: 'ja', swim: '', certs: [], dives: '', lastDive: '',
      medical: { form: FORM, answeredAt: '', answers: Array(QUESTIONS).fill(null) },
      insurance: { name: '', no: '' },
      sizes: { suit: '', fins: '' },
      flight: { date: '', time: '' },
      updatedAt: ''
    };
  }

  function certsOk(certs) {
    return Array.isArray(certs) && certs.length <= MAX_CERTS &&
      certs.every(c => isObj(c) && isStr(c.agency, 20) && isStr(c.level, 40) && isStr(c.no, 30) && isDate(c.date));
  }

  /* 本人・C カード・経験は、パスポートと見せる中身で同じ検査をする */
  function commonErrors(x) {
    return [
      !isStr(x.name, 60) && 'name',
      !LANGS.includes(x.lang) && 'lang',
      !SWIM.includes(x.swim) && 'swim',
      !certsOk(x.certs) && 'certs',
      !isDives(x.dives) && 'dives',
      !isDate(x.lastDive) && 'lastDive'
    ];
  }

  const result = (errors) => {
    const list = errors.filter(Boolean);
    return { ok: list.length === 0, errors: list };
  };

  function validate(p) {
    if (!isObj(p) || p.v !== VERSION) return result(['version']);
    const m = p.medical;
    return result([
      ...commonErrors(p),
      !(isObj(m) && isStr(m.form, 20) && isDate(m.answeredAt) && Array.isArray(m.answers) &&
        m.answers.length === QUESTIONS && m.answers.every(isAnswer)) && 'medical',
      !(isObj(p.insurance) && isStr(p.insurance.name, 40) && isStr(p.insurance.no, 30)) && 'insurance',
      !(isObj(p.sizes) && isStr(p.sizes.suit, 10) && isStr(p.sizes.fins, 10)) && 'sizes',
      !(isObj(p.flight) && isDate(p.flight.date) && isTime(p.flight.time)) && 'flight',
      !isStr(p.updatedAt, 40) && 'updatedAt'
    ]);
  }

  /* QR で見せる中身。健康は「答えた日」と「『はい』の番号」と「未回答の数」だけにする */
  function toShare(p, pick) {
    const k = { ...SHARE_DEFAULT, ...(pick || {}) };
    const m = p.medical;
    return {
      v: VERSION, k: 'share', name: p.name, lang: p.lang, swim: p.swim,
      certs: p.certs.map(c => ({ agency: c.agency, level: c.level, no: k.certNo ? c.no : '', date: c.date })),
      dives: p.dives, lastDive: p.lastDive,
      med: k.medical ? {
        form: m.form, at: m.answeredAt,
        yes: m.answers.map((a, i) => (a === 'yes' ? i : -1)).filter(i => i >= 0),
        open: m.answers.filter(a => a === null).length
      } : null,
      ins: k.insurance ? { name: p.insurance.name, no: k.insuranceNo ? p.insurance.no : '' } : null,
      sizes: k.sizes ? { suit: p.sizes.suit, fins: p.sizes.fins } : null,
      flight: k.flight ? { date: p.flight.date, time: p.flight.time } : null
    };
  }

  function medOk(med) {
    return med === null || (isObj(med) && isStr(med.form, 20) && isDate(med.at) && Array.isArray(med.yes) &&
      med.yes.every(i => Number.isInteger(i) && i >= 0 && i < QUESTIONS) &&
      Number.isInteger(med.open) && med.open >= 0 && med.open <= QUESTIONS);
  }

  function validateShare(s) {
    if (!isObj(s) || s.v !== VERSION || s.k !== 'share') return result(['version']);
    return result([
      ...commonErrors(s),
      !medOk(s.med) && 'med',
      !(s.ins === null || (isObj(s.ins) && isStr(s.ins.name, 40) && isStr(s.ins.no, 30))) && 'ins',
      !(s.sizes === null || (isObj(s.sizes) && isStr(s.sizes.suit, 10) && isStr(s.sizes.fins, 10))) && 'sizes',
      !(s.flight === null || (isObj(s.flight) && isDate(s.flight.date) && isTime(s.flight.time))) && 'flight'
    ]);
  }

  R.pass = { VERSION, FORM, QUESTIONS, MAX_CERTS, SHARE_DEFAULT, blank, validate, toShare, validateShare };
})();
