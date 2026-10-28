/* よく聞かれること: 質問に、お店が書いた答えだけで返す。AI に文章を作らせない。
   答えを選ぶのは match.js（決まった計算）。自信があれば答え、どの質問への答えかも見せる。
   迷えば「もしかして」で候補を出し、合う答えが無ければ質問をお店に渡す（お店の画面の「お店への質問」に入る） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('chat');

  const CHARA = 'assets/chara.png';   // お店の案内役の絵（名前はまだ無い。画面に名前は出さない）

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
  const mark = () => el('img', { class: 'faq__mark', src: CHARA, alt: '', width: 30, height: 30 });
  const answerRow = (text, sub) => {
    const p = el('p');
    const row = el('div', { class: 'faq__a' }, mark(), el('div', {}, p, sub ? el('small', { text: sub }) : null));
    typeInto(p, text);
    return row;
  };
  const say = (text) => log.append(answerRow(text));
  const you = (text) => log.append(el('p', { class: 'faq__asked', text }));
  const scroll = () => {};

  function answerCard(item, question) {
    const row = answerRow(L(item.a), `${L(R.T.answerFor).replace('{q}', L(item.q))} ・ ${L(R.T.updated)} ${item.updated}`);
    if (question) {
      // 選び間違いに気づけるように、いつでもお店に回せる
      row.lastChild.append(el('button', { class: 'linkbtn', type: 'button', text: L(R.T.wrongQuestion),
        onclick: (e) => { e.target.disabled = true; say(L(R.T.notFound)); log.append(handOff(question)); } }));
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

  function ask(question) {
    const text = question.trim();
    if (!text) return;
    log.replaceChildren();
    you(text);
    const r = R.matchFaq(text);
    if (r.status === 'hit') {
      log.append(answerCard(r.item, text));
    } else if (r.status === 'maybe') {
      say(L(R.T.didYouMean));
      log.append(candidates(r.candidates, text));
    } else {
      say(L(R.T.notFound));
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

  const FIRST = 5;   // 最初に見せる質問の数。ほかは「ほかの質問」を開いて見る

  function render() {
    log = el('div', { class: 'faq__log', 'aria-live': 'polite' });
    const input = el('input', { class: 'input', type: 'text', maxlength: 200, autocomplete: 'off',
      placeholder: L(R.T.placeholder), 'aria-label': L(R.T.placeholder) });
    const form = el('form', { class: 'faq__ask' }, input,
      el('button', { class: 'btn btn--ghost', type: 'submit', text: L(R.T.ask) }));
    form.addEventListener('submit', (e) => { e.preventDefault(); ask(input.value); input.value = ''; input.focus(); });
    const rest = R.FAQ.slice(FIRST);
    root.replaceChildren(
      el('div', { class: 'faq__head' },
        el('img', { class: 'faq__chara', src: CHARA, alt: '', width: 88, height: 90 }),
        el('h2', { class: 'h2', text: L(R.T.faqTitle) })),
      el('ul', { class: 'faq' }, R.FAQ.slice(0, FIRST).map(faqItem)),
      rest.length ? el('details', { class: 'faq__more' },
        el('summary', { text: `${L(R.T.faqMore)}（${rest.length}）` }),
        el('ul', { class: 'faq' }, rest.map(faqItem))) : null,
      form,
      el('p', { class: 'faq__note', text: L(R.T.faqNote) }),
      log);
  }

  R.renderChat = render;
})();
