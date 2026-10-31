/* お店の画面: 乗船者名簿とダイビング計画（国交省のダイビング船の安全対策ガイドライン）。今日の名簿（day-roster.js）から開く。
   決まりは js/roster-manifest.js（manifest）、保存は roster-core.js の editTrip（計画・ポイント）と editPerson（性別） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const S = () => R.roster;
  const M = () => R.rosterManifest;

  const nowIso = () => new Date().toISOString();
  const slash = (d) => d.replace(/-/g, '/');
  const clock = (t) => t.replace(/^0/, '');
  const TANK_SIZES = [10, 12];   // 画面に出す容量（L）。ほかの容量の計画もそのまま出す
  const GUIDELINE = '国土交通省「ダイビング船の安全対策ガイドライン」（令和 7 年 7 月）の乗船者名簿・ダイビング計画の項目による。健康に関する情報は含まない';
  const button = (text, onclick, cls) => el('button', { class: cls || 'linkbtn', type: 'button', text, onclick });
  const shortTime = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  /* 便を直す（計画・ポイント）。直したら同じ画面を描き直す */
  function editTrip(tripId, patch, ui) {
    const r = ui.save('core.editTrip', { tripId, patch, at: nowIso() });
    ui.go('manifest', r.error ? { tripId, warn: '入れられませんでした。時刻・分・本数の形を確かめてください' } : { tripId, saved: r.saved });
  }
  const planInput = (tripId, key, attrs, ui, parse) => el('input', { class: 'input', ...attrs, 'data-keep': `plan-${key}`,
    onchange: (e) => editTrip(tripId, { plan: { [key]: parse ? parse(e.target.value) : e.target.value } }, ui) });
  const toInt = (v) => (String(v).trim() === '' ? '' : Number(v));
  const row = (label, control, note) => el('div', { class: 'pickrow' }, el('span', { class: 'rd__k', text: label }),
    el('span', {}, control, note ? el('span', { class: 'mf__src', text: note }) : null));

  /* タンク: 10L と 12L の本数（ほかの容量は今の値のまま出す）。0 本の容量は計画から外す */
  function tankInputs(m, ui) {
    const { trip, plan } = m;
    const sizes = [...new Set([...TANK_SIZES, ...plan.tanks.map(x => x.size)])];
    const countOf = (size) => (plan.tanks.find(x => x.size === size) || { count: '' }).count;
    const set = (size, value) => {
      const count = toInt(value);
      const rest = plan.tanks.filter(x => x.size !== size);
      const tanks = count === '' || count === 0 ? rest : [...rest, { size, count }].sort((a, b) => a.size - b.size);
      editTrip(trip.id, { plan: { tanks } }, ui);
    };
    return el('span', { class: 'mf__tanks' }, sizes.map(size => el('label', { class: 'mf__tank' },
      el('span', { text: `${size}L` }),
      el('input', { class: 'input input--short', type: 'number', min: 0, max: S().MAX_PEOPLE * S().MAX_DIVES, inputmode: 'numeric',
        value: countOf(size), 'data-keep': `plan-tank-${size}`, onchange: (e) => set(size, e.target.value) }),
      el('span', { text: '本' }))));
  }

  function planRows(m, ui) {
    const { trip, plan, suggest } = m;
    const id = trip.id;
    const miss = (k) => m.planMissing.includes(k);
    return el('div', { class: 'tripfacts' },
      row('出港', planInput(id, 'depart', { type: 'time', value: plan.depart, class: 'input mf__time' }, ui), miss('depart') ? '・まだ' : null),
      row('帰港予定', planInput(id, 'back', { type: 'time', value: plan.back, class: 'input mf__time' }, ui)),
      row('港', planInput(id, 'port', { type: 'text', maxlength: 40, value: plan.port, placeholder: '例: 泊ふ頭' }, ui)),
      row('ポイント', el('input', { class: 'input', type: 'text', maxlength: 80, value: trip.site, 'data-keep': 'plan-site', placeholder: '例: ナガンヌ北',
        onchange: (e) => editTrip(id, { site: e.target.value }, ui) }), miss('site') ? '・まだ（条例の名簿の潜水場所と同じ欄）' : '条例の名簿の潜水場所と同じ欄'),
      row('潜水時間', el('span', { class: 'mf__pair' }, el('span', { text: '1 本' }),
        planInput(id, 'minutes', { type: 'number', min: 1, max: 180, inputmode: 'numeric', value: plan.minutes, class: 'input input--short' }, ui, toInt),
        el('span', { text: '分まで' })), miss('minutes') ? '・まだ' : null),
      row('タンク', tankInputs(m, ui), miss('tanks')
        ? null : `計 ${m.tankTotal} 本`),
      miss('tanks') && suggest.count ? el('p', { class: 'sheet__note' },
        button(`お客 ${suggest.count / M().DIVES_PER_GUEST} 名 × ${M().DIVES_PER_GUEST} 本で入れる（${suggest.size}L ${suggest.count} 本）`,
          () => editTrip(id, { plan: { tanks: [{ size: suggest.size, count: suggest.count }] } }, ui))) : null,
      row('船長', planInput(id, 'captain', { type: 'text', maxlength: 40, value: plan.captain }, ui)),
      row('船上の見張り', planInput(id, 'watch', { type: 'text', maxlength: 40, value: plan.watch, placeholder: '名前' }, ui),
        m.planCheck.includes('watch') ? '! まだ決めていない（船上の潜水者安全確保要員。2027-04 から努力義務）' : '船上の潜水者安全確保要員'));
  }

  /* 性別はお店が入れる（条例の名簿に無い項目）。選んだらすぐ保存 */
  function sexPicker(r, tripId, ui) {
    const save = (e) => {
      const res = ui.save('core.editPerson', { id: r.personId, patch: { sex: e.target.value }, who: 'staff', at: nowIso() });
      ui.go('manifest', res.error ? { tripId, warn: '性別を入れられませんでした' } : { tripId, saved: res.saved });
    };
    return el('select', { class: 'input mf__sex', 'aria-label': `${r.cells.name || 'この人'}の性別`, 'data-keep': `sex-${r.personId}`, onchange: save },
      el('option', { value: '', selected: !r.sex, text: '性別' }),
      Object.entries(M().SEX_JA).map(([v, t]) => el('option', { value: v, selected: r.sex === v, text: t })));
  }

  function personLine(r, m, ui) {
    if (r.kind === 'guide') {
      return el('li', { class: 'bk' }, el('span', { class: 'bk__name', text: r.cells.name }), el('span', { class: 'st', text: 'ガイド' }),
        el('span', { class: 'bk__meta', text: '性別・年齢・住所は、お店の控えで' }));
    }
    const short = r.missing.filter(k => k !== 'sex');
    const meta = [r.cells.address, r.cells.emergency ? `緊急 ${r.cells.emergency}` : ''].filter(Boolean).join('・');
    return el('li', { class: 'bk mf__person' },
      el('span', { class: 'bk__name' }, r.cells.name || '名前の分からない人', r.cells.age ? el('span', { class: 'age', text: `${r.cells.age} 歳` }) : null),
      sexPicker(r, m.trip.id, ui),
      el('span', { class: 'bk__meta', text: meta || '住所・緊急連絡先がまだ' }),
      short.length ? el('span', { class: 'bk__meta mf__miss', text: `・足りない: ${short.map(k => M().KEY_JA[k]).join('・')}（今日の名簿の「お客さんに聞く」から）` }) : null);
  }

  function renderManifest({ tripId, ui }) {
    const m = M().manifest(R.rosterStore.get(), tripId);
    if (!m) return [...ui.head('乗船者名簿'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const { trip, counts } = m;
    return [
      ...R.dayRoster.tripMast(trip, '乗船者名簿', ui, counts.total),
      el('p', { class: 'mf__counts', role: 'status' },
        el('span', { class: m.missingCount ? 'mf__warn' : 'st--ok', text: m.missingCount ? `足りない所 ${m.missingCount} 件` : '✓ 足りない所はありません' }),
        m.checkCount ? el('span', { text: `確かめる所 ${m.checkCount} 件` }) : null),
      el('p', { class: 'sheet__title' }, 'ダイビング計画'),
      planRows(m, ui),
      el('p', { class: 'sheet__title' }, '乗船者名簿', el('small', { text: `お客 ${counts.guests}・ガイド ${counts.guides}${counts.crew ? '・船 1' : ''}` })),
      el('ul', { class: 'bks bks--sheet' }, m.rows.map(r => personLine(r, m, ui))),
      m.partners.length ? el('ul', { class: 'bks bks--sheet' }, m.partners.map(x => el('li', { class: 'bk' },
        el('span', { class: 'bk__name', text: x.shop }), el('span', { class: 'st', text: `お客 ${x.guests} 名` }),
        el('span', { class: 'bk__meta', text: '名前などは、そのお店の名簿に残す（この紙には人数だけ）' })))) : null,
      el('p', { class: 'note', text: 'お客さんの健康の答えは、この名簿にも紙にも入りません。' }),
      el('p', { class: 'reset' }, button('今日の名簿に戻る', () => ui.go('day', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '印刷・PDF（船長へ）', onclick: () => ui.go('manifestprint', { tripId }) }))
    ];
  }

  /* ---------- 紙（船長に渡す・お店の控え） ---------- */
  /* 紙の列と幅（css の mf__col--*） */
  const COLS = [['#', 'n'], ['氏名', 'name'], ['性別', 'sex'], ['年齢', 'age'], ['住所', 'address'], ['緊急連絡先', 'emergency']];
  const cell = (text, cls) => el('td', { class: [text ? '' : 'paper__none', cls || ''].filter(Boolean).join(' ') || null }, text || '—');

  function manifestPaper(s, m) {
    const { trip, plan, counts } = m;
    const tanks = plan.tanks.map(x => `${x.size}L × ${x.count}`).join('・');
    const when = [plan.depart && `${clock(plan.depart)}${plan.port ? ` ${plan.port}` : ''}`, plan.back && clock(plan.back)].filter(Boolean).join(' / ');
    const meta = [['事業者', s.shop.name], ['日付', `${slash(trip.date)} ${trip.start ? clock(trip.start) : ''}`.trim()],
      ['船名', trip.boat || '—'], ['船長', plan.captain || '—']];
    const partnerRows = m.partners.map(x => el('tr', {}, cell(''), el('td', { colspan: '5', text: `${x.shop} のお客 ${x.guests} 名（名前などは、そのお店の名簿）` })));
    return el('section', { class: 'paper paper--manifest', 'aria-label': '乗船者名簿・ダイビング計画', 'data-trip': trip.id,
      'data-people': String(counts.total), 'data-paper': 'manifest', 'data-health': 'false' },
      el('h3', { class: 'paper__title', text: '乗船者名簿・ダイビング計画' }),
      el('p', { class: 'paper__meta' }, meta.map(([k, v]) => el('span', {}, `${k} `, el('b', { text: v })))),
      m.missingCount ? el('p', { class: 'paper__warn', text: `足りない所が ${m.missingCount} 件あります（— の欄）。そろってから印刷し直してください。` }) : null,
      el('table', { class: 'paper__table paper__table--plan' }, el('tbody', {},
        el('tr', {}, el('th', { scope: 'row', text: '出港 / 帰港予定' }), cell(when),
          el('th', { scope: 'row', text: '乗る人' }), cell(`${counts.total} 名（お客 ${counts.guests + counts.partnerGuests}・ガイド ${counts.guides}${counts.crew ? '・船 1' : ''}）`)),
        el('tr', {}, el('th', { scope: 'row', text: 'ポイント' }), cell(trip.site),
          el('th', { scope: 'row', text: '潜水時間' }), cell(plan.minutes === '' ? '' : `1 本 ${plan.minutes} 分まで`)),
        el('tr', {}, el('th', { scope: 'row', text: 'タンク' }), cell(tanks ? `${tanks}（計 ${m.tankTotal}）` : ''),
          el('th', { scope: 'row', text: '船上の見張り' }), cell(plan.watch)))),
      el('div', { class: 'paper__wrap' }, el('table', { class: 'paper__table paper__table--manifest' },
        el('thead', {}, el('tr', {}, COLS.map(([t, w]) => el('th', { scope: 'col', class: `mf__col--${w}`, text: t })))),
        el('tbody', {}, m.rows.map((r, i) => el('tr', {}, cell(String(i + 1)), cell(r.kind === 'guide' ? `${r.cells.name}（ガイド）` : r.cells.name),
          cell(r.cells.sex), cell(r.cells.age), cell(r.cells.address), cell(r.cells.emergency))), partnerRows))),
      el('p', { class: 'paper__sign' }, ['船長の確認', '出港前の人数　　名', '帰港後の人数　　名'].map(t => el('span', { text: t }))),
      el('p', { class: 'paper__foot' }, el('span', { text: GUIDELINE }), el('span', { text: `印刷 ${shortTime(nowIso())}` })));
  }

  function renderManifestPrint({ tripId, ui }) {
    const s = R.rosterStore.get();
    const m = M().manifest(s, tripId);
    if (!m) return [...ui.head('乗船者名簿'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    return [
      ...ui.head('乗船者名簿・ダイビング計画', `${ui.md(m.trip.date)} ${ui.tripLabel(m.trip)}。印刷の画面で「PDF に保存」も選べます`),
      manifestPaper(s, m),
      el('p', { class: 'reset' }, button('乗船者名簿に戻る', () => ui.go('manifest', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '印刷する', onclick: () => window.print() }))
    ];
  }

  R.boatManifest = { renderManifest, renderManifestPrint, manifestPaper };
})();
