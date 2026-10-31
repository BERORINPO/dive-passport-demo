/* お店の画面: 医師の診断書の一覧と、お店の決まり。今日の名簿（day-roster.js）から開く。
   決まりの当てはめは js/roster-medical.js（medicalList）、保存は roster-core.js の editPerson（診断日 health.medAt）と setMedicalRules */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const S = () => R.roster;
  const M = () => R.rosterMedical;

  const nowIso = () => new Date().toISOString();
  const slash = (d) => d.replace(/-/g, '/');
  const button = (text, onclick, cls) => el('button', { class: cls || 'linkbtn', type: 'button', text, onclick });
  const EDIT_SRC = ['guest', 'staff', 'passport', 'partner'];
  const CAUTION = '潜ってよいかは医師とお店が決めます。REDUX は、お店が入れた決まりを当てはめるだけです。';
  const ST = {
    missing: ['wait', '・まだ'], expired: ['check', '! 期限切れ'], ok: ['ok', '✓ 期限内'], unknown: ['wait', '・決められない'], none: ['ok', '要らない']
  };

  /* 要る理由と期限の 1 行 */
  function whyText(r, rules, trip) {
    const why = [
      r.why.includes('age') ? `${rules.age} 歳以上（お店の決まり）` : '',
      r.why.includes('yes') ? `健康の答えに「はい」が ${r.yes} つ（どの項目かは名簿で）` : ''
    ].filter(Boolean).join('・');
    const term = r.status === 'ok' ? `診断日 ${slash(r.medAt)} → ${slash(r.until)} まで`
      : r.status === 'expired' ? `診断日 ${slash(r.medAt)} → ${slash(r.until)} で切れた（便の日は ${slash(trip.date)}）`
        : `期限は診断日から ${r.days} 日${r.older ? `（${rules.olderAge} 歳以上）` : ''}`;
    return [why, term].filter(Boolean).join('。');
  }

  /* 診断日を入れる（消すと受け取っていないに戻る）。便の日より後の日は入れられない */
  function medInput(r, m, ui) {
    const p = r.person;
    const save = (e) => {
      const src = EDIT_SRC.includes(p.src.health) ? p.src.health : 'staff';
      const res = ui.save('core.editPerson', { id: p.id, patch: { health: { medAt: e.target.value } }, who: 'staff', src, at: nowIso() });
      ui.go('medical', res.error ? { tripId: m.trip.id, warn: '診断日を入れられませんでした。日付を確かめてください' } : { tripId: m.trip.id, saved: res.saved });
    };
    return el('label', { class: 'md__date' }, el('span', { text: r.medAt ? '診断日' : '受け取ったら診断日' }),
      el('input', { class: 'input', type: 'date', value: r.medAt, max: m.trip.date, 'data-keep': `med-${p.id}`,
        'aria-label': `${p.name || 'この人'}の診断書の診断日`, onchange: save }));
  }

  function needLine(r, m, ui) {
    const [cls, text] = ST[r.status];
    return el('li', { class: 'bk md__person' },
      el('span', { class: 'bk__name' }, r.person.name || '名前の分からない人', r.age !== null ? el('span', { class: 'age', text: `${r.age} 歳` }) : null),
      el('span', { class: `st st--${cls}`, text }),
      el('span', { class: 'bk__meta', text: whyText(r, m.rules, m.trip) }),
      r.trialOver ? el('span', { class: 'bk__meta mf__miss', text: `! 体験ダイビングは ${m.rules.trialMax} 歳まで（お店の決まり）` }) : null,
      medInput(r, m, ui));
  }

  function unknownLine(r, m, ui) {
    const short = [r.age === null && m.rules.age !== '' ? '生年月日' : '', !r.paper && r.person.health.answers.some(a => a === null) ? '健康の答え' : '']
      .filter(Boolean).join('・');
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: r.person.name || '名前の分からない人' }),
      el('span', { class: 'st st--wait', text: ST.unknown[1] }),
      el('span', { class: 'bk__meta', text: `${short}がまだなので、要るか決められません` }),
      button('お客さんに聞く', () => ui.go('ask', { bookingId: r.person.bookingId })));
  }

  function renderMedical({ tripId, ui }) {
    const m = M().medicalList(R.rosterStore.get(), tripId);
    if (!m) return [...ui.head('診断書'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const { counts } = m;
    const status = [
      counts.missing ? el('span', { class: 'mf__warn', text: `要るのにまだ ${counts.missing} 名` }) : null,
      counts.expired ? el('span', { class: 'mf__warn', text: `期限切れ ${counts.expired} 名` }) : null,
      counts.ok ? el('span', { class: 'st--ok', text: `受け取った ${counts.ok} 名` }) : null,
      counts.unknown ? el('span', { text: `決められない ${counts.unknown} 名` }) : null
    ].filter(Boolean);
    return [
      ...R.dayRoster.tripMast(m.trip, '診断書', ui, m.rows.length),
      el('p', { class: 'mf__counts', role: 'status' }, status.length ? status : el('span', { class: 'st--ok', text: '✓ 診断書が要る人はいません' })),
      m.paper ? el('p', { class: 'note', text: '健康の質問を紙の申込書で聞くお店なので、ここでは年齢の決まりだけで見ています。「はい」がある人は申込書で確かめてください。' }) : null,
      el('p', { class: 'sheet__title' }, '要る人', el('small', { text: `${m.need.length} 名` })),
      m.need.length ? el('ul', { class: 'bks bks--sheet' }, m.need.map(r => needLine(r, m, ui)))
        : el('p', { class: 'sheet__note', text: '要る人はいません。' }),
      m.unknown.length ? el('p', { class: 'sheet__title' }, '決められない人', el('small', { text: `${m.unknown.length} 名` })) : null,
      m.unknown.length ? el('ul', { class: 'bks bks--sheet' }, m.unknown.map(r => unknownLine(r, m, ui))) : null,
      m.none.length ? el('details', { class: 'sheet known' },
        el('summary', { text: `要らない人　${m.none.length} 名` }),
        el('p', { class: 'sheet__note', text: m.none.map(r => r.person.name || '名前の分からない人').join('・') })) : null,
      m.held ? el('p', { class: 'note', text: `乗り合いの他のお店のお客さん ${m.held} 名は、そのお店が確かめます（ここには入れません）。` }) : null,
      el('p', { class: 'note', text: CAUTION }),
      el('p', { class: 'reset' }, button('今日の名簿に戻る', () => ui.go('day', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn btn--ghost', type: 'button', text: 'お店の決まり', onclick: () => ui.go('medicalrules', { tripId }) }))
    ];
  }

  /* ---------- お店の決まり ---------- */
  const toValue = (v, blank) => (String(v).trim() === '' && blank ? '' : Number(v));
  function ruleInput(key, rules, tripId, ui, { blank, unit, min, max }) {
    const save = (e) => {
      const res = ui.save('core.setMedicalRules', { rules: { [key]: toValue(e.target.value, blank) }, at: nowIso() });
      ui.go('medicalrules', res.error ? { tripId, warn: `入れられませんでした。${min}〜${max} の数で入れてください${blank ? '（空にすると使わない）' : ''}` }
        : { tripId, saved: res.saved });
    };
    return el('span', { class: 'mf__pair' },
      el('input', { class: 'input input--short', type: 'number', min, max, inputmode: 'numeric', value: rules[key], 'data-keep': `med-rule-${key}`,
        'aria-label': key, onchange: save }), el('span', { text: unit }));
  }
  const ruleRow = (label, control, note) => el('div', { class: 'pickrow' }, el('span', { class: 'rd__k', text: label }),
    el('span', {}, control, note ? el('span', { class: 'mf__src', text: note }) : null));

  function rulesText(rules) {
    const byAge = rules.age === '' ? '年齢では決めない' : `${rules.age} 歳以上は要る`;
    const older = rules.olderAge === '' ? '' : `（${rules.olderAge} 歳以上は ${rules.olderDays} 日）`;
    return `今の決まり: ${byAge}・期限 ${rules.days} 日${older}。${CAUTION}`;
  }

  function renderRules({ tripId, ui }) {
    const rules = R.rosterCore.medicalOf(R.rosterStore.get());
    const age = { blank: true, unit: '歳', min: 1, max: 120 };
    const days = { blank: false, unit: '日', min: 1, max: 730 };
    return [
      ...ui.head('診断書の決まり', 'お店ごとに 1 回入れます。最初は沖縄のお店で多い決まりが入っています'),
      el('div', { class: 'tripfacts' },
        ruleRow('健康の答え', el('span', { text: '「はい」が 1 つでもあれば要る' }), '指導団体の病歴診断書と同じ（変えられません）'),
        ruleRow('年齢', ruleInput('age', rules, tripId, ui, age), '歳以上は、答えに関わらず要る（便の日の満年齢。空にすると使わない）'),
        ruleRow('期限', ruleInput('days', rules, tripId, ui, days), '診断日から（下の年齢より若い人）'),
        ruleRow('年配の期限', el('span', {}, ruleInput('olderAge', rules, tripId, ui, age), ruleInput('olderDays', rules, tripId, ui, days)),
          '歳以上は、診断日からこの日数（空にすると使わない）'),
        ruleRow('体験ダイビング', ruleInput('trialMax', rules, tripId, ui, age), '歳まで。超える人に「! 年齢」を出す（C カードなしの人。空にすると使わない）')),
      el('p', { class: 'note', text: rulesText(rules) }),
      tripId ? el('p', { class: 'reset' }, button('診断書の一覧に戻る', () => ui.go('medical', { tripId }), 'linkbtn linkbtn--muted')) : ui.back()
    ];
  }

  R.medicalList = { renderMedical, renderRules };
})();
