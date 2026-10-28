/* 1 人ずつのリンク（お店、日本語のみ）: 予約のリンクの画面（booking.js の「お客さんに聞く」）に、予約の人ごとの「この人のリンク」を出す。
   お店が作ったリンクだけが、AI が読んだ値をお客さんに見せ、「合っている」「直す」を受ける（決定ログ 2026-10-28 unconfirmed-marks・staff-person-links）。
   リンクは /api/ask-link に personId をつけて作る（js/roster-sync.js）。出し方は予約のリンクと同じ 3 つ（QR を見せる・SMS で送る・LINE で送る。js/contact-link.js）。
   人ごとの未確認の数は core の unconfirmedByPerson。作り直すと、その人の前のリンクは開けなくなるので、2 回押して作る。
   お客さんの名前は el() の text で出す（HTML として入れない）。SMS の宛先は予約の代表者の電話で、本文に名前は入れない */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;

  const NO_NAME = '名前の分からない人';
  /* 人の id → { url, expiresOn } か { wait: true } か { error: why }。画面を開き直しても残す（予約のリンクの made と同じ） */
  const made = new Map();
  let armed = '';     // 「もう一度押すと作る」に変わっている人の id
  let qrFor = '';     // 大きな QR を見せている人の id

  const nameOf = (p) => p.name || NO_NAME;

  /* 人ごとの行（純ロジック）: { personId, name, count, label }。count = 未確認の項目の数 */
  function rows(state, bookingId) {
    return R.rosterCore.unconfirmedByPerson(state, bookingId).map(x => ({
      personId: x.person.id, name: nameOf(x.person), count: x.count, label: x.count ? `未確認 ${x.count} 項目` : '未確認なし' }));
  }
  const waiting = (list) => list.filter(x => x.count > 0);

  async function mint(bookingId, personId, rerender) {
    armed = '';
    const before = made.get(personId);
    made.set(personId, { wait: true });
    rerender();
    const r = await R.rosterSync.askLink(bookingId, personId);
    /* 作れなかったときは、作る前のリンクをそのまま持つ（サーバーで作り直せていなければ、前のリンクはまだ開ける） */
    made.set(personId, r.ok ? { url: r.url, expiresOn: r.expiresOn } : { ...(before && before.url ? before : {}), error: r.why });
    qrFor = r.ok ? personId : '';
    rerender();
  }

  /* 「この人のリンク」: 1 回目は確かめの文に変わり、もう一度押すと作る（作り直すと、その人の前のリンクは開けなくなる） */
  function mintButton(x, bookingId, rerender) {
    const mine = made.get(x.personId);
    const busy = !!(mine && mine.wait);
    const isArmed = armed === x.personId;
    const label = busy ? '作っています…' : isArmed ? `もう一度押すと、${x.name} さんの前のリンクは開けなくなります` : mine && mine.url ? 'この人のリンクを作り直す' : 'この人のリンク';
    return el('button', { class: mine && mine.url ? 'btn btn--ghost' : 'btn', type: 'button', disabled: busy, text: label, 'aria-pressed': String(isArmed),
      onclick: () => { if (!isArmed) { armed = x.personId; rerender(); return; } return mint(bookingId, x.personId, rerender); } });
  }

  function qrBlock(url) {
    const qr = R.qrSvg(url);
    return el('div', { class: 'qr qr--big' }, qr || el('p', { class: 'errors', role: 'alert', text: 'QR を描けませんでした。「SMS で送る」か「LINE で送る」を使ってください。' }));
  }

  /* 作ったリンクの 3 つの出し方 */
  function outputs(x, b, shopName, url, rerender) {
    const L = R.contactLink;
    const sms = L.smsHref(b.leadPhone, shopName, url);
    const line = L.lineHref(shopName, url);
    const showQr = qrFor === x.personId;
    return [
      el('div', { class: 'sendrow' },
        el('button', { class: showQr ? 'btn' : 'btn btn--ghost', type: 'button', 'aria-pressed': String(showQr), text: 'QR を見せる',
          onclick: () => { qrFor = showQr ? '' : x.personId; rerender(); } }),
        sms ? el('a', { class: 'btn btn--ghost', href: sms, text: 'SMS で送る' }) : null,
        line ? el('a', { class: 'btn btn--ghost', href: line, target: '_blank', rel: 'noopener noreferrer', text: 'LINE で送る' }) : null),
      showQr ? qrBlock(url) : null,
      sms ? null : el('p', { class: 'sheet__note', text: '予約に電話番号が入っていないので、SMS では送れません。' })
    ];
  }

  function personBlock(x, b, shopName, md, rerender) {
    const mine = made.get(x.personId);
    const url = mine && mine.url ? mine.url : '';
    return el('div', { class: 'perlink' },
      el('div', { class: x.count ? 'rd rd--unsure' : 'rd' },
        el('span', { class: 'rd__k', text: x.name }),
        el('span', { class: 'rd__v' }, el('span', { class: 'rd__sub', text: x.label }))),
      el('div', { class: 'sendrow' }, mintButton(x, b.id, rerender)),
      mine && mine.error ? el('p', { class: 'flag flag--warn', role: 'status', text: mine.error === 404
        ? 'サーバーにまだこの予約が届いていません。少し待ってから、もう一度押してください。' : 'リンクを作れませんでした。もう一度押してください。' }) : null,
      url ? outputs(x, b, shopName, url, rerender) : null,
      url && mine.expiresOn ? el('p', { class: 'sheet__note', text: `${md(mine.expiresOn)} まで使えます。` }) : null);
  }

  /* 画面の部分。人が 1 人もいない予約には出さない（null）。state・booking・shopName・md（日付の文字）・rerender（描き直す） */
  function render({ state, booking, shopName, md, rerender }) {
    const list = rows(state, booking.id);
    if (!list.length) return null;
    const need = waiting(list);
    const total = need.reduce((n, x) => n + x.count, 0);
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, '1 人ずつのリンク', el('small', { text: need.length ? `未確認 ${need.length} 人・${total} 項目` : '未確認はありません' })),
      el('p', { class: 'sheet__note', text: 'お店が作ったこのリンクだけが、AI が読んだ内容をその人に見せ、「合っている」「直す」を受けられます。未確認のある人に送ると、名簿がそろいます。作り直すと、その人の前のリンクは開けなくなります。' }),
      list.map(x => personBlock(x, booking, shopName, md, rerender)));
  }

  /* 画面に入るとき（booking.js の go）。押しかけの確かめと QR は開くたびに閉じる */
  function enter() { armed = ''; qrFor = ''; }

  R.personLinks = { rows, render, enter };
})();
