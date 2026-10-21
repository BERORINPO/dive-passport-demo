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
  const STORE_NOTE_JA = {
    recovered: '保存されていた名簿が読めなかったので、この端末の別の場所に残して、空の名簿から始めました。',
    unreadable: '保存されていた名簿が読めませんでした。消さずに元のまま残しています。この画面で入れた予約は保存されず、閉じると消えます。',
    conflict: '別のタブで名簿が変わりました。この画面には、保存できていない予約があります。'
  };

  let mode = 'list';        // list / mail / phone / intake（名簿の取り込み）/ review（読み取りを確かめる）/ ask（お客さんに聞く）
                            // day（今日の名簿）/ print（条例の名簿）/ ics（カレンダー）/ log（記録）は day-roster.js
                            // share（乗り合い）/ partner（他のお店役）/ joint（合同名簿）/ jointprint / board（札ボード）/ leave（離れる前）は share-roster.js
  let intakeTrip = '';
  let reviewPerson = '';
  let askBooking = '';
  let dayTrip = '';
  let shareShop = '';       // 他のお店役で入れているお店
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
  const weekday = (d) => { const [y, m, dd] = d.split('-').map(Number); return WEEK[new Date(y, m - 1, dd).getDay()]; };
  const monthDay = (d) => { const [, m, dd] = d.split('-').map(Number); return `${m}/${dd}`; };
  const runLabel = (t) => (t.start ? (t.start < '12:00' ? '午前便' : '午後便') : '時刻未定');
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

  /* ctx: tripId（名簿の取り込みの便）/ personId（確かめる人）/ notice（知らせる文）/ saved（false なら保存できなかったと知らせる） */
  function go(next, ctx = {}) {
    mode = next;
    armedReset = false;
    notice = ctx.saved === false ? { kind: 'warn', text: NOT_SAVED } : ctx.warn ? { kind: 'warn', text: ctx.warn } : ctx.notice ? { kind: 'ok', text: ctx.notice } : null;
    if (ctx.tripId) { intakeTrip = ctx.tripId; dayTrip = ctx.tripId; }
    if (ctx.personId) reviewPerson = ctx.personId;
    if (ctx.bookingId) askBooking = ctx.bookingId;
    if (ctx.shop !== undefined) shareShop = ctx.shop;
    if (next === 'mail') mail = blankMail();
    if (next === 'phone') phone = blankPhone();
    if (next === 'ask') copied = null;
    render();
  }

  /* 予約を入れたあと、一覧に戻って知らせる */
  function done(date, text, saved) {
    day = date;
    notice = saved ? { kind: 'ok', text } : { kind: 'warn', text: `${text}。${NOT_SAVED}` };
    mode = 'list';
    render();
  }

  const head = (title, sub) => [
    el('p', { class: 'note', text: R.rosterStore.get().shop.name }),
    el('h2', { class: 'page__title', text: title }),
    sub ? el('p', { class: 'page__sub', text: sub }) : null,
    notice ? el('p', { class: `flag flag--${notice.kind}`, role: 'status', text: notice.text }) : null
  ];
  const back = () => el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: '予約の一覧に戻る', onclick: () => go('list') }));
  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { class: 'label', text: label }), control, hint ? el('span', { class: 'note', text: hint }) : null);
  /* 画面の下に固定する操作の帯。左が主、右が副 */
  const dock = R.dock;
  const mailErr = () => el('p', { class: 'errors', role: 'alert', text: mail.error });

  /* ---------- 予約の一覧（時刻表） ---------- */
  /* 予約の状態は、色の札にせず、文字の色と短い印で見せる */
  function bookingLine(row) {
    const b = row.booking;
    const total = row.people.length;
    const unsure = row.people.some(p => p.unsure.length);
    const waiting = row.people.filter(p => !p.done).length;
    const guests = row.people.filter(p => p.ask.length).length;   // お客さんの入力を待っている人。残りは便の項目（ポイント・ガイド）
    const st = unsure ? ['check', '! 確かめる'] : waiting ? ['wait', `・名簿 ${row.done}/${total}`] : ['ok', '✓ そろった'];
    const lead = b.leadName || (row.people[0] && row.people[0].name) || '名前の分からない予約';
    const others = Math.max(b.people, total) - 1;
    const where = C().isPartnerBooking(b) ? `${b.shop}（乗り合い）` : b.site ? `${b.site}（${SOURCE_JA[b.source]}）` : SOURCE_JA[b.source];
    const status = unsure ? '確かめてほしい所がある' : guests ? `${guests} 人分の入力を待っている` : waiting ? '便のポイントかガイドがまだ' : '';
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name' }, lead, others > 0 ? el('span', { class: 'nw', text: ` ほか ${others} 人` }) : null),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: `${where}　${status}`.trim() }),
      guests ? el('button', { class: 'linkbtn', type: 'button', text: 'お客さんに聞く', onclick: () => go('ask', { bookingId: b.id }) }) : null);
  }

  function tripCard(s, trip) {
    const rows = C().bookingRows(s, trip.id);
    return el('section', { class: 'trip', 'aria-label': tripLabel(trip) },
      el('div', { class: 'trip__time' }, trip.start ? clock(trip.start) : '—', el('small', { text: runLabel(trip) })),
      el('div', {},
        el('div', { class: 'trip__head' },
          el('h3', { class: 'trip__title', text: trip.tour || KIND_JA[trip.kind] }),
          el('span', { class: 'trip__count' }, el('b', { text: String(C().tripSummary(s, trip.id).booked) }), ' 人')),
        rows.length ? el('ul', { class: 'bks' }, rows.map(bookingLine)) : el('p', { class: 'note', text: 'この便の予約はまだありません' }),
        rows.length ? el('p', { class: 'trip__links' },
          el('button', { class: 'linkbtn', type: 'button', text: '今日の名簿', onclick: () => go('day', { tripId: trip.id }) }),
          el('button', { class: 'linkbtn', type: 'button', text: '乗り合い・札', onclick: () => go('share', { tripId: trip.id }) }),
          el('button', { class: 'linkbtn', type: 'button', text: '名簿の取り込み（申込書・C カード）', onclick: () => go('intake', { tripId: trip.id }) })) : null));
  }

  function resetButton() {
    return el('p', { class: 'reset' }, el('button', {
      class: 'linkbtn linkbtn--muted', type: 'button',
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
      ...head('予約', '便ごとの予約と、名簿のそろい具合'),
      R.rosterStore.note() ? el('p', { class: 'flag flag--warn', text: STORE_NOTE_JA[R.rosterStore.note()] }) : null,
      dates.length ? el('div', { class: 'days', role: 'group', 'aria-label': '日付' }, dates.map(d => el('button', {
        class: 'day', type: 'button', 'aria-pressed': String(d === day), 'aria-label': md(d),
        onclick: () => { day = d; notice = null; armedReset = false; render(); }
      }, el('small', { text: weekday(d) }), el('b', { text: monthDay(d) })))) : null,
      dates.length
        ? trips.filter(t => t.date === day).map(t => tripCard(s, t))
        : el('p', { class: 'empty', text: 'まだ予約がありません。「メールを貼る」で、見本のメールから試せます。' }),
      s.trips.length ? resetButton() : null,
      dock(
        el('button', { class: 'btn', type: 'button', text: 'メールを貼る', onclick: () => go('mail') }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '電話の予約', onclick: () => go('phone') }))
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
      sampleMode ? el('p', { class: 'note', text: cannotRead
        ? 'いまは見本の読み取りです。読めるのは見本のメールだけです。ほかの予約は「電話などの予約を足す」から入れてください。'
        : 'いまは見本の読み取りです（AI には送らず、試験で読んだ答えを使います）。' }) : null,
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
      ...head('電話の予約', '電話や窓口で受けた予約を、手で入れます'),
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

  /* ---------- お客さんに聞く（送るリンク） ---------- */
  /* 予約 1 件に 1 つのリンク。開いた人は、この予約の人の「まだ」の所だけを入れる（js/guest-ask.js）。
     試作ではこの端末の中だけで動く。本物では Worker が予約ごとの鍵を出す（P6） */
  const askUrl = (id) => `${location.origin}${location.pathname}#ask=${encodeURIComponent(id)}`;
  let copied = null;        // リンクを写せたか（ok / fail）

  function personLine(p, trip) {
    const items = R.roster.ITEMS[trip ? trip.kind : 'dive'];
    const st = C().status(p, trip);
    const labels = st.missing.map(k => items.find(i => i.key === k).ja);
    const rest = labels.length > 4 ? ` ほか ${labels.length - 4}` : '';
    return el('div', { class: 'rd' },
      el('span', { class: 'rd__k', text: p.name || '名前の分からない人' }),
      el('span', { class: 'rd__v' }, el('span', { class: 'fig', text: `${items.length - st.missing.length} / ${items.length}` }),
        el('span', { class: 'rd__sub', text: st.done ? '✓ そろった' : labels.length ? `まだ: ${labels.slice(0, 4).join('・')}${rest}` : '! 確かめる所がある' })));
  }

  function renderAskLink() {
    const s = R.rosterStore.get();
    const b = s.bookings.find(x => x.id === askBooking);
    if (!b) return [...head('お客さんに聞く'), el('p', { class: 'errors', text: 'この予約が見つかりません。' }), back()];
    const trip = s.trips.find(t => t.id === b.tripId);
    const people = s.people.filter(p => p.bookingId === b.id);
    const lead = b.leadName || (people[0] && people[0].name) || '名前の分からない予約';
    const items = R.roster.ITEMS[trip ? trip.kind : 'dive'];
    const url = askUrl(b.id);
    const copy = () => {
      const tell = (how) => () => { copied = how; render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(tell('ok'), tell('fail'));
      else tell('fail')();
    };
    return [
      ...head(people.length > 1 ? `${lead} ほか ${people.length - 1} 人` : lead, trip ? `${md(trip.date)} ${tripLabel(trip)}` : ''),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '名簿のそろい具合', el('small', { text: `${items.length} 項目` })),
        people.map(p => personLine(p, trip))),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, 'お客さんに送るリンク', el('small', { text: '予約 1 件に 1 つ' })),
        el('p', { class: 'url', text: url }),
        el('p', { class: 'sheet__note', text: 'LINE やメールに貼って送ります。開いた人は、この予約の人の「まだ」の所だけを入れられます。試作では、この端末の中だけで開けます。' })),
      copied === 'ok' ? el('p', { class: 'flag flag--ok', role: 'status', text: 'リンクを写しました' }) : null,
      copied === 'fail' ? el('p', { class: 'flag flag--warn', role: 'status', text: '写せませんでした。上のリンクを長押しして写してください' }) : null,
      back(),
      dock(
        el('button', { class: 'btn', type: 'button', text: 'リンクを写す', onclick: copy }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'この端末で開く（デモ）', onclick: () => R.openAsk(b.id) }))
    ];
  }

  /* ---------- 描く ---------- */
  /* 名簿の取り込みと確かめる画面（intake-photo.js）に渡す道具 */
  const ui = { head, field, md, tripLabel, save, go, rerender: () => render(), back, dock };
  const DAY_MODES = { day: 'renderDay', print: 'renderPrint', ics: 'renderIcs', log: 'renderLog' };
  const SHARE_MODES = { share: 'renderShare', partner: 'renderPartner', joint: 'renderJoint', jointprint: 'renderJointPrint', board: 'renderBoard', leave: 'renderLeave' };
  const PRINT_MODES = ['print', 'jointprint', 'board'];

  function render() {
    mailOut = null;
    mailInputs = [];
    phonePick = null;
    const body = mode === 'mail' ? renderMail() : mode === 'phone' ? renderPhone()
      : mode === 'intake' ? R.photoIntake.renderIntake({ tripId: intakeTrip, ui })
        : mode === 'review' ? R.photoIntake.renderReview({ personId: reviewPerson, ui })
          : mode === 'ask' ? renderAskLink()
            : DAY_MODES[mode] ? R.dayRoster[DAY_MODES[mode]]({ tripId: dayTrip, ui })
              : SHARE_MODES[mode] ? R.shareRoster[SHARE_MODES[mode]]({ tripId: dayTrip, shop: shareShop, ui }) : renderList();
    R.fill(root, body);
    /* 印刷では名簿の紙だけを出す（css/app.css）。紙が無い画面（札の番号がまだ）では白紙にしない */
    document.body.classList.toggle('print-roster', PRINT_MODES.includes(mode) && !!root.querySelector('.paper'));
    if (mode === 'list') showPickedDay();
  }

  /* 日付の並びは横に送るので、選んだ日が見える所まで横だけ動かす（画面は上下に動かさない） */
  function showPickedDay() {
    const on = root.querySelector('.day[aria-pressed="true"]');
    if (!on) return;
    const box = on.parentElement.getBoundingClientRect();
    const r = on.getBoundingClientRect();
    if (r.left < box.left || r.right > box.right) on.parentElement.scrollLeft += r.left - box.left;
  }

  R.renderBooking = render;
  R.rosterStore.subscribe(() => { if (['list', 'ask', 'day', 'log', 'joint', 'leave'].includes(mode) && !document.getElementById('view-booking').hidden) render(); });
})();
