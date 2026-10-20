/* リドが質問から「お店の答え」を選ぶ（決まった計算だけ。AI は使わず、文も作らない）。
   点数 = 手がかりの言葉（長く一致したものを優先）+ 言い換えとの似ている度合い + 答えの文との似ている度合い。
   自信があるときだけ答え、迷うときは「もしかして」で候補を見せ、低いときはお店に回す。
   ブラウザでも Node（テスト）でも動くように、globalThis.REDUX に足す */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const W_KEY = 1.0;      // 強い手がかり 1 つ
  const W_WEAK = 0.4;     // 弱い手がかり 1 つ
  const W_PARA = 0.8;     // 言い換えとの似ている度合い（0〜1）にかける重み
  const W_ANSWER = 0.3;   // 答えの文との似ている度合いにかける重み
  const HIT_MIN = 0.9;    // これ以上で、2 番目と差があれば答える
  const HIT_MARGIN = 0.3;
  const MAYBE_MIN = 0.45; // これ以上なら「もしかして」に出す
  const MAX_CANDIDATES = 3;

  const STOP_JA = new Set(['です', 'ます', 'すか', 'ませ', 'せん', 'ない', 'ので', 'けど', 'たい', 'かな', 'でき', 'いま', 'して', 'てい',
    'ある', 'あり', 'りま', 'いい', 'ても', 'でも', 'には', 'のは', 'って', 'ょう', 'しょ', 'いで', 'すが', 'んで', 'んで', 'るの', 'ょっ']);
  const STOP_EN = new Set(['the', 'a', 'an', 'is', 'are', 'do', 'does', 'we', 'i', 'you', 'my', 'can', 'to', 'of', 'in', 'on', 'for', 'it',
    'be', 'will', 'there', 'any', 'if', 'what', 'how', 'when', 'and', 'or', 'me', 'us', 'your', 'our', 'with', 'still', 'get', 'have', 'im']);

  const toHiragana = (s) => s.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const base = (s) => toHiragana(s.normalize('NFKC').toLowerCase());
  /* 日本語を探す形: 空白と記号を消す。英語を探す形: 記号を空白にして単語を残す */
  const compact = (s) => base(s).replace(/[\s\p{P}\p{S}]/gu, '');
  const spaced = (s) => ` ${base(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const isLatin = (k) => /^[a-z0-9 '\-]+$/i.test(k);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function tokens(text) {
    const sp = spaced(text).replace(/'/g, '');
    const words = (sp.match(/[a-z0-9]+/g) || []).filter(w => !STOP_EN.has(w)).map(w => w.replace(/s$/, ''));
    const cjk = compact(text).replace(/[a-z0-9]+/g, '');
    const grams = [];
    for (let i = 0; i < cjk.length - 1; i += 1) {
      const g = cjk.slice(i, i + 2);
      if (!STOP_JA.has(g)) grams.push(g);
    }
    return new Set([...words, ...grams]);
  }

  function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let both = 0;
    a.forEach(t => { if (b.has(t)) both += 1; });
    return (2 * both) / (a.size + b.size);
  }

  /* 手がかりの言葉を、全部の答えについてまとめて作っておく */
  let index = null;
  function buildIndex() {
    index = R.FAQ.map(item => {
      const m = (R.FAQ_MATCH || {})[item.id] || { keys: [], weak: [], para: [] };
      const terms = [...m.keys.map(k => [k, W_KEY]), ...m.weak.map(k => [k, W_WEAK])];
      return {
        item,
        latin: terms.filter(([k]) => isLatin(k)).map(([k, w]) => ({ re: new RegExp(` ${escape(base(k))}s? `), w })),
        cjk: terms.filter(([k]) => !isLatin(k)).map(([k, w]) => ({ k: compact(k), w })),
        paras: [item.q.ja, item.q.en, ...m.para].map(tokens),
        answer: tokens(`${item.a.ja} ${item.a.en}`)
      };
    });
    return index;
  }

  /* 日本語の手がかり: 重なったら長い方だけを数える（「カメラ」の中の「カメ」は数えない） */
  function cjkScores(qc, idx) {
    const found = [];
    idx.forEach((e, n) => e.cjk.forEach(({ k, w }) => {
      for (let i = qc.indexOf(k); i >= 0; i = qc.indexOf(k, i + 1)) found.push({ s: i, e: i + k.length, n, w });
    }));
    found.sort((a, b) => (b.e - b.s) - (a.e - a.s));
    const used = new Uint8Array(qc.length);
    const scores = new Array(idx.length).fill(0);
    found.forEach(f => {
      for (let j = f.s; j < f.e; j += 1) if (used[j]) return;
      for (let j = f.s; j < f.e; j += 1) used[j] = 1;
      scores[f.n] += f.w;
    });
    return scores;
  }

  function score(question) {
    const idx = index || buildIndex();
    const qc = compact(question);
    const qs = spaced(question).replace(/'/g, '');
    const qt = tokens(question);
    const cjk = cjkScores(qc, idx);
    return idx.map((e, n) => {
      const latin = e.latin.reduce((sum, { re, w }) => sum + (re.test(qs) ? w : 0), 0);
      const para = Math.max(...e.paras.map(p => dice(qt, p)));
      return { item: e.item, score: cjk[n] + latin + W_PARA * para + W_ANSWER * dice(qt, e.answer) };
    }).sort((a, b) => b.score - a.score);
  }

  /* 返り値: status = 'hit'（答える）/ 'maybe'（候補を見せる）/ 'none'（お店に回す） */
  R.matchFaq = (question) => {
    const ranked = score(question);
    const [first, second] = ranked;
    if (first.score >= HIT_MIN && first.score - second.score >= HIT_MARGIN) {
      return { status: 'hit', item: first.item, candidates: [] };
    }
    const candidates = ranked.filter(r => r.score >= MAYBE_MIN).slice(0, MAX_CANDIDATES).map(r => r.item);
    return candidates.length ? { status: 'maybe', item: null, candidates } : { status: 'none', item: null, candidates: [] };
  };

  R.matchScores = score;   // 調整と確認のため（画面では使わない）
})();
