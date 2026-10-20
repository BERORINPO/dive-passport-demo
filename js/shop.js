/* お店の画面（日本語のみ）: 受付の一覧と、気づくための印。参加できるかはお店が決める */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const root = document.getElementById('shop');

  const ja = (o) => (o ? o.ja : '');
  const pick = (list, id) => ja(list.find(o => o.id === id)) || '未回答';
  const langLabel = (id) => (R.LANGS.find(o => o.id === id) || { label: id }).label;
  const hours = (h) => `${Math.round(h * 10) / 10} 時間`;

  function flagText(f) {
    switch (f.kind) {
      case 'healthYes': return `健康の質問で「はい」: ${f.items.map(q => q.short).join('・')}。お客さまに確認の連絡を`;
      case 'healthMissing': return '健康の質問票がまだ。お客さまに送る';
      case 'healthOld': return `健康の質問票: ${f.days} 日前に回答（お店の決まり ${f.limit} 日まで）。答え直してもらう`;
      case 'healthAge': return `健康の質問票: ${f.days} 日前に回答`;
      case 'flightClose': return `帰りの便: 潜り終わりから ${hours(f.gap)}（お店の目安 ${f.rule} 時間）。時刻を確かめる`;
      case 'flightOk': return `帰りの便: 潜り終わりから ${hours(f.gap)}（お店の目安 ${f.rule} 時間）`;
      case 'flightUnknown': return '帰りの便: まだ決まっていない';
      default: return '';
    }
  }

  function guideNote(x) {
    const exp = x.exp === 'card' ? `C カード（${x.dives || '?'} 本）` : pick(R.EXP, x.exp);
    const worries = x.worries.length ? x.worries.map(w => pick(R.WORRIES, w)).join('・') : 'なし';
    return `泳ぎ: ${pick(R.SWIM, x.swim)} ／ 経験: ${exp} ／ 心配: ${worries}`;
  }

  function toggleChecked(id) {
    R.store.update(s => ({ ...s, intakes: s.intakes.map(x => (x.id === id ? { ...x, checked: !x.checked } : x)) }));
  }

  function intakeCard(x, s) {
    const { tour, flags } = R.assess(x, s);
    const needs = flags.some(f => f.level === 'warn') && !x.checked;
    return el('article', { class: `ticket${needs ? ' ticket--warn' : ''}` },
      el('div', { class: 'ticket__head' },
        el('h3', { class: 'ticket__name', text: `${x.name}（${x.people} 人）` }),
        el('span', { class: 'ticket__badges' },
          x.source === 'passport' ? el('span', { class: 'badge badge--pass', text: 'パスポートから' }) : null,
          el('span', { class: `badge${x.checked ? ' badge--ok' : needs ? ' badge--warn' : ''}`, text: x.checked ? '確認済み' : needs ? '要確認' : '未確認' }))),
      el('p', { class: 'ticket__meta', text: `${ja(tour.name)} ・ ${x.date} ・ 連絡: ${langLabel(x.lang)}` }),
      flags.length ? el('ul', { class: 'flags' }, flags.map(f => el('li', { class: `flag flag--${f.level}`, text: flagText(f) }))) : null,
      el('p', { class: 'ticket__note', text: `ガイドへのメモ ― ${guideNote(x)}` }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: x.checked ? '未確認に戻す' : '確認済みにする', onclick: () => toggleChecked(x.id) }));
  }

  function counters(s) {
    const warn = s.intakes.filter(x => !x.checked && R.assess(x, s).flags.some(f => f.level === 'warn')).length;
    const box = (n, label, cls) => el('div', { class: `count ${cls || ''}` }, el('span', { class: 'count__n', text: n }), el('span', { class: 'count__l', text: label }));
    return el('div', { class: 'counts' },
      box(s.intakes.length, '受付'), box(warn, '要確認', warn ? 'count--warn' : ''), box(s.questions.length, 'お店への質問'));
  }

  function questions(s) {
    if (!s.questions.length) return el('p', { class: 'note', text: 'リドが答えられなかった質問は、まだありません。' });
    return el('ul', { class: 'qlist' }, s.questions.map(q =>
      el('li', {}, el('span', { class: 'qlist__text', text: q.text }), el('span', { class: 'qlist__meta', text: `${langLabel(q.lang)} ・ ${new Date(q.at).toLocaleString('ja-JP')}` }))));
  }

  function settings(s) {
    const select = el('select', { class: 'input', id: 's-flight', onchange: (e) => {
      const h = Number(e.target.value);
      R.store.update(st => ({ ...st, flightHours: { ...st.flightHours, dive: h } }));
    } }, R.FLIGHT_RULES.map(r => el('option', { value: r.h, selected: s.flightHours.dive === r.h, text: r.label })));
    const days = el('select', { class: 'input', id: 's-medical', onchange: (e) => {
      const d = Number(e.target.value);
      R.store.update(st => ({ ...st, medicalDays: d }));
    } }, R.MEDICAL_DAYS.map(o => el('option', { value: o.d, selected: (s.medicalDays || R.MEDICAL_DAYS_DEFAULT) === o.d, text: o.label })));
    return el('div', { class: 'card' },
      el('h2', { class: 'h2', text: '設定' }),
      el('div', { class: 'field' }, el('label', { class: 'label', for: 's-flight', text: '体験ダイビングの、潜ったあと飛行機に乗るまでの目安' }), select),
      el('p', { class: 'note', text: 'DAN（ダイバーの安全団体）の推奨で、法令ではありません。どれを使うかはお店が決めます。' }),
      el('div', { class: 'field' }, el('label', { class: 'label', for: 's-medical', text: '健康の質問票を、答えた日から何日まで使うか' }), days),
      el('p', { class: 'note', text: 'パスポートの質問票は前に答えたものです。過ぎていたら「答え直してもらう」の印が付きます。' }));
  }

  function faqTable() {
    return el('div', { class: 'card' },
      el('h2', { class: 'h2', text: 'リドが使う答えの一覧' }),
      el('p', { class: 'note', text: 'お店が書いた文です。書き換えると、リドの答えも変わります（デモでは書き換えできません）。' }),
      el('div', { class: 'table-wrap' },
        el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', { text: '質問' }), el('th', { text: '答え' }), el('th', { text: '更新' }))),
          el('tbody', {}, R.FAQ.map(f => el('tr', {}, el('td', { text: f.q.ja }), el('td', { text: f.a.ja }), el('td', { text: f.updated })))))));
  }

  function render() {
    const s = R.store.get();
    const list = [...s.intakes].sort((a, b) => (a.checked - b.checked) || b.at.localeCompare(a.at));
    root.replaceChildren(
      counters(s),
      el('div', { class: 'card' },
        el('h2', { class: 'h2', text: '受付の一覧' }),
        el('p', { class: 'note', text: '参加できるかはお店が決めます。印は、見落としに気づくためのものです。' }),
        el('div', { class: 'tickets' }, list.map(x => intakeCard(x, s)))),
      el('div', { class: 'card' }, el('h2', { class: 'h2', text: 'お店への質問（リドが答えられなかったもの）' }), questions(s)),
      settings(s),
      faqTable(),
      el('p', { class: 'reset' }, el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'デモの受付を最初の状態に戻す', onclick: () => R.store.reset() })));
  }

  R.renderShop = render;
  R.store.subscribe(() => { if (!document.getElementById('view-shop').hidden) render(); });
})();
