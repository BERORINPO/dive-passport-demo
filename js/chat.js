/* 聞けば答える（よく聞かれること）: 自分の言葉で聞くと、お店が書いた答えから 1 つ選んで返す。AI は選ぶのと、日本語以外の質問への訳だけ（文章を作らない）。
   選ぶのは ai-reader.js の guestFaq（本物は Worker の AI、見本は match.js の決まった計算）。訳した答えには元の日本語の文を添える。
   体のことに触れた質問には答えない（決まった文だけを出し、AI にもお店の答えにも回さない。参加できるかはお店が確かめる）。
   AI が選べない・届かないときは match.js で選び、迷えば「もしかして」、合う答えが無ければ質問をお店に渡す（お店の画面の「お店への質問」に入る）。
   一覧（よく聞かれること）は下に畳んで残す */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('chat');


  let log = null;

  /* 答えの文字は少しずつ出す。読み上げ機能には全文をすぐ渡す。
     文字が出るのは画面が動く「動き」ではないので、「動きを減らす」設定でも同じにする */
  const MS_PER_CHAR = 22;
  function typeInto(node, text) {
    const shown = el('span', { 'aria-hidden': 'true' });
    node.replaceChildren(el('span', { class: 'sr-only', text }), shown);
    let i = 0;
    const step = () => {
      i += 1;
      shown.textContent = text.slice(0, i);
      if (log) scroll();
      if (i < text.length && node.isConnected) setTimeout(step, MS_PER_CHAR);
    };
    // 答えのカードは作ってから画面に入れるので、入った後（次の一瞬）に始める
    setTimeout(step, 0);
  }

  /* 「よく聞かれること」の形（design.md の部品）。質問を罫線の行で並べ、押すと下に答えが開く。
     自由に聞く欄は最後に 1 つ。答えは行の形で、左に案内役の小さい絵（全身のまま。丸く切らない。チャットの吹き出しにしない） */
  /* 答えの左の案内役（場面ごとの表情: 答えた = answer、お店の答えが無い・体のこと = sorry。決定ログ 2026-10-29 chara-faces） */
  const mark = (face = 'answer') => el('img', { class: 'faq__mark', src: R.CHARA[face], alt: '', width: 30, height: 30 });
  /* lang: 答えの言葉（訳した答えは質問の言葉）。読み上げと字形（中国語を日本語の字で描かない）のため */
  const answerRow = (text, sub, lang, face) => {
    const p = el('p', lang ? { lang } : {});
    const row = el('div', { class: 'faq__a' }, mark(face), el('div', {}, p, sub ? el('small', { text: sub }) : null));
    typeInto(p, text);
    return row;
  };
  const say = (text, face) => log.append(answerRow(text, '', '', face));
  const you = (text) => log.append(el('p', { class: 'faq__asked', text }));
  const scroll = () => {};

  function answerCard(item, question) {
    const row = answerRow(L(item.a), `${L(R.T.answerFor).replace('{q}', L(item.q))} ・ ${L(R.T.updated)} ${item.updated}`);
    if (question) {
      // 選び間違いに気づけるように、いつでもお店に回せる
      row.lastChild.append(el('button', { class: 'linkbtn', type: 'button', text: L(R.T.wrongQuestion),
        onclick: (e) => { e.target.disabled = true; say(L(R.T.notFound), 'sorry'); log.append(handOff(question)); } }));
    }
    return row;
  }

  function candidates(list, question) {
    const pick = (item) => () => { you(L(item.q)); log.append(answerCard(item, question)); };
    return el('div', { class: 'faq__maybe' },
      list.map(item => el('button', { class: 'linkbtn', type: 'button', text: L(item.q), onclick: pick(item) })),
      el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: L(R.T.noneOfThese),
        onclick: (e) => { e.target.disabled = true; log.append(handOff(question)); } }));
  }

  function handOff(question) {
    const btn = el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: L(R.T.askShop) });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      R.store.update(s => ({
        ...s,
        questions: [{ id: R.newId(), text: question, lang: R.lang, at: new Date().toISOString() }, ...s.questions]
      }));
      say(L(R.isWorkerBuild() ? R.T.sentReal : R.T.sent));
    });
    return btn;
  }

  /* 日本語以外で聞かれ、AI が訳した答え。元の日本語の文を開いて見られる */
  function translatedCard(item, text, question, lang) {
    const row = answerRow(text, `${L(R.T.translated).replace('{q}', item.q.ja)} ・ ${L(R.T.updated)} ${item.updated}`, lang);
    row.lastChild.append(el('details', { class: 'faq__orig' }, el('summary', { text: L(R.T.original) }), el('p', { lang: 'ja', text: item.a.ja })),
      el('button', { class: 'linkbtn', type: 'button', text: L(R.T.wrongQuestion),
        onclick: (e) => { e.target.disabled = true; say(L(R.T.notFound), 'sorry'); log.append(handOff(question)); } }));
    return row;
  }

  let asking = 0;   // 前の質問の答えが後から届いても、新しい質問の答えを上書きしない
  async function ask(question) {
    const text = question.trim();
    if (!text) return;
    const turn = ++asking;
    log.replaceChildren();
    you(text);
    /* いま何をしているかを 1 行ずつ出す（js/guest-steps.js）。行の中身は返った答えから作る */
    const steps = R.guestSteps.into(log);
    const { pause } = R.guestSteps;
    const T = R.T;
    steps.doing(L(T.stepReading));
    const faqs = R.FAQ.map(f => ({ id: f.id, q: f.q.ja, a: f.a.ja }));
    let got = null;
    try { got = await R.aiReader.guestFaq(text, faqs); } catch (e) { got = null; }   // 届かない・上限・形が違う → 決まった計算で選ぶ
    if (turn !== asking) return;
    const langName = got ? L(T.langNames[got.lang] || T.langNames.en) : '';
    steps.done(got && !got.health ? L(T.stepRead).replace('{lang}', langName) : L(T.stepReadPlain));
    if (got && got.health) { steps.note(L(T.stepHealth)); steps.face('sorry'); say(L(T.healthStop), 'sorry'); return; }
    steps.doing(L(T.stepSearch).replace('{n}', R.FAQ.length));
    await pause(500);
    if (turn !== asking) return;
    const item = got && got.faq ? R.FAQ.find(f => f.id === got.faq) : null;
    if (item) {
      steps.done(L(T.stepChose).replace('{q}', L(item.q)));
      const translate = got.lang !== 'ja' && got.answer;
      if (translate) {
        steps.doing(L(T.stepTranslating).replace('{lang}', langName));
        await pause(600);
        if (turn !== asking) return;
        steps.done(L(T.stepTranslated).replace('{lang}', langName));
      }
      steps.face('answer');
      log.append(translate ? translatedCard(item, got.answer, text, R.guestAi.langTag(got.lang, `${text} ${got.answer}`)) : answerCard(item, text));
      return;
    }
    steps.done(L(T.stepNone).replace('{n}', R.FAQ.length));
    const r = R.matchFaq(text);
    /* AI が「合う答えは無い」と言ったときは、決まった計算の当たりを答えとして出さない（言葉が似ているだけの別の答えになる。
       例: 「駐車場に充電器は？」に駐車場の料金）。候補として「もしかして」に出すだけ。AI に届かなかったときは今までどおり */
    if (r.status === 'hit' && !got) {
      steps.face('answer');
      log.append(answerCard(r.item, text));
    } else if (r.status === 'hit' || r.status === 'maybe') {
      steps.face('answer');
      say(L(R.T.didYouMean));
      log.append(candidates(r.status === 'hit' ? [r.item] : r.candidates, text));
    } else {
      steps.face('sorry');
      say(L(R.T.notFound), 'sorry');
      log.append(handOff(text));
    }
  }

  /* よく聞かれることの 1 行。開くと答え。閉じると消す */
  function faqItem(item) {
    const id = `faq-${item.id}`;
    const body = el('div', { id, hidden: true });
    const q = el('button', { class: 'faq__q', type: 'button', 'aria-expanded': 'false', 'aria-controls': id, text: L(item.q) });
    q.addEventListener('click', () => {
      const open = q.getAttribute('aria-expanded') !== 'true';
      q.setAttribute('aria-expanded', String(open));
      body.hidden = !open;
      body.replaceChildren(...(open ? [answerCard(item, null)] : []));
    });
    return el('li', { class: 'faq__item' }, q, body);
  }

  function render() {
    log = el('div', { class: 'faq__log', 'aria-live': 'polite' });
    const input = el('input', { class: 'input', type: 'text', maxlength: 200, autocomplete: 'off',
      placeholder: L(R.T.placeholder), 'aria-label': L(R.T.placeholder) });
    const form = el('form', { class: 'faq__ask' }, input,
      el('button', { class: 'btn btn--ghost', type: 'submit', text: L(R.T.ask) }));
    form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value; input.value = ''; input.focus(); ask(q); });
    root.replaceChildren(
      el('div', { class: 'faq__head' },
        el('img', { class: 'faq__chara', src: R.CHARA.hello, alt: '', width: 112, height: 112 }),
        el('h2', { class: 'h2', text: L(R.T.faqTitle) })),
      form,
      el('p', { class: 'faq__note', text: L(R.T.faqNote) }),
      log,
      el('details', { class: 'faq__more' },
        el('summary', { text: `${L(R.T.faqMore)}（${R.FAQ.length}）` }),
        el('ul', { class: 'faq' }, R.FAQ.map(faqItem))));
  }

  R.renderChat = render;
})();
