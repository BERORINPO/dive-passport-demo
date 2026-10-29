/* お客さんの画面: お店が送ったリンク（#ask=予約の id）から開く。その予約の人の「まだ」の所だけを入れる。
   パスポートから入れる・当日の朝に体調を答える、もここ。決まりは js/roster-guest.js（core）。
   試作では、この端末の名簿（localStorage）に入れる。本物のリンク（ask.html）では、同じ欄で Worker の /api/ask に送る
   （js/ask-page.js が R.guestAsk.remote で読み書きの先を差し替える。聞く項目は Worker が決める。plan/meibo.md「お客さんのリンク」） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const G = () => R.rosterGuest;
  const C = () => R.rosterCore;
  const root = document.getElementById('ask');
  const guestParts = ['tour', 'chat', 'intake'].map(id => document.getElementById(id));

  const T = {
    from: { ja: 'からのお願い', en: ' — a request' },
    titleDive: { ja: 'ダイビングの前に、あと少し教えてください', en: 'A few details before your dive' },
    titleSnorkel: { ja: 'スノーケリングの前に、あと少し教えてください', en: 'A few details before your snorkel tour' },
    law: { ja: '県の条例で、お店が名簿を作って 1 年残します', en: 'Okinawa rules require the shop to keep a list of participants for one year' },
    noBooking: { ja: 'このリンクは使えません。お店に聞いてください。', en: 'This link does not work. Please ask the shop.' },
    cancelTitle: { ja: 'このツアーは中止になりました', en: 'This tour is cancelled' },
    cancelText: { ja: '料金と次の予定は、お店から連絡があります。港には行かないでください。', en: 'The shop will contact you about the fee and other dates. Please do not go to the harbour.' },
    back: { ja: 'いつもの画面に戻る', en: 'Back to the usual screen' },
    passHere: { ja: 'この端末にパスポートがあります', en: 'This phone has a passport' },
    fromPass: { ja: 'パスポートから入れる', en: 'Fill from passport' },
    known: { ja: 'お店がもう知っていること', en: 'What the shop already has' },
    knownNote: { ja: '中身はここに出しません。直したい所があれば、集合のときにお店に伝えてください。', en: 'The details are not shown here. If something needs fixing, tell the shop when you meet.' },
    filled: { ja: '入力済み', en: 'Provided' },
    guestName: { ja: 'お名前（名簿に載ります）', en: 'Name (goes on the participant list)' },
    nameFirst: { ja: 'お名前だけ先に送る', en: 'Send the name first' },
    nameFirstNote: { ja: 'お店はまだこの方の名前を知りません。ほかの所はあとで入れても大丈夫です。', en: 'The shop does not have this person\'s name yet. You can fill in the rest later.' },
    personNo: { ja: '人目', en: 'Guest ' },
    birthDate: { ja: '生年月日', en: 'Date of birth' },
    address: { ja: '住所', en: 'Address' },
    emergency: { ja: '緊急時の連絡先（一緒に潜らない人）', en: 'Emergency contact (someone not diving with you)' },
    eName: { ja: 'お名前', en: 'Name' },
    eRelation: { ja: '続柄（例: 母）', en: 'Relation (e.g. mother)' },
    ePhone: { ja: '電話', en: 'Phone' },
    cert: { ja: 'C カード（ダイビングの認定証）', en: 'Diving certification card' },
    certDate: { ja: '取得した年月', en: 'Month you got it' },
    dives: { ja: '潜った本数', en: 'Logged dives' },
    lastDive: { ja: '最後に潜った月（0 本なら空のまま）', en: 'Month of your last dive (leave empty if none)' },
    history: { ja: '健康の質問（当てはまる物に「はい」）', en: 'Health questions (answer "Yes" if it applies)' },
    consent: { ja: '健康の答え（既往症・当日の体調）は県の条例の名簿として、お店が潜る前と後に測る血中酸素の数値はお店の記録として、お店が 1 年残します。見るのはこのお店の人だけで、乗り合いの便でも同じ船の他のお店には渡しません。AI には送りません。これに同意して答えます。',
      en: 'The shop keeps your health answers (medical history and how you feel on the day) in the participant list required by Okinawa rules, and the blood oxygen readings it takes before and after each dive as its own record, for one year. Only staff at this shop see them; they are not passed to other shops, even on shared boats. They are never sent to an AI. I agree and will answer.' },
    yes: { ja: 'はい', en: 'Yes' },
    no: { ja: 'いいえ', en: 'No' },
    todayLater: { ja: '当日の健康状態は、当日の朝にこのページで答えます。', en: 'You will answer how you feel on the morning of the tour, on this page.' },
    todayTitle: { ja: '今日の体調はどうですか', en: 'How do you feel today?' },
    todayOk: { ja: 'いつもどおり', en: 'As usual' },
    todayOkSub: { ja: '寝不足・二日酔い・かぜ気味ではない', en: 'No lack of sleep, hangover or cold' },
    todayBad: { ja: '少し調子が悪い', en: 'Not quite well' },
    todayBadSub: { ja: '集合のときに、スタッフに伝えてください', en: 'Please tell the staff when you meet' },
    todayNote: { ja: '参加できるかは、お店が決めます。この答えは名簿としてお店が 1 年残します。乗り合いの便でも、同じ船の他のお店には渡しません。', en: 'The shop decides whether you can join. The shop keeps this answer for one year in the participant list. It is not passed to other shops, even on shared boats.' },
    todayWait: { ja: '当日の朝に、このページで体調を答えます', en: 'On the morning of the tour, answer here how you feel' },
    todayDemo: { ja: '（デモ）当日として答える', en: '(Demo) Answer as if it were the day' },
    symTitle: { ja: '水に入ってから、こうなったらすぐガイドに', en: 'In the water, tell your guide right away if you feel:' },
    symNote: { ja: 'お店は海に入る前と後に、指先の機器で血中の酸素を測ることがあります。測った数値は、このお店だけが名簿と一緒に 1 年残し、他のお店や AI には渡しません。',
      en: 'The shop may check your blood oxygen with a fingertip sensor before and after each dive. Only this shop keeps the readings, for one year with the participant list; they are not passed to other shops or to an AI.' },
    symSource: { ja: '沖縄県警察「ダイビング・スノーケリング前後の体調チェック表」（暫定版・多言語版）より', en: 'From the Okinawa Prefectural Police health check sheet for diving and snorkelling (provisional, multilingual).' },
    confirmTitle: { ja: 'この内容で合っていますか', en: 'Is this correct?' },
    confirmLead: { ja: 'お店がメールや書類から読み取った内容です。違う所は「直す」を押してください。', en: 'The shop read this from your booking or documents. Press "Fix" if something is wrong.' },
    confirmYes: { ja: '合っている', en: 'Correct' },
    confirmAll: { ja: '全部合っている', en: 'All correct' },
    confirmFix: { ja: '直す', en: 'Fix' },
    confirmSend: { ja: '直した内容を送る', en: 'Send the fix' },
    confirmName: { ja: '名前が違うときは、集合のときにお店に伝えてください。', en: 'If the name is wrong, tell the shop when you meet.' },
    confirmed: { ja: 'ありがとうございます。確かめた内容をお店に伝えました', en: 'Thank you. The shop has been told.' },
    confName: { ja: 'お名前', en: 'Name' },
    confirmOther: { ja: 'まだ確かめていない項目があります。この方の分は、お店が確かめます:', en: 'Items still to be checked. The shop will check them with this person:' },
    send: { ja: '送る', en: 'Send' },
    sent: { ja: '送りました', en: 'Sent' },
    sentAll: { ja: '全員の分を送りました', en: 'Sent for everyone' },
    fix: { ja: '確かめてください', en: 'Please check' },
    doneTitle: { ja: 'そろいました', en: 'All set' },
    doneText: { ja: 'お店からの案内どおりに集まってください。', en: 'Please meet as the shop told you.' },
    passTitle: { ja: 'パスポートから入れる', en: 'Fill from your passport' },
    passFor: { ja: 'さんの欄に入れます。渡したくない物は外してください', en: ': uncheck anything you do not want to share' },
    passTo: { ja: 'に渡す物', en: ' will receive' },
    passCert: { ja: 'C カード', en: 'Certification' },
    passDives: { ja: '潜った本数', en: 'Logged dives' },
    passHistory: { ja: '健康の質問', en: 'Health questions' },
    passAnswers: { ja: '5 問の答え', en: 'Answers to 5 questions' },
    passAnswered: { ja: 'に答えた。中身はお店だけが見る', en: 'answered. Only the shop sees them' },
    passOld: { ja: '日前の答えなので使えません。この画面のあとで答え直してください', en: 'days old, so it cannot be used. Please answer again' },
    passNone: { ja: 'パスポートから入れられる物はありません。', en: 'Nothing on your passport is needed here.' },
    passNameDiff: { ja: '名前が違います', en: 'The names differ' },
    passNameEmpty: { ja: '名簿にまだ名前が無いので、同じ人か確かめられません', en: 'The list has no name yet, so we cannot check it is the same person' },
    passNameText: { ja: '同じ人なら、下の印を付けて入れてください。健康の答えは、名前が同じときだけ入れられます', en: 'If this is the same person, tick the box below. Health answers can only be used when the names match' },
    passOtherName: { ja: '名前が違っても、この人に入れる', en: 'Use it for this person even though the names differ' },
    passNameBlocked: { ja: '同じ人と確かめられないので入れられません', en: 'Cannot be used: we cannot confirm it is the same person' },
    passUse: { ja: '選んだ物を入れる', en: 'Use the selected items' },
    cancel: { ja: 'やめる', en: 'Cancel' },
    passRest: { ja: '生年月日・住所・緊急時の連絡先は、パスポートに無いので、この画面のあとで入れます。', en: 'Date of birth, address and emergency contact are not on the passport; enter them next.' },
    doneHere: { ja: 'この画面で入れる所はそろいました', en: 'This page is complete' },
    healthBy: { ja: '健康の質問と当日の体調は、1 人ずつのリンクで本人が答えます（お子さんは保護者の方）。', en: 'Health questions and how you feel on the day are answered by each person on their own link (a parent for children).' },
    personLink: { ja: 'さんのリンクを写す', en: ': copy their link' },
    personCopied: { ja: 'リンクを写しました。本人に送ってください', en: 'Link copied. Please send it to them' },
    personFail: { ja: '写せませんでした。下のリンクを長押しして写してください', en: 'Could not copy. Press and hold the link below to copy it' }
  };
  const ITEM_EN = { name: 'Name', birthDate: 'Date of birth', address: 'Address', emergency: 'Emergency contact', certDate: 'Certification date',
    courses: 'Courses', dives: 'Experience', lastDive: 'Last dive', history: 'Medical history', today: 'Health today' };
  const COURSE_EN = { OW: 'Open Water', AOW: 'Advanced', RESCUE: 'Rescue', JOW: 'Junior', DM: 'Divemaster', OTHER: 'Other', NONE: 'None (first dive)' };
  const PROBLEM = {
    personName: { ja: 'お名前（60 字まで。リンクや記号の並びは入れられません）', en: 'Name (up to 60 characters, no links)' },
    birthDate: T.birthDate, address: T.address, emergency: { ja: '緊急時の連絡先（名前と電話）', en: 'Emergency contact (name and phone)' },
    cert: T.cert, certDate: T.certDate, dives: T.dives, lastDive: { ja: '最後に潜った月', en: 'Last dive month' },
    history: { ja: '健康の質問（全部）', en: 'All health questions' }, consent: { ja: '健康の答えの同意', en: 'Consent for health answers' },
    name: { ja: '名前が違っても入れる、の印', en: 'The box for a different name' }, save: { ja: '保存できませんでした', en: 'Could not save' },
    network: { ja: '送れませんでした。電波を確かめて、もう一度押してください', en: 'Could not send. Check your connection and try again' },
    cancelled: { ja: 'このツアーは中止になりました', en: 'This tour is cancelled' }, 'not-today': { ja: '当日の体調は、当日の朝に答えます', en: 'Answer how you feel on the morning of the tour' },
    gone: { ja: 'このリンクは使えません。お店に聞いてください', en: 'This link does not work. Please ask the shop' },
    answered: { ja: '今日の体調はもう届いています。調子が悪くなったときだけ、選び直して送ってください', en: 'Your answer for today is already in. Send again only if you now feel unwell' },
    links: { ja: 'この人のリンクはもう 3 本作りました。前に写したリンクを使ってください', en: 'Three links have already been made for this person. Please use one you copied before' } };

  /* 開いている予約と、人ごとの書きかけ */
  let bookingId = '';
  let personId = '';
  let view = 'form';            // form / passport
  let drafts = {};
  let problems = [];
  let flash = null;         // 知らせる文（T のキー）。言語を切り替えても訳が合うように、文でなくキーで持つ
  let flashWho = null;      // 'sentNext' のときの、送った人と次の人の id: { sent, next }
  let todayDemo = false;
  let passKeys = null;          // パスポートから入れる物の印。null = まだ選んでいない（最初は入れられる物に全部付ける）
  let otherName = false;        // 名前が違っても、この人に入れる
  let remote = null;            // 本物のリンク: { view(), send, confirm(personId, agree, fix), today, personLink }（人ごとの呼び出し）。js/ask-page.js が入れる
  let personUrls = {};          // 1 人ずつのリンク（人の id → { url, copied }）
  let fixing = null;            // 「直す」を開いている項目: { personId, field, draft }

  /* 名前がまだ空の人は「2 人目」と呼ぶ（名前を入れる前の見分け） */
  const personLabel = (v, person) => {
    if (person.name) return person.name;
    const i = v.people.findIndex(x => x.person.id === person.id) + 1;
    return R.lang === 'en' ? `${L(T.personNo)}${i}` : `${i}${L(T.personNo)}`;
  };
  const itemLabel = (items, key) => (R.lang === 'en' ? ITEM_EN[key] : items.find(i => i.key === key).ja);
  /* 「当日として答える」はデモ（見本の読み取り）のときだけ。本物では Worker の時計で当日かを決める（plan/meibo.md） */
  const demoMode = () => !!R.aiReader && R.aiReader.mode() === 'sample';
  /* 本物のリンクでは、当日かどうかを Worker の日付で決める（entry.todayOpen） */
  const isTheDay = (trip, entry) => (remote ? !!(entry && entry.todayOpen) : R.today() === trip.date);
  const courseLabel = (c) => (R.lang === 'en' ? COURSE_EN[c] : C().COURSE_JA[c]);
  const md = (d) => { const [, m, dd] = d.split('-').map(Number); return `${m}/${dd}`; };

  function draftOf(p) {
    if (!drafts[p.id]) {
      drafts[p.id] = { name: '', birthDate: '', address: '', emergency: { name: '', relation: '', phone: '' }, cert: { course: '', date: '' },
        courses: '', dives: '', lastDive: '', answers: Array(R.roster.HEALTH_QUESTIONS).fill(null), consent: false, today: '' };
    }
    return drafts[p.id];
  }

  /* 入力の欄。値は書きかけ（drafts）に置き、送るまで名簿には入れない */
  const field = (label, control) => el('label', { class: 'field' }, el('span', { class: 'label', text: L(label) }), control);
  const input = (d, key, attrs) => el('input', { class: 'input', value: d[key], ...attrs, oninput: (e) => { d[key] = e.target.value; } });

  function formFields(entry, d, items) {
    const ask = entry.ask;
    const out = [];
    if (ask.includes('name')) {
      out.push(field(T.guestName, input(d, 'name', { type: 'text', maxlength: 60 })),
        el('p', { class: 'note', text: L(T.nameFirstNote) }),
        el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: L(T.nameFirst), onclick: () => sendName(entry, d) }));
    }
    if (ask.includes('birthDate')) out.push(field(T.birthDate, input(d, 'birthDate', { type: 'date', max: R.today(), autocomplete: 'bday' })));
    if (ask.includes('address')) out.push(field(T.address, input(d, 'address', { type: 'text', maxlength: 120, autocomplete: 'street-address' })));
    if (ask.includes('emergency')) {
      const e = d.emergency;
      const sub = (key, label, type) => el('input', { class: 'input', type, value: e[key], placeholder: L(label), 'aria-label': L(label), maxlength: key === 'relation' ? 20 : 60,
        oninput: (ev) => { e[key] = ev.target.value; } });
      const open = entry.parts.emergency;
      const parts = [['name', T.eName, 'text'], ['relation', T.eRelation, 'text'], ['phone', T.ePhone, 'tel']];
      out.push(el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(T.emergency) }),
        el('div', { class: 'row' }, parts.map(([k, label, type]) => (open.includes(k) ? sub(k, label, type)
          : el('p', { class: 'note', text: `${L(label)}: ${L(T.filled)}` }))))));
    }
    if (ask.includes('certDate') || ask.includes('courses')) {
      const courseOpen = entry.parts.cert.includes('course');
      const course = courseOpen ? d.cert.course : entry.parts.course;
      out.push(courseOpen ? field(T.cert, el('select', { class: 'input', onchange: (e) => { d.cert.course = e.target.value; render(); } },
        el('option', { value: '', text: '—' }),
        R.roster.COURSES.filter(c => c && !(c === 'NONE' && (entry.parts.hasDate ?? /^\d{4}-\d{2}/.test(entry.parts.date || '')))).map(c => el('option', { value: c, selected: d.cert.course === c, text: courseLabel(c) }))))
        : el('p', { class: 'note', text: `${L(T.cert)}: ${courseLabel(course)}（${L(T.filled)}）` }));
      if (ask.includes('certDate') && entry.parts.cert.includes('date') && course && course !== 'NONE') {
        out.push(field(T.certDate, el('input', { class: 'input input--short', type: 'month', value: d.cert.date, oninput: (e) => { d.cert.date = e.target.value; } })));
      }
    }
    if (ask.includes('dives')) out.push(field(T.dives, input(d, 'dives', { type: 'number', min: 0, max: 100000, inputmode: 'numeric', class: 'input input--short' })));
    if (ask.includes('lastDive')) out.push(field(T.lastDive, input(d, 'lastDive', { type: 'month', class: 'input input--short' })));
    if (ask.includes('history')) out.push(el('fieldset', { class: 'group' }, el('legend', { class: 'label', text: L(T.history) }), consentBox(d), healthRows(d)));
    return out;
  }

  /* 同意のチェック。健康の答え（既往症・当日の体調）を入れる所には全部出す。同意がまだの人だけ */
  const consentBox = (d) => el('label', { class: 'consent' },
    el('input', { type: 'checkbox', checked: d.consent, onchange: (e) => { d.consent = e.target.checked; render(); } }),
    el('span', { text: L(T.consent) }));

  function healthRows(d) {
    return R.HEALTH.map((q, i) => el('div', { class: 'hq' },
      el('p', { class: 'hq__q', text: L(q) }),
      el('div', { class: 'choices' }, ['yes', 'no'].map(a => el('label', { class: 'choice' },
        el('input', { type: 'radio', name: `ask-h${i}`, checked: d.answers[i] === a, disabled: !d.consent,
          onchange: () => { d.answers = d.answers.map((x, j) => (j === i ? a : x)); } }),
        el('span', { text: L(T[a]) }))))));
  }

  /* ---------- この内容で合っていますか（決定ログ 2026-10-28 unconfirmed-marks）----------
     AI が読んだまま、まだ誰も確かめていない値（entry.confirm）を、その人の分だけ見せる。健康は出さない。名前は「合っている」だけ */
  const CONF_LABEL = { name: T.confName, birthDate: T.birthDate, address: T.address, emergency: T.emergency, cert: T.cert, dives: T.dives, lastDive: T.lastDive };
  function confirmText(c) {
    const v = c.value;
    if (c.field === 'emergency') return [v.name, v.relation ? `(${v.relation})` : '', v.phone].filter(Boolean).join(' ');
    if (c.field === 'cert') return `${courseLabel(v.course) || ''} ${v.date}`.trim();
    return String(v);
  }

  /* 送る。本物のリンクは Worker に、試作はこの端末の名簿に。問題があれば画面に出し、入れた値は消さない */
  async function sendConfirm(entry, agree, fix) {
    problems = [];
    flash = null;
    if (remote) {
      const got = await remote.confirm(entry.person.id, agree, fix);
      problems = got.problems;
    } else {
      save('guest.confirmGuest', { id: entry.person.id, agree, ...(fix ? { fix } : {}), at: new Date().toISOString() });
    }
    if (!problems.length) { flash = 'confirmed'; fixing = null; }
    render();
  }

  /* 「直す」の入力欄（直す値の形は名簿のとおり。送る前に Worker が同じ検査をかける） */
  function fixControls(d, field) {
    const bind = (key) => (e) => { d[key] = e.target.value; };
    if (field === 'emergency') {
      const sub = (key, label, type) => el('input', { class: 'input', type, value: d[key], placeholder: L(label), 'aria-label': L(label), oninput: bind(key) });
      return el('div', { class: 'row' }, sub('name', T.eName, 'text'), sub('relation', T.eRelation, 'text'), sub('phone', T.ePhone, 'tel'));
    }
    if (field === 'cert') {
      return el('div', { class: 'row' }, el('select', { class: 'input', onchange: bind('course') },
        R.roster.COURSES.filter(Boolean).map(c => el('option', { value: c, selected: d.course === c, text: courseLabel(c) }))),
      el('input', { class: 'input input--short', type: 'month', value: d.date, oninput: bind('date') }));
    }
    const type = { birthDate: 'date', dives: 'number', lastDive: 'month' }[field] || 'text';
    const extra = field === 'dives' ? { min: 0, max: 100000, inputmode: 'numeric' } : {};
    return el('input', { class: 'input', type, value: d.v, maxlength: 120, ...extra, oninput: bind('v') });
  }
  const fixDraft = (c) => (typeof c.value === 'object' ? JSON.parse(JSON.stringify(c.value)) : { v: String(c.value) });
  function fixValue(d, field) {
    if (field === 'emergency') return { name: d.name.trim(), relation: d.relation.trim(), phone: d.phone.trim() };
    if (field === 'cert') return { course: d.course, date: d.course === 'NONE' ? '' : d.date };
    return field === 'dives' ? (d.v === '' ? '' : Number(d.v)) : d.v.trim();
  }

  function confirmRow(entry, c) {
    const label = L(CONF_LABEL[c.field]);
    const mine = fixing && fixing.personId === entry.person.id && fixing.field === c.field;
    if (mine) {
      const send = () => sendConfirm(entry, [], { [c.field]: fixValue(fixing.draft, c.field) });
      return el('div', { class: 'cf' }, el('p', { class: 'cf__head', text: label }), fixControls(fixing.draft, c.field),
        el('div', { class: 'actions actions--two' },
          el('button', { class: 'btn btn--small', type: 'button', text: L(T.confirmSend), onclick: send }),
          el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: L(T.cancel), onclick: () => { fixing = null; problems = []; render(); } })));
    }
    const open = () => { fixing = { personId: entry.person.id, field: c.field, draft: fixDraft(c) }; problems = []; render(); };
    return el('div', { class: 'cf' }, el('p', { class: 'cf__head', text: label }), el('p', { class: 'rd__v', text: confirmText(c) }),
      el('div', { class: c.canFix ? 'actions actions--two' : 'actions' },
        el('button', { class: 'btn btn--small', type: 'button', text: L(T.confirmYes), onclick: () => sendConfirm(entry, [c.field]) }),
        c.canFix ? el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: L(T.confirmFix), onclick: open }) : null));
  }

  function confirmPart(entry) {
    const list = entry.confirm || [];
    const left = entry.confirmLeft || [];
    if (!list.length && left.length) {
      return el('p', { class: 'sheet__note', text: `${L(T.confirmOther)} ${left.map(f => L(CONF_LABEL[f])).join(R.lang === 'en' ? ', ' : '・')}` });
    }
    if (!list.length) return null;
    const editing = fixing && fixing.personId === entry.person.id;
    return el('section', { class: 'sheet confirm' },
      el('p', { class: 'sheet__title' }, L(T.confirmTitle), el('small', { text: String(list.length) })),
      el('p', { class: 'sheet__note', text: L(T.confirmLead) }),
      list.map(c => confirmRow(entry, c)),
      list.some(c => c.field === 'name') ? el('p', { class: 'sheet__note', text: L(T.confirmName) }) : null,
      list.length > 1 && !editing ? el('button', { class: 'btn', type: 'button', text: L(T.confirmAll), onclick: () => sendConfirm(entry, list.map(c => c.field)) }) : null,
      el('p', { class: 'errors', role: 'alert', text: problemText() }));
  }

  /* 水に入ってからの症状（県警の体調チェック表の「注意」）。症状と注意の文は data-sipe.js（表のまま）。見出しと測ることの知らせは、この画面の言葉。
     画面の言葉（日本語・英語）で出し、ほかの言語は開いて見る */
  function symptomCard() {
    const X = R.SIPE;
    const cur = R.lang === 'en' ? 'en' : 'ja';
    const others = X.langs.filter(l => l.id !== cur);
    return el('section', { class: 'sym' },
      el('h3', { class: 'sym__title', text: L(T.symTitle) }),
      el('ul', { class: 'sym__list' }, X.symptoms[cur].map(s => el('li', { text: s }))),
      el('p', { class: 'sym__note', text: X.tell[cur] }),
      el('p', { class: 'sym__note', text: L(T.symNote) }),
      el('details', { class: 'sym__more' }, el('summary', { text: others.map(l => l.label).join('・') }),
        others.map(l => el('div', { class: 'sym__ln', lang: l.id },
          el('p', { class: 'sym__lang', text: l.label }), el('p', { text: X.tell[l.id] }), el('p', { class: 'sym__words', text: X.symptoms[l.id].join(' / ') })))),
      el('p', { class: 'sym__note', text: L(T.symSource) }));
  }

  /* 当日の体調。当日でなければ、デモのときだけ「当日として」答えられる */
  function todayPart(trip, d, entry) {
    const isDay = isTheDay(trip, entry) || (todayDemo && demoMode());
    if (!isDay) {
      return el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, L(T.todayWait), el('small', { text: md(trip.date) })),
        demoMode() ? el('p', { class: 'reset sheet__note' }, el('button', { class: 'linkbtn', type: 'button', text: L(T.todayDemo), onclick: () => { todayDemo = true; render(); } })) : null);
    }
    const big = (value, title, sub) => el('button', { class: 'big', type: 'button', 'aria-pressed': String(d.today === value),
      onclick: () => { d.today = value; render(); } }, L(title), el('small', { text: L(sub) }));
    return el('section', { class: 'today' },
      el('h3', { class: 'h2', text: L(T.todayTitle) }),
      entry.consented ? null : consentBox(d),
      big('ok', T.todayOk, T.todayOkSub), big('unwell', T.todayBad, T.todayBadSub),
      el('p', { class: 'note', text: L(T.todayNote) }));
  }

  /* ---------- 送る ---------- */
  /* op は { state, problems } を返す core の関数の名前。問題があれば保存せずに problems に置く。保存できなかったときも知らせる */
  function save(op, args) {
    try {
      const { saved, out } = R.rosterStore.apply(op, args);
      problems = out.problems.length ? out.problems : saved === false ? ['save'] : [];
      return !problems.length;
    } catch (e) {
      problems = ['save'];
      return false;
    }
  }

  /* 送れたら、まだ入れる所（聞く項目か、確かめる項目）が残っている次の人へ移る。
     「送る」は開いている 1 人分だけなので、2 人以上の予約で次の人を押し忘れて「送りました」だけが残らないように */
  function afterSent() {
    const v = remote ? remote.view() : localView();
    const people = v && Array.isArray(v.people) ? v.people : [];
    const at = people.findIndex(x => x.person.id === personId);
    const rest = [...people.slice(at + 1), ...people.slice(0, Math.max(at, 0))];
    const next = rest.find(x => x.ask.length || (x.confirm || []).length);
    flash = people.length < 2 ? 'sent' : next ? 'sentNext' : 'sentAll';
    flashWho = next ? { sent: personId, next: next.person.id } : null;
    if (next) personId = next.person.id;
    render();
    if (next && typeof window.scrollTo === 'function') window.scrollTo({ top: 0 });
  }

  /* 本物のリンク: Worker に送り、Worker が数えた問題を出す */
  async function sendRemote(entry, d) {
    if (entry.ask.length) {
      const got = await remote.send(entry.person.id, { ...d, dives: d.dives === '' ? '' : Number(d.dives) });
      if (got.problems.length) { problems = got.problems; render(); return; }
    }
    if (entry.needsToday && entry.todayOpen && d.today) {
      const got = await remote.today(entry.person.id, d.today, d.consent);
      if (got.problems.length) { problems = got.problems; render(); return; }
    }
    afterSent();
  }

  /* 名前が空の人の名前だけを送る（{ name } だけの入力。他の項目は聞いたまま） */
  async function sendName(entry, d) {
    problems = [];
    if (remote) {
      const got = await remote.send(entry.person.id, { name: d.name });
      if (got.problems.length) problems = got.problems; else flash = 'sent';
      render();
      return;
    }
    if (save('guest.applyGuest', { id: entry.person.id, input: { name: d.name }, today: R.today(), at: new Date().toISOString() })) flash = 'sent';
    render();
  }

  function send(entry, trip) {
    const d = draftOf(entry.person);
    const at = new Date().toISOString();
    problems = [];
    if (remote) { sendRemote(entry, d); return; }
    if (entry.ask.length) {
      const inputValue = { ...d, dives: d.dives === '' ? '' : Number(d.dives) };
      if (!save('guest.applyGuest', { id: entry.person.id, input: inputValue, today: R.today(), at })) { render(); return; }
    }
    const demo = !isTheDay(trip, entry) && todayDemo && demoMode();
    if (entry.needsToday && (isTheDay(trip, entry) || demo) && d.today) {
      if (!save('guest.answerToday', { id: entry.person.id, answer: d.today, day: trip.date, consent: d.consent, today: R.today(), demo, at })) { render(); return; }
    }
    afterSent();
  }

  /* ---------- パスポートから ---------- */
  function renderPassport(v, entry) {
    const pass = R.passStore.get();
    const maxDays = (R.store.get().medicalDays || R.MEDICAL_DAYS_DEFAULT);
    const offer = G().passportOffer(pass, { today: R.today(), maxDays });
    const items = G().passportChoices(R.rosterStore.get(), { id: entry.person.id, offer });
    const usable = items.filter(i => i.patch);
    if (passKeys === null) passKeys = usable.map(i => i.key);
    const row = (i) => {
      const value = i.key === 'cert' ? [i.level, i.date]
        : i.key === 'dives' ? [`${i.dives} ${R.lang === 'en' ? 'dives' : '本'}`, i.lastDive]
          : [L(T.passAnswers), i.blocked === 'name' ? L(T.passNameBlocked) : i.old ? `${i.days} ${L(T.passOld)}` : `${i.answeredAt} ${L(T.passAnswered)}`];
      return el('label', { class: 'pick' },
        el('input', { type: 'checkbox', checked: !!i.patch && passKeys.includes(i.key), disabled: !i.patch,
          onchange: (e) => { passKeys = e.target.checked ? [...passKeys, i.key] : passKeys.filter(k => k !== i.key); render(); } }),
        el('span', { class: 'rd__k', text: L({ cert: T.passCert, dives: T.passDives, history: T.passHistory }[i.key]) }),
        el('span', { class: 'rd__v' }, value[0], value[1] ? el('span', { class: 'rd__sub', text: value[1] }) : null));
    };
    const differs = !!pass && !G().passportSameName(R.rosterStore.get(), { id: entry.person.id, offer });
    const restAsked = ['birthDate', 'address', 'emergency'].some(k => entry.ask.includes(k));
    const chosen = usable.filter(i => passKeys.includes(i.key));
    const needsConsent = chosen.some(i => i.key === 'history') && !entry.consented;
    const d = draftOf(entry.person);
    const leave = () => { view = 'form'; passKeys = null; otherName = false; render(); };
    return [
      el('p', { class: 'note', text: `${v.shop}${L(T.passTo)}` }),
      el('h2', { class: 'page__title', text: L(T.passTitle) }),
      el('p', { class: 'page__sub', text: `${personLabel(v, entry.person)}${R.lang === 'en' ? '' : ' '}${L(T.passFor)}` }),
      items.length ? el('div', { class: 'sheet' }, items.map(row)) : el('p', { class: 'empty', text: L(T.passNone) }),
      differs ? el('div', { class: 'band band--warn' }, el('p', { class: 'band__title', text: L(entry.person.name ? T.passNameDiff : T.passNameEmpty) }),
        el('p', { class: 'band__text', text: `${pass.name || '—'} / ${entry.person.name || '—'}${R.lang === 'en' ? '. ' : '。'}${L(T.passNameText)}` })) : null,
      differs ? el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: otherName, onchange: (e) => { otherName = e.target.checked; render(); } }),
        el('span', { text: L(T.passOtherName) })) : null,
      needsConsent ? consentBox(d) : null,
      restAsked ? el('p', { class: 'note', text: L(T.passRest) }) : null,
      R.dock(
        el('p', { class: 'errors', role: 'alert', text: problemText() }),
        el('button', { class: 'btn', type: 'button', disabled: !chosen.length || (differs && !otherName) || (needsConsent && !d.consent), text: L(T.passUse),
          onclick: () => {
            const at = new Date().toISOString();
            if (!save('guest.applyPassport', { id: entry.person.id, offer, keys: passKeys, otherName, consent: d.consent, today: R.today(), at })) { render(); return; }
            flash = 'sent';
            leave();
          } }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: L(T.cancel), onclick: () => { problems = []; leave(); } }))
    ];
  }

  /* ---------- 描く ---------- */
  /* 便が中止になったら、入力は聞かずに知らせだけを出す（見落とすと港に来てしまうので、注意の帯） */
  function renderCancelled(v) {
    const { trip } = v;
    const t = R.roster.CANCEL_TEXT[trip.cancel.reason] || { why: '', en: '' };
    const why = trip.cancel.reason === 'other' ? '' : R.lang === 'en' ? t.en : t.why;   // 「その他」は理由を書かない
    return [
      el('p', { class: 'note', text: `${v.shop}${L(T.from)}` }),
      el('h2', { class: 'page__title', text: [md(trip.date), trip.start, trip.tour].filter(Boolean).join(' ') }),
      el('div', { class: 'band band--warn', role: 'alert' }, el('p', { class: 'band__title', text: `! ${L(T.cancelTitle)}` }),
        el('p', { class: 'band__text', text: [why, L(T.cancelText)].filter(Boolean).join(R.lang === 'en' ? '. ' : '。') })),
      backLink()
    ];
  }

  /* 試作だけ: いつもの画面に戻る。本物のリンク（ask.html）には戻る先が無い */
  const backLink = () => (remote ? null : el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: L(T.back), onclick: close })));

  /* 本物の予約のリンク: 健康は 1 人ずつのリンクで本人が答える。人ごとにリンクを作って写す */
  function healthLinks(v) {
    const open = v.people.filter(x => x.healthOpen);
    if (!open.length) return null;
    const copy = async (x) => {
      const got = personUrls[x.person.id] || await remote.personLink(x.person.id);
      if (!got.url) { problems = [got.why || 'network']; render(); return; }
      let copied = false;
      try { await navigator.clipboard.writeText(got.url); copied = true; } catch (e) { copied = false; }
      personUrls[x.person.id] = { url: got.url, copied };
      render();
    };
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__note', text: L(T.healthBy) }),
      open.map(x => {
        const made = personUrls[x.person.id];
        return el('div', { class: 'rd' },
          el('button', { class: 'linkbtn', type: 'button', text: `${personLabel(v, x.person)}${R.lang === 'en' ? '' : ' '}${L(T.personLink)}`, onclick: () => copy(x) }),
          made ? el('span', { class: 'rd__sub', text: L(made.copied ? T.personCopied : T.personFail) }) : null,
          made && !made.copied ? el('p', { class: 'url', text: made.url }) : null);
      }));
  }

  function renderForm(v) {
    const { trip, items } = v;
    const entry = v.people.find(x => x.person.id === personId) || v.people[0];
    personId = entry.person.id;
    const d = draftOf(entry.person);
    const pass = remote ? null : R.passStore.get();   // 本物のリンクでは、この端末のパスポートから入れる所は次の一切れ
    const done = !entry.ask.length && !entry.needsToday;
    /* お店がもう知っていることは、項目の名前だけを出す（リンクが転送されても中身が見えないように） */
    const known = entry.known.map(k => el('div', { class: 'rd' },
      el('span', { class: 'rd__k', text: itemLabel(items, k) }), el('span', { class: 'rd__v', text: L(T.filled) })));
    const canSend = entry.ask.length || (entry.needsToday && (isTheDay(trip, entry) || (todayDemo && demoMode())) && d.today);
    return [
      el('p', { class: 'note', text: `${v.shop}${L(T.from)}` }),
      el('h2', { class: 'page__title', text: L(trip.kind === 'snorkel' ? T.titleSnorkel : T.titleDive) }),
      el('p', { class: 'page__sub', text: `${[md(trip.date), trip.start, trip.tour].filter(Boolean).join(' ')}${R.lang === 'en' ? '. ' : '。'}${L(T.law)}` }),
      flash ? el('p', { class: 'flag flag--ok', role: 'status', text: flashText(v) }) : null,
      pass && entry.ask.some(k => ['certDate', 'courses', 'dives', 'lastDive', 'history'].includes(k))
        ? el('div', { class: 'passbar' }, el('span', { text: R.lang === 'en' ? `${L(T.passHere)} (${pass.name})` : `${L(T.passHere)}（${pass.name}）` }),
          el('button', { class: 'btn btn--small', type: 'button', text: L(T.fromPass), onclick: () => { view = 'passport'; flash = null; problems = []; passKeys = null; otherName = false; render(); } }))
        : null,
      v.people.length > 1 ? el('div', { class: 'ptabs', role: 'group' }, v.people.map(x => el('button', {
        class: 'ptab', type: 'button', 'aria-pressed': String(x.person.id === personId),
        onclick: () => { personId = x.person.id; problems = []; flash = null; render(); }
      }, personLabel(v, x.person), !x.ask.length && !x.needsToday ? ' ✓' : ''))) : null,
      confirmPart(entry),
      known.length ? el('details', { class: 'sheet known' },
        el('summary', { text: R.lang === 'en' ? `${L(T.known)} (${known.length})` : `${L(T.known)}（${known.length}）` }), known, el('p', { class: 'sheet__note', text: L(T.knownNote) })) : null,
      done ? el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, `✓ ${L(remote && entry.healthOpen ? T.doneHere : T.doneTitle)}`),
        el('p', { class: 'sheet__note', text: L(T.doneText) })) : null,
      entry.ask.length ? el('div', { class: 'form ask__form' }, formFields(entry, d, items)) : null,
      remote && v.kind === 'booking' ? healthLinks(v) : null,
      entry.needsToday && entry.ask.length ? el('p', { class: 'note', text: L(T.todayLater) }) : null,
      entry.needsToday && !entry.ask.length ? todayPart(trip, d, entry) : null,
      symptomCard(),
      canSend ? R.dock(
        el('p', { class: 'errors', role: 'alert', text: problemText() }),
        el('button', { class: 'btn', type: 'button', text: sendLabel(v, entry), onclick: () => send(entry, trip) })) : null,
      backLink()
    ];
  }

  /* 2 人以上の予約では、誰の分を送るのかをボタンに書く */
  const sendLabel = (v, entry) => {
    if (v.people.length < 2) return L(T.send);
    const who = personLabel(v, entry.person);
    return R.lang === 'en' ? `Send for ${who}` : `${who}の分を送る`;
  };
  const flashText = (v) => {
    if (flash !== 'sentNext' || !flashWho) return L(T[flash]);
    const who = (id) => personLabel(v, (v.people.find(x => x.person.id === id) || v.people[0]).person);
    return R.lang === 'en' ? `Sent for ${who(flashWho.sent)}. Next: ${who(flashWho.next)}` : `${who(flashWho.sent)}の分を送りました。次は ${who(flashWho.next)} です`;
  };

  const problemText = () => (problems.length ? `${L(T.fix)}: ${problems.map(k => L(PROBLEM[k] || PROBLEM.save)).join(R.lang === 'en' ? ', ' : '・')}` : '');

  /* 試作: この端末の名簿から */
  function localView() {
    const s = R.rosterStore.get();
    const v = G().guestView(s, bookingId);
    if (!v) return null;
    const booking = s.bookings.find(b => b.id === bookingId);
    v.shop = booking && C().isPartnerBooking(booking) ? booking.shop : s.shop.name;   // 乗り合いの他のお店のお客さんには、そのお店の名前を出す
    return v;
  }

  function render() {
    if (!bookingId && !remote) return;
    const v = remote ? remote.view() : localView();
    if (!v || !v.trip || !v.people.length) {
      R.fill(root, el('p', { class: 'empty', text: L(T.noBooking) }), backLink());
      return;
    }
    if (remote) v.items = R.roster.ITEMS[v.trip.kind || 'dive'];
    const entry = v.people.find(x => x.person.id === personId) || v.people[0];
    R.fill(root, v.trip.cancel ? renderCancelled(v) : view === 'passport' ? renderPassport(v, entry) : renderForm(v));
  }

  /* ---------- 開く・閉じる ---------- */
  function show(on) {
    root.hidden = !on;
    guestParts.forEach(n => { if (n) n.hidden = on; });
  }

  function open(id) {
    if (id !== bookingId) { drafts = {}; personId = ''; todayDemo = false; passKeys = null; otherName = false; }
    bookingId = id;
    view = 'form';
    problems = [];
    flash = null;
    show(true);
    if (R.showTab) R.showTab('guest');
    render();
  }

  function close() {
    bookingId = '';
    show(false);
    if (location.hash.startsWith('#ask=')) history.replaceState(null, '', location.pathname + location.search);
    window.scrollTo({ top: 0 });
  }

  function fromHash() {
    const m = /^#ask=([\w-]{1,64})$/.exec(location.hash);
    if (m) open(decodeURIComponent(m[1]));
  }

  /* お店の画面の「この端末で開く（デモ）」から */
  R.openAsk = (id) => {
    history.replaceState(null, '', `${location.pathname}${location.search}#ask=${encodeURIComponent(id)}`);
    open(id);
  };
  /* 本物のリンク（ask.html）から: 読み書きの先を Worker にする */
  R.guestAsk = {
    remote(source) {
      remote = source;
      drafts = {};
      personUrls = {};
      personId = '';
      view = 'form';
      show(true);
      render();
    },
    refresh: () => render()
  };
  window.addEventListener('hashchange', fromHash);
  R.onLang(() => render());
  R.rosterStore.subscribe(() => { if (bookingId && !root.hidden) render(); });
  fromHash();
})();
