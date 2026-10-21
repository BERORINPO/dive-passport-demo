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
  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  const dayParts = (d) => {
    const [y, m, dd] = String(d).split('-').map(Number);
    if (!y || !m || !dd) return ['—', '日付なし'];
    return [`${m}/${dd}`, WEEK[new Date(y, m - 1, dd).getDay()]];
  };

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

  /* 受付の 1 行。状態は色の札にせず、文字の色と短い印で見せる */
  function intakeLine(x, s) {
    const { tour, flags } = R.assess(x, s);
    const needs = flags.some(f => f.level === 'warn') && !x.checked;
    const st = x.checked ? ['ok', '✓ 確認済み'] : needs ? ['check', '! 確かめる'] : ['wait', '・未確認'];
    const meta = [ja(tour.name), `連絡: ${langLabel(x.lang)}`, x.source === 'passport' ? 'パスポートから' : ''].filter(Boolean).join('　');
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name' }, x.name, el('span', { class: 'nw', text: `（${x.people} 人）` })),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: meta }),
      flags.length ? el('ul', { class: 'fls' }, flags.map(f => el('li', { class: `fl fl--${f.level}`, text: flagText(f) }))) : null,
      el('p', { class: 'bk__note', text: `ガイドへのメモ: ${guideNote(x)}` }),
      el('button', { class: 'linkbtn', type: 'button', text: x.checked ? '未確認に戻す' : '確認済みにする', onclick: () => toggleChecked(x.id) }));
  }

  /* 日付ごとの時刻表。左に日付、右にその日の受付 */
  function dayBlock(date, list, s, past) {
    const [md, wd] = dayParts(date);
    const warn = list.filter(x => !x.checked && R.assess(x, s).flags.some(f => f.level === 'warn')).length;
    return el('section', { class: `trip${past ? ' trip--past' : ''}`, 'aria-label': md },
      el('div', { class: 'trip__time trip__time--date' }, md, el('small', { text: past ? `${wd} 過ぎた日` : wd })),
      el('div', {},
        el('div', { class: 'trip__head' },
          el('h3', { class: 'trip__title' }, '受付', warn ? el('span', { class: 'st st--check', text: `　! 確かめる ${warn}` }) : null),
          el('span', { class: 'trip__count' }, el('b', { text: String(list.length) }), ' 件')),
        el('ul', { class: 'bks' }, list.map(x => intakeLine(x, s)))));
  }

  function counters(s) {
    const warn = s.intakes.filter(x => !x.checked && R.assess(x, s).flags.some(f => f.level === 'warn')).length;
    const box = (n, label, cls) => el('div', { class: `count ${cls || ''}` }, el('span', { class: 'count__n', text: n }), el('span', { class: 'count__l', text: label }));
    return el('div', { class: 'counts' },
      box(s.intakes.length, '受付'), box(warn, '確かめる', warn ? 'count--warn' : ''), box(s.questions.length, 'お店への質問'));
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
    /* その日の中は、確かめる受付・未確認・確認済みの順。同じなら新しい順 */
    const rank = (x) => (x.checked ? 2 : R.assess(x, s).flags.some(f => f.level === 'warn') ? 0 : 1);
    const order = (a, b) => (rank(a) - rank(b)) || b.at.localeCompare(a.at);
    /* 今日から先の日を上に、古い順。過ぎた日はその下に、新しい順 */
    const today = R.today();
    const all = [...new Set(s.intakes.map(x => x.date))].sort();
    const dates = [...all.filter(d => d >= today), ...all.filter(d => !(d >= today)).reverse()];
    root.replaceChildren(
      el('h2', { class: 'page__title', text: '受付' }),
      el('p', { class: 'page__sub', text: 'お客さまが送った受付。参加できるかはお店が決めます。印は、見落としに気づくためのものです。' }),
      counters(s),
      dates.length
        ? el('div', { class: 'timetable' }, dates.map(d => dayBlock(d, s.intakes.filter(x => x.date === d).sort(order), s, !(d >= today))))
        : el('p', { class: 'empty', text: 'まだ受付がありません。「お客さま」の画面から送れます。' }),
      el('div', { class: 'card' }, el('h2', { class: 'h2', text: 'お店への質問（リドが答えられなかったもの）' }), questions(s)),
      settings(s),
      faqTable(),
      el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: 'デモの受付を最初の状態に戻す', onclick: () => R.store.reset() })));
  }

  R.renderShop = render;
  R.store.subscribe(() => { if (!document.getElementById('view-shop').hidden) render(); });
})();
