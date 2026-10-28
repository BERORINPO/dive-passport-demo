/* お店の画面: 乗り合い（船・乗るお店）/ 他のお店役で入れる / 合同名簿 / 合同名簿の印刷 / 船の上（お店ごとに全員戻った）/ 人数が合わないとき。
   予約の画面（booking.js）から開く。決まりは js/roster-share.js。他のお店が写真で名前を渡す画面は js/partner-photo.js。
   試作では、他のお店の分もこの端末の中で入れる（そのお店「役」に切り替える）。2 台のあいだのやりとりは後で（plan/meibo.md） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const C = () => R.rosterCore;
  const X = () => R.rosterShare;
  const healthShort = () => R.HEALTH.map(q => q.short);

  const SHOP_PROBLEM_JA = { empty: 'お店の名前を入れてください', long: 'お店の名前は 60 字までです', same: 'もう入っているお店です', many: '乗り合いのお店は 10 店までです' };
  const GUIDE_FIRST = 'ガイドの名前を先に入れてください（40 字まで）';
  const SAMPLE_SHOP = 'C ダイブ（見本）';
  const SAMPLE_GUIDE = '見本 三郎';
  const PRINT_ARM_MS = 700;       // 印刷のボタンが出てすぐの押し（前の画面のボタンを続けて押した物）は受け付けない間
  const ADD_PROBLEM_JA = { shop: 'このお店は乗り合いから外れています。乗り合いの画面で足してください' };
  const BOAT_PROBLEM_JA = { waiting: 'まだ戻っていないお店があります', empty: 'まだ誰も乗っていません', shop: 'このお店は、この便に乗っていません',
    person: 'この人は、このお店のお客さんではありません' };

  /* 入れかけの文字（画面を描き直しても消さない）。便とお店が替わったら空に戻す */
  let draft = blankDraft('');
  function blankDraft(key) { return { key, shop: '', name: '', guide: '' }; }
  const draftFor = (key) => { if (draft.key !== key) draft = blankDraft(key); return draft; };

  const nowIso = () => new Date().toISOString();
  const slash = (d) => d.replace(/-/g, '/');
  const clock = (t) => t.replace(/^0/, '');
  const hm = (iso) => { const d = new Date(iso); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const shortTime = (iso) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`; };
  const button = (text, onclick, cls) => el('button', { class: cls || 'linkbtn', type: 'button', text, onclick });
  const when = (ui, trip) => `${ui.md(trip.date)} ${trip.start ? clock(trip.start) : '時刻未定'}`;
  const notFound = (ui, title) => [...ui.head(title), el('p', { class: 'errors', text: 'この便が見つかりません。' }), ui.back()];

  /* 保存して描き直す。fn は state か { state, problem } を返す。problem があれば、state は変えずに知らせる。
     onOk は保存できたときだけ呼ぶ（入れかけの文字を空にするなど。失敗したら打った字を残す） */
  function apply(ui, fn, next, problemText, onOk) {
    let problem = null;
    const r = ui.save(st => {
      const out = fn(st);
      if (out && out.state) { problem = out.problem || null; return out.state; }
      return out;
    });
    if (r.error) return ui.go(next.mode, { ...next.ctx, warn: '入れられませんでした。長すぎないか確かめてください' });
    if (problem) return ui.go(next.mode, { ...next.ctx, warn: problemText(problem) });
    if (onOk) onOk();
    return ui.go(next.mode, { ...next.ctx, saved: r.saved });
  }

  /* 人の状態の短い字（名簿のそろい具合） */
  function personState(m, trip) {
    const total = R.roster.ITEMS[trip.kind].length;
    if (m.status.done) return ['ok', '✓ そろった'];
    if (m.status.unsure.length) return ['check', '! 確かめる'];
    return ['wait', `・名簿 ${total - m.status.missing.length}/${total}`];
  }
  const missingText = (m, trip) => {
    const items = R.roster.ITEMS[trip.kind];
    const keys = m.status.missing.filter(k => !items.find(i => i.key === k).trip);
    return keys.length ? `まだ: ${keys.map(k => items.find(i => i.key === k).ja).join('・')}` : '';
  };

  /* ---------- 乗り合い（船と乗るお店） ---------- */
  /* そろい具合は、船に要る合同名簿の 5 項目で見る（他のお店のお客さんの条例の名簿は、そのお店が作る。船の店は 13 項目を持たない） */
  function partnerLine(group, g, ui) {
    const tripId = g.trip.id;
    const people = group.members.filter(m => m.kind === 'person');
    const s = R.rosterStore.get();
    const rows = (X().jointRows(s, tripId).groups.find(x => x.name === group.name) || { rows: [] }).rows;
    const blank = rows.filter(r => r.blank > 0).length;
    const guide = X().partnerGuide(s, tripId, group.name);
    const cancel = g.trip.cancel;   // 中止したら、そのお店が確かめたかを出す（名簿のそろい具合より先に知りたいこと）
    const st = cancel ? (cancel.acked.includes(group.name) ? ['ok', '✓ 中止を確かめた'] : ['check', '! 中止をまだ見ていない'])
      : !people.length ? ['wait', '・まだ 0 人'] : blank ? ['wait', `・空の欄 ${blank} 人`] : ['ok', '✓ そろった'];
    const health = people.length ? `健康の 2 欄は${group.name}が確かめる` : '';
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: group.name }),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: [`${people.length} 人`, guide ? `ガイド ${guide}` : '', health].filter(Boolean).join('・') }),
      button(`${group.name}役で入れる（この端末で）`, () => ui.go('partner', { tripId, shop: group.name })),
      people.length ? null : button('外す', () => apply(ui, st2 => X().removePartner(st2, { tripId, name: group.name, at: nowIso() }),
        { mode: 'share', ctx: { tripId } }, () => '人のいるお店は外せません'), 'linkbtn linkbtn--muted'));
  }

  function addShopRow(trip, ui) {
    const d = draftFor(`share:${trip.id}`);
    const add = (name, onOk) => apply(ui, st => X().addPartner(st, { tripId: trip.id, name, at: nowIso() }),
      { mode: 'share', ctx: { tripId: trip.id } }, (p) => SHOP_PROBLEM_JA[p] || p, onOk);
    return [
      el('div', { class: 'addrow' },
        el('input', { class: 'input', type: 'text', maxlength: 60, 'aria-label': '足すお店の名前', placeholder: 'お店の名前', value: d.shop,
          oninput: (e) => { d.shop = e.target.value; } }),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'お店を足す', onclick: () => add(d.shop, () => { d.shop = ''; }) })),
      /* 見本のお店は、サーバーにつながっていない試作だけ（本物の名簿に架空のお店を混ぜない。ジンのレビュー 2026-10-28 H9） */
      R.rosterStore.synced() || trip.partners.includes(SAMPLE_SHOP) ? null
        : el('p', { class: 'sheet__note' }, button(`見本のお店（${SAMPLE_SHOP}）を足す`, () => add(SAMPLE_SHOP)))
    ];
  }

  function renderShare({ tripId, ui }) {
    const s = R.rosterStore.get();
    const g = X().boatGroups(s, tripId);
    if (!g) return notFound(ui, '乗り合い');
    const { trip } = g;
    const partners = g.groups.filter(x => !x.own);
    const setBoat = (boat) => apply(ui, st => C().editTrip(st, { tripId, patch: { boat }, at: nowIso() }), { mode: 'share', ctx: { tripId } }, String);
    const setHost = (host) => apply(ui, st => X().setHost(st, { tripId, host, at: nowIso() }), { mode: 'share', ctx: { tripId } }, () => '乗り合いのお店から選んでください');
    return [
      ...ui.head('乗り合い', `${ui.md(trip.date)} ${ui.tripLabel(trip)}`),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title', text: '船' }),
        el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: '船' }),
          el('input', { class: 'input', type: 'text', maxlength: 40, value: trip.boat, placeholder: '例: サンプル丸', onchange: (e) => setBoat(e.target.value) })),
        el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: '船を出す店' }),
          el('select', { class: 'input', onchange: (e) => setHost(e.target.value) },
            el('option', { value: '', selected: trip.host === '', text: `この店（${s.shop.name}）` }),
            trip.partners.map(name => el('option', { value: name, selected: trip.host === name, text: name }))))),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '同じ船に乗るお店', el('small', { text: `${partners.length} 店` })),
        partners.length ? el('ul', { class: 'bks bks--sheet' }, partners.map(group => partnerLine(group, g, ui))) : null,
        ...addShopRow(trip, ui),
        el('p', { class: 'sheet__note', text: '試作では、他のお店の分もこの端末で入れます。2 台のあいだのやりとりは後で作ります。' })),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title', text: 'この船に乗る人' }),
        el('div', { class: 'sum' },
          g.groups.map(x => [el('span', { text: `${x.name}　お客さん ${x.people}・ガイド ${x.guides}` }), el('b', { text: String(x.members.length) })]),
          el('span', { class: 'sum__all', text: '合わせて（ガイドも）' }), el('b', { class: 'sum__all', text: String(g.aboard) }))),
      ui.back(),
      ui.dock(
        el('button', { class: 'btn', type: 'button', text: '合同名簿を見る', onclick: () => ui.go('joint', { tripId }) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '船の上で（お店ごとに戻った）', onclick: () => ui.go('boat', { tripId }) }))
    ];
  }

  /* ---------- 他のお店役で入れる ---------- */
  function partnerPersonLine(m, trip, ui) {
    const st = personState(m, trip);
    const ask = C().askGuest(m.person, trip);
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: m.name || '名前の分からない人' }),
      el('span', { class: `st st--${st[0]}`, text: st[1] }),
      el('span', { class: 'bk__meta', text: [m.label, missingText(m, trip)].filter(Boolean).join('　') }),
      ask.length ? button('お客さんに聞く', () => ui.go('ask', { bookingId: m.person.bookingId })) : null);
  }

  /* 他のお店役: 乗せる人（ガイドと人）の面 */
  function partnerPeopleSheet(v, ui) {
    const { tripId, shop, people, d, guide } = v;
    const add = (list, onOk) => apply(ui, st => X().addPartnerPeople(st, { tripId, shop, people: list, guide, at: nowIso(), newId: R.newId }),
      v.back, (p) => ADD_PROBLEM_JA[p] || GUIDE_FIRST, onOk);
    const setGuide = (value) => {
      if (!people.length) { d.guide = value.trim(); ui.rerender(); return; }
      apply(ui, st => X().setPartnerGuide(st, { tripId, shop, guide: value, at: nowIso() }), v.back, () => GUIDE_FIRST);
    };
    const addOne = () => {
      const name = d.name.trim();
      if (!name) return;
      if (!guide) { ui.go('partner', { tripId, shop, warn: GUIDE_FIRST }); return; }
      add([{ name }], () => { d.name = ''; });
    };
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, '乗せる人', el('small', { text: `${people.length} 人` })),
      el('label', { class: 'pickrow' }, el('span', { class: 'rd__k', text: 'ガイド' }),
        el('input', { class: 'input', type: 'text', maxlength: 40, value: guide, placeholder: `例: ${SAMPLE_GUIDE}`, onchange: (e) => setGuide(e.target.value) })),
      people.length ? el('ul', { class: 'bks bks--sheet' }, people.map(m => partnerPersonLine(m, v.trip, ui))) : null,
      el('div', { class: 'addrow' },
        el('input', { class: 'input', type: 'text', maxlength: 60, 'aria-label': '足す人の名前', placeholder: '名前（イニシャルでもよい）', value: d.name,
          oninput: (e) => { d.name = e.target.value; } }),
        el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: '1 人足す', onclick: addOne })),
      el('p', { class: 'sheet__note', text: 'ふだんは下の「写真で名前を渡す」で。予約の一覧か紙の名簿を 1 枚撮ると、AI が名前を読みます。' }));
  }

  /* 他のお店役: 健康の 2 欄は渡さない、という知らせ（選ぶ所は無い） */
  function partnerHealthSheet(v, others) {
    const { shop } = v;
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title', text: '健康の 2 欄（既往症・当日の健康状態）' }),
      el('p', { class: 'sheet__note', text: `${shop}が自分で確かめます。同じ船のお店（${others}）には渡しません。名簿には「${shop}が確かめた」とだけ出ます。当日の体調は、便の日に「渡す」を押したら確かめた扱いになります。` }));
  }

  function renderPartner({ tripId, shop, ui }) {
    const s = R.rosterStore.get();
    const g = X().boatGroups(s, tripId);
    if (!g) return notFound(ui, '乗せる人');
    const group = g.groups.find(x => !x.own && x.key === shop);   // 乗り合いから外れても人の残っているお店は、ここで直せる
    if (!group) {
      return [...ui.head('乗せる人'), el('p', { class: 'errors', text: 'このお店は乗り合いに入っていません。' }),
        el('p', { class: 'reset' }, button('乗り合いに戻る', () => ui.go('share', { tripId }), 'linkbtn linkbtn--muted'))];
    }
    const { trip } = g;
    const people = group.members.filter(m => m.kind === 'person');
    const d = draftFor(`partner:${tripId}:${shop}`);
    const v = { tripId, shop, trip, people, d, back: { mode: 'partner', ctx: { tripId, shop } },
      guide: X().partnerGuide(s, tripId, shop) || d.guide };
    const others = g.groups.filter(x => x.key !== shop).map(x => x.name).join('・');
    const owner = X().boatOwner(s, trip);
    const handOver = () => {
      const r = ui.save(st => X().handOver(st, { tripId, shop, today: R.today(), at: nowIso() }));
      if (r.error) { ui.go('partner', { tripId, shop, warn: '渡せませんでした。もう一度押してください' }); return; }
      ui.go('share', { tripId, saved: r.saved, notice: `${shop}から ${people.length} 人を受け取りました（健康の 2 欄は${shop}が確かめる）` });
    };
    const [, ...head] = ui.head(owner === shop ? '自分の船に乗せる人' : `${owner}の船に乗せる人`, `${when(ui, trip)}　${trip.boat || ''}`.trim());
    const acked = !!trip.cancel && trip.cancel.acked.includes(shop);
    const ack = () => {
      const r = ui.save(st => C().ackCancel(st, { tripId, shop, at: nowIso() }));
      const took = !r.error && (R.rosterStore.get().trips.find(t => t.id === tripId).cancel || { acked: [] }).acked.includes(shop);
      ui.go('partner', took ? { tripId, shop, saved: r.saved, notice: `${owner}に「確かめた」と返しました` }
        : { tripId, shop, warn: r.error ? '記録できませんでした。もう一度押してください' : 'このお店は乗り合いから外れているので、確かめを返せません' });
    };
    return [
      roleFlag(shop, () => ui.go('share', { tripId })),
      ...head,
      cancelAlert(trip, owner, people.length, acked),
      partnerPeopleSheet(v, ui),
      partnerHealthSheet(v, others),
      people.length ? el('p', { class: 'reset' }, button('名簿を受け取る（潜水日時・場所入り）', () => ui.go('partnerpaper', { tripId, shop }))) : null,
      trip.cancel && !acked
        ? ui.dock(el('button', { class: 'btn', type: 'button', text: '知らせた（確かめ済み）', onclick: ack }))
        : trip.cancel ? null
          : ui.dock(el('button', { class: 'btn', type: 'button', text: '写真で名前を渡す', onclick: () => ui.go('partnerphoto', { tripId, shop }) }),
            people.length ? el('button', { class: 'btn btn--ghost', type: 'button', text: `${s.shop.name}に渡す（${people.length} 人）`, onclick: handOver }) : null)
    ];
  }

  const roleFlag = (shop, back) => el('p', { class: 'flag flag--info roleflag' }, el('span', { text: `${shop}役で入れています` }), button('戻る', back));

  /* 船を出す店が中止にしたら、相乗りのお店の画面の上に出す。お客さんへの連絡はそのお店から（連絡先はそのお店が持つ） */
  function cancelAlert(trip, owner, n, acked) {
    if (!trip.cancel) return null;
    return el('div', { class: 'act' },
      el('p', { class: 'act__title', text: `! 中止になりました（${(R.roster.CANCEL_TEXT[trip.cancel.reason] || { ja: '' }).ja}）` }),
      el('p', { text: `${shortTime(trip.cancel.at)} に ${owner}から。お客さん ${n} 人への連絡は、このお店からお願いします。お客さんのページにも中止と出ます。` }),
      acked ? el('p', { class: 'act__done', text: '✓ 確かめたと返しました' }) : null);
  }

  /* ---------- 相乗りのお店に名簿を返す ---------- */
  const fileSafe = (name) => String(name).replace(/[\\/:*?"<>|\p{Cc}\u202A-\u202E\u2066-\u2069]/gu, '_');
  /* 船を出す店が持つ潜水日時・潜水場所と、そのお店のガイドを入れた、そのお店のお客さんだけの名簿。
     健康の 2 欄は船を出す店が持たないので「お店が記入」で返す（決定ログ partner-return） */
  function renderPartnerPaper({ tripId, shop, ui }) {
    const s = R.rosterStore.get();
    const trip = s.trips.find(t => t.id === tripId);
    if (!trip) return notFound(ui, '名簿を返す');
    if (!X().shopsOf(s, trip).some(x => !x.own && x.key === shop)) {
      return [...ui.head('名簿を返す'), el('p', { class: 'errors', text: 'このお店は乗り合いに入っていません。' }), ui.back()];
    }
    const table = C().rosterRows(s, tripId, [], { shop });   // 健康の 2 欄は「お店が記入」になるので、短い言い方は使わない
    const guide = X().partnerGuide(s, tripId, shop);
    const csv = () => {
      R.saveFile(`meibo-${fileSafe(shop)}-${trip.date}${trip.start ? `-${trip.start.replace(':', '')}` : ''}.csv`, C().toCsv(table), 'text/csv;charset=utf-8');
      const r = ui.save(st => C().logOutput(st, { tripId, act: 'csv', people: table.rows.length, health: false, paper: 'partner', at: nowIso() }));
      ui.go('partnerpaper', { tripId, shop, saved: r.saved, notice: `CSV に書き出しました（${table.rows.length} 人）。${shop}に渡したら消してください` });
    };
    return [
      roleFlag(shop, () => ui.go('partner', { tripId, shop })),
      ...ui.head(`${shop}の名簿`, `${when(ui, trip)}　${X().boatOwner(s, trip)}の${trip.boat || '船'}`).slice(1),
      el('p', { class: 'note', text: `船を出す店が持つ潜水日時・潜水場所と、${shop}のガイドを入れた、${shop}のお客さんだけの名簿です。健康の 2 欄は${shop}が自分で確かめて書きます。` }),
      R.dayRoster.paper(s, trip, table, { shop, guide, paper: 'partner' }),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '名簿を印刷', onclick: () => window.print() }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: 'CSV', onclick: csv }))
    ];
  }

  /* ---------- 合同名簿 ---------- */
  function memberRow(m, trip) {
    const st = m.kind === 'person' && !m.status.done ? personState(m, trip) : null;
    return el('div', { class: 'tagrow' },
      el('span', { text: m.name || '名前の分からない人' }),
      st ? el('span', { class: `st st--${st[0]}`, text: st[1] }) : el('small', { text: m.label }));
  }

  function renderJoint({ tripId, ui }) {
    const g = X().boatGroups(R.rosterStore.get(), tripId);
    if (!g) return notFound(ui, '合同名簿');
    const { trip } = g;
    return [
      ...ui.head('合同名簿', `${when(ui, trip)}　${trip.boat || ''}　${g.groups.length} 店・${g.aboard} 人`.replace(/　　/g, '　')),
      g.groups.map(group => el('div', { class: 'sheet' },
        el('p', { class: 'shophead' }, el('span', { text: `${group.name}${group.owner ? '　この船' : ''}` }), el('span', { text: `${group.members.length} 人` })),
        group.members.length ? group.members.map(m => memberRow(m, trip)) : el('p', { class: 'sheet__note', text: 'まだいません。' }))),
      el('p', { class: 'reset' }, button('乗り合いに戻る', () => ui.go('share', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(el('button', { class: 'btn', type: 'button', text: '船の上で（お店ごとに戻った）', onclick: () => ui.go('boat', { tripId }) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '合同名簿を印刷', onclick: () => ui.go('jointprint', { tripId }) }))
    ];
  }

  /* ---------- 合同名簿（印刷） ---------- */
  /* 船の上で使う確認用の紙。条例の名簿は、お店ごとに自分のお客さんの分を今日の名簿から作る（決定ログ own-roster） */
  const JOINT_TITLE = '合同名簿（船の上の確認用）';
  function jointPaper(j) {
    const { trip, items } = j;
    const law = R.dayRoster.LAW[trip.kind];
    const label = (key) => R.roster.ITEMS[trip.kind].find(i => i.key === key).ja;   // 上の欄（日時・場所）の見出しは、条例の項目の名前
    const notDone = j.groups.reduce((n, x) => n + x.rows.filter(r => r.blank > 0).length, 0);
    const riders = j.groups.filter(x => x.name !== j.owner).map(x => x.name).join('・') || '—';
    const meta = [['船', trip.boat || '—'], ['船を出す店', j.owner], ['乗る店', riders],
      [label('when'), `${slash(trip.date)} ${trip.start ? clock(trip.start) : ''}`.trim()], [label('site'), trip.site || '—'],
      ['人数', `${j.people}（ガイド ${j.guides} 人を除く）`]];
    const cell = (v) => el('td', { class: v ? null : 'paper__none', text: v || '—' });
    return el('section', { class: 'paper', 'aria-label': JOINT_TITLE, 'data-trip': trip.id, 'data-people': String(j.people), 'data-paper': 'joint', 'data-health': 'false' },
      el('h3', { class: 'paper__title', text: JOINT_TITLE }),
      el('p', { class: 'paper__meta' }, meta.map(([k, v]) => el('span', {}, `${k} `, el('b', { text: v })))),
      notDone ? el('p', { class: 'paper__warn', text: `空の欄（—）がある人が ${notDone} 人います。そろってから印刷し直してください。` }) : null,
      el('div', { class: 'paper__wrap' }, el('table', { class: 'paper__table' },
        el('thead', {}, el('tr', {}, items.map(i => el('th', { scope: 'col', class: `paper__col--${i.key}`, text: i.ja })))),
        el('tbody', {}, j.groups.flatMap(x => [
          el('tr', { class: 'paper__shop' }, el('td', { colspan: String(items.length), text: `${x.name}　お客さん ${x.rows.length} 人` })),
          ...x.rows.map(r => el('tr', {}, items.map(i => cell(r.cells[i.key]))))
        ])))),
      el('p', { class: 'paper__foot' },
        el('span', { text: `住所・生年月日などを含む条例の${law.title}（${R.roster.ITEMS[trip.kind].length} 項目）は、お店ごとに自分のお客さんの分を作る（今日の名簿から印刷）` }),
        el('span', { text: `印刷 ${shortTime(nowIso())}　見る人はこの船のお店の人だけ。健康の欄は載せない（お店ごとに確かめる）` })));
  }

  function renderJointPrint({ tripId, ui }) {
    const s = R.rosterStore.get();
    const j = X().jointRows(s, tripId);
    if (!j) return notFound(ui, '合同名簿');
    return [
      ...ui.head(JOINT_TITLE, `${when(ui, j.trip)}。印刷の画面で「PDF に保存」も選べます`),
      jointPaper(j),
      el('p', { class: 'reset' }, button('合同名簿に戻る', () => ui.go('joint', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(printButton())
    ];
  }

  /* 印刷のボタン。前の画面の帯のボタン（同じ所にある「合同名簿を印刷」）を続けて押したとき、このボタンで印刷の画面を開かない */
  function printButton() {
    const shownAt = Date.now();
    return el('button', { class: 'btn', type: 'button', text: '印刷する', onclick: () => { if (Date.now() - shownAt >= PRINT_ARM_MS) window.print(); } });
  }

  /* ---------- 船の上: お店ごとに「全員戻った」（決定ログ photo-shopcheck） ---------- */
  /* 便の画面の見出し（design.md の形）。左に便の時刻を大きく、右に日付と、その画面の便や人を示す 1 行 */
  function boatMast(trip, title, ui, line, backText, backTo) {
    const [, h2, , notice] = ui.head(title);
    h2.classList.add('sr-only');
    return [
      el('p', { class: 'tripnav' }, button(backText, backTo), el('span', { text: R.rosterStore.get().shop.name })),
      h2,
      el('div', { class: 'mast' },
        el('span', { class: 'mast__t', text: trip.start ? clock(trip.start) : '—' }),
        el('span', { class: 'mast__d', text: ui.md(trip.date) }),
        el('span', { class: 'mast__w', text: line })),
      notice
    ];
  }
  const guidesText = (x) => (x.guides.length ? `ガイド ${x.guides.join('・')}` : 'ガイドまだ');

  /* ガイドが口で「全員戻りました」と伝えたら、そのお店を 1 回押す。全部のお店が戻るまで、ポイントを離れられない */
  function backLine(x, r, ui) {
    const tripId = r.trip.id;
    const go = (fn) => apply(ui, st => fn(st, { tripId, shop: x.key, at: nowIso() }), { mode: 'boat', ctx: { tripId } }, (p) => BOAT_PROBLEM_JA[p] || p);
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: x.own ? `${x.name}（この店）` : x.name }),
      x.backAt ? el('span', { class: 'st st--ok', text: `✓ ${hm(x.backAt)}` })
        : el('button', { class: 'btn btn--small', type: 'button', text: '全員戻った', onclick: () => go(X().recordReturn) }),
      el('span', { class: 'bk__meta', text: `${x.people.length} 人・${guidesText(x)}${x.backAt ? '' : '・まだ'}` }),
      x.backAt ? button('押し間違いを取り消す', () => go(X().undoReturn), 'linkbtn linkbtn--muted')
        : button('人数が合わない', () => ui.go('callout', { tripId, shop: x.key })));
  }

  function renderBoat({ tripId, ui }) {
    const r = X().returns(R.rosterStore.get(), tripId);
    if (!r) return notFound(ui, '船の上');
    const { trip } = r;
    const back = r.shops.length - r.waiting.length;
    const leave = () => {
      let problem = null;
      const at = nowIso();
      const out = ui.save(st => { const x = X().recordLeave(st, { tripId, at }); problem = x.problem; return x.state; });
      if (out.error) { ui.go('boat', { tripId, warn: '記録できませんでした。もう一度押してください' }); return; }
      if (problem) { ui.go('boat', { tripId, warn: BOAT_PROBLEM_JA[problem] || problem }); return; }
      ui.go('boat', { tripId, saved: out.saved, notice: `${r.dive} 本目のポイントを離れました（${hm(at)}、${r.shops.length} 店・${r.people} 人）` });
    };
    return [
      ...boatMast(trip, '船の上', ui, `${r.dive} 本目・${trip.site || '場所まだ'}　${r.people} 人・${r.shops.length} 店`, '← 乗り合い', () => ui.go('share', { tripId })),
      el('h3', { class: 'subhead' }, '戻ったお店', el('span', { text: `${back} / ${r.shops.length}` })),
      r.shops.length ? el('ul', { class: 'bks backs' }, r.shops.map(x => backLine(x, r, ui)))
        : el('p', { class: 'empty', text: 'まだ誰も乗っていません。' }),
      X().leaves(trip).length ? [
        el('h3', { class: 'subhead', text: 'この便の記録' }),
        X().leaves(trip).map((c, i) => el('div', { class: 'logrow' }, el('time', { datetime: c.at, text: hm(c.at) }),
          el('span', { text: `${c.dive || i + 1} 本目　${c.tags === undefined ? '全部のお店が戻って、ポイントを離れた' : `札で数えて離れた（札 ${c.tags} 枚）`}` })))
      ] : null,
      el('p', { class: 'reset' }, button('合同名簿を見る', () => ui.go('joint', { tripId }), 'linkbtn linkbtn--muted')),
      ui.dock(
        r.waiting.length ? el('p', { class: 'errors', text: `まだ ${r.waiting.length} 店: ${r.waiting.map(x => x.name).join('・')}` }) : null,
        el('button', { class: 'btn', type: 'button', disabled: !r.allBack, text: 'ポイントを離れる', onclick: leave }))
    ];
  }

  /* 人数が合わないときだけ、そのお店のお客さんの名前を呼んで「いた」を押す。全員いたら、そのお店を戻ったにする */
  function renderCallout({ tripId, shop, ui }) {
    const r = X().returns(R.rosterStore.get(), tripId);
    if (!r) return notFound(ui, '名前を呼ぶ');
    const x = r.shops.find(y => y.key === shop);
    if (!x) return [...ui.head('名前を呼ぶ'), el('p', { class: 'errors', text: BOAT_PROBLEM_JA.shop }), ui.back()];
    const here = (personId) => apply(ui, st => X().recordHere(st, { tripId, shop, personId, at: nowIso() }), { mode: 'callout', ctx: { tripId, shop } }, (p) => BOAT_PROBLEM_JA[p] || p);
    const allHere = () => apply(ui, st => X().recordReturn(st, { tripId, shop, at: nowIso() }), { mode: 'boat', ctx: { tripId, notice: `${x.name}: 全員いました` } }, (p) => BOAT_PROBLEM_JA[p] || p);
    const left = x.people.filter(m => !x.here.has(m.person.id));
    return [
      ...boatMast(r.trip, '名前を呼ぶ', ui, `${x.name}　${x.people.length} 人・${guidesText(x)}`, '← 戻ったお店', () => ui.go('boat', { tripId })),
      el('div', { class: 'act' },
        el('p', { class: 'act__title', text: '! 人数が合わないとき' }),
        el('p', { text: '名前を呼んで、いた人を押す。見つからなければ、すぐ 118（海上保安庁）に電話する。' })),
      el('h3', { class: 'subhead' }, '名前を呼ぶ', el('span', { text: `${x.here.size} / ${x.people.length}` })),
      el('ul', { class: 'bks backs' }, x.people.map(m => el('li', { class: 'bk' },
        el('span', { class: 'bk__name', text: m.name || '名前の分からない人' }),
        x.here.has(m.person.id) ? el('span', { class: 'st st--ok', text: '✓ いた' })
          : el('button', { class: 'btn btn--small', type: 'button', text: 'いた', onclick: () => here(m.person.id) }),
        el('span', { class: 'bk__meta', text: m.label })))),
      ui.dock(
        left.length ? el('p', { class: 'errors', text: `まだ ${left.length} 人: ${left.map(m => m.name || '名前の分からない人').join('・')}` }) : null,
        el('button', { class: 'btn', type: 'button', disabled: left.length > 0, text: `全員いた（${x.people.length} 人）`, onclick: allHere }))
    ];
  }

  R.shareRoster = { renderShare, renderPartner, renderPartnerPaper, renderJoint, renderJointPrint, renderBoat, renderCallout };
})();
