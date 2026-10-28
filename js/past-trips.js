/* お店の画面: 済んだ便（済んで 7 日を過ぎた便。読むだけ）。予約の画面（booking.js）から開く。
   サーバーが名簿の本体から便ごとに分けて置いた物を、月ごとに読んで並べる（/api/roster/past。plan/server.md の「済んだ便を分けて置く」）。
   直す所は無い。条例の名簿の紙を開いて、印刷・PDF にできる（day-roster.js の renderPrint）。サーバーを使わない版（GitHub Pages）では開かない */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;
  const MONTHS_BACK = 13;   // 名簿は 1 年残すので、13 か月前まで見られる

  let month = '';            // 見ている月（YYYY-MM）
  const got = {};            // 月 → { status: 'loading' | 'ok' | 'error', state, skipped, full }

  const thisMonth = () => R.today().slice(0, 7);
  function shift(ym, by) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + by, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function rangeOf(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = `${ym}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
    return { from: `${ym}-01`, to: last < R.today() ? last : R.today() };
  }
  const monthJa = (ym) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月`;

  /* 読んだ済んだ便に、お店の名前を付ける（お店の一覧がまだ空のあいだ、サーバーは名前を持たない） */
  const named = (state) => (state.shop.name ? state : { ...state, shop: { ...R.rosterStore.get().shop } });

  function load(ym, ui) {
    got[ym] = { status: 'loading' };
    const { from, to } = rangeOf(ym);
    R.rosterStore.past(from, to).then(r => {
      got[ym] = r.ok ? { status: 'ok', state: named(r.state), skipped: r.skipped, full: r.full } : { status: 'error', why: r.why };
      if (month === ym) ui.rerender();
    });
  }

  const button = (text, onclick, cls = 'linkbtn') => el('button', { class: cls, type: 'button', text, onclick });

  function tripRow(s, t, ui) {
    const n = C().tripSummary(s, t.id).listed;
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: `${ui.md(t.date)} ${ui.tripLabel(t)}` }),
      el('span', { class: 'bk__meta', text: `${n} 人${t.cancel ? '・中止' : ''}` }),
      button('名簿を開く', () => ui.go('pastprint', { tripId: t.id })));
  }

  function renderList({ ui }) {
    if (!month) month = thisMonth();
    if (!got[month]) load(month, ui);
    const cur = got[month];
    const oldest = shift(thisMonth(), -MONTHS_BACK);
    const nav = el('p', { class: 'reset' },
      month > oldest ? button('← 前の月', () => { month = shift(month, -1); ui.rerender(); }) : null,
      el('b', { text: `　${monthJa(month)}　` }),
      month < thisMonth() ? button('次の月 →', () => { month = shift(month, 1); ui.rerender(); }) : null);
    let body;
    if (cur.status === 'loading') body = el('p', { class: 'note', role: 'status', text: '読み込んでいます…' });
    else if (cur.status === 'error') {
      body = [el('p', { class: 'flag flag--warn', role: 'alert', text: cur.why === 'login' ? 'ログインが切れました。画面を読み込み直してください。'
        : '読み込めませんでした。電波を確かめて、もう一度押してください。' }), el('p', { class: 'reset' }, button('もう一度読む', () => { load(month, ui); ui.rerender(); }))];
    } else {
      const trips = C().tripList(cur.state).filter(t => t.date);
      body = [
        cur.skipped ? el('p', { class: 'flag flag--warn', role: 'alert', text: `読めなかった便が ${cur.skipped} 件あります。運営に知らせてください。` }) : null,
        cur.full ? el('p', { class: 'flag flag--warn', text: 'この月は便が多く、一部だけを出しています。' }) : null,
        trips.length ? el('ul', { class: 'bks' }, trips.map(t => tripRow(cur.state, t, ui)))
          : el('p', { class: 'empty', text: 'この月の済んだ便はありません（済んで 7 日までの便は、予約の一覧にあります）。' })
      ];
    }
    return [
      ...ui.head('済んだ便', '済んで 7 日を過ぎた便です。読むだけで、直すことはできません。名簿は作成の日から 1 年残ります。'),
      nav,
      body,
      ui.back()
    ];
  }

  function renderPrint({ tripId, ui }) {
    const cur = got[month];
    if (!cur || cur.status !== 'ok') { ui.go('past'); return []; }
    return R.dayRoster.renderPrint({ tripId, ui, state: cur.state, back: () => ui.go('past') });
  }

  R.pastTrips = { renderList, renderPrint };
})();
