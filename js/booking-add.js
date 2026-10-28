/* 予約を足す画面（お店、日本語のみ）: 予約サイトのメールを取り込む / 電話などの予約を足す。予約の画面（booking.js）から開く。
   予約と名簿は R.rosterStore（core.js）、形は roster-schema.js、組み立てと判断は roster-core.js、AI は ai-reader.js だけを通す。
   保存・移動・知らせ・便の選び・見出しなどの道具は、booking.js から init で受け取る ui を通す。
   AI やお客さんの文字は el() の text で出す（HTML として入れない）。電話番号はリンクにしない */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;

  const MODES = ['mail', 'phone'];
  const ERROR_JA = {
    input: '送れない文面です。届いたメールの本文をそのまま貼ってください（メールのソースは読めません）',
    auth: 'ログインが切れたか、通りませんでした。画面を読み込み直してください',
    limit: '今日か今月の上限に達しました。見本の読み取りでは続けられます',
    offline: '届きませんでした。通信を確かめて、もう一度試してください',
    bad: 'AI の答えが形に合わなかったので、使いませんでした。もう一度試すか、電話などの予約から手で入れてください'
  };

  /* booking.js の ui（init で受け取る） */
  let head, back, field, dock, md, clock, tripLabel, tripPicker, tour, save, go, done, SOURCE_JA, PROBLEM_JA;
  function init(ui) {
    ({ head, back, field, dock, md, clock, tripLabel, tripPicker, tour, save, go, done } = ui);
    ({ SOURCE_JA, PROBLEM_JA } = ui.labels);
  }

  const now = () => new Date().toISOString();

  let mail = blankMail();
  let phone = blankPhone();

  function blankMail() { return { text: '', sampleId: null, shown: null, reading: null, tripId: '', kind: '', busy: false, error: '' }; }
  function blankPhone() {
    return { date: R.today(), start: '', tourId: R.TOURS[0].id, leadName: '', leadPhone: '', email: '', people: '1', source: 'phone', note: '', tripId: '' };
  }


  const mailErr = () => el('p', { class: 'errors', role: 'alert', text: mail.error });

  /* ---------- 予約サイトのメールを取り込む ---------- */
  /* 見本のメールは、日付を今日から数えた日にずらして出す（data-samples.js の R.sampleMail） */
  const sampleText = (id) => R.sampleMail(id, R.today()).text;
  const matchSample = (text) => Object.keys(R.SAMPLE_MAILS).find(id => sampleText(id) === text.replace(/\r\n?/g, '\n').trimEnd()) || null;
  let mailOut = null;
  let mailInputs = [];      // 読んでいる間は押せなくする入力欄とボタン

  /* 読み取りの 1 行。左に項目名、右に値。値の下に小さく補足（自信なしの印） */
  function readRow(label, value, unsure, sub) {
    return el('div', { class: `rd${unsure ? ' rd--unsure' : ''}` },
      el('span', { class: 'rd__k', text: label }),
      el('span', { class: 'rd__v' }, value || '（メールに無い）',
        unsure || sub ? el('span', { class: 'rd__sub', text: [unsure ? '! 自信なし' : '', sub || ''].filter(Boolean).join('　') }) : null));
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
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, 'AI が読んだ結果', R.aiReader.mode() === 'sample' ? el('small', { text: '見本の読み取り' }) : null),
        readRow('予約サイト', b.site, u.has('site') || u.has('ref'), b.ref),
        readRow('日時', `${md(b.date)} ${b.start ? clock(b.start) : '時刻はメールに無い'}`, u.has('date') || u.has('start')),
        readRow('ツアー', b.tour, u.has('tour')),
        readRow('人数', b.people ? `${b.people} 人` : '', u.has('people')),
        readRow('代表者', b.leadName, u.has('leadName') || u.has('leadPhone'), b.leadPhone),
        readRow('読めた名前', names.join('・'), r.people.some(p => p.unsure.includes('name')))),
      r.healthSeen ? el('p', { class: 'flag flag--warn', text: 'AI が「健康の情報が見えた」と答えました。送った文面を確かめてください。' }) : null,
      tripPicker(want, mail, fillMail),
      el('div', { class: 'band' }, el('p', { class: 'band__title', text: 'メールに無いもの' }), el('p', { class: 'band__text', text: missingText(kind) })),
      dock(
        mailErr(),
        el('button', { class: 'btn', type: 'button', text: '予約を入れる', onclick: commitMail }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '貼り直す', onclick: () => { mail = { ...blankMail(), text: mail.text, sampleId: mail.sampleId }; fillMail(); } }))
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
      el('p', { class: 'note', text: !sampleMode ? 'この文面を Anthropic の AI に送ります。' : cannotRead
        ? 'いまは見本の読み取りです。読めるのは見本のメールだけです。ほかの予約は「電話などの予約を足す」から入れてください。'
        : 'いまは見本の読み取りです（AI には送らず、試験で読んだ答えを使います）。' }),
      dock(
        mailErr(),
        el('button', { class: 'btn', type: 'button', disabled: cannotRead || mail.busy, text: mail.busy ? '読んでいます…' : 'この文面を AI で読む', onclick: readMail }),
        el('button', { class: 'btn btn--ghost', type: 'button', disabled: mail.busy, text: '貼り直す', onclick: () => { mail.shown = null; fillMail(); } }))
    ];
  }

  function fillMail() {
    if (!mailOut) return;
    mailInputs.forEach(n => { n.disabled = mail.busy; });
    const body = mail.reading ? mailResult() : mail.shown ? mailPreview() : dock(
      mailErr(),
      el('button', { class: 'btn', type: 'button', disabled: !mail.text.trim(), text: 'AI に送る前の文面を見る', onclick: showMail }));
    R.fill(mailOut, body);
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
      save('core.logAi', { at: now(), sent });
      job.reading = reading;
      job.tripId = '';
      /* 書類の自動化: 日付が読めたら、確かめずに便へ入れて予定を作る（自信の無い所は印が付き、名簿の「確かめる」に出る） */
      if (reading.booking && reading.booking.date && mail === job) {
        const r = R.autoFlow.addReading(save, reading, 'ja');
        if (!r.error) { go('flow', { bookingId: r.bookingId, saved: r.saved, notice: '予約メールを読んで、自動で入れました' }); return; }
      }
    } catch (e) {
      if (e.sent) save('core.logAi', { at: now(), sent: e.sent });   // 送ったあとに失敗しても、送った記録は残す
      job.error = ERROR_JA[e.kind] || ERROR_JA.bad;
      if (e.sent && e.sent.healthSeen) job.error += '。AI が「健康の情報が見えた」と答えました。送った文面を確かめてください';
    } finally {
      job.busy = false;
      if (mail === job) fillMail();
    }
  }

  function commitMail() {
    const want = { ...mailWant(), kind: mail.kind || C().suggestTrip(R.rosterStore.get(), mailWant()).kind };
    const booking = C().bookingFromReading(mail.reading);
    const r = save('core.addBookingToTrip', { tripId: mail.tripId, want, booking, reading: mail.reading, src: 'mail', at: now() });
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
      onclick: () => { const text = sampleText(id); mail = { ...blankMail(), text, sampleId: id }; textarea.value = text; fillMail(); }
    }));
    mailInputs = [textarea, ...sampleButtons];
    mailOut = el('div', { class: 'mail__out' });
    fillMail();
    return [
      ...head('予約メールの取り込み', '届いたメールを貼ると、AI が予約の項目を読みます'),
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
    const email = phone.email.trim();
    if (email && !R.roster.emailOk(email)) { errorsNode.textContent = '確かめてください: メールアドレス'; return; }
    const booking = { source: phone.source, leadName: input.leadName, leadPhone: input.leadPhone, people: input.people, note: input.note, ...(email ? { leadEmail: email } : {}) };
    /* 画面の「今の」入力（phone）は、ここで全部写す。貯めた直しが、あとで別の予約の入力を読まないように */
    const r = save('core.addBookingToTrip', { tripId: phone.tripId, want: phoneWant(), booking, reading: null, src: 'staff', at: now() });
    if (r.error) { errorsNode.textContent = '予約を入れられませんでした。入力を確かめて、もう一度試してください。'; return; }
    const bookings = r.out.state.bookings;
    R.autoFlow.plan(save, bookings[bookings.length - 1].id);   // 書類の自動化: お願い・2 日前・前日の夜・当日の朝の予定
    done(phone.date, `予約を入れました: ${booking.leadName || '名前の分からない予約'}（${booking.people} 人）`, r.saved);
  }

  function renderPhone() {
    const set = (key, repick) => (e) => { phone[key] = e.target.value; if (repick) { phone.tripId = ''; fillPhonePick(); } };
    const errorsNode = el('p', { class: 'errors', role: 'alert' });
    phonePick = el('div', { class: 'phone__pick' });
    fillPhonePick();
    return [
      ...head('電話の予約'),
      el('form', { class: 'card form', novalidate: true, onsubmit: (e) => { e.preventDefault(); commitPhone(errorsNode); } },
        el('div', { class: 'row' },
          field('日付', el('input', { class: 'input', type: 'date', required: true, value: phone.date, oninput: set('date', true) })),
          field('集合の時刻（分かれば）', el('input', { class: 'input', type: 'time', value: phone.start, oninput: set('start', true) }))),
        field('ツアー', el('select', { class: 'input', onchange: set('tourId', true) },
          R.TOURS.map(t => el('option', { value: t.id, selected: t.id === phone.tourId, text: t.name.ja })))),
        phonePick,
        el('div', { class: 'row' },
          field('代表者の名前', el('input', { class: 'input', type: 'text', maxlength: 60, autocomplete: 'off', value: phone.leadName, oninput: set('leadName') })),
          field('電話', el('input', { class: 'input', type: 'tel', maxlength: 30, autocomplete: 'off', value: phone.leadPhone, oninput: set('leadPhone') }))),
        field('メールアドレス（分かれば）', el('input', { class: 'input', type: 'email', maxlength: 254, autocomplete: 'off', value: phone.email, oninput: set('email') }),
          'あると、名簿の項目のお願いを自動で送ります'),
        el('div', { class: 'row' },
          field('人数', el('input', { class: 'input input--short', type: 'number', min: 1, max: R.roster.MAX_PEOPLE, value: phone.people, oninput: set('people') })),
          field('どこから', el('select', { class: 'input', onchange: set('source') },
            ['phone', 'form'].map(k => el('option', { value: k, selected: k === phone.source, text: SOURCE_JA[k] }))))),
        field('メモ', el('textarea', { class: 'input', rows: 3, maxlength: 400, text: phone.note, oninput: set('note') }),
          '健康のことは書かないでください。名簿の健康の欄は、お客さんが自分で選びます。')),
      back(),
      dock(errorsNode, el('button', { class: 'btn', type: 'button', text: '予約を入れる', onclick: () => commitPhone(errorsNode) }))
    ];
  }

  /* 画面に入るとき（booking.js の go）。開くたびに入力を空から始める */
  function enter(next) {
    if (next === 'mail') mail = blankMail();
    if (next === 'phone') phone = blankPhone();
  }
  /* 描き直す前（booking.js の render）。前の画面の入れ物を手放す */
  function beforeRender() {
    mailOut = null;
    mailInputs = [];
    phonePick = null;
  }

  R.bookingAdd = { MODES, init, enter, beforeRender, renderMail, renderPhone };
})();
