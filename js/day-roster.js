/* お店の画面: 今日の名簿・血中酸素（県警の体調チェック表）・条例の名簿の印刷・CSV・カレンダー（.ics）・記録。予約の画面（booking.js）から開く。
   決まりは js/roster-day.js と roster-core.js（rosterRows・toCsv・editTrip・logOutput）、表の数値と言葉は js/data-sipe.js */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const S = () => R.roster;
  const C = () => R.rosterCore;
  const D = () => R.rosterDay;
  const X = () => R.rosterShare;
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
    courses: '講習受講歴', dives: '経験', lastDive: '最後に潜った日', sizes: 'サイズ', health: '健康の欄', guide: 'ガイド',
    site: '潜水場所', guides: 'ガイド', source: '予約の出どころ', people: '人数', leadName: '代表者', leadPhone: '代表者の電話', note: 'メモ',
    boat: '船', host: '船を出す店', partners: '乗り合いのお店' };
  let icsRange = 'ahead';   // ahead（今日から先の便）/ day（この日の便だけ）
  let csvHealth = false;    // CSV に健康の欄（既往症・当日の健康状態）を入れるか。初めは入れない。書き出した後と、便を替えたときに戻す
  let csvTrip = '';

  const nowIso = () => new Date().toISOString();
  const slash = (d) => d.replace(/-/g, '/');
  const clock = (t) => t.replace(/^0/, '');
  const KIND_JA = { dive: 'ダイビング', snorkel: 'スノーケル' };
  const reasonJa = (id) => (S().CANCEL_TEXT[id] || { ja: '' }).ja;
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
    /* 便で決めること（名簿の 3 項目）と血中酸素を、時刻の見出しの下の 1 つの表に（design.md の形） */
    return el('div', { class: 'tripfacts' },
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: labelOf(items, 'site') }),
        el('input', { class: 'input', type: 'text', maxlength: 80, list: 'site-list', value: trip.site,
          placeholder: prev ? `前の便: ${prev}` : '例: 北の根', onchange: (e) => edit({ site: e.target.value }) })),
      !trip.site && prev ? el('p', { class: 'sheet__note' }, button(`前の便と同じ（${prev}）にする`, () => edit({ site: prev }))) : null,
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: 'ガイド' }),
        el('input', { class: 'input', type: 'text', maxlength: 200, list: 'guide-list', value: trip.guides.join('・'),
          placeholder: '2 人なら ・ で区切る', onchange: (e) => edit({ guides: e.target.value.split(/[・,、]/) }) })),
      list('site-list', D().usedSites(s)), list('guide-list', D().usedGuides(s)),
      sipeRow(trip.id, ui),
      !trip.start ? el('p', { class: 'sheet__note', text: '潜水日時: 便の時刻がまだです。' }) : null);
  }

  /* 便の画面の見出し: 左に便の時刻を大きく、右に日付・ツアー・人数（design.md の形）。題は読み上げにだけ出す */
  function tripMast(trip, title, ui, count) {
    const [, h2, , notice] = ui.head(title);
    h2.classList.add('sr-only');
    return [
      el('p', { class: 'tripnav' }, button('← 予約', () => ui.go('list')), el('span', { text: R.rosterStore.get().shop.name })),
      h2,
      el('div', { class: trip.cancel ? 'mast mast--off' : 'mast' },
        el('span', { class: 'mast__t', text: trip.start ? clock(trip.start) : '—' }),
        el('span', { class: 'mast__d', text: ui.md(trip.date) }),
        el('span', { class: 'mast__w' }, `${trip.tour || KIND_JA[trip.kind]}`, count === undefined ? null : ['　', el('b', { text: String(count) }), ' 人'])),
      notice
    ];
  }

  /* 名前の横に、50 歳以上の人だけ年齢を出す（県警のまとめで、SIPE が疑われた人の多くが 50〜70 代） */
  const SIPE = () => R.SIPE;
  function ageChip(person, trip) {
    const age = D().ageOn(person.birthDate, trip.date);
    return age !== null && age >= SIPE().OLDER ? el('span', { class: 'age', text: `${age} 歳` }) : null;
  }
  const nameOf = (person, trip) => el('span', { class: 'bk__name' }, person.name || '名前の分からない人', ageChip(person, trip));

  function checkLine(x, g, ui) {
    const p = x.person;
    const why = [
      x.unsure.length ? `確かめる: ${x.unsure.map(k => labelOf(g.items, k)).join('・')}` : '',
      x.guest.length ? `お客さんの入力待ち: ${x.guest.map(k => labelOf(g.items, k)).join('・')}` : ''
    ].filter(Boolean);
    const st = x.unsure.length ? ['check', '! 確かめる'] : ['wait', `・まだ ${x.guest.length}`];
    return el('li', { class: 'bk' },
      nameOf(p, g.trip),
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
      ...tripMast(trip, '今日の名簿', ui, g.count),
      cancelBand(trip, ui),
      trip.partners.length ? el('p', { class: 'note', text: '乗り合いの他のお店のお客さんは、この名簿に入れません（条例の名簿はお店ごと）。船の全員は「乗り合い・札」の合同名簿で見ます。' }) : null,
      tripFields(g, ui),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '見てほしい人', el('small', { text: `${g.check.length} 人` })),
        g.check.length ? el('ul', { class: 'bks bks--sheet' }, g.check.map(x => checkLine(x, g, ui)))
          : el('p', { class: 'sheet__note', text: '見てほしい人はいません。' })),
      g.morning.length ? el('details', { class: 'sheet known', open: true },
        el('summary', { text: `当日の朝に体調を答える人　${g.morning.length} 人` }),
        el('ul', { class: 'bks bks--sheet' }, g.morning.map(x => el('li', { class: 'bk' },
          nameOf(x.person, trip),
          el('span', { class: 'st st--wait', text: '・当日の朝' }))))) : null,
      g.ready.length ? el('details', { class: 'sheet known', open: true },
        el('summary', { text: `そろった人　${g.ready.length} 人` }),
        el('ul', { class: 'bks bks--sheet' }, g.ready.map(x => el('li', { class: 'bk' },
          nameOf(x.person, trip),
          el('span', { class: 'st st--ok', text: x.done ? '✓ そろった' : '✓ お客さんの分' }))))) : null,
      /* ほかの書き出しは 1 行にまとめる。主な操作（印刷）だけを下の帯に */
      el('p', { class: 'morelinks' }, button('乗り合い・札', () => ui.go('share', { tripId })), button('名簿の取り込み', () => ui.go('intake', { tripId })),
        button('CSV に書き出す', () => exportCsv(trip, ui)), button('カレンダー（.ics）', () => ui.go('ics', { tripId })), button('記録', () => ui.go('log', { tripId })),
        trip.cancel || trip.host ? null : button('この便を中止にする', () => ui.go('cancel', { tripId }), 'linkbtn linkbtn--warn')),
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: csvHealth, onchange: (e) => { csvHealth = e.target.checked; } }),
        el('span', { text: 'CSV に健康の欄（既往症・当日の健康状態）も入れる' })),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '名簿を印刷', onclick: () => ui.go('print', { tripId }) }))
    ];
  }

  /* ---------- 便の中止（乗り合いの便では、相乗りのお店とお客さんの画面にも出す） ---------- */
  /* 中止の帯。見落とすとお客さんが港に来てしまうので、注意の色の帯（design.md の例外） */
  function cancelBand(trip, ui) {
    if (!trip.cancel) return null;
    const n = trip.cancel.acked.filter(s => trip.partners.includes(s)).length;
    const acked = trip.partners.length ? `相乗りのお店 ${n}/${trip.partners.length} が確かめた` : '';
    return el('div', { class: 'act' },
      el('p', { class: 'act__title', text: `! 中止（${reasonJa(trip.cancel.reason)}）` }),
      el('p', { text: [`${shortTime(trip.cancel.at)} に知らせた`, acked].filter(Boolean).join('。') }),
      el('p', { class: 'reset' }, button('中止を取り消す', () => {
        const r = ui.save(st => C().reopenTrip(st, { tripId: trip.id, at: nowIso() }));
        ui.go('day', r.error ? { tripId: trip.id, warn: '取り消せませんでした' } : { tripId: trip.id, saved: r.saved, notice: '中止を取り消しました' });
      })));
  }

  let cancelReason = 'wind';
  let cancelTripId = '';
  /* 中止の確認: 理由を選び、知らせる先（この店のお客さんと、相乗りのお店）と届く文を見てから押す */
  function renderCancel({ tripId, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return [...ui.head('中止にする'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    if (tripId !== cancelTripId) { cancelReason = 'wind'; cancelTripId = tripId; }
    if (trip.host) return [...tripMast(trip, '中止にする', ui), el('p', { class: 'note', text: `この便の船は${trip.host}が出します。中止は${trip.host}が決めます。` }), ui.back()];
    const own = C().peopleOf(s, tripId, { own: true }).length;
    const shops = trip.partners.map(shop => ({ shop, n: X().shopPeople(s, tripId, shop).length, guide: X().partnerGuide(s, tripId, shop) }));
    const text = `${ui.md(trip.date)}${trip.start ? clock(trip.start) : ''}の${trip.boat || '便'}は、${S().CANCEL_TEXT[cancelReason].why}中止です。料金は全額お返しします。${s.shop.name}`;
    const go = () => {
      const r = ui.save(st => C().cancelTrip(st, { tripId, reason: cancelReason, at: nowIso() }));
      ui.go('day', r.error ? { tripId, warn: '中止にできませんでした' } : { tripId, saved: r.saved,
        notice: trip.partners.length ? `中止を知らせました（この店のお客さん ${own} 人と、相乗りの ${trip.partners.length} 店）` : `中止を知らせました（お客さん ${own} 人）` });
    };
    const reason = (id) => el('label', { class: 'choice' },
      el('input', { type: 'radio', name: 'cancel-reason', value: id, checked: cancelReason === id, onchange: () => { cancelReason = id; ui.rerender(); } }),
      el('span', { text: reasonJa(id) }));
    return [
      ...tripMast(trip, '中止にする', ui),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, '理由'),
        el('div', { class: 'choices' }, S().CANCEL_REASONS.map(reason))),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, '知らせる先', el('small', { text: `${1 + shops.length} 店・${own + shops.reduce((n, x) => n + x.n, 0)} 人` })),
        el('ul', { class: 'bks bks--sheet' },
          el('li', { class: 'bk' }, el('span', { class: 'bk__name', text: 'この店のお客さん' }), el('span', { class: 'st', text: `${own} 人` })),
          shops.map(x => el('li', { class: 'bk' }, el('span', { class: 'bk__name', text: x.shop }), el('span', { class: 'st', text: `${x.n} 人` }),
            el('span', { class: 'bk__meta', text: `お店${x.guide ? `とガイド ${x.guide}` : ''}へ。お客さんへはお店から` }))))),
      el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, '届く文'), el('p', { class: 'cancel__msg', text })),
      el('p', { class: 'note', text: '試作では送らず、相乗りのお店の画面とお客さんのページに出ます。本物ではメールか LINE で送ります。' }),
      ui.dock(
        el('button', { class: 'btn btn--warn', type: 'button', text: '中止を知らせる', onclick: go }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'やめる', onclick: () => ui.go('day', { tripId }) }))
    ];
  }

  /* ---------- 血中酸素（県警の体調チェック表。判定は roster-day.js、数値と言葉は data-sipe.js） ---------- */
  function sipeRow(tripId, ui) {
    const g = D().sipeRows(R.rosterStore.get(), tripId);
    if (!g || !g.rows.length) return null;
    return el('div', { class: 'pickrow pickrow--act' },
      el('span', { class: 'rd__k', text: '血中酸素' }),
      el('span', { class: 'pickrow__v' }, el('b', { class: 'fig', text: `${g.measured}/${g.rows.length}` }), ' 測った',
        g.high.length ? el('span', { class: 'sum__hi' }, '　! 高リスク ', el('b', { class: 'fig', text: String(g.high.length) })) : null),
      button('入れる', () => ui.go('spo2', { tripId })));
  }

  let thirdTrip = '';   // 3 本目の欄を開いた便
  const unitOf = (trip) => (trip.kind === 'snorkel' ? '回' : '本');
  const sideJa = (trip) => (trip.kind === 'snorkel' ? { pre: '入る前', post: '上がった後' } : { pre: '潜る前', post: '潜った後' });

  function whyText(w, unit) {
    return w.kind === 'notBack' ? `${w.dive} ${unit}目の前（${w.value}）が、${w.dive - 1} ${unit}目の後（${w.ref}）に戻っていない`
      : `${w.dive} ${unit}目の${w.side === 'pre' ? '前' : '後'}が ${w.value}（${SIPE().LOW} 以下）`;
  }

  /* 入れた数値を残す。残したあと描き直すので、次に押した欄（Tab や次の欄を押した先）にフォーカスを戻す。
     幅の外の数や数でない文字は、描き直さずに入れた文字を残し、その人の行の下に知らせてその欄に戻す（描き直すと前の値に戻り、打ち間違いに気付けない） */
  /* 残せなかった打ち間違い（欄の data-spo2 → 打った字）。ほかの欄を残して画面を描き直しても、消さずに出し直す */
  let spo2Bad = {};
  let spo2BadTrip = '';
  const badText = (text) => `${S().SPO2_MIN}〜${S().SPO2_MAX} の数で入れてください（入れたのは「${text.slice(0, 10)}」）。まだ残していません`;

  function saveSpo2(input, { id, dive, side, trip, ui }) {
    const text = input.value.normalize('NFKC').trim();
    const value = text === '' ? '' : /^\d{1,3}$/.test(text) ? Number(text) : NaN;
    const key = input.dataset.spo2;
    if (value !== '' && !(Number.isInteger(value) && value >= S().SPO2_MIN && value <= S().SPO2_MAX)) {
      spo2Bad = { ...spo2Bad, [key]: text };
      input.setAttribute('aria-invalid', 'true');
      const row = input.closest('.sp');
      const msg = row && (row.querySelector('.sp__bad') || row.appendChild(el('p', { class: 'sp__bad', role: 'alert' })));
      if (msg) msg.textContent = badText(text);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return;
    }
    spo2Bad = Object.fromEntries(Object.entries(spo2Bad).filter(([k]) => k !== key));
    setTimeout(() => {
      const next = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.spo2 : '';
      const r = ui.save(st => D().setSpo2(st, { id, dive, side, value, at: nowIso() }));
      ui.go('spo2', r.error ? { tripId: trip.id, warn: '入れられませんでした。もう一度入れてください' } : { tripId: trip.id, saved: r.saved });
      const again = next ? document.querySelector(`[data-spo2="${CSS.escape(next)}"]`) : null;
      if (again) again.focus();
    }, 0);
  }

  function spo2Row(r, { trip, dives, ui }) {
    const unit = unitOf(trip);
    const side = sideJa(trip);
    const name = r.person.name || '名前の分からない人';
    /* 3 つ目の目安を比べられない本があれば「目安に当たらない」とは出さない */
    const st = r.risk.high ? ['check', '! 高リスク'] : r.risk.pending.length ? ['wait', `・${r.risk.pending[0] - 1} ${unit}目の後がまだ`]
      : r.risk.measured ? ['ok', '目安に当たらない'] : ['wait', '・まだ'];
    /* 血中酸素を残すことは、お客さんのページの同意の文（今の版）に入っている。前の版の同意か、まだ答えていない人は、測る前に口頭で確かめる */
    const agreed = r.person.health.consentVer === R.rosterGuest.CONSENT_VER;
    const bads = Object.keys(spo2Bad).filter(k => k.startsWith(`${r.person.id}:`));
    const cell = (dive, s) => {
      const v = r.spo2[dive - 1][s];
      const hit = r.risk.why.some(w => w.dive === dive && w.side === s);
      const key = `${r.person.id}:${dive}:${s}`;
      const bad = Object.prototype.hasOwnProperty.call(spo2Bad, key) ? spo2Bad[key] : null;
      return el('input', { class: hit ? 'input sp__in sp__in--hi' : 'input sp__in', type: 'text', inputmode: 'numeric', maxlength: 3,
        autocomplete: 'off', value: bad !== null ? bad : v === '' ? '' : String(v), 'data-spo2': key, 'aria-invalid': bad !== null ? 'true' : null,
        'aria-label': `${name} ${dive} ${unit}目 ${side[s]}${hit ? '（高リスクの目安）' : ''}`,
        onchange: (e) => saveSpo2(e.target, { id: r.person.id, dive, side: s, trip, ui }) });
    };
    return el('div', { class: 'sp' },
      el('div', { class: 'sp__head' }, el('span', { class: 'sp__name' }, name, ageChip(r.person, trip)), el('span', { class: `st st--${st[0]}`, text: st[1] })),
      agreed ? null : el('p', { class: 'sp__note', text: '血中酸素を残す同意がまだです（同意の文が前の版か、まだ答えていない）。入れる前に口頭で確かめてください' }),
      el('div', { class: 'sp__grid', role: 'group', 'aria-label': name },
        el('span'), el('span', { class: 'sp__h', text: side.pre }), el('span', { class: 'sp__h', text: side.post }),
        dives.map(d => [el('span', { class: 'sp__n', text: `${d} ${unit}目` }), cell(d, 'pre'), cell(d, 'post')])),
      r.risk.why.length ? el('p', { class: 'sp__why', text: r.risk.why.map(w => whyText(w, unit)).join('。') }) : null,
      bads.length ? el('p', { class: 'sp__bad', role: 'alert', text: badText(spo2Bad[bads[0]]) }) : null);
  }

  function renderSpo2({ tripId, ui }) {
    const g = D().sipeRows(R.rosterStore.get(), tripId);
    if (!g) return [...ui.head('血中酸素'), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];
    const { trip } = g;
    if (tripId !== spo2BadTrip) { spo2Bad = {}; spo2BadTrip = tripId; }
    if (g.shown >= S().SPO2_DIVES) thirdTrip = tripId;   // 3 本目の数値を消しても、入力の途中で欄ごと消さない
    const count = Math.max(g.shown, thirdTrip === tripId ? S().SPO2_DIVES : 0);
    const dives = Array.from({ length: count }, (_, i) => i + 1);
    const unit = unitOf(trip);
    const care = [el('p', { text: SIPE().emergency }), el('ul', {}, SIPE().care.map(c => el('li', { text: c })))];
    return [
      ...tripMast(trip, '血中酸素', ui),
      el('p', { class: 'note', text: '指先の機器（パルスオキシメーター）で測った数値を入れます' }),
      g.high.length ? el('div', { class: 'act' },
        el('p', { class: 'act__title', text: `! 高リスクの目安の人がいます（${g.high.map(r => r.person.name || '名前の分からない人').join('・')}）` }),
        el('p', { text: SIPE().stop }), care)
        : el('details', { class: 'sheet known' }, el('summary', { text: `症状があって ${SIPE().LOW} 以下になったら` }), el('div', { class: 'act act--plain' }, care)),
      g.rows.length ? el('div', { class: 'sheet' }, g.rows.map(r => spo2Row(r, { trip, dives, ui })))
        : el('p', { class: 'note', text: 'この便には、このお店のお客さんがまだいません。' }),
      count < S().SPO2_DIVES && g.rows.length
        ? el('p', { class: 'reset' }, button(`${count + 1} ${unit}目の欄を出す`, () => { thirdTrip = tripId; ui.rerender(); })) : null,
      el('p', { class: 'note', text: `目安（県警の表）: 1 ${unit}目の前が ${SIPE().LOW} 以下、後が ${SIPE().LOW} 以下、次の前が直前の後より低い、のどれかで高リスク。参加できるかはお店が決めます。` }),
      el('p', { class: 'note', text: trip.partners.length
        ? '数値は健康の欄と同じで、このお店だけが見ます。乗り合いの他のお店のお客さんは、そのお店のガイドが測ります（この店には来ません）。'
        : '数値は健康の欄と同じで、このお店だけが見ます。' }),
      el('p', { class: 'note', text: `出典: ${SIPE().source}` }),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '今日の名簿に戻る', onclick: () => ui.go('day', { tripId }) }))
    ];
  }

  /* ---------- 条例の名簿（印刷） ---------- */
  /* opt: 相乗りのお店に返す名簿なら { shop, guide, paper: 'partner' }（事業者とガイドをそのお店にする） */
  function paper(s, trip, table, opt = {}) {
    const law = LAW[trip.kind];
    const notDone = table.rows.filter(r => !r.done).length;
    const label = (key) => table.items.find(i => i.key === key).ja;
    const meta = [['事業者', opt.shop || s.shop.name], [label('when'), `${slash(trip.date)} ${trip.start ? clock(trip.start) : ''}`.trim()],
      [label('site'), trip.site || '—'], [label('guide'), (opt.shop ? opt.guide : trip.guides.join('・')) || '—'], ['人数', String(table.rows.length)]];
    return el('section', { class: 'paper', 'aria-label': law.title, 'data-trip': trip.id, 'data-people': String(table.rows.length),
      'data-paper': opt.paper || null, 'data-health': opt.paper ? 'false' : null },
      el('h3', { class: 'paper__title', text: law.title }),
      el('p', { class: 'paper__meta' }, meta.map(([k, v]) => el('span', {}, `${k} `, el('b', { text: v })))),
      notDone ? el('p', { class: 'paper__warn', text: `まだそろっていない人が ${notDone} 人います（— の欄）。そろってから印刷し直してください。` }) : null,
      el('div', { class: 'paper__wrap' }, el('table', { class: 'paper__table' },
        el('thead', {}, el('tr', {}, table.items.map(i => el('th', { scope: 'col', text: i.ja })))),
        el('tbody', {}, table.rows.map(r => el('tr', {}, table.items.map(i => el('td', { class: r.cells[i.key] ? null : 'paper__none', text: r.cells[i.key] || '—' }))))))),
      el('p', { class: 'paper__foot' },
        el('span', { text: `この名簿は ${slash(C().keepUntil(trip.date))} まで残す（作成の日から 1 年。${law.rule}）` }),
        el('span', { text: `印刷 ${shortTime(nowIso())}　見る人はこのお店の人だけ（乗り合いの便でも、同じ船の他のお店には見せない）。健康の欄は人に見せない` })));
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
  const PAPER_JA = { joint: '合同名簿', board: '札ボード', partner: '相乗りのお店の名簿' };
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
      aboard: `ポイントを離れる前: 全員戻った（札 ${e.after.tags} 枚）`,
      cancel: `便を中止にした（${reasonJa(e.after.reason)}）`, reopen: '中止を取り消した', ack: `${e.after.shop}が中止を確かめた`
    }[e.act] || e.act;
    /* 便の項目（潜水場所・ガイド）だけは前と後を出す。人の中身（健康の答えなど）は出さない */
    const tripValues = e.kind === 'trip' && e.act === 'edit'
      ? e.fields.map(f => `${[].concat(e.before[f] || '—').join('・') || '—'} → ${[].concat(e.after[f] || '—').join('・') || '—'}`).join('　') : '';
    const sub = [tripValues, e.kind === 'person' && e.act === 'edit' ? '中身は名簿の画面で見る' : '', e.demo ? (e.after && e.after.health && e.after.health.heldBy ? '見本: 便の日にそのお店が確かめたことにした' : 'デモで当日として答えた') : ''].filter(Boolean).join('　');
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

  R.dayRoster = { LAW, renderDay, renderSpo2, renderCancel, renderPrint, renderIcs, renderLog, paper, tripMast };
})();
