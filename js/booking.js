/* 予約の画面（お店、日本語のみ）: 予約の一覧と、画面の切り替え。メールの取り込みと電話の予約は js/booking-add.js、
   予約を直す・別の便へ・取り消すは js/booking-edit.js（どちらも、ここの ui を通して保存や移動をする）。
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
  const PROBLEM_JA = { date: '日付', people: '人数（1〜30）', leadName: '代表者の名前（60 字まで）', leadPhone: '電話（30 字まで）', note: 'メモ（400 字まで）' };
  const NOT_SAVED = 'この端末に保存できませんでした。画面を閉じると消えます。';
  const STORE_NOTE_JA = {
    recovered: '保存されていた名簿が読めなかったので、この端末の別の場所に残して、空の名簿から始めました。',
    unreadable: '保存されていた名簿が読めませんでした。消さずに元のまま残しています。この画面で入れた予約は保存されず、閉じると消えます。',
    conflict: '別のタブで名簿が変わりました。この画面には、保存できていない予約があります。',
    'sync-offline': 'サーバーに送れていない直しがあります。この端末に残してあり、つながったら送ります。',
    'sync-kept': '送れないうちに別の端末で名簿が直されました。この端末の名簿は消さずに別の場所に残し、サーバーの名簿にしました。',
    'sync-dropped': '別の端末の直しとぶつかったため、この端末の直しを取り消した物があります。取り消す前の名簿は別の場所に残しました。予約と名簿を確かめてください。',
    'sync-shop': 'この端末には、別のお店の名簿がありました。送らずに端末の別の場所に残し、ログインしたお店の名簿にしました。',
    'sync-lost': '送れなかった直しを、端末の容量が足りず残せませんでした。予約と名簿を確かめ、足りない物を入れ直してください。',
    'sync-shop-changed': 'ログインしたお店が変わりました。画面を読み込み直してください。この端末の直しは送らず、別の場所に残してあります。',
    'sync-conflict': '別の端末が先に直した項目を、この端末の直しで書き換えました。記録の画面で、前と後を確かめてください。',
    'sync-gone': 'サーバーの名簿が見つかりません。この端末の直しは送らず、名簿を別の場所に残しました。お店の管理者に知らせてください。',
    'sync-shrunk': 'サーバーの名簿は、この端末の名簿より人が大きく減っていました。この端末の名簿は消さず、別の場所に残しました。予約と名簿を確かめてください。',
    'sync-newer': 'REDUX が新しくなりました。画面を読み込み直してください。この端末の直しは別の場所に残してあります。',
    'sync-login': 'ログインが切れました。画面を読み込み直してください。直しはこの端末に残してあり、ログインし直したら送ります。',
    'sync-shrink': 'この端末から、名簿の人が大きく消える書き込みがあったので、サーバーが止めました。サーバーの名簿に戻し、この端末の名簿は別の場所に残しました。',
    'sync-rejected': 'サーバーが受け付けなかった直しがあります。サーバーの名簿に戻し、この端末の名簿は別の場所に残しました。予約と名簿を確かめてください。',
    newer: '別のタブで、この画面より新しい版の名簿が保存されました。消さないよう、この画面からは保存しません。ページを読み込み直してください。'
  };

  /* 読めなかった予約メール（サーバーを使う版だけ）。予約の一覧と書類の自動化の画面を開いたときに、1 分に 1 回まで読む */
  const UNREAD_WHY_JA = { limit: '1 日の上限を超えた', size: 'メールが大きすぎる', text: '本文が読めない', 'no-date': '日付が書かれていない',
    full: '名簿がいっぱい', roster: '名簿に書けなかった', error: 'サーバーの誤り', ai: 'AI が読めなかった',
    many: 'この日は、ほかにも読めなかったメールがある（多すぎて 1 通ずつは残していない）' };
  const unread = { items: [], at: 0 };
  function loadUnread() {
    if (!R.rosterStore.synced() || Date.now() - unread.at < 60000) return;
    unread.at = Date.now();
    R.rosterSync.unread().then(r => { if (r.ok) { unread.items = r.items; if (['list', 'board'].includes(mode)) render(); } });
  }
  /* 読めなかった予約メールは、書類の自動化の画面（auto-flow.js の renderBoard）に出す */
  const unreadView = () => ({
    items: unread.items,
    whyText: (x) => UNREAD_WHY_JA[x.why] || '読めなかった',
    done: (id) => R.rosterSync.doneUnread(id).then(ok => { if (ok) { unread.items = unread.items.filter(x => x.id !== id); render(); } })
  });

  let mode = 'list';        // list / board（書類の自動化、auto-flow.js）/ mail / phone / intake（名簿の取り込み）/ review（読み取りを確かめる）/ ask（お客さんに聞く）
                            // day（今日の名簿）/ spo2（血中酸素）/ print（条例の名簿）/ ics（カレンダー）/ log（記録）は day-roster.js
                            // share（乗り合い）/ partner（他のお店役）/ partnerpaper / joint（合同名簿）/ jointprint / boat（船の上）/ callout（名前で呼ぶ）は share-roster.js
                            // partnerphoto（他のお店が写真で名前を渡す）は partner-photo.js
                            // kept（端末に残した名簿を見て戻す）
  let intakeTrip = '';
  let reviewPerson = '';
  let askBooking = '';
  let dayTrip = '';
  let shareShop = '';       // 他のお店役で入れているお店
  let day = '';
  let notice = null;        // { kind: 'ok' | 'warn', text }
  let armedReset = false;

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

  /* 保存は rosterStore.apply を通す。op は roster-core.js の ops の名前、args は押した時に決まる入力を全部入れた物（時刻もここで決める）。
     形が合わなければ error、端末に書けなければ saved: false。out は core の関数の答え（bookingId など） */
  function save(op, args, opts) {
    try {
      const r = R.rosterStore.apply(op, args, opts);
      return { error: null, saved: r.saved, out: r.out };
    } catch (e) {
      return { error: e, saved: false, out: null };
    }
  }

  /* ctx: day（一覧で開く日）/ tripId（名簿の取り込みの便）/ personId（確かめる人）/ notice（知らせる文）/ saved（false なら保存できなかったと知らせる） */
  function go(next, ctx = {}) {
    mode = next;
    armedReset = false;
    armedKept = '';
    notice = ctx.saved === false ? { kind: 'warn', text: NOT_SAVED } : ctx.warn ? { kind: 'warn', text: ctx.warn } : ctx.notice ? { kind: 'ok', text: ctx.notice } : null;
    if (ctx.tripId) { intakeTrip = ctx.tripId; dayTrip = ctx.tripId; }
    if (ctx.personId) reviewPerson = ctx.personId;
    if (ctx.bookingId) askBooking = ctx.bookingId;
    if (ctx.shop !== undefined) shareShop = ctx.shop;
    if (ctx.day) day = ctx.day;
    R.bookingAdd.enter(next);    // メールと電話は、開くたびに空から始める
    R.bookingEdit.enter(next);   // 直す・別の便へ・取り消すは、開くたびに今の予約から入力を作り直す
    if (next === 'ask') { copied = null; showQr = ctx.showQr === true; }
    render();
  }

  /* 予約を入れたあと、一覧に戻って知らせる */
  function done(date, text, saved) {
    day = date;
    notice = saved ? { kind: 'ok', text } : { kind: 'warn', text: `${text}。${NOT_SAVED}` };
    mode = 'list';
    render();
  }

  /* サーバーにつながっていない間は、どの画面でも上に出す（直しは端末に貯めて、試し直している） */
  function linkBanner() {
    if (R.rosterStore.link() !== 'down') return null;
    const n = R.rosterStore.pending();
    return el('p', { class: 'flag flag--warn', role: 'status',
      text: `サーバーにつながっていません。${n ? `直した ${n} 件はこの端末に残してあり、つながったら送ります。` : '直しはこの端末に残し、つながったら送ります。'}` });
  }
  /* 名簿の知らせ。つながっていない知らせ（sync-offline）は linkBanner が出す */
  function storeNote() {
    const key = R.rosterStore.note();
    if (!key || key === 'sync-offline') return null;
    const seen = key === 'sync-conflict';
    return el('p', { class: 'flag flag--warn' }, `${STORE_NOTE_JA[key]}${seen ? `（${R.rosterStore.conflicts().length} 件）` : ''}`,
      seen ? el('button', { class: 'linkbtn', type: 'button', text: '確かめた', onclick: () => R.rosterStore.clearConflicts() }) : null);
  }

  const head = (title, sub) => [
    el('p', { class: 'note', text: R.rosterStore.get().shop.name }),
    el('h2', { class: 'page__title', text: title }),
    sub ? el('p', { class: 'page__sub', text: sub }) : null,
    linkBanner(),
    notice ? el('p', { class: `flag flag--${notice.kind}`, role: 'status', text: notice.text }) : null
  ];
  const back = () => el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: '予約の一覧に戻る', onclick: () => go('list') }));
  const field = (label, control, hint) => el('label', { class: 'field' }, el('span', { class: 'label', text: label }), control, hint ? el('span', { class: 'note', text: hint }) : null);
  /* 画面の下に固定する操作の帯。左が主、右が副 */
  const dock = R.dock;

  /* ---------- 予約の一覧（時刻表） ---------- */
  /* 予約の状態は、色の札にせず、文字の色と短い印で見せる */
  function bookingLine(row) {
    const b = row.booking;
    const total = row.people.length;
    const unsure = row.people.some(p => p.unsure.length);
    const waiting = row.people.filter(p => !p.done).length;
    const guests = row.people.filter(p => p.ask.length).length;   // お客さんの入力を待っている人。残りは便の項目（ポイント・ガイド）
    const heldToday = row.people.some(p => p.heldToday);            // 当日の体調を、乗り合いの他のお店が便の日に確かめる
    const st = unsure ? ['check', '! 確かめる'] : waiting ? ['wait', `・名簿 ${row.done}/${total}`] : ['ok', '✓ そろった'];
    const lead = b.leadName || (row.people[0] && row.people[0].name) || '名前の分からない予約';
    const others = Math.max(b.people, total) - 1;
    const where = C().isPartnerBooking(b) ? `${b.shop}（乗り合い）` : b.site ? `${b.site}（${SOURCE_JA[b.source]}）` : SOURCE_JA[b.source];
    const auto = R.autoFlow.rowNote(R.rosterStore.get(), b.id);   // 書類の自動化: 送ったお願い・お店への知らせ
    /* 直す・別の便へ・取り消す（乗り合いの他のお店の予約は、そのお店の名簿が元なので出さない） */
    const acts = C().isPartnerBooking(b) ? null : el('div', { class: 'bk__acts' },
      el('button', { class: 'linkbtn', type: 'button', text: '直す', onclick: () => go('bedit', { bookingId: b.id }) }),
      el('button', { class: 'linkbtn', type: 'button', text: '別の便へ', onclick: () => go('bmove', { bookingId: b.id }) }),
      el('button', { class: 'linkbtn linkbtn--warn', type: 'button', text: '取り消す', onclick: () => go('bcancel', { bookingId: b.id }) }));
    const status = unsure ? '確かめてほしい所がある' : auto ? auto.text : guests ? `${guests} 人分の入力を待っている`
      : heldToday ? `当日の体調は${b.shop}が便の日に確かめる` : waiting ? '便のポイントかガイドがまだ' : '';
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name' }, lead, others > 0 ? el('span', { class: 'nw', text: ` ほか ${others} 人` }) : null),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: `${where}　${status}`.trim() }),
      R.autoFlow.hasPlan(R.rosterStore.get(), b.id) ? el('button', { class: 'linkbtn', type: 'button', text: '流れを見る', onclick: () => go('flow', { bookingId: b.id }) })
        : guests ? el('button', { class: 'linkbtn', type: 'button', text: 'お客さんに聞く', onclick: () => go('ask', { bookingId: b.id }) }) : null,
      /* 電話の予約などで、その場のお客さんにリンクを QR で見せる（作ったリンクは SMS・LINE でも送れる）。リンクを作れるのはサーバーにつながる版だけ */
      R.rosterStore.synced() && onWorker() && !C().isPartnerBooking(b)
        ? el('button', { class: 'linkbtn', type: 'button', text: 'QR を見せる', onclick: () => go('ask', { bookingId: b.id, showQr: true }) }) : null,
      acts);
  }

  function tripCard(s, trip) {
    const rows = C().bookingRows(s, trip.id);
    return el('section', { class: 'trip', 'aria-label': tripLabel(trip) },
      el('div', { class: trip.cancel ? 'trip__time trip__time--off' : 'trip__time' }, trip.start ? clock(trip.start) : '—',
        el('small', { text: trip.cancel ? '中止' : runLabel(trip) })),
      el('div', {},
        el('div', { class: 'trip__head' },
          el('h3', { class: 'trip__title', text: trip.tour || KIND_JA[trip.kind] }),
          el('span', { class: 'trip__count' }, el('b', { text: String(C().tripSummary(s, trip.id).booked) }), ' 人')),
        rows.length ? el('ul', { class: 'bks' }, rows.map(bookingLine)) : el('p', { class: 'note', text: 'この便の予約はまだありません' }),
        /* 便ごとの操作は 1 つ（design.md の部品）。乗り合い・名簿の取り込みは今日の名簿の画面から */
        rows.length ? el('p', { class: 'trip__links' },
          el('button', { class: 'linkbtn', type: 'button', text: '今日の名簿', onclick: () => go('day', { tripId: trip.id }) })) : null));
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

  /* AI の読み取り（見本 / 本物）。本物を選べるのは、Worker 版で /api/healthz が通ったときだけ。公開版には出さない */
  function aiRow() {
    const A = R.aiReader;
    if (!A.available()) return null;
    const real = A.mode() === 'real';
    const left = A.left();
    const fig = (t) => el('span', { class: 'fig', text: t });
    return el('div', { class: `ai${real ? ' ai--on' : ''}` },
      el('span', { class: 'rd__k', text: 'AI の読み取り' }),
      el('span', { class: 'ai__v' }, el('b', { text: real ? '本物' : '見本' }),
        real ? el('small', {}, el('span', { class: 'nw' }, '今日あと ', fig(String(left.today)), ' 件'), '・',
          el('span', { class: 'nw' }, '今月あと ', fig(`$${left.monthUsd.toFixed(2)}`)))
          : el('small', { text: '試験の答えを使う。AI には送らない' })),
      el('button', { class: 'linkbtn', type: 'button', text: real ? '見本に戻す' : '本物にする', onclick: () => A.setMode(real ? 'sample' : 'real') }));
  }

  /* 健康の質問をどこで聞くか（お店ごと）。紙にすると、お客さんのリンクと自動の連絡は健康を聞かず、名簿の健康の欄は「紙の申込書」になる */
  function healthModeRow(s) {
    const paper = C().paperOf(s);
    const pick = (on) => () => {
      const r = save('core.setHealthPaper', { paper: on, at: now() });
      notice = r.error ? { kind: 'warn', text: '切り替えられませんでした' }
        : { kind: 'ok', text: on ? '健康の質問は、紙の申込書で聞きます。お客さんのリンクと自動の連絡では聞きません。' : '健康の質問を、お客さんのリンクで聞きます。' };
      render();
    };
    const opt = (on, text) => el('button', { class: 'ptab', type: 'button', 'aria-pressed': String(paper === on), text, onclick: pick(on) });
    return el('section', { class: 'reset' },
      el('span', { class: 'rd__k', text: '健康の質問（お店ごと）' }),
      el('div', { class: 'ptabs', role: 'group', 'aria-label': '健康の質問' }, opt(false, 'アプリで聞く'), opt(true, '紙の申込書で聞く')));
  }

  function renderList() {
    loadUnread();
    const s = R.rosterStore.get();
    const trips = C().tripList(s);
    const dates = [...new Set(trips.map(t => t.date))];
    day = pickDay(dates);
    return [
      ...head('予約'),
      aiRow(),
      storeNote(),
      R.autoFlow.boardRow(s, { unread: unread.items.length, ui }),
      dates.length ? el('div', { class: 'days', role: 'group', 'aria-label': '日付' }, dates.map(d => el('button', {
        class: 'day', type: 'button', 'aria-pressed': String(d === day), 'aria-label': md(d),
        onclick: () => { day = d; notice = null; armedReset = false; render(); }
      }, el('small', { text: weekday(d) }), el('b', { text: monthDay(d) })))) : null,
      dates.length
        ? trips.filter(t => t.date === day).map(t => tripCard(s, t))
        : el('p', { class: 'empty', text: 'まだ予約がありません。「メールを貼る」で、見本のメールから試せます。' }),
      /* 見本・デモのボタンは、サーバーにつながっていない試作だけ
         （本物の名簿に架空の予約を混ぜない・名簿を消さない。ジンのレビュー 2026-10-28 H9） */
      !R.rosterStore.synced() ? el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: '見本の乗り合い便を作る（4 店・30 人）',
        onclick: () => {
          /* 開いている日でなく今日に作り、今日を開く（見本の便は「今日の 13:00」。小禄さんの不具合さがし 2026-10-27） */
          const r = save('share.addBigSample', { day: R.today(), at: now() });
          if (!r.error) day = R.today();
          notice = r.error ? { kind: 'warn', text: '見本の便を作れませんでした' } : { kind: 'ok', text: '見本の乗り合い便を作りました（13:00、4 店・お客さん 30 人）' };
          render();
        } })) : null,
      /* 書類の自動化のデモ: 見本のメールが届いた形と、次の予定の時刻まで進める */
      !R.rosterStore.synced() ? el('p', { class: 'reset' }, el('button', {
        class: 'linkbtn linkbtn--muted', type: 'button', text: '見本のメールが届く（デモ）', onclick: () => R.autoFlow.demoMail(ui) })) : null,
      /* デモの時計はつながっていない試作だけ（サーバーの版では予定を動かすのは Cron） */
      !R.rosterStore.synced() && (s.jobs || []).some(j => j.status === 'waiting') ? el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: '時刻を次の予定まで進める（デモ）', onclick: () => R.autoFlow.demoAdvance(ui) })) : null,
      healthModeRow(s),
      R.walkinStaff.listRow({ ui }),
      R.apiKeysStaff.listRow({ ui }),
      R.rosterStore.kept().length ? el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button',
        text: `端末に残した名簿（${R.rosterStore.kept().length}）`, onclick: () => go('kept') })) : null,
      /* 済んで 7 日を過ぎた便は、サーバーが便ごとに分けて置く（読むだけ）。サーバーを使わない版には無い */
      R.rosterStore.synced() ? el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: '済んだ便を見る（7 日より前）', onclick: () => go('past') })) : null,
      !R.rosterStore.synced() && s.trips.length ? resetButton() : null,
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

  /* ---------- 端末に残した名簿（送れなかった・ぶつかった・断られたときの、直す前の名簿） ---------- */
  let armedKept = '';
  const keptWhen = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  function keptLine(k) {
    const armed = armedKept === k.key;
    const restore = () => {
      if (!armed) { armedKept = k.key; render(); return; }
      armedKept = '';
      const ok = R.rosterStore.restoreKept(k.key);
      go(ok ? 'list' : 'kept', ok ? { notice: '残した名簿に戻しました（戻す前の名簿も残してあります）' } : { warn: '戻せませんでした' });
    };
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: keptWhen(k.at) }),
      el('span', { class: 'bk__meta', text: k.ok ? `便 ${k.trips}・予約 ${k.bookings}・人 ${k.people}` : '読めない名簿（そのまま残しています）' }),
      k.ok ? el('button', { class: armed ? 'btn btn--small' : 'linkbtn', type: 'button', text: armed ? 'もう一度押すと、この名簿に置き換わります' : '戻す', onclick: restore }) : null);
  }
  function renderKept() {
    const list = R.rosterStore.kept(true);
    return [
      ...head('端末に残した名簿', `送れなかった直しや、別の端末とぶつかったときの名簿を、新しい ${list.length} 個残しています（最大 5 個）。戻すと今の名簿に置き換わります。今の名簿も残します。`),
      list.length ? el('ul', { class: 'bks' }, list.map(keptLine)) : el('p', { class: 'empty', text: '残した名簿はありません。' }),
      back()
    ];
  }

  /* ---------- お客さんに聞く（送るリンク） ---------- */
  /* 予約 1 件に 1 つのリンク。開いた人は、この予約の人の「まだ」の所だけを入れる（js/guest-ask.js）。
     試作（GitHub Pages）ではこの端末の中だけで動く。Worker 版では Worker が予約ごとの鍵のリンクを作り、お客さんはログインなしで開く（ask.html） */
  const askUrl = (id) => `${location.origin}${location.pathname}#ask=${encodeURIComponent(id)}`;
  const onWorker = () => !!document.querySelector('meta[name="redux-worker"]');
  let copied = null;        // リンクを写せたか（ok / fail）
  let showQr = false;       // リンクを大きな QR でお客さんに見せている
  let made = null;          // Worker が作ったリンク { bookingId, url, expiresOn } か { bookingId, wait } か { bookingId, error }

  async function makeLink(bookingId) {
    made = { bookingId, wait: true };
    copied = null;
    render();
    const r = await R.rosterSync.askLink(bookingId);
    made = r.ok ? { bookingId, url: r.url, expiresOn: r.expiresOn } : { bookingId, error: r.why };
    render();
  }

  function personLine(p, trip) {
    const items = R.roster.ITEMS[trip ? trip.kind : 'dive'];
    const st = C().status(p, trip, { paper: C().paperOf(R.rosterStore.get()) });
    const labels = st.missing.map(k => items.find(i => i.key === k).ja);
    const rest = labels.length > 4 ? ` ほか ${labels.length - 4}` : '';
    return el('div', { class: 'rd' },
      el('span', { class: 'rd__k', text: p.name || '名前の分からない人' }),
      el('span', { class: 'rd__v' }, el('span', { class: 'fig', text: `${items.length - st.missing.length} / ${items.length}` }),
        el('span', { class: 'rd__sub', text: st.done ? '✓ そろった' : labels.length ? `まだ: ${labels.slice(0, 4).join('・')}${rest}` : '! 確かめる所がある' })));
  }

  /* リンクを大きな QR で見せる（お客さんが自分のスマホのカメラで読む）。リンクがまだ無いときは、作る前に「前のリンクが開けなくなる」と知らせる */
  function qrView(url, mine) {
    const qr = url ? R.qrSvg(url) : null;
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, 'QR を見せる', el('small', { text: 'お客さんのスマホで読む' })),
      url
        ? [el('div', { class: 'qr qr--big' }, qr || el('p', { class: 'errors', role: 'alert', text: 'QR を描けませんでした。下の「リンクを写す」で送ってください。' })),
          el('p', { class: 'sheet__note', text: 'この画面をお客さんに見せ、スマホのカメラで読み取ってもらいます。開いた人は、この予約の人の「まだ」の所だけを入れられます。' }),
          el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: 'QR を閉じる', onclick: () => { showQr = false; render(); } }))]
        : el('p', { class: 'sheet__note', text: mine && mine.wait ? 'リンクを作っています…'
          : 'まだこの予約のリンクがありません。作ると、前に送ったリンクは開けなくなります。下の「リンクを作る」を押すと、ここに QR が出ます。' }));
  }

  /* スタッフの携帯から送る（契約も鍵も要らない。リンクを文に入れて、SMS アプリか LINE の共有画面を開くだけで、送るのはスタッフが押す）。
     本文に入るのはお店の名前・決まった 1 行・この予約のリンクだけ。電話番号の無い予約には SMS のボタンを出さない */
  function sendSheet(b, shopName, url) {
    const L = R.contactLink;
    const sms = L.smsHref(b.leadPhone, shopName, url);
    const line = L.lineHref(shopName, url);
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, 'スマホで送る', el('small', { text: '送るのはスタッフ' })),
      el('p', { class: 'sheet__note', text: 'リンクを入れた文を作って、この端末の SMS か LINE を開きます。宛先と送信は、開いた先で確かめて押します。' }),
      el('div', { class: 'sendrow' },
        el('button', { class: showQr ? 'btn' : 'btn btn--ghost', type: 'button', 'aria-pressed': String(showQr), text: 'QR を見せる', onclick: () => { showQr = !showQr; render(); } }),
        sms ? el('a', { class: 'btn btn--ghost', href: sms, text: 'SMS で送る' }) : null,
        line ? el('a', { class: 'btn btn--ghost', href: line, target: '_blank', rel: 'noopener noreferrer', text: 'LINE で送る' }) : null),
      sms ? null : el('p', { class: 'sheet__note', text: '予約に電話番号が入っていないので、SMS では送れません。' }));
  }

  function renderAskLink() {
    const s = R.rosterStore.get();
    const b = s.bookings.find(x => x.id === askBooking);
    if (!b) return [...head('お客さんに聞く'), el('p', { class: 'errors', text: 'この予約が見つかりません。' }), back()];
    const trip = s.trips.find(t => t.id === b.tripId);
    const people = s.people.filter(p => p.bookingId === b.id);
    const lead = b.leadName || (people[0] && people[0].name) || '名前の分からない予約';
    const items = R.roster.ITEMS[trip ? trip.kind : 'dive'];
    const real = onWorker();
    const mine = made && made.bookingId === b.id ? made : null;
    const url = real ? (mine && mine.url) || '' : askUrl(b.id);
    const copy = () => {
      const tell = (how) => () => { copied = how; render(); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(tell('ok'), tell('fail'));
      else tell('fail')();
    };
    return [
      ...head(people.length > 1 ? `${lead} ほか ${people.length - 1} 人` : lead, trip ? `${md(trip.date)} ${tripLabel(trip)}` : ''),
      real && showQr ? qrView(url, mine) : null,
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '名簿のそろい具合', el('small', { text: `${items.length} 項目` })),
        people.map(p => personLine(p, trip))),
      real && url ? sendSheet(b, s.shop.name, url) : null,
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, 'お客さんに送るリンク', el('small', { text: '予約 1 件に 1 つ' })),
        url ? el('p', { class: 'url', text: url }) : null,
        el('p', { class: 'sheet__note', text: real
          ? `LINE やメールに貼って送ります。お客さんはログインなしで開き、この予約の人の「まだ」の所だけを入れられます。健康の質問は、そこから 1 人ずつのリンクで本人が答えます。${mine && mine.expiresOn ? `${md(mine.expiresOn)} まで使えます。` : ''}作り直すと、前に送ったリンクは開けなくなります。`
          : 'LINE やメールに貼って送ります。開いた人は、この予約の人の「まだ」の所だけを入れられます。試作では、この端末の中だけで開けます。' })),
      mine && mine.error ? el('p', { class: 'flag flag--warn', role: 'status', text: mine.error === 404
        ? 'サーバーにまだこの予約が届いていません。少し待ってから、もう一度押してください。' : 'リンクを作れませんでした。もう一度押してください。' }) : null,
      copied === 'ok' ? el('p', { class: 'flag flag--ok', role: 'status', text: 'リンクを写しました' }) : null,
      copied === 'fail' ? el('p', { class: 'flag flag--warn', role: 'status', text: '写せませんでした。上のリンクを長押しして写してください' }) : null,
      back(),
      real
        ? dock(
          url ? el('button', { class: 'btn', type: 'button', text: 'リンクを写す', onclick: copy }) : null,
          el('button', { class: url ? 'btn btn--ghost' : 'btn', type: 'button', disabled: !!(mine && mine.wait), text: mine && mine.wait ? '作っています…' : url ? '作り直す' : 'リンクを作る',
            onclick: () => makeLink(b.id) }))
        : dock(
          el('button', { class: 'btn', type: 'button', text: 'リンクを写す', onclick: copy }),
          el('button', { class: 'btn btn--ghost', type: 'button', text: 'この端末で開く（デモ）', onclick: () => R.openAsk(b.id) }))
    ];
  }

  /* ---------- 描く ---------- */
  /* 名簿の取り込みと確かめる画面（intake-photo.js）に渡す道具 */
  const ui = { head, field, md, tripLabel, save, go, rerender: () => render(), back, dock, clock, tripPicker, tour, done,
    labels: { KIND_JA, SOURCE_JA, PROBLEM_JA } };
  R.bookingAdd.init(ui);
  R.bookingEdit.init(ui);
  const DAY_MODES = { day: 'renderDay', spo2: 'renderSpo2', cancel: 'renderCancel', print: 'renderPrint', ics: 'renderIcs', log: 'renderLog' };
  const SHARE_MODES = { share: 'renderShare', partner: 'renderPartner', partnerpaper: 'renderPartnerPaper', joint: 'renderJoint', jointprint: 'renderJointPrint', boat: 'renderBoat', callout: 'renderCallout' };
  const PRINT_MODES = ['print', 'partnerpaper', 'jointprint', 'pastprint'];

  function render() {
    R.bookingAdd.beforeRender();
    R.bookingEdit.beforeRender();
    const body = R.bookingEdit.MODES.includes(mode) ? R.bookingEdit.render(mode, askBooking)
      : mode === 'mail' ? R.bookingAdd.renderMail() : mode === 'phone' ? R.bookingAdd.renderPhone() : mode === 'kept' ? renderKept()
      : mode === 'intake' ? R.photoIntake.renderIntake({ tripId: intakeTrip, ui })
        : mode === 'review' ? R.photoIntake.renderReview({ personId: reviewPerson, ui })
          : mode === 'ask' ? renderAskLink()
            : mode === 'walkin' ? R.walkinStaff.render({ ui })
            : mode === 'apikeys' ? R.apiKeysStaff.render({ ui })
            : mode === 'flow' ? R.autoFlow.render({ bookingId: askBooking, ui })
            : mode === 'board' ? (loadUnread(), R.autoFlow.renderBoard({ ui, unread: unreadView() }))
            : DAY_MODES[mode] ? R.dayRoster[DAY_MODES[mode]]({ tripId: dayTrip, ui })
              : SHARE_MODES[mode] ? R.shareRoster[SHARE_MODES[mode]]({ tripId: dayTrip, shop: shareShop, ui })
                : mode === 'partnerphoto' ? R.partnerPhoto.render({ tripId: dayTrip, shop: shareShop, ui })
                  : mode === 'past' ? R.pastTrips.renderList({ ui })
                    : mode === 'pastprint' ? R.pastTrips.renderPrint({ tripId: dayTrip, ui }) : renderList();
    R.fill(root, body);
    /* 印刷では名簿の紙だけを出す（css/app.css）。紙が無い画面では白紙にしない */
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
  /* 書類の自動化: 時刻が来た予定を 1 分ごとに動かす。予約と名簿の画面を見ているときは描き直す */
  const autoTick = () => { if (R.autoFlow.tick(save) && !root.closest('[hidden]') && ![...R.bookingAdd.MODES, ...R.bookingEdit.MODES].includes(mode)) render(); };
  setTimeout(autoTick, 1500);
  setInterval(autoTick, 60000);
  const LIVE_MODES = ['list', 'board', 'ask', 'day', 'log', 'joint', 'boat', 'callout'];
  R.rosterStore.subscribe(() => { if (LIVE_MODES.includes(mode) && !document.getElementById('view-booking').hidden) render(); });
  /* 見本 / 本物が変わった（切り替えた・上限で見本に戻った・healthz が通った）。入力の途中の画面は描き直さない */
  R.aiReader.onChange(() => { if (mode === 'list' && !document.getElementById('view-booking').hidden) render(); });
})();
