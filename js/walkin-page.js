/* 店頭の QR の画面（walkin.html）の起動（entry）。店頭に貼った QR の # の後ろの鍵で、今日・明日の便（日付・時刻・ツアーの名前だけ）を /api/walkin から受け取り、
   便を選んで、名簿の項目（代表者の名前・人数・生年月日・住所・緊急時の連絡先、メールは任意）を入れてもらう。健康の質問はここでは聞かない。
   ほかのお客さんの名前も人数も、この画面には出ない。検査と置き場所は Worker（worker/walkin-core.mjs）。画面でも空欄だけは先に知らせる。
   鍵は # の後ろだけに置き（サーバーの記録・Referer に残さない）、開いたら URL と履歴から消す。決定ログ 2026-10-28 walkin-qr */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const root = document.getElementById('walkin');

  const T = {
    sub: { ja: 'ご来店の受付', en: 'Check-in' },
    langBtn: { ja: 'English', en: '日本語' },
    loading: { ja: '読み込んでいます…', en: 'Loading…' },
    gone: { ja: 'この QR は使えません。スタッフに声をかけてください。', en: 'This QR code does not work. Please ask a staff member.' },
    offline: { ja: 'つながりませんでした。電波を確かめて、もう一度読み取ってください。', en: 'Could not connect. Check your connection and scan the code again.' },
    limit: { ja: '今日はこれ以上受け付けられません。スタッフに声をかけてください。', en: 'We cannot take more entries today. Please ask a staff member.' },
    title: { ja: 'ご来店ありがとうございます', en: 'Welcome' },
    pickLead: { ja: '参加するツアーを選んでください', en: 'Choose your tour' },
    today: { ja: '今日', en: 'Today' },
    tomorrow: { ja: '明日', en: 'Tomorrow' },
    noStart: { ja: '時刻未定', en: 'Time to be set' },
    ask: { ja: 'スタッフに聞く', en: 'Ask the staff' },
    askSub: { ja: '便が分からないときは、スタッフが決めます', en: 'The staff will pick it for you' },
    next: { ja: '次へ', en: 'Next' },
    back: { ja: '戻る', en: 'Back' },
    formLead: { ja: 'お名前などを入力してください', en: 'Please enter your details' },
    law: { ja: '県の条例で、お店が名簿を作って 1 年残します。入力はスタッフが確認してから名簿に入ります。健康のことは、ここでは聞きません。',
      en: 'Okinawa rules require the shop to keep a list of participants for one year. ' +
        'Staff will check what you enter before it goes on the list. We do not ask about health here.' },
    name: { ja: '代表者のお名前', en: 'Name of the lead person' },
    people: { ja: '人数（ご自身を入れて）', en: 'Number of people (including you)' },
    birthDate: { ja: '生年月日', en: 'Date of birth' },
    address: { ja: '住所', en: 'Address' },
    emergency: { ja: '緊急時の連絡先', en: 'Emergency contact' },
    eName: { ja: 'お名前', en: 'Name' },
    eRelation: { ja: 'ご関係（任意）', en: 'Relation (optional)' },
    ePhone: { ja: '電話番号', en: 'Phone number' },
    email: { ja: 'メールアドレス（任意）', en: 'Email (optional)' },
    submit: { ja: '送る', en: 'Send' },
    sending: { ja: '送っています…', en: 'Sending…' },
    needs: { ja: '確かめてください: ', en: 'Please check: ' },
    failed: { ja: '送れませんでした。もう一度押してください。', en: 'Could not send. Please try again.' },
    doneTitle: { ja: '送りました', en: 'Sent' },
    doneText: { ja: 'スタッフに声をかけてください。確認のあと、名簿に入ります。', en: 'Please tell a staff member. Your details go on the list after they check.' }
  };
  const FIELD_JA = { name: T.name, people: T.people, birthDate: T.birthDate, address: T.address, emergency: T.emergency, email: T.email, trip: T.pickLead };

  const STORE = 'redux-walkin-key';
  /* # の後ろに鍵があれば移して URL から消す。無ければ、このタブで前に開いた鍵（読み込み直し） */
  function takeKey() {
    const m = /^#w=([A-Za-z0-9_-]{43})$/.exec(location.hash);
    if (m) {
      try { sessionStorage.setItem(STORE, m[1]); } catch (e) { /* 移せなくても、この表示の間は使える */ }
      history.replaceState(null, '', location.pathname);
      return m[1];
    }
    try { return sessionStorage.getItem(STORE) || ''; } catch (e) { return ''; }
  }
  const forget = () => { try { sessionStorage.removeItem(STORE); } catch (e) { /* 消せなくても、送った内容は残らない */ } };
  const key = takeKey();

  let view = null;                // { shop, today, trips: [{ id, date, start, tour, kind }] }
  let failed = null;              // 画面全体のエラー文
  let step = 'trip';              // trip / form / done
  let tripId = null;              // null = まだ選んでいない、'' = スタッフに聞く
  let sending = false;
  let problems = [];              // 直してほしい項目の名前
  let message = null;             // 送れなかったときの文
  const draft = { name: '', people: '1', birthDate: '', address: '', emergency: { name: '', relation: '', phone: '' }, email: '' };

  const kindJa = { dive: 'ダイビング', snorkel: 'スノーケル' };
  const clock = (t) => (t ? t.replace(/^0/, '') : L(T.noStart));
  const tourName = (t) => t.tour || kindJa[t.kind] || '';
  const dayName = (t) => (t.date === view.today ? L(T.today) : L(T.tomorrow));

  const field = (label, control) => el('label', { class: 'field' }, el('span', { class: 'label', text: L(label) }), control);
  const input = (get, set, attrs) => el('input', { class: 'input', value: get(), ...attrs, oninput: (e) => set(e.target.value) });

  function renderTrip() {
    const big = (value, title, sub) => el('button', { class: 'big', type: 'button', 'aria-pressed': String(tripId === value),
      onclick: () => { tripId = value; render(); } }, title, el('small', { text: sub }));
    return [
      el('h2', { class: 'page__title', text: L(T.title) }),
      el('p', { class: 'page__sub', text: view.shop }),
      el('p', { class: 'note', text: L(T.pickLead) }),
      view.trips.map(t => big(t.id, `${clock(t.start)}　${tourName(t)}`, dayName(t))),
      big('', L(T.ask), L(T.askSub)),
      R.dock(el('button', { class: 'btn', type: 'button', disabled: tripId === null, text: L(T.next), onclick: () => { step = 'form'; render(); } }))
    ];
  }

  const bad = (name) => problems.includes(name);

  function renderForm() {
    const e = draft.emergency;
    const sub = (k, label, type, max) => el('input', { class: 'input', type, value: e[k], maxlength: max, placeholder: L(label), 'aria-label': L(label),
      oninput: (ev) => { e[k] = ev.target.value; } });
    const names = problems.map(p => L(FIELD_JA[p] || T.failed)).join(' / ');
    const errors = el('p', { class: 'errors', role: 'alert', text: problems.length ? `${L(T.needs)}${names}` : message ? L(message) : '' });
    return [
      el('h2', { class: 'page__title', text: L(T.formLead) }),
      el('p', { class: 'note', text: L(T.law) }),
      el('form', { class: 'card form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); submit(); } },
        field(T.name, input(() => draft.name, (v) => { draft.name = v; }, { type: 'text', maxlength: 60, autocomplete: 'name', 'aria-invalid': String(bad('name')) })),
        field(T.people, input(() => draft.people, (v) => { draft.people = v; }, { type: 'number', min: 1, max: 10, inputmode: 'numeric', class: 'input input--short' })),
        field(T.birthDate, input(() => draft.birthDate, (v) => { draft.birthDate = v; }, { type: 'date', max: view.today, autocomplete: 'bday' })),
        field(T.address, input(() => draft.address, (v) => { draft.address = v; }, { type: 'text', maxlength: 120, autocomplete: 'street-address' })),
        el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(T.emergency) }),
          sub('name', T.eName, 'text', 60), sub('relation', T.eRelation, 'text', 20), sub('phone', T.ePhone, 'tel', 30)),
        field(T.email, input(() => draft.email, (v) => { draft.email = v; }, { type: 'email', maxlength: 254, autocomplete: 'email' })),
        errors,
        R.dock(el('button', { class: 'btn', type: 'submit', disabled: sending, text: L(sending ? T.sending : T.submit) }),
          el('button', { class: 'btn btn--ghost', type: 'button', disabled: sending, text: L(T.back),
            onclick: () => { step = 'trip'; problems = []; message = null; render(); } })))
    ];
  }

  function renderDone() {
    return [el('h2', { class: 'page__title', text: L(T.doneTitle) }), el('p', { class: 'note', text: L(T.doneText) })];
  }

  /* 空の欄は先に知らせる。ほかの検査（長さ・日付・名前に使えない字）は Worker が名簿と同じ式でかける */
  function localProblems() {
    const e = draft.emergency;
    return [!draft.name.trim() && 'name', !draft.birthDate && 'birthDate', !draft.address.trim() && 'address', (!e.name.trim() || !e.phone.trim()) && 'emergency',
      !(Number.isInteger(Number(draft.people)) && Number(draft.people) >= 1) && 'people'].filter(Boolean);
  }

  async function submit() {
    problems = localProblems();
    message = null;
    if (problems.length) { render(); return; }
    sending = true;
    render();
    const r = await R.askApi.walkin({ k: key, action: 'submit', tripId, name: draft.name, people: Number(draft.people), email: draft.email, birthDate: draft.birthDate,
      address: draft.address, emergency: { ...draft.emergency } });
    sending = false;
    if (r.status === 202) { forget(); step = 'done'; render(); return; }
    if (r.status === 400 && r.data && Array.isArray(r.data.problems)) problems = r.data.problems.filter(p => typeof p === 'string');
    else if (r.status === 404) failed = T.gone;
    else if (r.status === 429) failed = T.limit;
    else message = r.status === 0 ? T.offline : T.failed;
    render();
  }

  function frame() {
    document.getElementById('brandSub').textContent = L(T.sub);
    document.getElementById('lang').textContent = L(T.langBtn);
    document.documentElement.lang = R.lang;
  }

  function render() {
    frame();
    if (failed) { R.fill(root, el('p', { class: 'empty', text: L(failed) })); return; }
    if (!view) { R.fill(root, el('p', { class: 'note', text: L(T.loading) })); return; }
    R.fill(root, step === 'done' ? renderDone() : step === 'form' ? renderForm() : renderTrip());
  }

  const isView = (v) => !!v && typeof v === 'object' && typeof v.shop === 'string' && typeof v.today === 'string' && Array.isArray(v.trips);

  async function start() {
    if (!key) { failed = T.gone; render(); return; }
    const r = await R.askApi.walkin({ k: key, action: 'view' });
    if (r.status !== 200 || !isView(r.data)) {
      failed = r.status === 0 ? T.offline : r.status === 429 ? T.limit : T.gone;
      render();
      return;
    }
    view = r.data;
    render();
  }

  document.getElementById('lang').addEventListener('click', () => R.guestLang.set(R.lang === 'ja' ? 'en' : 'ja'));
  R.onLang(render);
  R.lang = R.guestLang.get();
  render();
  /* 開いたまま別の QR を開いたとき（# だけが変わってページは読み直されない） */
  window.addEventListener('hashchange', () => location.reload());
  start();
})();
