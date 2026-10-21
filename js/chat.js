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

  const say = (text, key) => {
    const p = el('p', { class: 'msg msg--turtle' });
    log.append(p);
    typeInto(p, text);
    if (key) voice(key, text);
  };
  const you = (text) => log.append(el('p', { class: 'msg msg--you', text }));
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function answerCard(item, question) {
    voice(`faq-${item.id}`, L(item.a));
    const text = el('p', { class: 'answer__text' });
    const card = el('div', { class: 'answer' },
      el('span', { class: 'answer__tag', text: `${L(R.T.answerFor).replace('{q}', L(item.q))} ・ ${L(R.T.updated)} ${item.updated}` }),
      text);
    typeInto(text, L(item.a));
    if (question) {
      // 選び間違いに気づけるように、いつでもお店に回せる
      card.append(el('button', { class: 'answer__wrong', type: 'button', text: L(R.T.wrongQuestion),
        onclick: (e) => { e.target.disabled = true; say(L(R.T.notFound), 'notFound'); log.append(handOff(question)); scroll(); } }));
    }
    return card;
  }

  function candidates(list, question) {
    const pick = (item) => () => { you(L(item.q)); log.append(answerCard(item, question)); scroll(); };
    return el('div', { class: 'maybe' },
      list.map(item => el('button', { class: 'chip', type: 'button', text: L(item.q), onclick: pick(item) })),
      el('button', { class: 'chip chip--ghost', type: 'button', text: L(R.T.noneOfThese),
        onclick: (e) => { e.target.disabled = true; log.append(handOff(question)); scroll(); } }));
  }

  function handOff(question) {
    const btn = el('button', { class: 'btn btn--ghost', type: 'button', text: L(R.T.askShop) });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      R.store.update(s => ({
        ...s,
        questions: [{ id: R.newId(), text: question, lang: R.lang, at: new Date().toISOString() }, ...s.questions]
      }));
      say(L(R.T.sent), 'sent');
      scroll();
    });
    return btn;
  }

  function ask(question, picked) {
    const text = question.trim();
    if (!text) return;
    you(text);
    if (picked) {
      log.append(answerCard(picked, null));
      scroll();
      return;
    }
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
    scroll();
  }

  function render() {
    log = el('div', { class: 'chat__log', 'aria-live': 'polite' });
    const input = el('input', { class: 'input', type: 'text', maxlength: 200, autocomplete: 'off',
      placeholder: L(R.T.placeholder), 'aria-label': L(R.T.placeholder) });
    const form = el('form', { class: 'chat__form' }, input,
      el('button', { class: 'btn', type: 'submit', text: L(R.T.ask) }));
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); input.value = ''; input.focus(); });
    const chips = el('div', { class: 'chips' }, R.FAQ.map(item =>
      el('button', { class: 'chip', type: 'button', text: L(item.q), onclick: () => ask(L(item.q), item) })));

    const head = el('div', { class: 'chat__head' }, el('span', { class: 'avatar' }), el('h2', { class: 'h2', text: L(R.T.chatTitle) }));
    head.firstChild.innerHTML = R.TURTLE; // arch-allow: 固定の SVG
    const stage = el('div', { class: 'lido-stage', id: 'lido-stage', role: 'img', 'aria-label': L(R.T.chatTitle) });
    root.replaceChildren(head, stage, log, chips, form);
    if (R.mountLido) R.mountLido(stage);
    say(L(R.T.greet), 'greet');
  }

  R.renderChat = render;
})();
