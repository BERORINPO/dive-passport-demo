/* 予約を直す・別の便へ・取り消す画面（お店、日本語のみ）。予約の画面（booking.js）の一覧の「直す」「別の便へ」「取り消す」から開く。
   予約と名簿は R.rosterStore（core.js）、形は roster-schema.js、組み立てと判断は roster-core.js を通す。
   保存・移動・知らせ・便の選び・見出しなどの道具は、booking.js から init で受け取る ui を通す。
   お客さんの文字は el() の text で出す（HTML として入れない） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;

  /* booking.js の ui（init で受け取る） */
  let head, back, field, dock, md, tripLabel, tripPicker, tour, save, go, done, render, KIND_JA, PROBLEM_JA;
  function init(ui) {
    ({ head, back, field, dock, md, tripLabel, tripPicker, tour, save, go, done, rerender: render } = ui);
    ({ KIND_JA, PROBLEM_JA } = ui.labels);
  }

  /* ---------- 予約を直す・別の便へ・取り消す（H4） ----------
     取り消しと別の便へは、押すと確かめの文に変わり、もう一度押すと実行する（window.confirm は使わない）。
     入力の途中は bk に持ち、押した時に args へ全部写す（貯めた直しが、あとで別の予約の入力を読まないように） */
  const BOOK_MODES = ['bedit', 'bmove', 'bcancel'];
  const CANCEL_JA = { guest: 'お客さんの都合', dup: '同じ予約が二つある', shop: 'お店の都合', other: 'その他' };
  let bk = null;            // { id, name, phone, email, note, names: { 人の id: 名前 }, date, start, tourId, tripId, moveTo, reason, armed, error }
  let bkPick = null;

  function blankBk(b, trip) {
    return { id: b.id, name: b.leadName, phone: b.leadPhone, email: b.leadEmail || '', note: b.note, names: {},
      date: trip.date, start: trip.start, tourId: '', tripId: b.tripId, moveTo: '', reason: 'guest', armed: false, error: '' };
  }
  /* 開いている予約。見つからない（別の端末が取り消した）・乗り合いの他のお店の予約・便が無い予約は null */
  function bookTarget(bookingId) {
    const s = R.rosterStore.get();
    const b = s.bookings.find(x => x.id === bookingId);
    const trip = b && s.trips.find(x => x.id === b.tripId);
    if (!b || !trip || C().isPartnerBooking(b)) return null;
    if (!bk || bk.id !== b.id) bk = blankBk(b, trip);
    return { s, b, trip, people: s.people.filter(p => p.bookingId === b.id) };
  }
  const bookLead = (t) => t.b.leadName || (t.people[0] && t.people[0].name) || '名前の分からない予約';
  const bookHead = (title, t) => head(title, `${bookLead(t)}　${md(t.trip.date)} ${tripLabel(t.trip)}`);
  const bookGone = (title) => [...head(title), el('p', { class: 'errors', role: 'alert', text: 'この予約が見つかりません。別の端末で取り消された可能性があります。' }), back()];
  const bookDock = (errorsNode, main) => dock(errorsNode, main, el('button', { class: 'btn btn--ghost', type: 'button', text: 'やめる', onclick: () => go('list') }));
  /* 押すと確かめの文に変わり、もう一度押すと実行する */
  const armedBtn = (label, armedLabel, run, extra = {}) => el('button', { class: 'btn btn--warn', type: 'button', ...extra,
    text: bk.armed ? armedLabel : label, onclick: () => { if (!bk.armed) { bk.armed = true; render(); return; } run(); } });

  /* 直す: 代表者の連絡先・メモ・名前の無い人の名前・日付と時刻とツアー（変えると別の便に移る） */
  const bkTour = () => (bk.tourId ? tour(bk.tourId) : null);
  const bkMoved = (t) => bk.date !== t.trip.date || bk.start !== t.trip.start || (!!bkTour() && bkTour().name.ja !== t.trip.tour);
  function bkWant(t) {
    const x = bkTour();
    return { date: bk.date, start: bk.start, tour: x ? x.name.ja : t.trip.tour, kind: x ? (x.diving ? 'dive' : 'snorkel') : t.trip.kind };
  }
  function fillBkPick(t) {
    if (!bkPick) return;
    if (!bkMoved(t)) { bk.tripId = t.b.tripId; R.fill(bkPick); return; }
    if (!bk.date) { R.fill(bkPick, el('p', { class: 'note', text: '日付を入れると、入れる便を選べます' })); return; }
    R.fill(bkPick, tripPicker(bkWant(t), bk, () => fillBkPick(t)));
  }

  function saveBookEdit(t, errorsNode) {
    const fail = (text) => { errorsNode.textContent = text; };
    const moved = bkMoved(t);
    const input = { date: bk.date, people: t.b.people, leadName: bk.name.trim(), leadPhone: bk.phone.trim(), note: bk.note.trim() };
    const problems = C().bookingProblems(input).filter(p => p !== 'date' || moved);
    if (problems.length) { fail(`確かめてください: ${problems.map(p => PROBLEM_JA[p]).join('・')}`); return; }
    const email = bk.email.trim();
    if (email && !R.roster.emailOk(email)) { fail('確かめてください: メールアドレス'); return; }
    const r = save('core.editBooking', { bookingId: t.b.id, patch: { leadName: input.leadName, leadPhone: input.leadPhone, leadEmail: email, note: input.note } });
    if (r.error) { fail('直せませんでした。入力を確かめて、もう一度試してください。'); return; }
    let saved = r.saved;
    const named = Object.entries(bk.names).map(([id, name]) => [id, name.trim()]).filter(([, name]) => name);
    for (const [id, name] of named) {
      const p = save('core.editPerson', { id, patch: { name }, who: 'staff' });
      if (p.error) { fail('お名前を入れられませんでした（60 字まで）。ほかの直しは保存しました。'); return; }
      saved = saved && p.saved;
    }
    if (moved && bk.tripId !== t.b.tripId) {
      const m = save('auto.moveBooking', { bookingId: t.b.id, tripId: bk.tripId, want: bkWant(t), nowJst: R.nowJst() });
      if (m.error) { fail('便を移せませんでした。日付と便を確かめてください。ほかの直しは保存しました。'); return; }
      saved = saved && m.saved;
      R.autoFlow.tick(save);
    }
    const stuck = email && email !== (t.b.leadEmail || '') && (t.s.outbox || []).some(o => o.bookingId === t.b.id && o.kind !== 'staff' && ['unsent', 'failed'].includes(o.status));
    done(bk.date || t.trip.date, `予約を直しました${moved ? '。便を移したので、自動の予定は新しい日付で作り直しました' : ''}${stuck ? '。送れていなかった連絡は、「書類の自動化」から送り直せます' : ''}`, saved);
  }

  function renderBookEdit(bookingId) {
    const t = bookTarget(bookingId);
    if (!t) return bookGone('予約を直す');
    const errorsNode = el('p', { class: 'errors', role: 'alert' });
    const set = (key) => (e) => { bk[key] = e.target.value; };
    const setWhen = (key) => (e) => { bk[key] = e.target.value; bk.tripId = ''; fillBkPick(t); };
    const unnamed = t.people.map((p, i) => ({ p, i })).filter(x => !x.p.name.trim());
    bkPick = el('div', { class: 'phone__pick' });
    fillBkPick(t);
    return [
      ...bookHead('予約を直す', t),
      el('form', { class: 'card form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveBookEdit(t, errorsNode); } },
        el('div', { class: 'row' },
          field('代表者の名前', el('input', { class: 'input', type: 'text', maxlength: 60, autocomplete: 'off', value: bk.name, oninput: set('name') })),
          field('電話', el('input', { class: 'input', type: 'tel', maxlength: 30, autocomplete: 'off', value: bk.phone, oninput: set('phone') }))),
        field('メールアドレス', el('input', { class: 'input', type: 'email', maxlength: 254, autocomplete: 'off', value: bk.email, oninput: set('email') }),
          '自動のお願いは、ここに送ります。直すと、次の連絡から新しい宛先に送ります'),
        unnamed.map(x => field(`お名前（${x.i + 1} 人目）`, el('input', { class: 'input', type: 'text', maxlength: 60, autocomplete: 'off',
          value: bk.names[x.p.id] || '', oninput: (e) => { bk.names[x.p.id] = e.target.value; } }), x.i === unnamed[0].i ? '分かる人だけ入れてください' : null)),
        el('div', { class: 'row' },
          field('日付', el('input', { class: 'input', type: 'date', required: true, value: bk.date, oninput: setWhen('date') })),
          field('集合の時刻', el('input', { class: 'input', type: 'time', value: bk.start, oninput: setWhen('start') }))),
        field('ツアー', el('select', { class: 'input', onchange: setWhen('tourId') },
          el('option', { value: '', selected: !bk.tourId, text: `今のまま（${t.trip.tour || KIND_JA[t.trip.kind]}）` }),
          R.TOURS.map(x => el('option', { value: x.id, selected: x.id === bk.tourId, text: x.name.ja }))),
          '日付・時刻・ツアーを変えると、別の便に移ります'),
        bkPick,
        field('メモ', el('textarea', { class: 'input', rows: 3, maxlength: 400, text: bk.note, oninput: set('note') }),
          '健康のことは書かないでください。')),
      back(),
      dock(errorsNode, el('button', { class: 'btn', type: 'button', text: '直した内容で保存', onclick: () => saveBookEdit(t, errorsNode) }))
    ];
  }

  /* 別の便へ: 今ある便から選ぶ。自動の予定は、新しい便の日で作り直す（送り済みのお願いはそのまま） */
  function commitBookMove(t, to) {
    const r = save('auto.moveBooking', { bookingId: t.b.id, tripId: to.id, nowJst: R.nowJst() });
    if (r.error) { bk.error = '移せませんでした。便を選び直してください。'; bk.armed = false; render(); return; }
    R.autoFlow.tick(save);
    done(to.date, `${bookLead(t)} の予約を ${md(to.date)} ${tripLabel(to)} へ移しました。自動の予定は新しい日付で作り直しました。日付が変わったことは、お客さんに電話などで伝えてください`, r.saved);
  }
  function renderBookMove(bookingId) {
    const t = bookTarget(bookingId);
    if (!t) return bookGone('別の便へ');
    const options = C().tripList(t.s).filter(x => x.id !== t.b.tripId && !x.cancel);
    const to = options.find(x => x.id === bk.moveTo) || null;
    const errorsNode = el('p', { class: 'errors', role: 'alert', text: bk.error });
    return [
      ...bookHead('別の便へ', t),
      options.length ? el('div', { class: 'card form' },
        field('移す先の便', el('select', { class: 'input', onchange: (e) => { bk.moveTo = e.target.value; bk.armed = false; bk.error = ''; render(); } },
          el('option', { value: '', selected: !to, text: '移す先の便を選ぶ' }),
          options.map(x => el('option', { value: x.id, selected: !!to && x.id === to.id, text: `${md(x.date)} ${tripLabel(x)}` }))),
        '日付や時刻が今の便と違うときは、「直す」で日付と時刻を変えます'))
        : el('p', { class: 'empty', text: '移せる便がありません。日付や時刻を変えるときは、「直す」から入れてください。' }),
      el('div', { class: 'band' }, el('p', { class: 'band__title', text: '移すと' }),
        el('p', { class: 'band__text', text: '待っている自動の予定（2 日前のもう一度・前日の夜・当日の朝）は、新しい便の日で作り直します。送り済みのお願いは、そのままです。' })),
      back(),
      bookDock(errorsNode, armedBtn('この便へ移す', to ? `もう一度押すと、${md(to.date)} の便へ移します` : '', () => commitBookMove(t, to), { disabled: !to }))
    ];
  }

  /* 取り消す: 予約と人を名簿から外し、自動の予定と送る準備ができていた連絡も止める。いつ・だれが・なぜは記録に残る */
  function commitBookCancel(t) {
    const r = save('core.cancelBooking', { bookingId: t.b.id, reason: bk.reason });
    if (r.error) { bk.error = '取り消せませんでした。もう一度試してください。'; bk.armed = false; render(); return; }
    done(t.trip.date, `予約を取り消しました: ${bookLead(t)}（${CANCEL_JA[bk.reason]}）。この予約への自動の連絡は止めました`, r.saved);
  }
  function renderBookCancel(bookingId) {
    const t = bookTarget(bookingId);
    if (!t) return bookGone('予約を取り消す');
    const errorsNode = el('p', { class: 'errors', role: 'alert', text: bk.error });
    return [
      ...bookHead('予約を取り消す', t),
      el('div', { class: 'band band--warn' }, el('p', { class: 'band__title', text: '取り消すと' }),
        el('p', { class: 'band__text', text: `この予約の ${Math.max(t.b.people, t.people.length)} 人が、名簿と合同名簿から外れます。` }),
        el('p', { class: 'band__text', text: '自動のお願い・もう一度・当日の質問は、この予約には出なくなります。送る準備ができていた連絡も送りません。' }),
        el('p', { class: 'band__text', text: 'いつ・だれが・なぜ取り消したかは記録に残ります。元には戻せません。' })),
      el('div', { class: 'card form' },
        field('取り消す理由', el('select', { class: 'input', onchange: (e) => { bk.reason = e.target.value; bk.armed = false; render(); } },
          C().BOOKING_CANCEL_REASONS.map(k => el('option', { value: k, selected: k === bk.reason, text: CANCEL_JA[k] }))))),
      back(),
      bookDock(errorsNode, armedBtn('この予約を取り消す', 'もう一度押すと、取り消します', () => commitBookCancel(t)))
    ];
  }

  const SCREENS = { bedit: renderBookEdit, bmove: renderBookMove, bcancel: renderBookCancel };
  /* 画面に入るとき（booking.js の go）。開くたびに、今の予約から入力を作り直す（bookTarget） */
  function enter(next) { if (BOOK_MODES.includes(next)) bk = null; }
  /* 描き直す前（booking.js の render） */
  function beforeRender() { bkPick = null; }

  R.bookingEdit = { MODES: BOOK_MODES, init, enter, beforeRender, render: (mode, bookingId) => SCREENS[mode](bookingId) };
})();
