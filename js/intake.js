/* 予約前の確認: ツアーの中身を正直に見せ、泳ぎ・経験・心配・健康・帰りの便を聞く。
   判定はしない。送られた内容はお店の画面に入り、お店が気づくための印が付く */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const T = () => R.T;
  const root = document.getElementById('intake');
  const tourRoot = document.getElementById('tour');   // 画面の題・ツアー・このツアーのこと（入力の form の外。選んだツアーは draft に持つ）

  function blank() {
    const day = R.ymd(R.addDays(new Date(), 2));
    return {
      tour: 'dive', date: day, people: 2, name: '', lang: R.lang, swim: '', exp: '', dives: '', worries: [],
      consent: false, answers: R.HEALTH.map(() => null), medicalAt: '',
      flightMode: 'unknown', flightDate: day, flightTime: '', source: 'form'
    };
  }

  let draft = blank();
  let doneId = null;
  let savedNote = '';
  const set = (patch) => { draft = { ...draft, ...patch }; };

  /* ---------- パスポートとの行き来（決まった対応表。AI は使わない） ---------- */
  function passToDraft(p) {
    const answered = Boolean(p.medical.answeredAt);
    const exp = p.certs.length ? 'card' : p.dives > 0 ? 'few' : (p.dives === 0 ? 'first' : draft.exp);
    return {
      name: p.name, lang: p.lang, swim: p.swim || draft.swim, exp,
      dives: p.dives === '' ? '' : String(p.dives),
      consent: answered, answers: answered ? [...p.medical.answers] : R.HEALTH.map(() => null),
      medicalAt: p.medical.answeredAt,
      flightMode: p.flight.date ? 'set' : draft.flightMode,
      flightDate: p.flight.date || draft.flightDate,
      flightTime: p.flight.time || draft.flightTime,
      source: 'passport'
    };
  }

  function intakeToPass(x, base) {
    const p = base || { ...R.pass.blank(), lang: R.LANGS.some(o => o.id === x.lang) ? x.lang : 'ja' };
    const dives = parseInt(x.dives, 10);
    return {
      ...p,
      name: x.name, lang: x.lang, swim: x.swim,
      dives: Number.isInteger(dives) && dives >= 0 ? dives : (x.exp === 'first' ? 0 : p.dives),
      medical: x.health.consent ? { form: R.pass.FORM, answeredAt: x.medicalAt, answers: [...x.health.answers] } : p.medical,
      flight: x.flight.mode === 'set' ? { date: x.flight.date, time: x.flight.time } : p.flight,
      updatedAt: new Date().toISOString()
    };
  }

  function passBanner() {
    const tp = R.TP;
    const p = R.passStore.get();
    if (draft.source === 'passport') {
      const text = draft.medicalAt ? L(tp.filledNote).replace('{date}', draft.medicalAt) : L(tp.filledNoMedical);
      return el('p', { class: 'flash', role: 'status', text });
    }
    if (!p) return null;
    return el('div', { class: 'passbar' },
      el('span', { text: `${L(tp.fromPass)}: ${p.name}` }),
      el('button', { class: 'btn btn--small', type: 'button', text: L(tp.fillFromPass),
        onclick: () => { set(passToDraft(p)); renderForm(); } }));
  }

  /* ---------- 部品 ---------- */
  function field(labelText, control, id) {
    return el('div', { class: 'field' }, el('label', { class: 'label', for: id, text: labelText }), control);
  }

  function group(legend, ...kids) {
    return el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: legend }), ...kids);
  }

  function choices(name, options, isOn, onPick, type) {
    return el('div', { class: R.choiceClass(options.map(L)) }, options.map(o =>
      el('label', { class: 'choice' },
        el('input', { type: type || 'radio', name, value: o.id, checked: isOn(o.id), onchange: (e) => onPick(o.id, e.target.checked) }),
        el('span', { text: L(o) }))));
  }

  /* このツアーのこと: 罫線の表（色の箱にしない）。時間と料金は数字の書体 */
  function factsBox() {
    const tour = R.TOURS.find(t => t.id === draft.tour);
    const row = (k, v) => el('div', { class: 'facts__row' }, el('span', { class: 'facts__k', text: k }), el('p', { class: 'facts__v' }, v));
    return el('div', { class: 'facts', id: 'facts', 'aria-label': L(T().factsTitle) },
      row(L(T().factTime), el('span', { class: 'facts__fig', text: `${tour.start}–${tour.end}` })),
      tour.facts.map(f => row('', L(f))),
      row(L(T().factPrice), [el('span', { class: 'facts__price', text: tour.price }), R.lang === 'en' ? ' yen' : ' 円']));
  }

  function renderTour() {
    const t = T();
    R.fill(tourRoot,
      el('h1', { class: 'page__h1', text: L(t.intakeTitle) }),
      el('section', { class: 'guest-sec' },
        el('h2', { class: 'h2', text: L(t.fTour) }),
        choices('tour', R.TOURS.map(x => ({ id: x.id, ...x.name })), (id) => draft.tour === id,
          (id) => { set({ tour: id }); swap('facts', factsBox()); }),
        factsBox()));
  }

  function healthGroup() {
    const disabled = !draft.consent;
    const rows = R.HEALTH.map((q, i) => el('div', { class: 'hq' },
      el('p', { class: 'hq__q', text: L(q) }),
      choices(`h${i}`, [{ id: 'yes', ...T().yes }, { id: 'no', ...T().no }],
        (id) => draft.answers[i] === id,
        (id) => set({ answers: draft.answers.map((a, j) => (j === i ? id : a)), medicalAt: R.today() }))));
    const wrap = el('div', { class: 'hq-wrap', id: 'hq' }, rows);
    wrap.querySelectorAll('input').forEach(inp => { inp.disabled = disabled; });
    return wrap;
  }

  function flightInputs() {
    const off = draft.flightMode !== 'set';
    const date = el('input', { class: 'input', type: 'date', id: 'f-fdate', value: draft.flightDate, disabled: off,
      onchange: (e) => set({ flightDate: e.target.value }) });
    const time = el('input', { class: 'input', type: 'time', id: 'f-ftime', value: draft.flightTime, disabled: off,
      onchange: (e) => set({ flightTime: e.target.value }) });
    return el('div', { class: 'row', id: 'flight' },
      field(L(T().fFlightDate), date, 'f-fdate'), field(L(T().fFlightTime), time, 'f-ftime'));
  }

  const swap = (id, node) => { const old = root.querySelector(`#${id}`) || tourRoot.querySelector(`#${id}`); if (old) old.replaceWith(node); };

  /* ---------- 入力の画面 ---------- */
  function renderForm() {
    const t = T();
    const errors = el('p', { class: 'errors', id: 'errors', role: 'alert' });

    const basics = el('div', { class: 'row' },
      field(L(t.fDate), el('input', { class: 'input', type: 'date', id: 'f-date', value: draft.date, onchange: (e) => set({ date: e.target.value }) }), 'f-date'),
      field(L(t.fPeople), el('input', { class: 'input', type: 'number', id: 'f-people', min: 1, max: 10, value: draft.people, onchange: (e) => set({ people: Number(e.target.value) || 1 }) }), 'f-people'));

    const who = el('div', { class: 'row' },
      field(L(t.fName), el('input', { class: 'input', type: 'text', id: 'f-name', maxlength: 60, autocomplete: 'name', value: draft.name, oninput: (e) => set({ name: e.target.value }) }), 'f-name'),
      field(L(t.fLang), el('select', { class: 'input', id: 'f-lang', onchange: (e) => set({ lang: e.target.value }) },
        R.LANGS.map(o => el('option', { value: o.id, selected: draft.lang === o.id, text: o.label }))), 'f-lang'));

    const dives = el('div', { class: 'field', id: 'dives', hidden: draft.exp !== 'card' },
      el('label', { class: 'label', for: 'f-dives', text: L(t.fDives) }),
      el('input', { class: 'input input--short', type: 'number', id: 'f-dives', min: 0, value: draft.dives, onchange: (e) => set({ dives: e.target.value }) }));

    const swim = group(L(t.fSwim), choices('swim', R.SWIM, (id) => draft.swim === id, (id) => set({ swim: id })));
    const exp = group(L(t.fExp), choices('exp', R.EXP, (id) => draft.exp === id,
      (id) => { set({ exp: id }); root.querySelector('#dives').hidden = id !== 'card'; }), dives);
    const worries = group(L(t.fWorries), choices('worries', R.WORRIES, (id) => draft.worries.includes(id),
      (id, on) => set({ worries: on ? [...draft.worries, id] : draft.worries.filter(w => w !== id) }), 'checkbox'));

    const consent = el('label', { class: 'consent' },
      el('input', { type: 'checkbox', checked: draft.consent, onchange: (e) => { set({ consent: e.target.checked }); swap('hq', healthGroup()); } }),
      el('span', { text: L(t.consent) }));
    const health = group(L(t.fHealth), el('p', { class: 'note', text: L(t.healthNote) }), consent, healthGroup());

    const flight = group(L(t.fFlight),
      choices('flightMode', [{ id: 'set', ...t.flightSet }, { id: 'unknown', ...t.flightUnknown }, { id: 'none', ...t.flightNone }],
        (id) => draft.flightMode === id, (id) => { set({ flightMode: id }); swap('flight', flightInputs()); }),
      flightInputs());

    const form = el('form', { class: 'form', novalidate: true },
      basics, who, swim, exp, worries, health, flight, errors,
      el('button', { class: 'btn btn--big', type: 'submit', text: L(t.submit) }));
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(errors); });

    renderTour();
    R.fill(root, passBanner(), form);
  }

  function submit(errorsNode) {
    const t = T();
    const problems = [
      !draft.tour && L(t.errTour),
      !draft.date && L(t.errDate),
      !draft.name.trim() && L(t.errName)
    ].filter(Boolean);
    if (problems.length) {
      errorsNode.textContent = problems.join(' / ');
      return;
    }
    const intake = {
      id: R.newId(), at: new Date().toISOString(), tour: draft.tour, date: draft.date, people: draft.people,
      name: draft.name.trim(), lang: draft.lang, swim: draft.swim, exp: draft.exp, dives: draft.dives,
      worries: [...draft.worries],
      health: { consent: draft.consent, answers: draft.consent ? [...draft.answers] : R.HEALTH.map(() => null) },
      medicalAt: draft.consent ? (draft.medicalAt || R.today()) : '',
      flight: { mode: draft.flightMode, date: draft.flightMode === 'set' ? draft.flightDate : '', time: draft.flightMode === 'set' ? draft.flightTime : '' },
      source: draft.source,
      checked: false
    };
    R.store.update(s => ({ ...s, intakes: [intake, ...s.intakes] }));
    doneId = intake.id;
    render();
  }

  /* ---------- 送ったあとの画面 ---------- */
  function passSave(intake) {
    const tp = R.TP;
    if (savedNote) return el('p', { class: 'flash', role: 'status', text: savedNote });
    if (intake.source === 'passport') return null;
    const p = R.passStore.get();
    return el('div', { class: 'passbar passbar--col' },
      el('span', { text: L(tp.saveLead) }),
      el('button', { class: 'btn btn--small', type: 'button', text: L(p ? tp.updatePass : tp.saveToPass),
        onclick: () => { savedNote = L(tp.savedToPass); R.passStore.set(intakeToPass(intake, p)); render(); } }));
  }

  function renderDone() {
    const t = T();
    const s = R.store.get();
    const intake = s.intakes.find(x => x.id === doneId);
    if (!intake) {
      // お店の画面で受付を最初の状態に戻したとき。入力の画面に戻る
      doneId = null;
      renderForm();
      return;
    }
    const { flags } = R.assess(intake, s);
    const msgs = R.guestMessages(intake, flags);
    tourRoot.replaceChildren();
    root.replaceChildren(
      el('div', { class: 'done' },
        el('h2', { class: 'h2', text: L(t.doneTitle) }),
        el('p', { class: 'lead', text: L(t.doneBody) }),
        msgs.length ? el('ul', { class: 'done__list' }, msgs.map(m => el('li', { text: L(m) }))) : null,
        passSave(intake),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', type: 'button', text: L(t.seeShop), onclick: () => R.showTab('shop') }),
          el('button', { class: 'btn btn--ghost', type: 'button', text: L(t.again), onclick: () => { doneId = null; savedNote = ''; draft = blank(); render(); } }))));
  }

  function render() {
    if (doneId) renderDone(); else renderForm();
  }

  R.renderIntake = render;
  // パスポートが作られた・消されたときは、入力の画面の「パスポートで埋める」を出し直す
  R.passStore.subscribe(() => { if (!doneId) renderForm(); });
})();
