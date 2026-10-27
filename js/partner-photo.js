/* お店の画面: 乗り合いの他のお店が、予約の一覧（予約アプリの画面か紙の名簿）を写真 1 枚撮って、船に名前を渡す（決定ログ photo-shopcheck）。
   ① 撮る（健康や備考の欄が写っていれば、なぞって黒く塗る）→ ② AI が読んだ人を確かめる（自信なしは直す・足りない所は入れてもよい）→ 船に渡す。
   船に渡すのは名前・体験かどうか・緊急時の連絡先だけ（roster-share.js の fromListReading）。試作では、そのお店「役」でこの端末の中で入れる。
   写真は photo-prep.js が描き直した物だけを送る。AI が「健康の情報が見えた」と答えたら、その読み取りは使わない。
   AI やお客さんの文字は el() の text で出す */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;
  const X = () => R.rosterShare;

  /* 申込書（健康の質問が付く）はここで撮らせない（塗らずに送れる種類なので。ザクのレビュー 2026-10-27）。申込書は名簿の取り込みの画面で、塗ってから送る */
  const KIND_JA = { app: '予約アプリの一覧の画面', paper: '紙の名簿' };
  const SAMPLE = { id: 'l1', src: 'assets/samples/l1.jpg', label: '見本の写真（C ダイブの予約の一覧）' };
  const ERROR_JA = {
    input: '送れない写真です。写真を選び直してください',
    auth: 'ログインが切れたか、通りませんでした。画面を読み込み直してください',
    limit: '今日か今月の上限に達しました。見本の読み取りでは続けられます',
    offline: '届きませんでした。通信を確かめて、もう一度試してください',
    bad: 'AI の答えが形に合わなかったので、使いませんでした。もう一度試してください'
  };
  const HEALTH_SEEN = 'AI が「健康の情報が見えた」と答えたので、この読み取りは使いません。健康の欄を黒く塗ってから、もう一度送ってください。';
  const GUIDE_FIRST = 'ガイドの名前を入れてください（40 字まで）';
  const UNSURE_JA = { name: '名前', cert: '体験かどうか', emergency: '緊急時の連絡先' };
  const now = () => new Date().toISOString();
  const clock = (t) => t.replace(/^0/, '');
  const button = (text, onclick, cls) => el('button', { class: cls || 'linkbtn', type: 'button', text, onclick });

  /* 撮っている写真と読み取り。便とお店が替わったら空に戻す */
  let shot = blankShot('');
  function blankShot(key) {
    return { key, kind: 'app', src: null, sampleId: null, img: null, done: null, rects: [], confirmed: false, prepared: null,
      rows: null, readMode: '', open: -1, edit: null, guide: '', loading: false, making: false, busy: false, error: '' };
  }
  function reset(key, keep) {
    if (shot.done) shot.done();
    shot = { ...blankShot(key), ...(keep || {}) };
  }
  const locked = () => shot.loading || shot.making || shot.busy;
  const errLine = () => el('p', { class: 'errors', role: 'alert', text: shot.error });

  /* ---------- ① 撮る ---------- */
  async function pick(src, sampleId, ui) {
    reset(shot.key, { kind: shot.kind, guide: shot.guide });
    const job = shot;
    Object.assign(job, { src, sampleId, loading: true });
    ui.rerender();
    try {
      const { img, done } = await R.photoPrep.loadImage(src);
      if (shot !== job) { done(); return; }
      Object.assign(job, { img, done });
    } catch (e) {
      job.error = '写真を読み込めませんでした。別の写真を選んでください';
    } finally {
      job.loading = false;
      if (shot === job) ui.rerender();
    }
  }

  async function makePhoto(ui) {
    const job = shot;
    Object.assign(job, { error: '', making: true });
    ui.rerender();
    try {
      job.prepared = await R.photoPrep.prepare({ doc: 'list', src: job.src, rects: job.rects, sampleId: job.sampleId });
    } catch (e) {
      job.error = '送る写真を作れませんでした。四角を引き直して、もう一度試してください';
    } finally {
      job.making = false;
      if (shot === job) ui.rerender();
    }
  }

  async function readPhoto(ui) {
    const job = shot;
    Object.assign(job, { busy: true, error: '' });
    ui.rerender();
    const backToPaint = () => Object.assign(job, { prepared: null, confirmed: false, error: HEALTH_SEEN });
    try {
      const { reading, sent } = await R.aiReader.read(job.prepared.req);
      ui.save(s => C().logAi(s, { at: now(), sent }));
      if (reading.healthSeen) { backToPaint(); return; }   // 塗り残し。同じ写真をもう一度送らせない
      job.rows = X().fromListReading(reading);
      job.readMode = sent.mode;   // 読んだときの読み方（あとで見本 / 本物を切り替えても、出す言葉は変えない）
      if (!job.rows.length) job.error = '写真から名前を読み取れませんでした。写真を撮り直してください';
    } catch (e) {
      if (e.sent) ui.save(s => C().logAi(s, { at: now(), sent: e.sent }));   // 送ったあとに失敗しても、送った記録は残す
      job.error = ERROR_JA[e.kind] || ERROR_JA.bad;
      if (e.sent && e.sent.healthSeen) backToPaint();
    } finally {
      job.busy = false;
      if (shot === job) ui.rerender();
    }
  }

  function kindStep(ui) {
    const choose = (kind) => { shot.kind = kind; ui.rerender(); };
    return el('div', { class: R.choiceClass(Object.values(KIND_JA)), role: 'radiogroup', 'aria-label': '撮る物' },
      Object.entries(KIND_JA).map(([k, label]) => el('label', { class: 'choice' },
        el('input', { type: 'radio', name: 'list-kind', checked: shot.kind === k, disabled: locked(), onchange: () => choose(k) }),
        el('span', { text: label }))));
  }

  function shootStep(ui) {
    const fileInput = el('input', { class: 'input', type: 'file', accept: 'image/*', capture: 'environment', disabled: locked(),
      onchange: (e) => { if (e.target.files[0]) pick(e.target.files[0], null, ui); } });
    return [
      el('h3', { class: 'subhead', text: '撮る物' }),
      kindStep(ui),
      ui.field('写真を撮る・選ぶ', fileInput, 'この便のお客さんが 1 枚に入っていればよい'),
      el('p', { class: 'reset' }, button(SAMPLE.label, () => pick(SAMPLE.src, SAMPLE.id, ui))),
      shot.loading ? el('p', { class: 'note', text: '写真を読み込んでいます…' }) : null
    ];
  }

  /* 塗る所を確かめる。予約の一覧は塗らなくてよいが、健康や備考の欄が写っていれば、なぞって黒く塗る */
  function paintStep(ui) {
    const edit = (rects) => { shot.rects = rects; shot.confirmed = false; ui.rerender(); };
    const paper = shot.kind === 'paper';
    return [
      el('p', { class: 'note', text: paper ? '申込書は撮らないでください。名簿に健康やメモの欄があれば、写真の上をなぞって黒く塗ってください。黒い所は AI に送りません。'
        : '健康やメモの欄が写っていたら、写真の上をなぞって黒く塗ってください。黒い所は AI に送りません。' }),
      R.photoIntake.maskEditor(shot.img, shot.rects, (r) => edit([...shot.rects, r]), locked),
      shot.rects.length ? el('div', { class: 'actions' },
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: locked(), text: '最後の四角を消す', onclick: () => edit(shot.rects.slice(0, -1)) })) : null,
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: shot.confirmed, disabled: locked(), onchange: (e) => { shot.confirmed = e.target.checked; ui.rerender(); } }),
        el('span', { text: '健康の欄は写っていないか、黒く隠れている' })),
      ui.dock(errLine(),
        el('button', { class: 'btn', type: 'button', disabled: !shot.confirmed || locked(), text: shot.making ? '作っています…' : 'AI に送る写真を作る', onclick: () => makePhoto(ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', disabled: locked(), text: '撮り直す', onclick: () => { reset(shot.key, { kind: shot.kind, guide: shot.guide }); ui.rerender(); } }))
    ];
  }

  function sendStep(ui) {
    const sampleMode = R.aiReader.mode() === 'sample';
    const cannotRead = sampleMode && !shot.sampleId;
    return [
      el('img', { class: 'photo__sent', src: shot.prepared.dataUrl, alt: 'AI に送る写真' }),
      el('p', { class: 'note', text: !sampleMode ? 'この写真を Anthropic の AI に送ります。' : cannotRead
        ? 'いまは見本の読み取りです。読めるのは見本の写真だけです。'
        : 'いまは見本の読み取りです（AI には送らず、見本の答えを使います）。' }),
      ui.dock(errLine(),
        el('button', { class: 'btn', type: 'button', disabled: cannotRead || shot.busy, text: shot.busy ? '読んでいます…' : 'この写真を AI で読む', onclick: () => readPhoto(ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', disabled: shot.busy, text: '塗り直す', onclick: () => { shot.prepared = null; shot.confirmed = false; ui.rerender(); } }))
    ];
  }

  /* ---------- ② 確かめて渡す ---------- */
  const kindOf = (row) => (row.cert.course === 'NONE' ? '体験' : 'ファン');
  const contactOf = (row) => [row.emergency.name, row.emergency.relation ? `（${row.emergency.relation}）` : '', row.emergency.phone ? ` ${row.emergency.phone}` : ''].join('').trim();

  function openEditor(i, ui) {
    const r = shot.rows[i];
    shot.open = i;
    shot.edit = { name: r.name, none: r.cert.course === 'NONE', eName: r.emergency.name, eRel: r.emergency.relation, ePhone: r.emergency.phone };
    ui.rerender();
  }

  /* 直した行は、お店が確かめたので自信なしの印を外す */
  function saveEditor(ui) {
    const e = shot.edit;
    const name = e.name.trim().slice(0, 60);
    if (!name) { shot.error = '名前を入れてください'; ui.rerender(); return; }
    shot.rows = shot.rows.map((r, i) => (i !== shot.open ? r : {
      name, cert: { course: e.none ? 'NONE' : '', date: '' }, unsure: [],
      emergency: { name: e.eName.trim().slice(0, 60), relation: e.eRel.trim().slice(0, 20), phone: e.ePhone.trim().slice(0, 30) }
    }));
    Object.assign(shot, { open: -1, edit: null, error: '' });
    ui.rerender();
  }

  function editor(ui) {
    const e = shot.edit;
    const input = (label, key, max, type) => ui.field(label, el('input', { class: 'input', type: type || 'text', maxlength: max, value: e[key],
      oninput: (ev) => { e[key] = ev.target.value; } }));
    return el('div', { class: 'rowedit' },
      input('名前', 'name', 60),
      el('div', { class: 'choices', role: 'radiogroup', 'aria-label': '種類' },
        [['ファン', false], ['体験', true]].map(([label, none]) => el('label', { class: 'choice' },
          el('input', { type: 'radio', name: 'row-kind', checked: e.none === none, onchange: () => { e.none = none; } }), el('span', { text: label })))),
      input('緊急時の連絡先（名前）', 'eName', 60),
      input('続柄', 'eRel', 20),
      input('緊急時の連絡先（電話）', 'ePhone', 30, 'tel'),
      el('div', { class: 'actions' },
        el('button', { class: 'btn btn--small', type: 'button', text: 'この人を直す', onclick: () => saveEditor(ui) }),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'やめる', onclick: () => { Object.assign(shot, { open: -1, edit: null }); ui.rerender(); } })));
  }

  function rowLine(row, i, ui) {
    const unsure = row.unsure.map(k => UNSURE_JA[k]).filter(Boolean);
    const missing = X().listMissing(row);
    const meta = unsure.length ? el('span', { class: 'bk__meta st--check', text: `! 自信なし: ${unsure.join('・')}` })
      : missing.length ? el('span', { class: 'bk__meta st--wait', text: '・緊急時の連絡先が写真に無い' })
        : el('span', { class: 'bk__meta', text: `${kindOf(row)}・${contactOf(row)}` });
    const act = unsure.length ? '直す' : missing.length ? '入れる' : '';
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: row.name }),
      act ? el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: act, onclick: () => openEditor(i, ui) })
        : el('span', { class: 'st st--ok', text: '✓' }),
      meta,
      shot.open === i ? editor(ui) : null,
      !act && shot.open !== i ? button('直す', () => openEditor(i, ui), 'linkbtn linkbtn--muted') : null);
  }

  function handOver(v, ui) {
    const guide = shot.guide.trim();
    if (!guide || guide.length > 40) { shot.error = GUIDE_FIRST; ui.rerender(); return; }
    let out = null;
    const r = ui.save(st => {
      out = X().addPartnerList(st, { tripId: v.tripId, shop: v.shop, rows: shot.rows, guide, at: now(), newId: R.newId });
      if (out.problem) return st;
      return X().handOver(out.state, { tripId: v.tripId, shop: v.shop, today: R.today(), at: now() });
    });
    if (r.error || !out) { shot.error = '渡せませんでした。もう一度押してください'; ui.rerender(); return; }
    if (out.problem) { shot.error = out.problem === 'guide' ? GUIDE_FIRST : 'このお店は乗り合いから外れています。乗り合いの画面で足してください'; ui.rerender(); return; }
    const added = out.ids.length;
    reset('');
    ui.go('share', { tripId: v.tripId, saved: r.saved,
      notice: `${v.shop}から ${added} 人を受け取りました${out.skipped ? `（${out.skipped} 人はもう入っていた）` : ''}。健康の 2 欄は${v.shop}が確かめる` });
  }

  function checkStep(v, ui) {
    const rows = shot.rows;
    const unsure = rows.filter(r => r.unsure.length).length;
    const missing = rows.filter(r => X().listMissing(r).length).length;
    return [
      el('div', { class: 'rd' }, el('span', { class: 'rd__k', text: '写真' }),
        el('span', { class: 'rd__v' }, KIND_JA[shot.kind], el('span', { class: 'rd__sub', text: shot.readMode === 'real' ? 'AI が読んだ' : '見本の読み取り' }))),
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: 'ガイド' }),
        el('input', { class: 'input', type: 'text', maxlength: 40, value: shot.guide, placeholder: '例: 見本 三郎', oninput: (e) => { shot.guide = e.target.value; } })),
      el('p', { class: 'sumline' },
        el('span', { class: unsure ? 'st--check' : '', text: `確かめる所 ${unsure} 件` }), '・',
        el('span', { class: missing ? 'st--wait' : '', text: `足りない所 ${missing} 件` })),
      el('h3', { class: 'subhead' }, '乗せる人', el('span', { text: String(rows.length) })),
      el('ul', { class: 'bks' }, rows.map((row, i) => rowLine(row, i, ui))),
      ui.dock(
        unsure ? el('p', { class: 'errors', text: `確かめる所が ${unsure} 件あります。「直す」で確かめてから渡します` }) : errLine(),
        el('button', { class: 'btn', type: 'button', disabled: !!unsure || shot.open !== -1, text: `${rows.length} 人を船に渡す`, onclick: () => handOver(v, ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '撮り直す', onclick: () => { reset(shot.key, { kind: shot.kind, guide: shot.guide }); ui.rerender(); } }))
    ];
  }

  /* ---------- 画面 ---------- */
  function render({ tripId, shop, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    const key = `${tripId}:${shop}`;
    if (shot.key !== key) reset(key, { guide: trip ? X().partnerGuide(s, tripId, shop) : '' });
    const back = () => { reset(''); ui.go('partner', { tripId, shop }); };
    if (!trip || !X().shopsOf(s, trip).some(x => !x.own && x.key === shop)) {
      return [...ui.head('写真で名前を渡す'), el('p', { class: 'errors', text: 'この便か、このお店が見つかりません。' }), ui.back()];
    }
    const owner = X().boatOwner(s, trip);
    const [, h2, , notice] = ui.head('写真で名前を渡す');
    h2.classList.add('sr-only');
    const v = { tripId, shop, trip };
    return [
      el('p', { class: 'flag flag--info roleflag' }, el('span', { text: `${shop}役で入れています` }), button('戻る', back)),
      h2,
      el('div', { class: 'mast' },
        el('span', { class: 'mast__t', text: trip.start ? clock(trip.start) : '—' }),
        el('span', { class: 'mast__d', text: ui.md(trip.date) }),
        el('span', { class: 'mast__w' }, `${owner}の${trip.boat || '船'}に乗る`, shot.rows ? ['　', el('b', { text: String(shot.rows.length) }), ' 人'] : null)),
      notice,
      shot.rows ? checkStep(v, ui)
        : shot.prepared ? sendStep(ui)
          : shot.img ? paintStep(ui)
            : [...shootStep(ui), shot.error ? errLine() : null]
    ];
  }

  R.partnerPhoto = { render };
})();
