/* 店頭の QR のお店の画面（entry、日本語のみ）。予約の画面（booking.js）から開く。決定ログ 2026-10-28 walkin-qr。
   - 店頭の QR を作る: Worker が鍵を作り（サーバーには SHA-256 だけ）、この画面で A5 の貼り紙に QR を出して印刷する。鍵つきの URL が出るのは作った 1 回だけ
   - 店頭で入れた人: 来店したお客さんが QR から入れた物（Worker が名簿と同じ検査を通して置いた物。名簿の本体には、まだ入っていない）。
     「その予約にまとめる」「便を選んで入れる」は名簿の直しの記録（op log。guest.mergeWalkin・guest.addWalkin）を通すので、電波が無くても貯めて送る。
     「入れない」と、入れたあとの行の削除は js/roster-sync.js（入れたときは、名簿の直しがサーバーに届いてから消す）
   お客さんの文字は el() の text で出す（HTML として入れない） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const G = () => R.rosterGuest;
  const REFRESH_MS = 60000;
  const KIND_JA = { dive: 'ダイビング', snorkel: 'スノーケル' };

  /* items: null（まだ読んでいない）/ 一覧。poster: 作った QR { url, at }（この画面を読み込み直すと消える。鍵はサーバーに SHA-256 しか無いので出し直せず、作り直す） */
  const st = { items: null, keyAt: '', loadedAt: 0, loading: false, error: '', poster: null, making: false, armedRotate: false, armedReject: '', picking: '', pickTrip: '',
    notice: null };

  const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(iso)}`; };
  const synced = () => R.rosterStore.synced();
  const allSynced = () => R.rosterStore.pending() === 0;

  /* 名簿に渡す物は、お客さんが入れた項目だけ */
  const payload = (w) => ({ name: w.name, people: w.people, email: w.email, birthDate: w.birthDate, address: w.address, emergency: { ...w.emergency } });

  /* 隠した行をサーバーで消す。名簿の直しを待っている行は、直しがサーバーに届くまで残す */
  async function flush() {
    if (!synced()) return;
    await R.rosterSync.flushWalkinDrops({ synced: allSynced() });
  }

  async function load(ui, force) {
    /* 読めなかったときも間隔を空ける（読めない間、描き直すたびに読みに行かない）。「読み直す」は force */
    if (!synced() || st.loading || (!force && Date.now() - st.loadedAt < REFRESH_MS)) return;
    st.loading = true;
    await flush();
    const r = await R.rosterSync.walkins();
    st.loading = false;
    st.loadedAt = Date.now();
    if (r.ok) { st.items = r.items; st.keyAt = r.keyAt; st.error = ''; } else st.error = r.why === 'login' ? 'login' : 'network';
    ui.rerender();
  }

  /* ---------- 店頭の QR（貼り紙） ---------- */
  async function makeKey(ui) {
    st.making = true;
    st.armedRotate = false;
    ui.rerender();
    const r = await R.rosterSync.walkinKey();
    st.making = false;
    if (r.ok) {
      st.poster = { url: r.url, at: r.at };
      st.keyAt = r.at;
      st.notice = { kind: 'ok', text: '店頭の QR を作りました。前の QR は開けなくなりました。' };
    } else {
      st.notice = { kind: 'warn', text: 'QR を作れませんでした。電波を確かめて、もう一度押してください。' };
    }
    ui.rerender();
  }

  /* 印刷では貼り紙だけを出す（css/app.css の body.print-poster）。印刷が終わったら戻す */
  function printPoster() {
    document.body.classList.add('print-poster');
    window.addEventListener('afterprint', () => document.body.classList.remove('print-poster'), { once: true });
    window.print();
  }

  function posterNode(shopName) {
    const qr = R.qrSvg(st.poster.url);
    return el('section', { class: 'poster', 'aria-label': '店頭に貼る QR' },
      el('p', { class: 'poster__shop', text: shopName }),
      el('h3', { class: 'poster__title', text: 'ご来店のお客さまへ' }),
      el('p', { class: 'poster__lead', text: 'スマホで QR を読み取り、お名前などの入力をお願いします。' }),
      qr ? el('div', { class: 'poster__qr' }, qr) : el('p', { class: 'errors', text: 'QR を描く部品が読めていません。画面を読み込み直してください。' }),
      el('p', { class: 'poster__note', text: '入力はスタッフが確認してから名簿に入ります。健康のことは、ここでは聞きません。' }));
  }

  function keySection(ui, shopName) {
    const made = st.keyAt ? `${when(st.keyAt)} に作りました。` : 'まだ作っていません。';
    const rotate = !!st.keyAt;
    return [
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '店頭の QR', el('small', { text: '貼り紙 A5' })),
        el('p', { class: 'sheet__note', text: `${made}お客さんがスマホで読むと、今日か明日の便を選んで、お名前などを入れられます。作り直すと、貼ってある QR は開けなくなります。` +
          '鍵はこの画面に作った 1 回だけ出ます（読み込み直すと出せないので、そのときは作り直します）。' }),
        st.armedRotate ? el('p', { class: 'flag flag--warn', role: 'status', text: '作り直すと、貼ってある QR は使えなくなります。もう一度押すと作り直します。' }) : null),
      st.poster ? posterNode(shopName) : null,
      ui.dock(
        st.poster ? el('button', { class: 'btn', type: 'button', text: 'A5 で印刷', onclick: printPoster }) : null,
        el('button', { class: st.poster ? 'btn btn--ghost' : 'btn', type: 'button', disabled: st.making,
          text: st.making ? '作っています…' : rotate && st.armedRotate ? 'もう一度押すと作り直す' : st.keyAt ? '作り直す' : '店頭の QR を作る',
          onclick: () => { if (rotate && !st.armedRotate) { st.armedRotate = true; ui.rerender(); return; } makeKey(ui); } }))
    ];
  }

  /* ---------- 店頭で入れた人 ---------- */
  function removeItem(id) {
    st.items = (st.items || []).filter(x => x.id !== id);
    st.armedReject = '';
    st.picking = '';
  }

  /* 名簿に入れる。直しの記録に積んだあと、この端末で行を隠し、名簿がサーバーに届いてからサーバーの行を消す */
  async function accept(ui, item, how) {
    const base = { walkin: payload(item) };
    const r = how.bookingId ? ui.save('guest.mergeWalkin', { ...base, bookingId: how.bookingId, today: R.today() }) : ui.save('guest.addWalkin', { ...base, tripId: how.tripId });
    const problems = r.out ? r.out.problems : [];
    /* 'nothing': 名簿に全部入っていた（入れる所が無い）。名簿は変わらないが、この行は片付ける */
    if (r.error || !r.out || problems.some(p => p !== 'nothing')) {
      st.notice = { kind: 'warn', text: problems.includes('cancelled') ? 'その便は中止になっています。別の便を選んでください。' : '名簿に入れられませんでした。便や予約がまだあるか確かめてください。' };
      ui.rerender();
      return;
    }
    R.rosterSync.hideWalkin(item.id, true);
    removeItem(item.id);
    st.notice = r.saved ? { kind: 'ok', text: problems.includes('nothing') ? 'すでに名簿に入っていました。この行は片付けました。' : '名簿に入れました。' }
      : { kind: 'warn', text: '名簿に入れましたが、この端末に保存できませんでした。画面を閉じる前に予約の画面を確かめてください。' };
    ui.rerender();
    await flush();
  }

  async function reject(ui, item) {
    if (st.armedReject !== item.id) { st.armedReject = item.id; ui.rerender(); return; }
    R.rosterSync.hideWalkin(item.id, false);
    removeItem(item.id);
    st.notice = { kind: 'ok', text: '入れませんでした。入力の内容は消します。' };
    ui.rerender();
    await flush();
  }

  /* 便を選ぶ: 受けた日以降の、中止していない自分の店の便 */
  function tripChoices(s, item) {
    return R.rosterCore.tripList(s).filter(t => t.date >= item.day && !t.cancel && !t.host).slice(0, 12);
  }

  function pickRow(ui, s, item) {
    const trips = tripChoices(s, item);
    if (!trips.length) return el('p', { class: 'note', text: 'この日以降の便がありません。予約の画面で便を作ってから入れてください。' });
    const first = trips.find(t => t.id === item.tripId) || trips[0];
    if (!trips.some(t => t.id === st.pickTrip)) st.pickTrip = first.id;
    return el('div', { class: 'picker' },
      el('label', { class: 'field' }, el('span', { class: 'label', text: '入れる便' }),
        el('select', { class: 'input', onchange: (e) => { st.pickTrip = e.target.value; } },
          trips.map(t => el('option', { value: t.id, selected: t.id === st.pickTrip, text: `${ui.md(t.date)} ${ui.tripLabel(t)}` })))),
      el('button', { class: 'btn btn--small', type: 'button', text: 'この便に入れる', onclick: () => accept(ui, item, { tripId: st.pickTrip }) }));
  }

  function itemLine(ui, s, item) {
    const matches = G().walkinMatches(s, item);
    const wished = s.trips.find(t => t.id === item.tripId);
    const bookingOf = (m) => s.bookings.find(b => b.id === m.bookingId);
    const tripOf = (m) => s.trips.find(t => t.id === m.tripId);
    const picking = st.picking === item.id;
    const togglePick = () => { st.picking = picking ? '' : item.id; st.pickTrip = ''; ui.rerender(); };
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name' }, item.name, el('span', { class: 'nw', text: ` ${item.people} 人` })),
      el('span', { class: 'st st--wait', text: when(item.at) }),
      el('span', { class: 'bk__meta', text: `${wished ? `希望の便: ${ui.md(wished.date)} ${ui.tripLabel(wished)}` : '便はスタッフに聞く'}　生年月日 ${item.birthDate}` }),
      matches.map(m => {
        const b = bookingOf(m);
        const t = tripOf(m);
        return el('button', { class: 'btn btn--small', type: 'button', text: `その予約にまとめる（${t ? ui.tripLabel(t) : ''}${b && b.people > 1 ? `・${b.people} 人` : ''}）`,
          onclick: () => accept(ui, item, { bookingId: m.bookingId }) });
      }),
      el('button', { class: matches.length ? 'linkbtn' : 'btn btn--small', type: 'button', onclick: togglePick,
        text: picking ? '便を選ぶのをやめる' : matches.length ? '別の予約として入れる' : '便を選んで入れる' }),
      picking ? pickRow(ui, s, item) : null,
      el('button', { class: 'linkbtn linkbtn--warn', type: 'button', text: st.armedReject === item.id ? 'もう一度押すと、入力の内容を消します' : '入れない', onclick: () => reject(ui, item) }));
  }

  function listSection(ui, s) {
    const items = st.items;
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, '店頭で入れた人', el('small', { text: '受けて 2 日で消えます' })),
      st.error === 'login' ? el('p', { class: 'flag flag--warn', role: 'status', text: 'ログインが切れました。画面を読み込み直してください。' })
        : st.error ? el('p', { class: 'flag flag--warn', role: 'status', text: '一覧を読めませんでした。電波を確かめてください。' }) : null,
      items === null ? el('p', { class: 'note', text: st.error ? '' : '読み込んでいます…' })
        : items.length ? el('ul', { class: 'bks bks--sheet' }, items.map(x => itemLine(ui, s, x)))
          : el('p', { class: 'empty', text: '店頭で入れた人はいません。' }),
      el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', disabled: st.loading, text: '読み直す', onclick: () => load(ui, true) })));
  }

  function render({ ui }) {
    const s = R.rosterStore.get();
    load(ui, false);
    return [
      ...ui.head('店頭の QR', '来店したお客さんが、スマホで名前などを入れます'),
      st.notice ? el('p', { class: `flag flag--${st.notice.kind}`, role: 'status', text: st.notice.text }) : null,
      synced() ? listSection(ui, s) : el('p', { class: 'empty', text: 'サーバーにつながる版だけで使えます。' }),
      ...(synced() ? keySection(ui, s.shop.name) : []),
      ui.back()
    ];
  }

  /* 予約の一覧の 1 行: 入れた人の数と、画面を開くボタン。サーバーを使わない版には出さない */
  function listRow({ ui }) {
    if (!synced()) return null;
    load(ui, false);
    const n = st.items ? st.items.length : 0;
    return el('section', { class: 'reset' },
      el('span', { class: 'rd__k', text: '店頭の QR' }),
      n ? el('p', { class: 'flag flag--info', role: 'status', text: `店頭で入れた人が ${n} 人います` }) : null,
      el('button', { class: 'linkbtn', type: 'button', text: n ? `店頭で入れた人を見る（${n}）` : '店頭の QR・店頭で入れた人', onclick: () => { st.notice = null; ui.go('walkin'); } }));
  }

  /* 名簿の直しがサーバーに届いたら、入れた行をサーバーで消す（画面を開いていなくても） */
  R.rosterStore.subscribe(() => { if (synced() && allSynced()) flush(); });

  R.walkinStaff = { render, listRow };
})();
