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

  /* 時刻が来た予定を動かす。サーバーにつながっている版では動かさない（予定を動かし連絡を作るのは Worker の Cron だけ。
     画面が作るとリンクが Access の中を指し、お客さんが開けない。ジンのレビュー 2026-10-28 H1）。試作（つながっていない）では画面が動かす */
  function tick(save) {
    if (R.rosterStore.synced()) return false;
    const s = R.rosterStore.get();
    const nowJst = R.nowJst();
    if (!(s.jobs || []).some(j => j.status === 'waiting' && j.due <= nowJst)) return false;
    const at = R.nowIso();
    save('auto.runDue', { nowJst, at, askBase: askBase() });
    return true;
  }

  /* 読み取りから入れる。{ error, saved, bookingId } */
  function addReading(save, reading, lang) {
    const at = R.nowIso();
    const nowJst = R.nowJst();
    const r = save('auto.addFromReading', { reading, lang, at, nowJst });
    if (!r.error) tick(save);
    return { ...r, bookingId: r.out ? r.out.bookingId : '' };
  }

  /* 予約 1 件の予定を作る（電話の予約など、予定のまだ無い予約） */
  function plan(save, bookingId) {
    const nowJst = R.nowJst();
    const r = save('auto.planJobs', { bookingId, nowJst });
    if (!r.error) tick(save);
    return r;
  }

  /* ---------- 一覧の 1 行に足す言葉 ---------- */
  const OUT_JA = { request: 'お願いを送る', remind: 'もう一度お願いを送る', today: '当日の体調の質問を送る', staff: 'お店への知らせ' };
  function rowNote(state, bookingId) {
    const outs = (state.outbox || []).filter(o => o.bookingId === bookingId && !A().isPartnersNotice(o));   // 相乗りのお店の確認待ちの知らせは、乗り合いの画面に出す
    if (outs.some(o => o.kind === 'staff')) return { warn: true, text: '前日の夜までに名簿の項目が届かなかった。当日の受付で聞く' };
    const last = outs[outs.length - 1];
    if (!last) return null;
    if (last.status === 'unsent' && last.why === 'no-email') return { warn: true, text: 'メールアドレスが無いので、お願いを送っていない' };
    if (last.status === 'failed' && last.why === 'maybe-sent') return { warn: true, text: `${OUT_JA[last.kind]}: 送れたか分からない（書類の自動化で確かめる）` };
    if (last.status === 'failed' && last.why !== A().RESENT) return { warn: true, text: `${OUT_JA[last.kind]}: 送れなかった（書類の自動化で送り直せる）` };
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
  /* 健康の質問を紙で聞くお店は、当日の朝の体調の質問を送らない（roster-auto.js の needToday が空）。予定の文もそれに合わせる */
  const PAPER_MORNING = { plan: '名簿を作る', done: '名簿を作った' };
  const planJa = (s, kind) => (kind === 'morning' && R.rosterCore.paperOf(s) ? PAPER_MORNING.plan : PLAN_JA[kind]);
  function outLine(o) {
    const what = A().isPartnersNotice(o) ? 'お店に知らせた: 相乗りのお店の確認待ち（乗り合いの画面で見る）'
      : o.kind === 'staff' ? 'お店に知らせた: 名簿の項目が届いていない人がいる'
      : `${o.status === 'sent' ? '送った' : o.status === 'queued' ? '送る準備ができた' : o.status === 'failed' ? '送れなかった' : '送っていない'}: ${OUT_JA[o.kind]}`;
    const why = o.status === 'failed' && o.why === 'maybe-sent' ? '（送れたか分からない。お客さんに届いたか確かめてください）'
      : o.why === A().RESENT ? '（送り直した）' : o.why === A().CONFIRMED ? '（届いたのをお店が確かめた）'
      : o.status === 'unsent' ? (o.why === 'no-email' ? '（メールアドレスが無い）' : '（メールの設定がまだ無い）')
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
        : el('li', { class: 'bk bk--next' }, el('span', { class: 'bk__name' }, el('span', { class: 'fig', text: dueText(x.due) }), `　予定: ${planJa(s, x.job.kind)}`))));
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

  /* ---------- お店全体（画面 10。モック screen-10-auto-board） ---------- */
  const OUT_NAME = { request: '名簿の項目のお願い', remind: 'もう一度お願い', today: '当日の体調の質問', staff: 'お店への知らせ' };
  const DONE_JA = { request: 'お願いを送った', remind: 'もう一度お願いを送った', eve: 'お店に知らせた', morning: '名簿を作り、当日の体調の質問を送った' };
  const FAIL_JA = { 'no-email': 'メールアドレスが無い', 'no-mail-config': 'メールの設定がまだ無い' };
  const RESEND_JA = {
    resent: 'もう送り直してあります', 'not-failed': 'もう送ったか、送る準備ができています', 'no-email': 'メールアドレスが無いので送れません',
    past: '済んだ便なので送りません', cancel: '中止の便なので送りません', done: '名簿がもうそろっているので送りません', 'not-found': 'この連絡が見つかりません',
    asked: 'もう送り直しを頼んであります'
  };
  const LATER_SHOW = 10;
  let laterAll = false;
  const leadOf = (state, b) => b.leadName || ((state.people.find(p => p.bookingId === b.id) || {}).name) || '名前の分からない予約';
  const tripText = (ui, trip) => `${ui.md(trip.date)} ${ui.tripLabel(trip)}`;

  /* 予約の一覧の上の 1 行。自動の予定も連絡も読めなかったメールも無ければ出さない */
  function boardRow(state, { unread, ui }) {
    if (!(state.jobs || []).length && !(state.outbox || []).length && !unread) return null;
    const b = A().board(state, { nowJst: R.nowJst() });
    const check = b.maybe.length + b.failed.length + unread;
    return el('div', { class: 'ai' },
      el('span', { class: 'rd__k', text: '書類の自動化' }),
      el('span', { class: 'ai__v' }, check ? el('b', { class: 'st--check', text: `! 確かめる ${check}` }) : el('b', { class: 'st--ok', text: '✓ 確かめる所なし' }),
        el('small', { text: `今日の予定 ${b.today.filter(r => r.job.status === 'waiting').length} 件・送る準備 ${b.ready.length} 件` })),
      el('button', { class: 'linkbtn', type: 'button', text: '開く', onclick: () => ui.go('board') }));
  }

  /* 送り直す・届いていた。名簿を直す op を当てる（サーバーの版とぶつかったら、最新に当て直しても 2 つは作らない） */
  function act(ui, op, args, okText) {
    const r = ui.save(op, args);
    const problem = r.out ? r.out.problem : '';
    ui.go('board', { saved: r.saved, warn: r.error ? '直せませんでした' : problem ? RESEND_JA[problem] || '直せませんでした' : null, notice: r.error || problem ? null : okText });
  }
  /* サーバーにつながっている版は、送り直しを頼む印だけを付ける（連絡は次の Cron が今の予約から作る）。試作は画面で作る */
  const resendIt = (ui, id) => (R.rosterStore.synced()
    ? act(ui, 'auto.requestResend', { id, nowJst: R.nowJst() }, '送り直しを頼みました。次の送信（15 分以内）で 1 通だけ送ります')
    : act(ui, 'auto.resend', { id, nowJst: R.nowJst(), at: R.nowIso(), askBase: askBase() }, '送る準備をしました（この端末の試作では送りません）'));
  const confirmIt = (ui, id) => act(ui, 'auto.confirmSent', { id, at: R.nowIso() }, '届いていた連絡として残しました');

  function boardLine({ at, name, st, meta, next, extra }) {
    return el('li', { class: next ? 'bk bk--next' : 'bk' },
      el('span', { class: 'bk__name' }, el('span', { class: 'fig', text: at }), '　', name),
      st ? el('span', { class: `st st--${st[0]}`, text: st[1] }) : el('span'),
      el('span', { class: 'bk__meta', text: meta }),
      extra || null);
  }
  const toFlow = (ui, bookingId) => el('button', { class: 'linkbtn', type: 'button', text: '流れを見る', onclick: () => ui.go('flow', { bookingId }) });
  const outMeta = (state, ui, r) => [leadOf(state, r.booking), tripText(ui, r.trip)].join('・');

  function maybeLine(state, ui, r) {
    return boardLine({
      at: jstOf(r.out.at), name: `${leadOf(state, r.booking)} さんへ「${OUT_NAME[r.out.kind]}」`, st: ['check', '! 確かめる'],
      meta: `送る途中で止まった・${tripText(ui, r.trip)}・${r.out.to}`,
      extra: el('div', { class: 'bk__ask' },
        el('p', { text: 'もう一度送ると 2 通届くことがあります。お客さんに届いたか確かめてから選んでください。' }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '届いていた（送り直さない）', onclick: () => confirmIt(ui, r.out.id) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '届いていない・送り直す', onclick: () => resendIt(ui, r.out.id) }))
    });
  }
  function failedLine(state, ui, r) {
    const can = !A().resendProblem(state, r.out, R.nowJst().slice(0, 10));
    const why = r.out.status === 'unsent' ? FAIL_JA[r.out.why] || '送っていない' : '送る所で断られた';
    return boardLine({
      at: jstOf(r.out.at), name: `${leadOf(state, r.booking)} さんへ「${OUT_NAME[r.out.kind]}」`, st: null, meta: `${why}・${tripText(ui, r.trip)}`,
      extra: can ? el('button', { class: 'linkbtn', type: 'button', text: '送り直す', onclick: () => resendIt(ui, r.out.id) }) : toFlow(ui, r.booking.id)
    });
  }
  function jobLine(state, ui, r, { withDay }) {
    const j = r.job;
    const waiting = j.status === 'waiting';
    const late = waiting && j.due <= R.nowJst();
    return boardLine({
      at: withDay ? dueText(j.due) : j.due.slice(11).replace(/^0/, ''), next: waiting && !late,
      name: waiting ? `${planJa(state, j.kind)}（予定）` : j.status === 'skipped' ? 'そろっていたので送らなかった'
        : j.kind === 'morning' && R.rosterCore.paperOf(state) ? PAPER_MORNING.done : DONE_JA[j.kind],
      st: late ? ['wait', '・待っている'] : waiting ? null : ['ok', j.status === 'skipped' ? '✓ そろった' : '✓ 済んだ'],
      meta: outMeta(state, ui, r), extra: toFlow(ui, r.booking.id)
    });
  }
  const section = (title, count, rows) => (rows.length
    ? el('div', { class: 'sheet' }, el('p', { class: 'sheet__title' }, title, el('small', { class: 'fig', text: String(count) })), el('ul', { class: 'bks bks--sheet' }, rows))
    : null);

  /* unread: { items: [{ id, at, why }], whyText(item), done(id) } は予約の画面（booking.js）が持つ（サーバーの版だけ） */
  function renderBoard({ ui, unread }) {
    const s = R.rosterStore.get();
    const nowJst = R.nowJst();
    const b = A().board(s, { nowJst });
    const check = b.maybe.length + b.failed.length + unread.items.length;
    const later = laterAll ? b.later : b.later.slice(0, LATER_SHOW);
    const today = nowJst.slice(0, 10);
    return [
      ...ui.head('書類の自動化', `今 ${dueText(nowJst)}・${R.rosterStore.synced() ? 'メールは 1 分ごとに送る' : 'この端末の試作では送らない'}`),
      el('p', { class: 'sumline sumline--board' },
        el('b', { class: check ? 'st--check' : 'st--ok', text: check ? `! 確かめる ${check}` : '✓ 確かめる所なし' }),
        el('span', { class: 'st--wait', text: `・送る準備 ${b.ready.length}` }), el('span', { text: `今日 ${b.today.length}` }), el('span', { text: `これから ${b.later.length}` })),
      section('送れたか分からない', b.maybe.length, b.maybe.map(r => maybeLine(s, ui, r))),
      section('送れなかった', b.failed.length, b.failed.map(r => failedLine(s, ui, r))),
      section('読めなかった予約メール', unread.items.length, unread.items.map(x => boardLine({
        at: jstOf(x.at), name: '届いたメール', st: null, meta: `${unread.whyText(x)}。受信箱でこの時刻のメールを探し「メールを貼る」で入れる`,
        extra: el('button', { class: 'linkbtn', type: 'button', text: '入れた・済んだ', onclick: () => unread.done(x.id) })
      }))),
      section('送る準備ができた', b.ready.length, b.ready.map(r => boardLine({
        at: jstOf(r.out.at), name: `${leadOf(s, r.booking)} さんへ「${OUT_NAME[r.out.kind]}」`, st: ['wait', r.sending ? '・送っている' : r.asked ? '・送り直しを頼んだ' : '・次で送る'],
        meta: tripText(ui, r.trip), extra: toFlow(ui, r.booking.id)
      }))),
      section(`今日 ${ui.md(today)}`, b.today.length, b.today.map(r => jobLine(s, ui, r, { withDay: r.job.due.slice(0, 10) !== today }))),
      section('これから', b.later.length, later.map(r => jobLine(s, ui, r, { withDay: true }))),
      b.later.length > later.length ? el('p', { class: 'reset' }, el('button', { class: 'linkbtn', type: 'button', text: `残り ${b.later.length - later.length} 件を見る`,
        onclick: () => { laterAll = true; ui.rerender(); } })) : null,
      b.maybe.length + b.failed.length + b.ready.length + b.today.length + b.later.length + unread.items.length ? null
        : el('p', { class: 'empty', text: '自動の予定と連絡はまだありません。' }),
      ui.back()
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
      ui.save('core.logAi', { at: new Date().toISOString(), sent });
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

  R.autoFlow = { tick, addReading, plan, rowNote, hasPlan, render, boardRow, renderBoard, demoMail, demoAdvance };
})();
