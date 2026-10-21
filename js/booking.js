/* 予約の画面（お店、日本語のみ）: 予約の一覧 / 予約サイトのメールを取り込む / 電話などの予約を足す。
   予約と名簿は R.rosterStore（core.js）、形は roster-schema.js、組み立てと判断は roster-core.js、AI は ai-reader.js だけを通す。
   この画面は、入力を集めて core を呼び、結果を描くだけ。
   AI やお客さんの文字は el() の text で出す（HTML として入れない）。電話番号はリンクにしない */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const root = document.getElementById('booking');
  const C = () => R.rosterCore;

  const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  const SOURCE_JA = { mail: 'メールから', form: '自社の予約フォーム', phone: '電話などの予約', partner: '乗り合い' };
  const KIND_JA = { dive: 'ダイビング', snorkel: 'スノーケル' };
  const ERROR_JA = {
    input: '送れない文面です。届いたメールの本文をそのまま貼ってください（メールのソースは読めません）',
    auth: '合言葉か、ログインを確かめてください',
    limit: '今日か今月の上限に達しました。見本の読み取りでは続けられます',
    offline: '届きませんでした。通信を確かめて、もう一度試してください',
    bad: 'AI の答えが形に合わなかったので、使いませんでした。もう一度試すか、電話などの予約から手で入れてください'
  };
  const PROBLEM_JA = { date: '日付', people: '人数（1〜30）', leadName: '代表者の名前（60 字まで）', leadPhone: '電話（30 字まで）', note: 'メモ（400 字まで）' };
  const NOT_SAVED = 'この端末に保存できませんでした。画面を閉じると消えます。';

  let mode = 'list';        // list / mail / phone
  let day = '';
  let notice = null;        // { kind: 'ok' | 'warn', text }
  let armedReset = false;
  let mail = blankMail();
  let phone = blankPhone();

  function blankMail() { return { text: '', sampleId: null, shown: null, reading: null, tripId: '', kind: '', busy: false, error: '' }; }
  function blankPhone() {
    return { date: day, start: '', tourId: R.TOURS[0].id, leadName: '', leadPhone: '', people: '1', source: 'phone', note: '', tripId: '' };
  }

  const now = () => new Date().toISOString();
  function md(d) {
    if (!d) return '日付なし';
    const [y, m, dd] = d.split('-').map(Number);
    return `${m}/${dd}（${WEEK[new Date(y, m - 1, dd).getDay()]}）`;
  }
  const clock = (t) => t.replace(/^0/, '');
  const tripLabel = (t) => `${t.start ? `${t.start < '12:00' ? '午前便' : '午後便'} ${clock(t.start)}` : '時刻未定の便'} ${t.tour || KIND_JA[t.kind]}`;
  const tour = (id) => R.TOURS.find(t => t.id === id);

  /* 保存は rosterStore を通す。形が合わなければ例外、端末に書けなければ saved: false */
  function save(fn) {
    try {
      return { error: null, saved: R.rosterStore.update(fn) };
    } catch (e) {
      return { error: e, saved: false };
    }
  }

  function go(next) {
    mode = next;
    notice = null;
    armedReset = false;
    if (next === 'mail') mail = blankMail();
    if (next === 'phone') phone = blankPhone();
    render();
  }

  /* 予約を入れたあと、一覧に戻って知らせる */
  function done(date, text, saved) {
    day = date;
    notice = saved ? { kind: 'ok', text } : { kind: 'warn', text: `${text}。${NOT_SAVED}` };
    mode = 'list';
    render();
  }

  const head = (title) => [
    el('p', { class: 'note', text: `${R.rosterStore.get().shop.name} お店の画面` }),
    el('h2', { class: 'h2 h2--big', text: title })
  ];
  const back = () => el('p', { class: 'reset' }, el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: '予約の一覧に戻る', onclick: () => go('list') }));
  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { class: 'label', text: label }), control, hint ? el('span', { class: 'note', text: hint }) : null);

  /* ---------- 予約の一覧 ---------- */
  function bookingLine(row) {
    const b = row.booking;
    const total = row.people.length;
    const unsure = row.people.some(p => p.unsure.length);
    const waiting = row.people.filter(p => !p.done).length;
    const chip = unsure ? ['warn', '確かめる'] : [waiting ? 'info' : 'ok', `名簿 ${row.done} / ${total}`];
    const lead = b.leadName || (row.people[0] && row.people[0].name) || '名前の分からない予約';
    const others = Math.max(b.people, total) - 1;
    const where = b.site ? `${b.site}（${SOURCE_JA[b.source]}）` : SOURCE_JA[b.source];
    const status = unsure ? 'AI が自信なしと言った所を、お店が確かめる' : waiting ? `${waiting} 人分の入力を待っている` : 'そろった';
    return el('li', { class: 'bk' },
      el('div', { class: 'bk__top' },
        el('span', { class: 'bk__name', text: others > 0 ? `${lead} ほか ${others} 人` : lead }),
        el('span', { class: `chip chip--${chip[0]}`, text: chip[1] })),
      el('div', { class: 'bk__meta', text: `${where} ${status}` }));
  }

  function tripCard(s, trip) {
    const rows = C().bookingRows(s, trip.id);
    return el('section', { class: 'card trip', 'aria-label': tripLabel(trip) },
      el('div', { class: 'trip__head' },
        el('h3', { class: 'trip__title', text: tripLabel(trip) }),
        el('span', { class: 'trip__count', text: `${C().tripSummary(s, trip.id).booked} 人` })),
      rows.length ? el('ul', { class: 'bks' }, rows.map(bookingLine)) : el('p', { class: 'note', text: 'この便の予約はまだありません' }));
  }

  function resetButton() {
    return el('p', { class: 'reset' }, el('button', {
      class: 'btn btn--ghost btn--small', type: 'button',
      text: armedReset ? 'もう一度押すと、デモの予約がすべて消えます' : 'デモの予約をすべて消す',
      onclick: () => {
        if (!armedReset) { armedReset = true; render(); return; }
        armedReset = false;
        R.rosterStore.reset();
        go('list');
      }
    }));
  }

  /* 開いたときの日付: 今日以降でいちばん近い日。無ければいちばん新しい日 */
  function pickDay(dates) {
    if (dates.includes(day)) return day;
    const today = R.today();
    return dates.find(d => d >= today) || dates[dates.length - 1] || '';
  }

  function renderList() {
    const s = R.rosterStore.get();
    const trips = C().tripList(s);
    const dates = [...new Set(trips.map(t => t.date))];
    day = pickDay(dates);
    return [
      ...head('予約'),
      R.rosterStore.recovered() ? el('p', { class: 'flag flag--warn', text: '保存されていた名簿が読めなかったので、この端末の別の場所に残して、空の名簿から始めました。' }) : null,
      notice ? el('p', { class: `flag flag--${notice.kind}`, role: 'status', text: notice.text }) : null,
      dates.length ? el('div', { class: 'days', role: 'group', 'aria-label': '日付' }, dates.map(d => el('button', {
        class: 'day', type: 'button', 'aria-pressed': String(d === day), text: md(d),
        onclick: () => { day = d; notice = null; armedReset = false; render(); }
      }))) : null,
      dates.length
        ? trips.filter(t => t.date === day).map(t => tripCard(s, t))
        : el('div', { class: 'card' }, el('p', { class: 'lead', text: 'まだ予約がありません。「予約サイトのメールを貼る」で、見本のメールから試せます。' })),
      el('div', { class: 'actions actions--stack' },
        el('button', { class: 'btn btn--big', type: 'button', text: '予約サイトのメールを貼る', onclick: () => go('mail') }),
        el('button', { class: 'btn btn--ghost btn--big', type: 'button', text: '電話などの予約を足す', onclick: () => go('phone') })),
      s.trips.length ? resetButton() : null
    ];
  }

  /* ---------- 入れる便を選ぶ（メールと電話で同じ）。新しい便のときは、種類も選べる ---------- */
  function tripPicker(want, draft, repaint) {
    const sug = C().suggestTrip(R.rosterStore.get(), want);
    if (!draft.tripId) draft.tripId = sug.tripId || 'new';
    const select = el('select', { class: 'input', onchange: (e) => { draft.tripId = e.target.value; repaint(); } },
      sug.candidates.map(t => el('option', { value: t.id, selected: t.id === draft.tripId, text: `${md(t.date)} ${tripLabel(t)}` })),
      el('option', { value: 'new', selected: draft.tripId === 'new', text: `新しい便を作る（${md(want.date)} ${want.start ? clock(want.start) : '時刻未定'}）` }));
    const kindSelect = draft.tripId === 'new' && draft.kind !== undefined ? field('新しい便の種類', el('select', {
      class: 'input', onchange: (e) => { draft.kind = e.target.value; draft.tripId = ''; repaint(); }
    }, Object.entries(KIND_JA).map(([k, ja]) => el('option', { value: k, selected: k === sug.kind, text: ja })))) : null;
    return el('div', { class: 'picker' },
      field('入れる便', select, sug.candidates.length > 1 && !sug.tripId ? 'この日の便がいくつかあります。入れる便を選んでください' : null),
      kindSelect);
  }

  /* ---------- 予約サイトのメールを取り込む ---------- */
  const matchSample = (text) => Object.keys(R.SAMPLE_MAILS).find(id => R.SAMPLE_MAILS[id].text === text.replace(/\r\n?/g, '\n').trimEnd()) || null;
  let mailOut = null;
  let mailInputs = [];      // 読んでいる間は押せなくする入力欄とボタン

  function readRow(label, value, unsure) {
    return el('div', { class: `rd${unsure ? ' rd--unsure' : ''}` },
      el('span', { class: 'rd__k', text: label }),
      el('span', { class: 'rd__v', text: value || '（メールに無い）' }),
      unsure ? el('span', { class: 'chip chip--warn', text: '自信なし' }) : null);
  }

  function mailWant() {
    const b = mail.reading.booking;
    return { date: b.date, start: b.start, tour: b.tour, kind: mail.kind };
  }

  function missingText(kind) {
    const { unknown, items } = C().missingForReading(mail.reading, kind);
    return `${unknown > 0 ? `${unknown} 人の名前と、` : ''}${items.map(i => i.ja).join('・')}。予約を入れたあと、お客さんに入力してもらいます。`;
  }

  function mailResult() {
    const r = mail.reading;
    const b = r.booking;
    if (!b || !b.date) {
      return el('p', { class: 'errors', role: 'alert', text: '予約の日付を読めませんでした。「電話などの予約を足す」から手で入れてください。' });
    }
    const u = new Set(b.unsure);
    const want = mailWant();
    const kind = C().suggestTrip(R.rosterStore.get(), want).kind;
    const names = r.people.map(p => p.name).filter(Boolean);
    return [
      el('div', { class: 'card card--flat' },
        el('h3', { class: 'h3', text: 'AI が読んだ結果' }),
        readRow('予約サイト', `${b.site}${b.ref ? `（${b.ref}）` : ''}`, u.has('site') || u.has('ref')),
        readRow('日時', `${md(b.date)} ${b.start ? clock(b.start) : '時刻はメールに無い'}`, u.has('date') || u.has('start')),
        readRow('ツアー', b.tour, u.has('tour')),
        readRow('人数', b.people ? `${b.people} 人` : '', u.has('people')),
        readRow('代表者', `${b.leadName} ${b.leadPhone}`.trim(), u.has('leadName') || u.has('leadPhone')),
        readRow('読めた名前', names.join('・'), r.people.some(p => p.unsure.includes('name'))),
        r.healthSeen ? el('p', { class: 'flag flag--warn', text: 'AI が「健康の情報が見えた」と答えました。送った文面を確かめてください。' }) : null),
      tripPicker(want, mail, fillMail),
      el('div', { class: 'band' }, el('p', { class: 'band__title', text: 'メールに無いもの' }), el('p', { class: 'band__text', text: missingText(kind) })),
      el('div', { class: 'actions actions--stack' },
        el('button', { class: 'btn btn--big', type: 'button', text: '予約を入れる', onclick: commitMail }),
        el('button', { class: 'btn btn--ghost btn--big', type: 'button', text: '貼り直す', onclick: () => { mail = { ...blankMail(), text: mail.text, sampleId: mail.sampleId }; fillMail(); } }))
    ];
  }

  function mailPreview() {
    const sampleMode = R.aiReader.mode() === 'sample';
    const cannotRead = sampleMode && !mail.sampleId;
    return [
      el('div', { class: 'facts' },
        el('p', { class: 'band__title', text: 'AI に送る文面' }),
        el('p', { class: 'note', text: mail.shown.redacted
          ? `健康に触れていそうな所（${mail.shown.redacted} か所）は外しました。外した所は［ ］の印になっています。`
          : '健康に触れていそうな所は見つかりませんでした。' }),
        el('pre', { class: 'mail__shown', text: mail.shown.text })),
      sampleMode ? el('p', { class: 'note', text: cannotRead
        ? 'いまは見本の読み取りです。読めるのは見本のメールだけです。ほかの予約は「電話などの予約を足す」から入れてください。'
        : 'いまは見本の読み取りです（AI には送らず、試験で読んだ答えを使います）。' }) : null,
      el('div', { class: 'actions actions--stack' },
        el('button', { class: 'btn btn--big', type: 'button', disabled: cannotRead || mail.busy, text: mail.busy ? '読んでいます…' : 'この文面を AI で読む', onclick: readMail }),
        el('button', { class: 'btn btn--ghost btn--big', type: 'button', disabled: mail.busy, text: '貼り直す', onclick: () => { mail.shown = null; fillMail(); } }))
    ];
  }

  function fillMail() {
    if (!mailOut) return;
    mailInputs.forEach(n => { n.disabled = mail.busy; });
    const body = mail.reading ? mailResult() : mail.shown ? mailPreview() : el('div', { class: 'actions actions--stack' },
      el('button', { class: 'btn btn--big', type: 'button', disabled: !mail.text.trim(), text: 'AI に送る前の文面を見る', onclick: showMail }));
    R.fill(mailOut, body, el('p', { class: 'errors', role: 'alert', text: mail.error }));
  }

  function showMail() {
    mail.error = '';
    try {
      mail.shown = R.aiReader.preview({ doc: 'mail', text: mail.text, sampleId: mail.sampleId });
    } catch (e) {
      mail.error = ERROR_JA[e.kind] || ERROR_JA.input;
    }
    fillMail();
  }

  /* 読んでいる間に別のメールに替えられても、結果は読み始めたメールにだけ付ける */
  async function readMail() {
    const job = mail;
    job.busy = true;
    job.error = '';
    fillMail();
    try {
      const { reading, sent } = await R.aiReader.read({ doc: 'mail', text: job.text, sampleId: job.sampleId });
      save(s => C().logAi(s, { at: now(), sent }));
      job.reading = reading;
      job.tripId = '';
    } catch (e) {
      if (e.sent) save(s => C().logAi(s, { at: now(), sent: e.sent }));   // 送ったあとに失敗しても、送った記録は残す
      job.error = ERROR_JA[e.kind] || ERROR_JA.bad;
    } finally {
      job.busy = false;
      if (mail === job) fillMail();
    }
  }

  function commitMail() {
    const want = { ...mailWant(), kind: mail.kind || C().suggestTrip(R.rosterStore.get(), mailWant()).kind };
    const booking = C().bookingFromReading(mail.reading);
    const r = save(s => C().addBookingToTrip(s, { tripId: mail.tripId, want, booking, reading: mail.reading, src: 'mail', at: now(), newId: R.newId }).state);
    if (r.error) { mail.error = '予約を入れられませんでした。読み取りを確かめて、もう一度試してください。'; fillMail(); return; }
    done(want.date, `予約を入れました: ${booking.leadName || '名前の分からない予約'}`, r.saved);
  }

  function renderMail() {
    const textarea = el('textarea', {
      class: 'input mail__text', rows: 9, text: mail.text,
      oninput: (e) => { mail = { ...blankMail(), text: e.target.value, sampleId: matchSample(e.target.value) }; fillMail(); }
    });
    const sampleButtons = Object.entries(R.SAMPLE_MAILS).map(([id, m], i) => el('button', {
      class: 'btn btn--ghost btn--small', type: 'button', title: m.note, text: `見本 ${i + 1}`,
      onclick: () => { mail = { ...blankMail(), text: m.text, sampleId: id }; textarea.value = m.text; fillMail(); }
    }));
    mailInputs = [textarea, ...sampleButtons];
    mailOut = el('div', { class: 'mail__out' });
    fillMail();
    return [
      ...head('予約サイトのメールを取り込む'),
      el('p', { class: 'note', text: '見本のメール（架空）で試せます' }),
      el('div', { class: 'samples', role: 'group', 'aria-label': '見本のメール' }, sampleButtons),
      field('届いたメールを、そのまま貼る', textarea),
      mailOut,
      back()
    ];
  }

  /* ---------- 電話などの予約を足す ---------- */
  let phonePick = null;

  function phoneWant() {
    const t = tour(phone.tourId);
    return { date: phone.date, start: phone.start, tour: t.name.ja, kind: t.diving ? 'dive' : 'snorkel' };
  }

  function fillPhonePick() {
    if (!phonePick) return;
    if (!phone.date) { R.fill(phonePick, el('p', { class: 'note', text: '日付を入れると、入れる便を選べます' })); return; }
    R.fill(phonePick, tripPicker(phoneWant(), phone, fillPhonePick));
  }

  function commitPhone(errorsNode) {
    const input = { date: phone.date, people: Number(phone.people), leadName: phone.leadName.trim(), leadPhone: phone.leadPhone.trim(), note: phone.note.trim() };
    const problems = C().bookingProblems(input);
    if (problems.length) { errorsNode.textContent = `確かめてください: ${problems.map(p => PROBLEM_JA[p]).join('・')}`; return; }
    const booking = { source: phone.source, leadName: input.leadName, leadPhone: input.leadPhone, people: input.people, note: input.note };
    const r = save(s => C().addBookingToTrip(s, { tripId: phone.tripId, want: phoneWant(), booking, reading: null, src: 'staff', at: now(), newId: R.newId }).state);
    if (r.error) { errorsNode.textContent = '予約を入れられませんでした。入力を確かめて、もう一度試してください。'; return; }
    done(phone.date, `予約を入れました: ${booking.leadName || '名前の分からない予約'}（${booking.people} 人）`, r.saved);
  }

  function renderPhone() {
    const set = (key, repick) => (e) => { phone[key] = e.target.value; if (repick) { phone.tripId = ''; fillPhonePick(); } };
    const errorsNode = el('p', { class: 'errors', role: 'alert' });
    phonePick = el('div', { class: 'phone__pick' });
    fillPhonePick();
    return [
      ...head('電話などの予約を足す'),
      el('form', { class: 'card', novalidate: true, onsubmit: (e) => { e.preventDefault(); commitPhone(errorsNode); } },
        el('div', { class: 'row' },
          field('日付', el('input', { class: 'input', type: 'date', required: true, value: phone.date, oninput: set('date', true) })),
          field('集合の時刻（分かれば）', el('input', { class: 'input', type: 'time', value: phone.start, oninput: set('start', true) }))),
        field('ツアー', el('select', { class: 'input', onchange: set('tourId', true) },
          R.TOURS.map(t => el('option', { value: t.id, selected: t.id === phone.tourId, text: t.name.ja })))),
        phonePick,
        el('div', { class: 'row' },
          field('代表者の名前', el('input', { class: 'input', type: 'text', maxlength: 60, autocomplete: 'off', value: phone.leadName, oninput: set('leadName') })),
          field('電話', el('input', { class: 'input', type: 'tel', maxlength: 30, autocomplete: 'off', value: phone.leadPhone, oninput: set('leadPhone') }))),
        el('div', { class: 'row' },
          field('人数', el('input', { class: 'input input--short', type: 'number', min: 1, max: R.roster.MAX_PEOPLE, value: phone.people, oninput: set('people') })),
          field('どこから', el('select', { class: 'input', onchange: set('source') },
            ['phone', 'form'].map(k => el('option', { value: k, selected: k === phone.source, text: SOURCE_JA[k] }))))),
        field('メモ', el('textarea', { class: 'input', rows: 3, maxlength: 400, text: phone.note, oninput: set('note') }),
          '健康のことは書かないでください。名簿の健康の欄は、お客さんが自分で選びます。'),
        errorsNode,
        el('button', { class: 'btn btn--big', type: 'submit', text: '予約を入れる' })),
      back()
    ];
  }

  /* ---------- 描く ---------- */
  function render() {
    mailOut = null;
    mailInputs = [];
    phonePick = null;
    const body = mode === 'mail' ? renderMail() : mode === 'phone' ? renderPhone() : renderList();
    R.fill(root, body);
  }

  R.renderBooking = render;
  R.rosterStore.subscribe(() => { if (mode === 'list' && !document.getElementById('view-booking').hidden) render(); });
})();
