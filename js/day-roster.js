/* お店の画面: 今日の名簿・条例の名簿の印刷・CSV・カレンダー（.ics）・記録。予約の画面（booking.js）から開く。
   決まりは js/roster-day.js と roster-core.js（rosterRows・toCsv・editTrip・logOutput） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;
  const D = () => R.rosterDay;
  const healthShort = () => R.HEALTH.map(q => q.short);

  /* 条例の名簿の名前と、保存の決まりの条文（施行規則） */
  /* 令和 7 年沖縄県公安委員会規則第 16 号（2026-04-01 施行）。名簿の項目は第 30 条・第 36 条の第 1 項、保存は第 3 項 */
  const RULE = '沖縄県水難事故の防止及び遊泳者等の安全の確保等に関する条例施行規則';
  const LAW = {
    dive: { title: '潜水者名簿', rule: `${RULE} 第30条第3項` },
    snorkel: { title: 'スノーケリング者名簿', rule: `${RULE} 第36条第3項` }
  };
  const WHO_JA = { staff: 'お店', guest: 'お客さん', ai: 'AI', system: '自動' };
  const DOC_JA = { mail: '予約メール', paper: '申込書', ccard: 'C カード' };
  const FIELD_JA = { name: '氏名', birthDate: '生年月日', phone: '電話', address: '住所', emergency: '緊急時の連絡先', cert: 'C カード',
    courses: '講習受講歴', dives: '経験', lastDive: '最後に潜った日', sizes: 'サイズ', health: '健康の答え', guide: 'ガイド',
    site: '潜水場所', guides: 'ガイド', source: '予約の出どころ', people: '人数', leadName: '代表者', leadPhone: '代表者の電話', note: 'メモ',
    boat: '船', host: '船を出す店', partners: '乗り合いのお店' };
  let icsRange = 'ahead';   // ahead（今日から先の便）/ day（この日の便だけ）
  let csvHealth = false;    // CSV に健康の欄（既往症・当日の健康状態）を入れるか。初めは入れない。書き出した後と、便を替えたときに戻す
  let csvTrip = '';

  const nowIso = () => new Date().toISOString();
  const slash = (d) => d.replace(/-/g, '/');
  const clock = (t) => t.replace(/^0/, '');
  /* 2026-10-21T09:00:00.000Z → 20261021T090000Z（.ics の DTSTAMP） */
  const stampOf = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');
  const shortTime = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const labelOf = (items, key) => (items.find(i => i.key === key) || { ja: FIELD_JA[key] || key }).ja;
  const button = (text, onclick, cls) => el('button', { class: cls || 'linkbtn', type: 'button', text, onclick });

  /* ---------- 今日の名簿 ---------- */
  function tripFields(g, ui) {
    const s = R.rosterStore.get();
    const { trip, items } = g;
    const prev = D().previousSite(s, trip);
    const edit = (patch) => {
      const r = ui.save(st => C().editTrip(st, { tripId: trip.id, patch, at: nowIso() }));
      ui.go('day', r.error ? { tripId: trip.id, warn: '入れられませんでした。長すぎないか確かめてください（ガイドは 1 人 40 字まで）' } : { tripId: trip.id, saved: r.saved });
    };
    const list = (id, values) => el('datalist', { id }, values.map(v => el('option', { value: v })));
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, '便で決めること', el('small', { text: '名簿の 3 項目' })),
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: labelOf(items, 'site') }),
        el('input', { class: 'input', type: 'text', maxlength: 80, list: 'site-list', value: trip.site,
          placeholder: prev ? `前の便: ${prev}` : '例: 北の根', onchange: (e) => edit({ site: e.target.value }) })),
      !trip.site && prev ? el('p', { class: 'sheet__note' }, button(`前の便と同じ（${prev}）にする`, () => edit({ site: prev }))) : null,
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: 'ガイド' }),
        el('input', { class: 'input', type: 'text', maxlength: 200, list: 'guide-list', value: trip.guides.join('・'),
          placeholder: '2 人なら ・ で区切る', onchange: (e) => edit({ guides: e.target.value.split(/[・,、]/) }) })),
      list('site-list', D().usedSites(s)), list('guide-list', D().usedGuides(s)),
      !trip.start ? el('p', { class: 'sheet__note', text: '潜水日時: 便の時刻がまだです。' }) : null);
  }

  function checkLine(x, g, ui) {
    const p = x.person;
    const why = [
      x.unsure.length ? `確かめる: ${x.unsure.map(k => labelOf(g.items, k)).join('・')}` : '',
      x.guest.length ? `お客さんの入力待ち: ${x.guest.map(k => labelOf(g.items, k)).join('・')}` : ''
    ].filter(Boolean);
    const st = x.unsure.length ? ['check', '! 確かめる'] : ['wait', `・まだ ${x.guest.length}`];
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: p.name || '名前の分からない人' }),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: why.join('　') }),
      x.unsure.length ? button('確かめる', () => ui.go('review', { personId: p.id }))
        : button('お客さんに聞く', () => ui.go('ask', { bookingId: p.bookingId })));
  }

  function exportCsv(trip, ui) {
    const table = C().rosterRows(R.rosterStore.get(), trip.id, healthShort(), { own: true });
    const items = csvHealth ? table.items : table.items.filter(i => !i.health);
    R.saveFile(`meibo-${trip.date}${trip.start ? `-${trip.start.replace(':', '')}` : ''}.csv`, C().toCsv({ items, rows: table.rows }), 'text/csv;charset=utf-8');
    const withHealth = csvHealth;
    csvHealth = false;
    const r = ui.save(st => C().logOutput(st, { tripId: trip.id, act: 'csv', people: table.rows.length, health: withHealth, at: nowIso() }));
    ui.go('day', { tripId: trip.id, saved: r.saved, notice: withHealth
      ? `CSV に書き出しました（${table.rows.length} 人、健康の欄あり）。人に送らず、使い終わったら消してください`
      : `CSV に書き出しました（${table.rows.length} 人、健康の欄なし）。使い終わったら消してください` });
  }

  function renderDay({ tripId, ui }) {
    if (tripId !== csvTrip) { csvHealth = false; csvTrip = tripId; }
    const g = D().dayGroups(R.rosterStore.get(), tripId, R.today());
    if (!g) return [...ui.head('今日の名簿'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const { trip } = g;
    return [
      ...ui.head('今日の名簿', `${ui.md(trip.date)} ${ui.tripLabel(trip)}　${g.count} 人`),
      trip.partners.length ? el('p', { class: 'note', text: '乗り合いの他のお店のお客さんは、この名簿に入れません（条例の名簿はお店ごと）。船の全員は「乗り合い・札」の合同名簿で見ます。' }) : null,
      tripFields(g, ui),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '見てほしい人', el('small', { text: `${g.check.length} 人` })),
        g.check.length ? el('ul', { class: 'bks bks--sheet' }, g.check.map(x => checkLine(x, g, ui)))
          : el('p', { class: 'sheet__note', text: '見てほしい人はいません。' })),
      g.morning.length ? el('details', { class: 'sheet known' },
        el('summary', { text: `当日の朝に体調を答える人　${g.morning.length} 人` }),
        el('ul', { class: 'bks bks--sheet' }, g.morning.map(x => el('li', { class: 'bk' },
          el('span', { class: 'bk__name', text: x.person.name || '名前の分からない人' }),
          el('span', { class: 'st st--wait', text: '・当日の朝' }))))) : null,
      g.ready.length ? el('details', { class: 'sheet known' },
        el('summary', { text: `そろった人　${g.ready.length} 人` }),
        el('ul', { class: 'bks bks--sheet' }, g.ready.map(x => el('li', { class: 'bk' },
          el('span', { class: 'bk__name', text: x.person.name || '名前の分からない人' }),
          el('span', { class: 'st st--ok', text: x.done ? '✓ そろった' : '✓ お客さんの分' }))))) : null,
      el('p', { class: 'reset' }, button('カレンダーに入れる（.ics）', () => ui.go('ics', { tripId })), '　',
        button('記録を見る', () => ui.go('log', { tripId }), 'linkbtn linkbtn--muted')),
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: csvHealth, onchange: (e) => { csvHealth = e.target.checked; } }),
        el('span', { text: 'CSV に健康の欄（既往症・当日の健康状態）も入れる' })),
      ui.back(),
      ui.dock(
        el('button', { class: 'btn', type: 'button', text: '名簿を印刷', onclick: () => ui.go('print', { tripId }) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'CSV に書き出す', onclick: () => exportCsv(trip, ui) }))
    ];
  }

  /* ---------- 条例の名簿（印刷） ---------- */
  function paper(s, trip, table) {
    const law = LAW[trip.kind];
    const notDone = table.rows.filter(r => !r.done).length;
    const label = (key) => table.items.find(i => i.key === key).ja;
    const meta = [['事業者', s.shop.name], [label('when'), `${slash(trip.date)} ${trip.start ? clock(trip.start) : ''}`.trim()],
      [label('site'), trip.site || '—'], [label('guide'), trip.guides.join('・') || '—'], ['人数', String(table.rows.length)]];
    return el('section', { class: 'paper', 'aria-label': law.title, 'data-trip': trip.id, 'data-people': String(table.rows.length) },
      el('h3', { class: 'paper__title', text: law.title }),
      el('p', { class: 'paper__meta' }, meta.map(([k, v]) => el('span', {}, `${k} `, el('b', { text: v })))),
      notDone ? el('p', { class: 'paper__warn', text: `まだそろっていない人が ${notDone} 人います（— の欄）。そろってから印刷し直してください。` }) : null,
      el('div', { class: 'paper__wrap' }, el('table', { class: 'paper__table' },
        el('thead', {}, el('tr', {}, table.items.map(i => el('th', { scope: 'col', text: i.ja })))),
        el('tbody', {}, table.rows.map(r => el('tr', {}, table.items.map(i => el('td', { class: r.cells[i.key] ? null : 'paper__none', text: r.cells[i.key] || '—' }))))))),
      el('p', { class: 'paper__foot' },
        el('span', { text: `この名簿は ${slash(C().keepUntil(trip.date))} まで残す（作成の日から 1 年。${law.rule}）` }),
        el('span', { text: `印刷 ${shortTime(nowIso())}　見る人はこの便のお店の人だけ（乗り合いの便では同じ船のお店も）。健康の欄は人に見せない` })));
  }

  function renderPrint({ tripId, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return [...ui.head('条例の名簿'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const table = C().rosterRows(s, tripId, healthShort(), { own: true });
    return [
      ...ui.head(LAW[trip.kind].title, `${ui.md(trip.date)} ${ui.tripLabel(trip)}。印刷の画面で「PDF に保存」も選べます`),
      paper(s, trip, table),
      el('p', { class: 'reset' }, button('今日の名簿に戻る', () => ui.go('day', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '印刷する', onclick: () => window.print() }))
    ];
  }

  /* ---------- カレンダー（.ics） ---------- */
  function renderIcs({ tripId, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return [...ui.head('カレンダーに入れる'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const trips = D().icsTrips(s, icsRange === 'day' ? { day: trip.date } : { from: R.today() });
    const range = (key, text) => el('button', { class: 'ptab', type: 'button', 'aria-pressed': String(icsRange === key), text, onclick: () => { icsRange = key; ui.rerender(); } });
    const save = () => {
      R.saveFile(`redux-${icsRange === 'day' ? trip.date : 'trips'}.ics`, D().toIcs(s, { trips, stamp: stampOf(nowIso()) }), 'text/calendar;charset=utf-8');
      ui.go('ics', { tripId, notice: `カレンダーの予定を ${trips.length} 件書き出しました。カレンダーのアプリで開いてください` });
    };
    return [
      ...ui.head('カレンダーに入れる', '便ごとに予定を 1 つ作ります。Google カレンダーや iPhone のカレンダーで読み込めます'),
      el('div', { class: 'ptabs', role: 'group' }, range('ahead', '今日から先の便'), range('day', `${ui.md(trip.date)} の便だけ`)),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '入る予定', el('small', { text: `${trips.length} 件` })),
        trips.length ? trips.map(t => el('p', { class: 'ics' }, el('b', { class: 'fig', text: `${ui.md(t.date)} ${t.start ? clock(t.start) : '終日'}` }),
          ` ${t.tour || ''} ${C().tripSummary(s, t.id).booked} 人`)) : el('p', { class: 'sheet__note', text: '入る便がありません。' }),
        el('p', { class: 'sheet__note', text: '入るのは時刻・ツアー・人数・潜水場所だけです。名前・電話・健康のことは入れません。' })),
      el('p', { class: 'note', text: '時刻やツアーを変えたら、カレンダーの前の予定を消してから読み込み直してください。自動で直る「購読」は、本物にするとき（P6）に足します。' }),
      el('p', { class: 'reset' }, button('今日の名簿に戻る', () => ui.go('day', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn', type: 'button', disabled: !trips.length, text: '.ics を書き出す', onclick: save }))
    ];
  }

  /* ---------- 記録 ---------- */
  const PAPER_JA = { joint: '合同名簿', board: '札ボード' };
  function logLine(e, s, items) {
    const person = e.kind === 'person' ? s.people.find(p => p.id === e.id) : null;
    const booking = e.kind === 'booking' ? s.bookings.find(b => b.id === e.id) : null;
    const who = e.kind === 'person' ? `${(person && person.name) || '名前の分からない人'}の` : e.kind === 'booking' ? '予約の' : '便の';
    const fields = e.fields.map(f => labelOf(items, f)).join('・');
    const text = {
      add: e.kind === 'trip' ? '便を作った' : e.kind === 'booking' ? '予約を入れた' : `${who.slice(0, -1)}を名簿に入れた`,
      edit: `${who}${fields}`, check: `${who.slice(0, -1)}を確かめた`,
      print: e.after.paper === 'board' ? `札ボードの印刷の画面を開いた（札 ${e.after.people} 枚）` : `${PAPER_JA[e.after.paper] || '名簿'}の印刷の画面を開いた（${e.after.people} 人）`,
      csv: `名簿を CSV に書き出した（${e.after.people} 人、健康の欄${e.after.health === false ? 'なし' : 'あり'}）`, remove: '保存期間を過ぎた便を消した',
      handover: `${(booking && booking.shop) || '乗り合いのお店'}から ${e.after.people} 人を受け取った（健康の欄${e.after.health ? 'あり' : 'なし'}）`,
      tags: e.after.renamed ? `ガイドの名前を直して、札を付け替えた（全部で ${e.after.tags} 枚）` : `札の番号を付けた（${e.after.added} 枚。全部で ${e.after.tags} 枚）`,
      aboard: `ポイントを離れる前: 全員戻った（札 ${e.after.tags} 枚）`
    }[e.act] || e.act;
    /* 便の項目（潜水場所・ガイド）だけは前と後を出す。人の中身（健康の答えなど）は出さない */
    const tripValues = e.kind === 'trip' && e.act === 'edit'
      ? e.fields.map(f => `${[].concat(e.before[f] || '—').join('・') || '—'} → ${[].concat(e.after[f] || '—').join('・') || '—'}`).join('　') : '';
    const sub = [tripValues, e.kind === 'person' && e.act === 'edit' ? '中身は名簿の画面で見る' : '', e.demo ? 'デモで当日として答えた' : ''].filter(Boolean).join('　');
    return el('div', { class: 'logrow' }, el('time', { datetime: e.at, text: shortTime(e.at) }),
      el('span', {}, `${WHO_JA[e.who] || e.who}　${text}`, sub ? el('small', { text: sub }) : null));
  }

  function aiLine(e) {
    const x = e.sent;
    const sub = [`送った量 ${Math.max(1, Math.round(x.size / 1024))} KB`, x.masked ? '健康の欄を塗った' : '',
      x.redacted ? `健康に触れていそうな所を ${x.redacted} か所外した` : '',
      x.healthSeen ? '健康の情報が見えたと答えた' : '健康の情報は見えなかった', x.mode === 'sample' ? '見本の読み取り' : ''].filter(Boolean).join('・');
    return el('div', { class: 'logrow' }, el('time', { datetime: e.at, text: shortTime(e.at) }),
      el('span', {}, `AI　${DOC_JA[x.doc] || x.doc}を読んだ`, el('small', { text: sub })));
  }

  function renderLog({ tripId, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return [...ui.head('記録'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const items = R.roster.ITEMS[trip.kind];
    const { entries, ai } = D().tripLog(s, tripId);
    return [
      ...ui.head('記録', `${ui.md(trip.date)} ${ui.tripLabel(trip)}。足すだけで、消したり書き換えたりできません`),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, 'この便の記録', el('small', { text: `${entries.length} 件` })),
        entries.length ? entries.map(e => logLine(e, s, items)) : el('p', { class: 'sheet__note', text: 'まだありません。' })),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, 'AI に送った記録', el('small', { text: '便に付かない・この端末の全部' })),
        ai.length ? ai.slice(0, 30).map(aiLine) : el('p', { class: 'sheet__note', text: 'まだありません。' })),
      el('p', { class: 'note', text: '保存はこの端末の中（試作）。正本は印刷した紙です。1 年たった便は、記録ごと消して件数だけ残します。' }),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '今日の名簿に戻る', onclick: () => ui.go('day', { tripId }) }))
    ];
  }

  /* 印刷の記録は、印刷の直前に残す（「印刷する」でも、ブラウザのメニューや Ctrl+P でも）。名簿の紙を出しているときだけ */
  window.addEventListener('beforeprint', () => {
    const paper = document.querySelector('#view-booking:not([hidden]) .paper[data-trip]');
    if (!paper) return;
    try {
      R.rosterStore.update(st => C().logOutput(st, { tripId: paper.dataset.trip, act: 'print', people: Number(paper.dataset.people),
        health: paper.dataset.health !== 'false', paper: paper.dataset.paper, at: nowIso() }));
    } catch (e) {
      /* 記録できなくても印刷は止めない。記録の画面に出ないだけ */
    }
  });

  R.dayRoster = { LAW, renderDay, renderPrint, renderIcs, renderLog };
})();
