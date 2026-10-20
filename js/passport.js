/* ダイバーの画面: パスポートを作る・直す・お店に見せる（QR）。中身はこのブラウザの中だけ */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const TP = () => R.TP;
  const root = document.getElementById('passport');
  const QR_MS = 120000;

  let editing = null;      // 直している途中のパスポート。null のときは見ている
  let pick = { ...R.pass.SHARE_DEFAULT };
  let qrUrl = null;
  let qrTimer = null;
  let flash = '';

  const upd = (patch) => { editing = { ...editing, ...patch }; };
  let seq = 0;
  const nextId = () => `p-${(seq += 1)}`;

  /* ---------- 入力の部品 ---------- */
  function input(label, value, onInput, attrs) {
    const id = nextId();
    return el('div', { class: 'field' },
      el('label', { class: 'label', for: id, text: label }),
      el('input', { class: 'input', id, value, oninput: (e) => onInput(e.target.value), ...(attrs || {}) }));
  }

  function select(label, options, value, onChange) {
    const id = nextId();
    return el('div', { class: 'field' },
      el('label', { class: 'label', for: id, text: label }),
      el('select', { class: 'input', id, onchange: (e) => onChange(e.target.value) },
        options.map(o => el('option', { value: o.value, selected: o.value === value, text: o.label }))));
  }

  function radios(name, options, current, onPick) {
    return el('div', { class: 'choices' }, options.map(o =>
      el('label', { class: 'choice' },
        el('input', { type: 'radio', name, value: o.id, checked: current === o.id, onchange: () => onPick(o.id) }),
        el('span', { text: L(o) }))));
  }

  const toDives = (v) => {
    const n = parseInt(v, 10);
    return Number.isInteger(n) && n >= 0 ? n : '';
  };

  /* ---------- 直す ---------- */
  function certRow(c, i) {
    const t = TP();
    const set = (patch) => upd({ certs: editing.certs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    return el('div', { class: 'cert' },
      select(L(t.fAgency), R.AGENCIES.map(a => ({ value: a, label: a })), c.agency, (v) => set({ agency: v })),
      input(L(t.fLevel), c.level, (v) => set({ level: v }), { maxlength: 40, placeholder: 'Open Water Diver' }),
      input(L(t.fNo), c.no, (v) => set({ no: v }), { maxlength: 30 }),
      input(L(t.fCertDate), c.date, (v) => set({ date: v }), { type: 'month' }),
      el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: L(t.delCert),
        onclick: () => { upd({ certs: editing.certs.filter((_, j) => j !== i) }); renderEdit(); } }));
  }

  function medicalGroup() {
    const t = TP();
    const answer = (i, id) => upd({ medical: {
      ...editing.medical,
      answers: editing.medical.answers.map((a, j) => (j === i ? id : a)),
      answeredAt: R.today()
    } });
    return el('fieldset', { class: 'group' },
      el('legend', { class: 'label', text: L(t.fMedical) }),
      el('p', { class: 'note', text: L(t.medicalNote) }),
      R.HEALTH.map((q, i) => el('div', { class: 'hq' },
        el('p', { class: 'hq__q', text: L(q) }),
        radios(`pm${i}`, [{ id: 'yes', ...R.T.yes }, { id: 'no', ...R.T.no }], editing.medical.answers[i], (id) => answer(i, id)))));
  }

  function save(errorsNode) {
    const answered = editing.medical.answers.some(a => a !== null);
    const next = {
      ...editing,
      name: editing.name.trim(),
      medical: { ...editing.medical, answeredAt: answered ? editing.medical.answeredAt : '' },
      updatedAt: new Date().toISOString()
    };
    const check = R.pass.validate(next);
    if (!check.ok) {
      errorsNode.textContent = `${L(TP().invalid)} (${check.errors.join(', ')})`;
      return;
    }
    editing = null;
    flash = L(TP().saved);
    R.passStore.set(next);
  }

  function renderEdit() {
    const t = TP();
    const p = editing;
    const errors = el('p', { class: 'errors', role: 'alert' });
    const form = el('form', { class: 'form', novalidate: true },
      el('div', { class: 'row' },
        input(L(t.fName), p.name, (v) => upd({ name: v }), { maxlength: 60, autocomplete: 'name' }),
        select(L(t.fLang), R.LANGS.map(o => ({ value: o.id, label: o.label })), p.lang, (v) => upd({ lang: v }))),
      el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(t.fSwim) }),
        radios('pswim', R.SWIM, p.swim, (id) => upd({ swim: id }))),
      el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(t.fCerts) }),
        p.certs.map(certRow),
        p.certs.length < R.pass.MAX_CERTS ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: L(t.addCert),
          onclick: () => { upd({ certs: [...editing.certs, { agency: 'PADI', level: '', no: '', date: '' }] }); renderEdit(); } }) : null),
      el('div', { class: 'row' },
        input(L(t.fDives), p.dives, (v) => upd({ dives: toDives(v) }), { type: 'number', min: 0, inputmode: 'numeric' }),
        input(L(t.fLastDive), p.lastDive, (v) => upd({ lastDive: v }), { type: 'month' })),
      medicalGroup(),
      el('div', { class: 'row' },
        input(L(t.fInsurance), p.insurance.name, (v) => upd({ insurance: { ...editing.insurance, name: v } }), { maxlength: 40, placeholder: 'DAN' }),
        input(L(t.fInsuranceNo), p.insurance.no, (v) => upd({ insurance: { ...editing.insurance, no: v } }), { maxlength: 30 })),
      el('div', { class: 'row' },
        select(L(t.fSuit), R.SUITS.map(s => ({ value: s, label: s || '—' })), p.sizes.suit, (v) => upd({ sizes: { ...editing.sizes, suit: v } })),
        input(L(t.fFins), p.sizes.fins, (v) => upd({ sizes: { ...editing.sizes, fins: v } }), { maxlength: 10, placeholder: '24-25' })),
      el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(t.fFlight) }),
        el('div', { class: 'row' },
          input(L(R.T.fFlightDate), p.flight.date, (v) => upd({ flight: { ...editing.flight, date: v } }), { type: 'date' }),
          input(L(R.T.fFlightTime), p.flight.time, (v) => upd({ flight: { ...editing.flight, time: v } }), { type: 'time' }))),
      errors,
      el('div', { class: 'actions' },
        el('button', { class: 'btn', type: 'submit', text: L(t.save) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: L(t.cancel), onclick: () => { editing = null; render(); } })));
    form.addEventListener('submit', (e) => { e.preventDefault(); save(errors); });
    root.replaceChildren(el('div', { class: 'card' }, el('h2', { class: 'h2', text: L(t.title) }), form));
  }

  /* ---------- お店に見せる ---------- */
  function hideQr() {
    clearTimeout(qrTimer);
    qrUrl = null;
    const area = root.querySelector('#qr-area');
    if (area) area.replaceChildren();
  }

  function fillQr(area) {
    const t = TP();
    const img = R.qrSvg ? R.qrSvg(qrUrl) : null;
    R.fill(area,
      img || el('p', { class: 'note', text: L(t.qrFail) }),
      img ? null : el('p', { class: 'qr__url', text: qrUrl }),
      el('div', { class: 'actions' },
        el('a', { class: 'btn btn--ghost btn--small', href: qrUrl, target: '_blank', rel: 'noopener', text: L(t.openHere) }),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: L(t.hideQr), onclick: hideQr })),
      el('p', { class: 'note', text: L(t.qrNote) }));
  }

  async function showQr(p) {
    const code = await R.codec.encode(R.pass.toShare(p, pick));
    qrUrl = R.codec.passUrl(code);
    clearTimeout(qrTimer);
    qrTimer = setTimeout(hideQr, QR_MS);
    const area = root.querySelector('#qr-area');
    if (area) fillQr(area);
  }

  function sharePanel(p) {
    const t = TP();
    const checks = el('div', { class: 'choices choices--col' }, R.SHARE_ITEMS.map(o =>
      el('label', { class: 'choice' },
        el('input', { type: 'checkbox', checked: pick[o.id], onchange: (e) => { pick = { ...pick, [o.id]: e.target.checked }; hideQr(); } }),
        el('span', { text: L(o) }))));
    const area = el('div', { class: 'qr', id: 'qr-area', 'aria-live': 'polite' });
    if (qrUrl) fillQr(area);
    return el('div', { class: 'card' },
      el('h2', { class: 'h2', text: L(t.shareTitle) }),
      el('p', { class: 'note', text: L(t.shareLead) }),
      checks,
      el('div', { class: 'actions' }, el('button', { class: 'btn', type: 'button', text: L(t.showQr), onclick: () => showQr(p) })),
      area);
  }

  /* ---------- 見る ---------- */
  function renderEmpty() {
    const t = TP();
    root.replaceChildren(el('div', { class: 'card' },
      el('h2', { class: 'h2', text: L(t.title) }),
      el('p', { class: 'lead', text: L(t.lead) }),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', type: 'button', text: L(t.create), onclick: () => { editing = { ...R.pass.blank(), lang: R.lang }; render(); } }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: L(t.sample), onclick: () => R.passStore.set(R.samplePass()) }))));
  }

  function render() {
    if (editing) { renderEdit(); return; }
    const p = R.passStore.get();
    if (!p) { renderEmpty(); return; }
    const t = TP();
    root.replaceChildren(
      el('div', { class: 'card' },
        el('h2', { class: 'h2', text: L(t.title) }),
        flash ? el('p', { class: 'flash', role: 'status', text: flash }) : null,
        R.rowsList(R.shareRows(R.fullShare(p))),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', type: 'button', text: L(t.edit), onclick: () => { hideQr(); editing = { ...p }; render(); } }),
          el('button', { class: 'btn btn--ghost', type: 'button', text: L(t.remove),
            onclick: () => { if (window.confirm(L(t.confirmRemove))) { hideQr(); R.passStore.clear(); } } }))),
      sharePanel(p));
    flash = '';
  }

  R.renderPassport = render;
  R.passStore.subscribe(() => {
    hideQr();
    if (!document.getElementById('view-pass').hidden) render();
  });
})();
