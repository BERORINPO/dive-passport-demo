/* ウミガメのリド: 質問に、お店が書いた答えだけで返す。AI に文章を作らせない。
   答えを選ぶのは match.js（決まった計算）。自信があれば答え、どの質問への答えかも見せる。
   迷えば「もしかして」で候補を出し、合う答えが無ければ質問をお店に渡す（お店の画面の「お店への質問」に入る） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('chat');

  R.TURTLE = '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
    '<ellipse cx="14" cy="44" rx="7" ry="4" transform="rotate(-30 14 44)" class="t-flip"/>' +
    '<ellipse cx="50" cy="44" rx="7" ry="4" transform="rotate(30 50 44)" class="t-flip"/>' +
    '<ellipse cx="32" cy="40" rx="17" ry="14" class="t-shell"/>' +
    '<path d="M32 28l7 5-3 8h-8l-3-8z M18 38l7-5 M46 38l-7-5 M28 41l-6 7 M36 41l6 7" class="t-scute"/>' +
    '<circle cx="32" cy="20" r="10" class="t-head"/>' +
    '<circle cx="28" cy="18" r="2" class="t-eye"/><circle cx="36" cy="18" r="2" class="t-eye"/>' +
    '<path d="M28 23q4 3 8 0" class="t-smile"/></svg>';

  let log = null;

  /* 3D のリドが読み込めていれば、決まった文の声（key）を流して話す。無ければ文字だけ */
  const voice = (key, text) => { if (R.lidoSpeak) R.lidoSpeak(key, text); };

  /* リドの文字は、声の速さで少しずつ出す（しゃべっている感じのため）。読み上げ機能には全文をすぐ渡す。
     文字が出るのは画面が動く「動き」ではないので、「動きを減らす」設定でも同じにする */
  const MS_PER_CHAR = { ja: 105, en: 55 };
  const MS_PER_CHAR_SILENT = 22;
  function typeInto(node, text) {
    const shown = el('span', { 'aria-hidden': 'true' });
    node.replaceChildren(el('span', { class: 'sr-only', text }), shown);
    const talking = R.lidoSoundOn && R.lidoSoundOn();
    const per = talking ? (MS_PER_CHAR[R.lang] || MS_PER_CHAR.en) : MS_PER_CHAR_SILENT;
    let i = 0;
    const step = () => {
      i += 1;
      shown.textContent = text.slice(0, i);
      if (log) scroll();
      if (i < text.length && node.isConnected) setTimeout(step, per);
    };
    // 答えのカードは作ってから画面に入れるので、入った後（次の一瞬）に始める
    setTimeout(step, 0);
  }

  /* 「よく聞かれること」の形（design.md の部品）。質問を罫線の行で並べ、押すと下に答えが開く。
     自由に聞く欄は最後に 1 つ。答えは行の形で、左にリドの印（チャットの吹き出しにしない） */
  const mark = () => { const m = el('span', { class: 'lido-mark', 'aria-hidden': 'true' }); m.innerHTML = R.TURTLE; return m; }; // arch-allow: 固定の SVG
  const answerRow = (text, sub) => {
    const p = el('p');
    const row = el('div', { class: 'faq__a' }, mark(), el('div', {}, p, sub ? el('small', { text: sub }) : null));
    typeInto(p, text);
    return row;
  };
  const say = (text, key) => {
    log.append(answerRow(text));
    if (key) voice(key, text);
  };
  const you = (text) => log.append(el('p', { class: 'faq__asked', text }));
  const scroll = () => {};

  function answerCard(item, question) {
    voice(`faq-${item.id}`, L(item.a));
    const row = answerRow(L(item.a), `${L(R.T.answerFor).replace('{q}', L(item.q))} ・ ${L(R.T.updated)} ${item.updated}`);
    if (question) {
      // 選び間違いに気づけるように、いつでもお店に回せる
      row.lastChild.append(el('button', { class: 'linkbtn', type: 'button', text: L(R.T.wrongQuestion),
        onclick: (e) => { e.target.disabled = true; say(L(R.T.notFound), 'notFound'); log.append(handOff(question)); } }));
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
      say(L(R.T.sent), 'sent');
    });
    return btn;
  }

  function ask(question) {
    const text = question.trim();
    if (!text) return;
    log.replaceChildren();
    you(text);
    const r = R.matchFaq(text);
    if (r.status === 'hit') {
      log.append(answerCard(r.item, text));
    } else if (r.status === 'maybe') {
      say(L(R.T.didYouMean), 'didYouMean');
      log.append(candidates(r.candidates, text));
    } else {
      say(L(R.T.notFound), 'notFound');
      log.append(handOff(text));
    }
  }

  /* よく聞かれることの 1 行。開くと答え（声も流す）。閉じると消す */
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

  const FIRST = 5;   // 最初に見せる質問の数。ほかは「ほかの質問」を開いて見る

  function render() {
    log = el('div', { class: 'faq__log', 'aria-live': 'polite' });
    const input = el('input', { class: 'input', type: 'text', maxlength: 200, autocomplete: 'off',
      placeholder: L(R.T.placeholder), 'aria-label': L(R.T.placeholder) });
    const form = el('form', { class: 'faq__ask' }, input,
      el('button', { class: 'btn btn--ghost', type: 'submit', text: L(R.T.ask) }));
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); input.value = ''; input.focus(); });
    const stage = el('div', { class: 'lido-stage', id: 'lido-stage', role: 'img', 'aria-label': L(R.T.chatTitle) });
    const rest = R.FAQ.slice(FIRST);
    root.replaceChildren(
      el('h2', { class: 'h2', text: L(R.T.faqTitle) }),
      stage,
      el('ul', { class: 'faq' }, R.FAQ.slice(0, FIRST).map(faqItem)),
      rest.length ? el('details', { class: 'faq__more' },
        el('summary', { text: `${L(R.T.faqMore)}（${rest.length}）` }),
        el('ul', { class: 'faq' }, rest.map(faqItem))) : null,
      form,
      el('p', { class: 'faq__note', text: L(R.T.faqNote) }),
      log);
    if (R.mountLido) R.mountLido(stage);
  }

  R.renderChat = render;
})();
