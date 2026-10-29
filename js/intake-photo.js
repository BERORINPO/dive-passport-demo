/* 名簿の取り込み（お店、日本語のみ）: ① 申込書・C カードの写真を読む / ② 読み取りを確かめる。予約の画面（booking.js）から開く。
   写真は photo-prep.js が描き直して（申込書は健康の欄を塗って）作った物だけを AI に送る。塗る四角はお店が写真の上で確かめ、
   隠れていない所があれば足す（健康の欄が離れて 2 か所あることもある）。申込書も C カードも、送る前に確認の印が要る。
   AI が「健康の情報が見えた」と答えたら、その読み取りは使わない（送った記録には印が残る）。
   名簿の組み立てと判断は roster-core.js、保存は booking.js から受け取る ui.save を通す。
   AI やお客さんの文字は el() の text で出す。img の src は、見本の写真の場所か、この画面で作った写真だけ */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;
  const M = () => R.photoMask;

  const DOC_JA = { paper: '申込書', ccard: 'C カード' };
  const SRC_JA = { mail: '予約メール', paper: '申込書', ccard: 'C カード', guest: 'お客さん', staff: 'お店', passport: 'パスポート', partner: '乗り合いのお店' };
  const ERROR_JA = {
    input: '送れない写真です。写真を選び直してください',
    auth: 'ログインが切れたか、通りませんでした。画面を読み込み直してください',
    limit: '今日か今月の上限に達しました。見本の読み取りでは続けられます',
    offline: '届きませんでした。通信を確かめて、もう一度試してください',
    bad: 'AI の答えが形に合わなかったので、使いませんでした。もう一度試してください'
  };
  const SAMPLES = { paper: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'], ccard: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] };
  const HEALTH_SEEN = 'AI が「健康の情報が見えた」と答えたので、この読み取りは使いません。撮った書類と、塗った所を確かめてください。';
  const now = () => new Date().toISOString();

  let shot = blankShot('');
  function blankShot(tripId) {
    return { tripId, doc: '', src: null, sampleId: null, img: null, done: null, rects: [], confirmed: false,
      prepared: null, reading: null, personId: '', otherName: false, loading: false, making: false, busy: false, error: '' };
  }
  function reset(tripId, doc) {
    if (shot.done) shot.done();
    shot = { ...blankShot(tripId), doc: doc || '' };
  }

  const locked = () => shot.loading || shot.making || shot.busy;   // 写真を読む・作る・AI が読む間は、写真と四角を変えない

  /* ---------- 塗る四角を確かめる。写真の上をなぞると四角を足せる ---------- */
  /* 乗り合いの他のお店が予約の一覧を撮る画面（partner-photo.js）でも使う。isLocked は、その画面が写真を作っている間か */
  function maskEditor(img, rects, onAdd, isLocked = locked) {
    const size = M().fitSize(img.naturalWidth, img.naturalHeight, 900);
    const canvas = el('canvas', { class: 'photo__canvas', width: size.width, height: size.height, role: 'img',
      'aria-label': '写真。黒い四角が AI に送らない所。なぞると四角を足せます' });
    const ctx = canvas.getContext('2d');
    let from = null;
    const draw = (live) => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000';
      [...rects, ...(live ? [live] : [])].forEach(r => {
        const p = M().toPixels(r, canvas.width, canvas.height);
        ctx.fillRect(p.x0, p.y0, p.x1 - p.x0, p.y1 - p.y0);
      });
    };
    const at = (e) => { const b = canvas.getBoundingClientRect(); return { x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height }; };
    canvas.addEventListener('pointerdown', (e) => { if (isLocked()) return; from = at(e); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => { if (from) draw(M().rectFrom(from, at(e))); });
    canvas.addEventListener('pointerup', (e) => {
      if (!from) return;
      const r = M().rectFrom(from, at(e));
      from = null;
      if (M().usable(r)) onAdd(r); else draw();
    });
    draw();
    return canvas;
  }

  /* ---------- ① 取り込み ---------- */
  /* 写真を選ぶ。読み込みが終わる前に選び直されたら、前の写真は捨てる（確かめた写真と送る写真を同じにする） */
  async function pick(src, sampleId, ui) {
    reset(shot.tripId, shot.doc);
    const job = shot;
    job.src = src;
    job.sampleId = sampleId;
    job.rects = job.doc === 'paper' ? [{ ...M().SAMPLE_FORM_HEALTH }] : [];
    job.loading = true;
    ui.rerender();
    try {
      const { img, done } = await R.photoPrep.loadImage(src);
      if (shot !== job) { done(); return; }
      job.img = img;
      job.done = done;
    } catch (e) {
      job.error = '写真を読み込めませんでした。別の写真を選んでください';
    } finally {
      job.loading = false;
      if (shot === job) ui.rerender();
    }
  }

  /* 送る写真を作る。作っている間は写真も四角も変えられない */
  async function makePhoto(ui) {
    const job = shot;
    job.error = '';
    job.making = true;
    ui.rerender();
    try {
      job.prepared = await R.photoPrep.prepare({ doc: job.doc, src: job.src, rects: job.rects, sampleId: job.sampleId });
    } catch (e) {
      job.error = '送る写真を作れませんでした。四角を引き直して、もう一度試してください';
    } finally {
      job.making = false;
      if (shot === job) ui.rerender();
    }
  }

  async function readPhoto(ui) {
    const job = shot;
    job.busy = true;
    job.error = '';
    ui.rerender();
    try {
      const { reading, sent } = await R.aiReader.read(job.prepared.req);
      ui.save('core.logAi', { at: now(), sent });
      if (reading.healthSeen) {   // 塗り残しか、撮る書類の間違い。読み取りは使わず、塗る画面に戻す（同じ写真をもう一度送らせない）
        job.prepared = null;
        job.confirmed = false;
        job.error = HEALTH_SEEN;
        return;
      }
      job.reading = reading;
      const read = reading.people[0];
      const hit = read ? C().findByName(C().peopleOf(R.rosterStore.get(), job.tripId, { own: true }), read.name) : null;
      job.personId = hit ? hit.id : '';
    } catch (e) {
      if (e.sent) ui.save('core.logAi', { at: now(), sent: e.sent });   // 送ったあとに失敗しても、送った記録は残す
      job.error = ERROR_JA[e.kind] || ERROR_JA.bad;
      if (e.sent && e.sent.healthSeen) {   // 答えは壊れていても、健康が見えたと言っていたら、成功のときと同じく塗る画面に戻す
        job.prepared = null;
        job.confirmed = false;
        job.error = HEALTH_SEEN;
      }
    } finally {
      job.busy = false;
      if (shot === job) ui.rerender();
    }
  }

  function applyRead(ui) {
    const read = shot.reading.people[0];
    /* 画面の「今の」入力（shot）は、ここで全部写す。貯めた直しが、あとで別の人の写真を読まないように */
    const r = ui.save('core.applyReadingTo', { personId: shot.personId, read, src: shot.doc, at: now() });
    const got = r.out;
    if (r.error || !got) { shot.error = '名簿に入れられませんでした。入れる人を選び直してください'; ui.rerender(); return; }
    const personId = shot.personId;
    reset(shot.tripId, '');
    ui.go('review', { personId, saved: r.saved, fields: got.fields });
  }

  /* 誤りの文は帯の中（ボタンの上）に出す */
  const shotErr = () => el('p', { class: 'errors', role: 'alert', text: shot.error });

  function readResult(ui) {
    const s = R.rosterStore.get();
    const read = shot.reading.people[0];
    if (!read) return el('p', { class: 'errors', role: 'alert', text: '写真から人を読み取れませんでした。写真を選び直してください。' });
    const people = C().peopleOf(s, shot.tripId, { own: true });   // 自分の店の申込書なので、乗り合いの他のお店のお客さんは選ばせない
    if (!shot.personId && people.length) shot.personId = (people.find(p => !p.name) || people[0]).id;
    const target = people.find(p => p.id === shot.personId);
    const differs = !!(target && target.name && read.name && !C().sameName(target.name, read.name));
    const u = new Set(read.unsure);
    const row = (label, value, unsure) => el('div', { class: `rd${unsure ? ' rd--unsure' : ''}` },
      el('span', { class: 'rd__k', text: label }),
      el('span', { class: 'rd__v' }, value || '（写真に無い）', unsure ? el('span', { class: 'rd__sub', text: '! 自信なし' }) : null));
    const e = read.emergency;
    return [
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, `AI が${DOC_JA[shot.doc]}から読んだ結果`, R.aiReader.mode() === 'sample' ? el('small', { text: '見本の読み取り' }) : null),
        row('氏名', read.name, u.has('name')),
        row('生年月日', read.birthDate, u.has('birthDate')),
        shot.doc === 'paper' ? row('住所', read.address, u.has('address')) : null,
        shot.doc === 'paper' ? row('緊急の連絡先', `${e.name}${e.relation ? `（${e.relation}）` : ''} ${e.phone}`.trim(), u.has('emergency')) : null,
        row('C カード', `${C().COURSE_JA[read.cert.course] || ''} ${read.cert.date}`.trim(), u.has('cert')),
        shot.doc === 'paper' ? row('潜った本数', read.dives === '' ? '' : `${read.dives} 本`, u.has('dives')) : null,
        shot.doc === 'paper' ? row('最後に潜った日', read.lastDive, u.has('lastDive')) : null),
      people.length ? ui.field('入れる人', el('select', { class: 'input', onchange: (ev) => { shot.personId = ev.target.value; shot.otherName = false; ui.rerender(); } },
        people.map(p => el('option', { value: p.id, selected: p.id === shot.personId, text: p.name || '名前の分からない人' }))),
        '空いている所だけ埋めます。人やお店が入れた所は変えません') : el('p', { class: 'errors', text: 'この便にはまだ人がいません。先に予約を入れてください。' }),
      differs ? el('p', { class: 'flag flag--warn', text: `名前が違います（${DOC_JA[shot.doc]}: ${read.name} ／ 名簿: ${target.name}）。入れる人を確かめてください。` }) : null,
      differs ? el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: shot.otherName, onchange: (ev) => { shot.otherName = ev.target.checked; ui.rerender(); } }),
        el('span', { text: '名前が違っても、この人に入れる' })) : null,
      ui.dock(
        shotErr(),
        el('button', { class: 'btn', type: 'button', disabled: !people.length || (differs && !shot.otherName), text: '名簿に入れる', onclick: () => applyRead(ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '写真を選び直す', onclick: () => { reset(shot.tripId, shot.doc); ui.rerender(); } }))
    ];
  }

  function photoStep(ui) {
    if (shot.loading) return el('p', { class: 'note', text: '写真を読み込んでいます…' });
    if (!shot.img) return null;
    if (shot.prepared) {
      const sampleMode = R.aiReader.mode() === 'sample';
      const cannotRead = sampleMode && !shot.sampleId;
      return [
        el('div', { class: 'facts' },
          el('p', { class: 'band__title', text: 'AI に送る写真' }),
          el('p', { class: 'note', text: shot.doc === 'paper' ? '黒い所は送りません。描き直したので、撮った場所などの情報も入っていません。' : '描き直したので、撮った場所などの情報は入っていません。' }),
          el('img', { class: 'photo__sent', src: shot.prepared.dataUrl, alt: 'AI に送る写真' })),
        el('p', { class: 'note', text: !sampleMode ? 'この写真を Anthropic の AI に送ります。' : cannotRead
          ? 'いまは見本の読み取りです。読めるのは見本の写真だけです。'
          : 'いまは見本の読み取りです（AI には送らず、試験で読んだ答えを使います）。' }),
        shot.reading ? readResult(ui) : ui.dock(
          shotErr(),
          el('button', { class: 'btn', type: 'button', disabled: cannotRead || shot.busy, text: shot.busy ? '読んでいます…' : 'この写真を AI で読む', onclick: () => readPhoto(ui) }),
          el('button', { class: 'btn btn--ghost', type: 'button', disabled: shot.busy, text: '塗り直す', onclick: () => { shot.prepared = null; shot.confirmed = false; ui.rerender(); } }))
      ];
    }
    const paper = shot.doc === 'paper';
    const edit = (rects) => { shot.rects = rects; shot.confirmed = false; ui.rerender(); };
    return [
      paper ? el('p', { class: 'note', text: '健康の欄が黒い四角で隠れているか確かめてください。隠れていない所があれば、写真の上をなぞって四角を足します。' })
        : el('p', { class: 'note', text: 'C カードには健康の欄が無いので、塗らずに送ります。申込書が写っていないか確かめてください。' }),
      maskEditor(shot.img, shot.rects, (r) => edit([...shot.rects, r])),
      paper ? el('div', { class: 'actions' },
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: locked() || !shot.rects.length, text: '最後の四角を消す', onclick: () => edit(shot.rects.slice(0, -1)) }),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', disabled: locked(), text: '見本の書式の位置に戻す', onclick: () => edit([{ ...M().SAMPLE_FORM_HEALTH }]) })) : null,
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: shot.confirmed, disabled: locked(), onchange: (e) => { shot.confirmed = e.target.checked; ui.rerender(); } }),
        el('span', { text: paper ? '健康の欄が黒く隠れているのを確かめた' : '写っているのは C カードだけ。申込書や健康の欄は写っていない' })),
      ui.dock(
        shotErr(),
        el('button', { class: 'btn', type: 'button', disabled: !shot.confirmed || (paper && !shot.rects.length) || locked(),
          text: shot.making ? '作っています…' : 'AI に送る写真を作る', onclick: () => makePhoto(ui) }))
    ];
  }

  function docStep(ui) {
    const fileInput = el('input', { class: 'input', type: 'file', accept: 'image/*', capture: 'environment', disabled: locked(),
      onchange: (e) => { if (e.target.files[0]) pick(e.target.files[0], null, ui); } });
    return [
      ui.field(`${DOC_JA[shot.doc]}の写真を撮る・選ぶ`, fileInput),
      el('p', { class: 'note', text: '見本の写真（架空）で試せます' }),
      el('div', { class: 'samples', role: 'group', 'aria-label': `見本の${DOC_JA[shot.doc]}` }, SAMPLES[shot.doc].map((id, i) => el('button', {
        class: 'btn btn--ghost btn--small', type: 'button', text: `見本 ${i + 1}`, 'aria-pressed': String(shot.sampleId === id), disabled: locked(),
        onclick: () => pick(`assets/samples/${id}.jpg`, id, ui)
      })))
    ];
  }

  function renderIntake({ tripId, ui }) {
    if (shot.tripId !== tripId) reset(tripId, '');
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return [...ui.head('名簿の取り込み'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const checks = C().toCheck(s, tripId);
    const chooseDoc = (doc) => () => { reset(tripId, doc); ui.rerender(); };
    return [
      ...ui.head('名簿の取り込み', `${ui.md(trip.date)} ${ui.tripLabel(trip)}`),
      el('div', { class: 'actions actions--two' },
        el('button', { class: `btn ${shot.doc === 'paper' ? '' : 'btn--ghost'}`, type: 'button', 'aria-pressed': String(shot.doc === 'paper'), text: '申込書を撮る', onclick: chooseDoc('paper') }),
        el('button', { class: `btn ${shot.doc === 'ccard' ? '' : 'btn--ghost'}`, type: 'button', 'aria-pressed': String(shot.doc === 'ccard'), text: 'C カードを撮る', onclick: chooseDoc('ccard') })),
      el('p', { class: 'note', text: '申込書の健康の欄は、この端末の中で塗りつぶしてから AI に送ります。健康の質問は、お客さん本人が答えます。' }),
      shot.doc ? el('div', { class: 'card' }, docStep(ui), photoStep(ui), shot.img ? null : shotErr()) : null,
      checks.length ? el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, `読み取りを確かめる（${checks.length} 人）`),
        el('ul', { class: 'checks' }, checks.map(p => el('li', {},
          el('span', { class: 'bk__name', text: p.name || '名前の分からない人' }),
          el('button', { class: 'btn btn--small btn--ghost', type: 'button', text: '確かめる', onclick: () => ui.go('review', { personId: p.id }) }))))) : null,
      ui.back()
    ];
  }

  /* ---------- ② 読み取りを確かめる（v12、2026-10-28）----------
     自信なしの項目を先に開いて出し、ほかの AI が読む項目も「ほかの項目も直す」で全部その場で直せる。
     健康の 2 項目は出さない（お客さん本人が答える）。直した項目は前と後を記録に残す（core の confirmReview） */
  let review = { personId: '', edits: {}, open: false, error: '', done: '', doneAt: '' };

  /* 項目ごとの入力欄。直そうとした値は、描き直しても消さない */
  function editor(row, p, ui) {
    const set = (key, value) => { review.edits[key] = value; };
    const shown = (key, value) => (Object.prototype.hasOwnProperty.call(review.edits, key) ? review.edits[key] : value);
    const input = (key, value, props) => el('input', { class: 'input', value: shown(key, value),
      oninput: (e) => set(key, e.target.value), onchange: () => ui.rerender(), ...(props || {}) });
    const group = (kids) => el('div', { class: 'row row--3' }, kids);
    switch (row.field) {
      case 'emergency': return group([ui3('名前', input('emergency.name', p.emergency.name)), ui3('続柄', input('emergency.relation', p.emergency.relation)),
        ui3('電話', input('emergency.phone', p.emergency.phone, { type: 'tel' }))]);
      case 'cert': return el('div', { class: 'row' },
        ui3('コース', el('select', { class: 'input', onchange: (e) => { set('cert.course', e.target.value); ui.rerender(); } },
          R.roster.COURSES.map(c => el('option', { value: c, selected: c === shown('cert.course', p.cert.course), text: c ? C().COURSE_JA[c] : '（分からない）' })))),
        ui3('取得日（2023-08-20 など）', input('cert.date', p.cert.date)));
      case 'sizes': return group([ui3('身長（cm）', input('sizes.height', String(p.sizes.height), { type: 'number', min: 1 })),
        ui3('体重（kg）', input('sizes.weight', String(p.sizes.weight), { type: 'number', min: 1 })),
        ui3('足（cm）', input('sizes.foot', String(p.sizes.foot), { type: 'number', min: 1, step: 0.5 }))]);
      case 'dives': return input('dives', String(p.dives), { type: 'number', min: 0, 'aria-label': row.label });
      case 'birthDate': return input('birthDate', p.birthDate, { type: 'date', 'aria-label': row.label });
      case 'lastDive': return input('lastDive', p.lastDive, { placeholder: '2025-08 など', 'aria-label': row.label });
      case 'phone': return input('phone', p.phone, { type: 'tel', 'aria-label': row.label });
      default: return input(row.field, p[row.field], { 'aria-label': row.label });
    }
  }
  const ui3 = (label, control) => el('label', { class: 'field' }, el('span', { class: 'label label--small', text: label }), control);

  /* 直した欄から、人の項目の形を組む。元と同じ値に戻した項目は、直したことにしない */
  function patchFrom(p) {
    const patch = {};
    Object.entries(review.edits).forEach(([key, value]) => {
      const [field, sub] = key.split('.');
      const v = String(value).trim();
      const out = field === 'dives' || field === 'sizes' ? (v === '' ? '' : Number(v)) : v;   // 数の項目は数に直す
      if (sub) patch[field] = { ...(patch[field] || p[field]), [sub]: out };
      else patch[field] = out;
    });
    return Object.fromEntries(Object.entries(patch).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(p[k])));
  }

  /* 記録や「前の値」に出す書き方（入れ子は 1 行に） */
  function valueText(field, v) {
    const empty = '（空）';
    if (v === '' || v === undefined || v === null) return empty;
    if (field === 'emergency') return [v.name, v.relation ? `（${v.relation}）` : '', v.phone ? ` ${v.phone}` : ''].join('').trim() || empty;
    if (field === 'cert') return `${C().COURSE_JA[v.course] || ''} ${v.date}`.trim() || empty;
    if (field === 'sizes') {
      return [v.height !== '' ? `${v.height} cm` : '', v.weight !== '' ? `${v.weight} kg` : '', v.foot !== '' ? `足 ${v.foot} cm` : ''].filter(Boolean).join(' ') || empty;
    }
    return String(v);
  }

  function confirmPerson(personId, ui) {
    const p = R.rosterStore.get().people.find(x => x.id === personId);
    const patch = patchFrom(p);
    const at = now();
    const r = ui.save('core.confirmReview', { id: personId, patch, at });
    if (r.error) { review.error = '直した値の形が合いません。日付は 2023-08-20、本数は数で入れてください。'; ui.rerender(); return; }
    review = { personId, edits: {}, open: false, error: '', done: personId, doneAt: at };
    ui.rerender();
  }

  /* 1 項目分: 名前と印、入力欄、印の理由か前の値 */
  function fieldBlock(row, p, patch, ui) {
    const changed = Object.prototype.hasOwnProperty.call(patch, row.field);
    const byGuest = ['guest', 'passport'].includes(row.src);
    const mark = changed ? ['cf__mark--fixed', '直した'] : row.unsure ? ['cf__mark--check', '! 確かめる'] : null;
    const undo = () => { Object.keys(review.edits).filter(k => k.split('.')[0] === row.field).forEach(k => delete review.edits[k]); ui.rerender(); };
    return el('div', { class: 'cf' },
      el('p', { class: 'cf__head' }, el('span', { text: row.label }), mark ? el('span', { class: `cf__mark ${mark[0]}`, text: mark[1] }) : null),
      editor(row, p, ui),
      changed ? el('p', { class: 'cf__was' }, `前の値: ${valueText(row.field, p[row.field])}　`,
        el('button', { class: 'linkbtn', type: 'button', text: '元に戻す', onclick: undo }))
        : row.unsure ? el('p', { class: 'cf__why', text: byGuest ? `${SRC_JA[row.src]}が片方だけ入れました。同じカードの物か確かめてください` : 'AI の自信が低い所です。書類と見比べてください' }) : null);
  }

  /* 名簿に入れたあと: この人の記録（新しい順） */
  function renderDone(p, ui) {
    const s = R.rosterStore.get();
    const trip = C().tripOf(s, p);
    const all = trip ? Object.values(C().reviewFields(p, trip)).flat() : [];
    const label = (f) => (all.find(r => r.field === f) || { label: f }).label;
    const blank = (f, v) => valueText(f, v) === '（空）';
    const one = (e, f) => (blank(f, e.before[f]) ? `${label(f)}を入れた: ${valueText(f, e.after[f])}`
      : `${label(f)}を直した: ${valueText(f, e.before[f])} → ${valueText(f, e.after[f])}`);
    const text = (e) => (e.act === 'edit' ? e.fields.map(f => one(e, f)).join('、')
      : e.fields.length ? `${e.fields.map(label).join('・')}をそのまま認めた` : '読み取りを確かめた');
    /* いま「名簿に入れる」を押したときの記録だけ（直した・認めた）。前からの記録は名簿の記録の画面で見る */
    const rows = s.log.filter(e => e.kind === 'person' && e.id === p.id && e.at === review.doneAt && ['edit', 'check'].includes(e.act)).reverse();
    const reset = () => { review = { personId: '', edits: {}, open: false, error: '', done: '' }; };
    const leave = () => { reset(); ui.go('intake', {}); };
    const toDay = () => { reset(); ui.go('day', { tripId: trip.id }); };
    return [
      ...ui.head(`${p.name || '名前の分からない人'}さん`),
      el('p', { class: 'flag flag--ok', text: '✓ 名簿に入れました（確かめる所 0 件）' }),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, '記録', el('small', { text: '新しい順' })),
        rows.map(e => el('div', { class: 'rd' }, el('span', { class: 'rd__k', text: hm(e.at) }),
          el('span', { class: 'rd__v' }, text(e), el('span', { class: 'rd__sub', text: 'お店' }))))),
      ui.dock(
        trip ? el('button', { class: 'btn', type: 'button', text: '今日の名簿に戻る', onclick: toDay }) : null,
        el('button', { class: 'btn btn--ghost', type: 'button', text: '名簿の取り込みに戻る', onclick: leave }))
    ];
  }
  /* 記録の時刻（日本の時刻の 時:分） */
  const hm = (iso) => new Date(Date.parse(iso) + 9 * 3600 * 1000).toISOString().slice(11, 16);

  function renderReview({ personId, ui }) {
    if (review.personId !== personId) review = { personId, edits: {}, open: false, error: '', done: '' };
    const s = R.rosterStore.get();
    const p = s.people.find(x => x.id === personId);
    const trip = p && C().tripOf(s, p);
    if (!p || !trip) return [...ui.head('読み取りを確かめる'), el('p', { class: 'errors', text: 'この人が見つかりません。' }), ui.back()];
    if (review.done === personId) return renderDone(p, ui);
    const from = [...new Set(Object.values(p.src).filter(src => ['mail', 'paper', 'ccard'].includes(src)))].map(src => SRC_JA[src]);
    const { unsure, others } = C().reviewFields(p, trip);
    const unconfirmedKeys = C().unconfirmed(s, p, trip);
    const unconfirmed = unconfirmedKeys.length;
    const itemJa = (k) => (R.roster.ITEMS[trip.kind].find(i => i.key === k) || { ja: k }).ja;
    const patch = patchFrom(p);
    const fixed = Object.keys(patch).length;
    const accepted = unsure.filter(r => !Object.prototype.hasOwnProperty.call(patch, r.field)).length;
    const toggle = (open) => () => { review.open = open; ui.rerender(); };
    return [
      ...ui.head(`${p.name || '名前の分からない人'}さん`, `${from.length ? `${from.join('と')}から読み取りました。` : ''}${ui.md(trip.date)} ${ui.tripLabel(trip)}`),
      /* 自信なしが 0 でも未確認が残るときは「✓ 0 件」を出さない（下の未確認の数と食い違って見えるため） */
      unsure.length || !unconfirmed
        ? el('p', { class: `flag ${unsure.length ? 'flag--warn' : 'flag--ok'}`, text: `${unsure.length ? '!' : '✓'} 確かめる所 ${unsure.length} 件` }) : null,
      /* AI が読んだまま、まだ誰も確かめていない項目（名簿の紙の「▲未確認」と同じ数え方）。「この内容で名簿に入れる」で確かめ済みになる */
      unconfirmed ? el('p', { class: 'note', text: `まだ確かめていない項目 ${unconfirmed}: ${unconfirmedKeys.map(itemJa).join('・')}`
        + '（名簿の紙には「▲未確認」と出ます）。元の書類や本人と見比べて、直す所がなければ「この内容で名簿に入れる」を押してください。' }) : null,
      unsure.length ? el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, '確かめる所', el('small', { text: `${unsure.length} 項目` })),
        unsure.map(r => fieldBlock(r, p, patch, ui))) : null,
      review.open
        ? el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, 'AI が読んだ項目',
            el('button', { class: 'linkbtn linkbtn--muted', type: 'button', text: 'たたむ', onclick: toggle(false) })),
          others.map(r => fieldBlock(r, p, patch, ui)))
        : el('button', { class: 'cf__more', type: 'button', onclick: toggle(true) },
          el('span', { text: `ほかの項目も直す（${others.length} 項目）` }), el('span', { text: '開く' })),
      el('div', { class: 'cf' }, el('p', { class: 'cf__head', text: '既往症・当日の体調' }),
        el('p', { class: 'cf__locked', text: 'お客さん本人が答えます（お店は直せません）' })),
      ui.dock(
        el('p', { class: 'errors', role: 'alert', text: review.error }),
        el('p', { class: 'note cf__count', text: fixed || accepted ? `直した ${fixed} 項目・そのまま認める ${accepted} 項目` : '直した項目はありません' }),
        el('button', { class: 'btn', type: 'button', text: 'この内容で名簿に入れる', onclick: () => confirmPerson(personId, ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'あとで確かめる', onclick: () => ui.go('intake', {}) }))
    ];
  }

  R.photoIntake = { renderIntake, renderReview, maskEditor };
})();
