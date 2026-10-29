/* お客さまの画面の AI が「いま何をしているか」の手順の行（聞けば答える・まとめて書けば入る）。
   進み中の行は ● が点滅し、終わると ✓ になる。行の中身は AI が実際に返した物から作る（飾りの手順を作らない）。
   「動きを減らす」設定では待たず、点滅もしない（design.md の「動き」の例外。決定ログ 2026-10-29 guest-ai-steps） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const CHARA = 'assets/chara.png';

  const still = () => Boolean(window.matchMedia) && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* 行と行の間の待ち。「動きを減らす」では待たない */
  const pause = (ms) => new Promise(resolve => setTimeout(resolve, still() ? 0 : ms));

  const line = (s) => el('li', { class: `gsteps__${s.kind}${s.field ? ' gsteps__field' : ''}`, text: s.text });
  const box = (list) => el('div', { class: 'gsteps' }, el('img', { class: 'gsteps__chara', src: CHARA, alt: '', width: 44, height: 46 }), list);

  /* 手順の並び（state）から描く。[{ kind: 'doing' | 'done' | 'note', text, field }] */
  const view = (steps) => box(el('ol', { class: 'gsteps__list', 'aria-live': 'polite' }, steps.map(line)));

  /* host の下に足し、1 行ずつ足していく形 */
  function into(host) {
    const list = el('ol', { class: 'gsteps__list', 'aria-live': 'polite' });
    host.append(box(list));
    let last = null;
    const finish = (text) => {
      if (!last) return;
      last.className = 'gsteps__done';
      if (text) last.textContent = text;
      last = null;
    };
    return {
      doing(text) { finish(); last = line({ kind: 'doing', text }); list.append(last); },
      done: finish,
      note(text) { finish(); list.append(line({ kind: 'note', text })); }
    };
  }

  R.guestSteps = { pause, view, into };
})();
