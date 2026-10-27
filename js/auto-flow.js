/* 書類の自動化の画面（entry）。計画は plan/auto.md、決まりは js/roster-auto.js（core）。
   - tick: 時刻が来た予定を動かす（予約と名簿の画面を開いている間、1 分ごと）。送るのは Worker だけで、画面は「送る準備ができた」まで
   - addReading / addForm: 読み取り・フォームから予約を入れ、予定を作る
   - render: 1 件の予約の流れ（起きたことと、これからの予定。送った連絡の文面も見られる）
   - demoMail / demoAdvance: デモの「見本のメールが届く」「時刻を進める」 */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const A = () => R.rosterAuto;

  const askBase = () => `${location.origin}${location.pathname}#ask=`;

  function tick(save) {
    const s = R.rosterStore.get();
    const nowJst = R.nowJst();
    if (!(s.jobs || []).some(j => j.status === 'waiting' && j.due <= nowJst)) return false;
    const at = R.nowIso();
    save(st => A().runDue(st, { nowJst, at, newId: R.newId, askBase: askBase() }).state);
    return true;
  }

  /* 読み取りから入れる。{ error, saved, bookingId } */
  function addReading(save, reading, lang) {
    const at = R.nowIso();
    const nowJst = R.nowJst();
    let bookingId = '';
    const r = save(st => { const out = A().addFromReading(st, { reading, lang, at, nowJst, newId: R.newId }); bookingId = out.bookingId; return out.state; });
    if (!r.error) tick(save);
    return { ...r, bookingId };
  }

  /* 予約 1 件の予定を作る（電話の予約など、予定のまだ無い予約） */
  function plan(save, bookingId) {
    const nowJst = R.nowJst();
    const r = save(st => A().planJobs(st, { bookingId, nowJst, newId: R.newId }));
    if (!r.error) tick(save);
    return r;
  }

  /* ---------- 一覧の 1 行に足す言葉 ---------- */
  const OUT_JA = { request: 'お願いを送る', remind: 'もう一度お願いを送る', today: '当日の体調の質問を送る', staff: 'お店への知らせ' };
  function rowNote(state, bookingId) {
    const outs = (state.outbox || []).filter(o => o.bookingId === bookingId);
    if (outs.some(o => o.kind === 'staff')) return { warn: true, text: '前日の夜までに名簿の項目が届かなかった。当日の受付で聞く' };
    const last = outs[outs.length - 1];
    if (!last) return null;
    if (last.status === 'unsent' && last.why === 'no-email') return { warn: true, text: 'メールアドレスが無いので、お願いを送っていない' };
    return { warn: false, text: `${OUT_JA[last.kind]}: ${last.status === 'sent' ? '送った' : '送る準備ができた'}` };
  }
  const hasPlan = (state, bookingId) => (state.jobs || []).some(j => j.bookingId === bookingId);

  /* ---------- 1 件の予約の流れ ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  /* ISO（UTC）を日本の時刻の「M/D HH:MM」に */
  function jstOf(iso) {
    const t = new Date(Date.parse(iso) + 9 * 3600000);
    return `${t.getUTCMonth() + 1}/${t.getUTCDate()} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  }
  const dueText = (due) => `${Number(due.slice(5, 7))}/${Number(due.slice(8, 10))} ${due.slice(11)}`;
  const ADDED_JA = { ai: '予約メールが届き、AI が読んで便に入れた', guest: 'お客さんが自社の予約フォームから入れた', staff: 'お店が予約を入れた', system: '予約が入った' };
  const PLAN_JA = { request: 'お願いを送る', remind: 'まだなら、もう一度お願いを送る', eve: 'まだなら、お店に知らせる', morning: '名簿を作り、当日の体調の質問を送る' };
  function outLine(o) {
    const what = o.kind === 'staff' ? 'お店に知らせた: 名簿の項目が届いていない人がいる'
      : `${o.status === 'sent' ? '送った' : o.status === 'queued' ? '送る準備ができた' : o.status === 'failed' ? '送れなかった' : '送っていない'}: ${OUT_JA[o.kind]}`;
    const why = o.status === 'unsent' ? (o.why === 'no-email' ? '（メールアドレスが無い）' : '（メールの設定がまだ無い）')
      : o.status === 'queued' ? '（メールの設定がそろうと送る）' : '';
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name' }, el('span', { class: 'fig', text: jstOf(o.at) }), `　${what}`),
      el('span', { class: 'bk__meta', text: [o.to ? `宛先: ${o.to}` : '', why].filter(Boolean).join('　') }),
      el('details', { class: 'mailbody' },
        el('summary', { text: '文面を見る' }),
        el('p', { class: 'mailbody__subject', text: o.subject }),
        el('p', { class: 'mailbody__text', text: o.body })));
  }

  function render({ bookingId, ui }) {
    const s = R.rosterStore.get();
    const b = s.bookings.find(x => x.id === bookingId);
    if (!b) return [...ui.head('予約の流れ'), el('p', { class: 'errors', text: 'この予約が見つかりません。' }), ui.back()];
    const trip = s.trips.find(t => t.id === b.tripId);
    const people = s.people.filter(p => p.bookingId === b.id);
    const lead = b.leadName || (people[0] && people[0].name) || '名前の分からない予約';
    const items = A().timeline(s, b.id);
    const lines = items.map(x => (x.kind === 'added'
      ? el('li', { class: 'bk' }, el('span', { class: 'bk__name' }, el('span', { class: 'fig', text: jstOf(x.at) }), `　${ADDED_JA[x.who] || ADDED_JA.system}`))
      : x.kind === 'out' ? outLine(x.out)
        : el('li', { class: 'bk bk--next' }, el('span', { class: 'bk__name' }, el('span', { class: 'fig', text: dueText(x.due) }), `　予定: ${PLAN_JA[x.job.kind]}`))));
    return [
      ...ui.head(people.length > 1 ? `${lead} ほか ${people.length - 1} 人` : lead, trip ? `${ui.md(trip.date)} ${ui.tripLabel(trip)}` : ''),
      el('div', { class: 'sheet' },
        el('p', { class: 'sheet__title' }, '起きたことと、これからの予定', el('small', { text: `今 ${dueText(R.nowJst())}` })),
        items.length ? el('ul', { class: 'bks bks--sheet' }, lines) : el('p', { class: 'sheet__note', text: 'この予約には、自動の予定がありません（前の版で入れた予約）。' })),
      el('div', { class: 'facts' },
        el('div', { class: 'facts__row' }, el('span', { class: 'facts__k', text: '送り先' }),
          el('p', { class: 'facts__v', text: b.leadEmail || 'メールアドレスが無い（お願いはリンクを写して送る）' }))),
      hasPlan(s, b.id) ? null : el('p', { class: 'reset' }, el('button', { class: 'linkbtn', type: 'button', text: 'この予約の自動の予定を作る', onclick: () => {
        const r = plan(ui.save, b.id);
        ui.go('flow', { bookingId: b.id, saved: r.saved, warn: r.error ? '予定を作れませんでした' : null });
      } })),
      ui.back(),
      ui.dock(el('button', { class: 'btn', type: 'button', text: 'お客さんに聞くリンク', onclick: () => ui.go('ask', { bookingId: b.id }) }))
    ];
  }

  /* ---------- デモ ---------- */
  let demoNext = 0;
  /* 見本のメールが届いた形にする: 読んで、便に入れ、予定を作り、お願いまで動かす */
  async function demoMail(ui) {
    const ids = Object.keys(R.SAMPLE_MAILS);
    const id = ids[demoNext % ids.length];
    demoNext += 1;
    const text = R.sampleMail(id, R.today()).text;
    try {
      const { reading, sent } = await R.aiReader.read({ doc: 'mail', text, sampleId: id });
      ui.save(s => R.rosterCore.logAi(s, { at: new Date().toISOString(), sent }));
      const r = addReading(ui.save, reading, id === 'e2' ? 'en' : 'ja');
      ui.go('flow', { bookingId: r.bookingId, saved: r.saved, notice: r.error ? null : `見本のメール（${id}）が届き、自動で入れました`, warn: r.error ? '見本のメールを入れられませんでした' : null });
    } catch (e) {
      ui.go('list', { warn: '見本のメールを読めませんでした' });
    }
  }

  /* 次の予定の時刻まで進めて動かす（デモの時計。開き直すと戻る） */
  function demoAdvance(ui) {
    const next = A().nextDue(R.rosterStore.get(), R.nowJst());
    if (!next) { ui.go('list', { notice: 'これから動く予定はありません' }); return; }
    R.setClockTo(next);
    tick(ui.save);
    ui.go('list', { day: next.slice(0, 10), notice: `時刻を ${dueText(next)} まで進めて、予定を動かしました（デモ）` });
  }

  R.autoFlow = { tick, addReading, plan, rowNote, hasPlan, render, demoMail, demoAdvance };
})();
