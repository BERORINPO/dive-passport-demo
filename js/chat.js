/* ウミガメのリド: 質問に、お店が書いた答えだけで返す。AI に文章を作らせない。
   合う答えが無ければ、質問をお店に渡す（お店の画面の「お店への質問」に入る） */
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

  /* 質問に一番多く言葉が当たった答えを選ぶ。1 つも当たらなければ null */
  const norm = (s) => s.toLowerCase().replace(/[\s　]/g, '');
  function match(question) {
    const q = norm(question);
    return R.FAQ.reduce((best, item) => {
      const score = item.keys.reduce((n, k) => n + (q.includes(norm(k)) ? 1 : 0), 0);
      return score > best.score ? { item, score } : best;
    }, { item: null, score: 0 }).item;
  }

  let log = null;

  const say = (text) => log.append(el('p', { class: 'msg msg--turtle', text }));
  const you = (text) => log.append(el('p', { class: 'msg msg--you', text }));
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function answerCard(item) {
    return el('div', { class: 'answer' },
      el('span', { class: 'answer__tag', text: `${L(R.T.shopAnswer)} ・ ${L(R.T.updated)} ${item.updated}` }),
      el('p', { class: 'answer__text', text: L(item.a) }));
  }

  function handOff(question) {
    const btn = el('button', { class: 'btn btn--ghost', type: 'button', text: L(R.T.askShop) });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      R.store.update(s => ({
        ...s,
        questions: [{ id: R.newId(), text: question, lang: R.lang, at: new Date().toISOString() }, ...s.questions]
      }));
      say(L(R.T.sent));
      scroll();
    });
    return btn;
  }

  function ask(question, picked) {
    const text = question.trim();
    if (!text) return;
    you(text);
    const item = picked || match(text);
    if (item) {
      log.append(answerCard(item));
    } else {
      say(L(R.T.notFound));
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
    head.firstChild.innerHTML = R.TURTLE;
    root.replaceChildren(head, log, chips, form);
    say(L(R.T.greet));
  }

  R.renderChat = render;
})();
