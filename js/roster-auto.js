/* 書類の自動化（core）。計画は plan/auto.md、流れの図は docs/flow/doc-automation.png。
   予約を入れたら、自動の予定（state.jobs）を作り、時刻が来たら送る連絡（state.outbox）を作る。送るのは Worker（worker/mail.mjs）だけ。
   時計を使わない: 今の時刻は日本の時刻の文字「YYYY-MM-DDTHH:MM」（nowJst）で受け取り、文字のまま比べる。
   ブラウザでも Node（テスト）でも Worker でも動くように、globalThis.REDUX に足す。roster-schema.js・roster-core.js の後に読む */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  /* 予定の時刻（日本の時刻）。2 日前の朝にもう一度、前日の夜にお店へ、当日の朝に名簿と体調の質問 */
  const REMIND_AT = '09:00';
  const EVE_AT = '20:00';
  const MORNING_AT = '06:00';
  /* Worker が作る連絡の、お客さんのリンクを入れる所の印 */
  const LINK_MARK = '[[ask-link]]';

  /* ---------- 日付（時計を使わずに数える。roster-guest.js の dayNumber と同じ暦の式） ---------- */
  function dayNumber(ymd) {
    const [y0, m, d] = ymd.split('-').map(Number);
    const y = m <= 2 ? y0 - 1 : y0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  }
  function ymdOf(n) {
    const z = n + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const dayAdd = (ymd, n) => ymdOf(dayNumber(ymd) + n);
  const weekday = (ymd) => (((dayNumber(ymd) + 4) % 7) + 7) % 7;   // 1970-01-01 は木曜日。0 が日曜日
  const WEEK = { ja: ['日', '月', '火', '水', '木', '金', '土'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };

  /* ---------- 人と予約 ---------- */
  const bookingOf = (state, id) => state.bookings.find(b => b.id === id) || null;
  const tripOfBooking = (state, b) => (b ? state.trips.find(t => t.id === b.tripId) || null : null);
  const peopleOfBooking = (state, bookingId) => state.people.filter(p => p.bookingId === bookingId);
  /* お願いで聞く人: 名簿の項目のうち、お客さんに聞く項目がまだある人（当日の体調は当日の朝に別に聞く） */
  function missingPeople(state, bookingId) {
    const b = bookingOf(state, bookingId);
    const trip = tripOfBooking(state, b);
    return peopleOfBooking(state, bookingId).filter(p => C().askGuest(p, trip, { paper: C().paperOf(state) }).some(k => k !== 'today'));
  }
  /* 当日の体調がまだの人（他のお店が確かめる人は除く）。健康を紙で聞くお店では、当日の朝の質問は送らない（受付で紙に書いてもらう） */
  const needToday = (state, bookingId) => (C().paperOf(state) ? []
    : peopleOfBooking(state, bookingId).filter(p => !C().isHeld(p) && !p.health.today));

  /* ---------- 文面（健康の答えは入れない。名前と日付とリンクだけ） ---------- */
  function md(date, lang) {
    if (!date) return lang === 'ja' ? '日にち未定' : 'date to be set';
    const [, m, d] = date.split('-').map(Number);
    const w = WEEK[lang === 'ja' ? 'ja' : 'en'][weekday(date)];
    return lang === 'ja' ? `${m}/${d}（${w}）` : `${w} ${m}/${d}`;
  }
  /* ko・zh は、文面を用意するまで英語で送る */
  const textLang = (lang) => (lang === 'ja' ? 'ja' : 'en');
  /* お願いの最後の 1 行。[アプリで聞くお店, 健康を紙で聞くお店] */
  const HEALTH_NOTE = {
    ja: ['健康の質問の答えは、このお店だけが見ます。AI には送りません。', '健康の質問は、当日の受付で紙の申込書にお願いします。'],
    en: ['Only this shop sees your health answers. They are not sent to AI.', 'Health questions are answered on the paper form at check-in on the day.']
  };
  function message(kind, { shop, booking, trip, people, link, paper = false }) {
    const L = textLang(booking.lang || 'ja');
    const when = `${md(trip.date, L)}${trip.start ? ` ${trip.start}` : ''}`;
    const names = people.map(p => p.name || (L === 'ja' ? '（お名前未定の方）' : '(name not given)'));
    const lead = booking.leadName || names[0] || '';
    if (L === 'ja') {
      const hello = `${lead} 様\n\n${when} ${trip.tour} のご予約、ありがとうございます。\n`;
      const sign = `\n\n${shop}`;
      if (kind === 'request' || kind === 'remind') {
        return {
          subject: `${kind === 'remind' ? '【もう一度】' : ''}【${shop}】${md(trip.date, 'ja')} のダイビングの前に、名簿の項目をお願いします`,
          body: `${hello}沖縄県の条例で、お店は潜る方の名簿を作ります。まだいただいていない項目だけを、下のリンクからお願いします（約 3 分）。\n\n${link}\n\n` +
            `お願いする方: ${names.join('、')}\n${HEALTH_NOTE.ja[paper ? 1 : 0]}${sign}`
        };
      }
      if (kind === 'today') {
        return {
          subject: `【${shop}】本日のダイビングの前に、体調を教えてください`,
          body: `${hello}潜る前に、今日の体調を下のリンクから教えてください（1 分）。\n\n${link}\n\nお願いする方: ${names.join('、')}${sign}`
        };
      }
      return {
        subject: `名簿がそろっていません: ${when} ${lead} さんの予約`,
        body: `前日の夜になっても、名簿の項目が届いていない方がいます。当日の受付で聞いてください。\n\nまだの方: ${names.join('、')}`
      };
    }
    const hello = `Dear ${lead},\n\nThank you for booking ${trip.tour} on ${when}.\n`;
    const sign = `\n\n${shop}`;
    if (kind === 'request' || kind === 'remind') {
      return {
        subject: `${kind === 'remind' ? '[Reminder] ' : ''}[${shop}] Please fill in the diver list before your dive on ${md(trip.date, 'en')}`,
        body: `${hello}Under Okinawa Prefecture rules, the shop keeps a list of everyone who dives. ` +
          `Please fill in only the missing items at the link below (about 3 minutes).\n\n${link}\n\nFor: ${names.join(', ')}\n${HEALTH_NOTE.en[paper ? 1 : 0]}${sign}`
      };
    }
    if (kind === 'today') {
      return {
        subject: `[${shop}] Before today's dive, please tell us how you feel`,
        body: `${hello}Before diving, please answer today's health check at the link below (1 minute).\n\n${link}\n\nFor: ${names.join(', ')}${sign}`
      };
    }
    return { subject: `Diver list incomplete: ${when} ${lead}`, body: `Some divers have not sent their list items. Please ask them at check-in.\n\nMissing: ${names.join(', ')}` };
  }

  /* ---------- 予定を作る ---------- */
  /* 予約 1 件の予定。お願いはすぐ。過ぎた予定は作らない（当日の朝だけは、過ぎていてもすぐ動かす） */
  function planJobs(state, { bookingId, nowJst, newId }) {
    const b = bookingOf(state, bookingId);
    const trip = tripOfBooking(state, b);
    if (!b || !trip) throw new Error(`planJobs: 予約が見つからない (${bookingId})`);
    if (!S().isJst(nowJst)) throw new Error(`planJobs: nowJst は YYYY-MM-DDTHH:MM (${nowJst})`);
    const job = (kind, due) => ({ v: S().VERSION, id: newId(), kind, bookingId, tripId: trip.id, due, status: 'waiting', doneAt: '' });
    const jobs = [job('request', nowJst)];
    if (trip.date) {
      const remind = `${dayAdd(trip.date, -2)}T${REMIND_AT}`;
      const eve = `${dayAdd(trip.date, -1)}T${EVE_AT}`;
      const morning = `${trip.date}T${MORNING_AT}`;
      if (remind > nowJst) jobs.push(job('remind', remind));
      if (eve > nowJst) jobs.push(job('eve', eve));
      if (trip.date >= nowJst.slice(0, 10)) jobs.push(job('morning', morning > nowJst ? morning : nowJst));
    }
    return { ...state, jobs: [...(state.jobs || []), ...jobs] };
  }

  /* AI の読み取り（予約メール）から予約を入れ、予定を作る。同じ日・時刻の便が無ければ作る。{ state, bookingId } */
  function addFromReading(state, { reading, lang, at, nowJst, newId }) {
    const b = reading.booking || {};
    const want = { date: b.date || '', start: b.start || '', tour: b.tour || '', kind: '' };
    const sug = C().suggestTrip(state, want);
    const booking = { ...C().bookingFromReading(reading), ...(S().LANGS.includes(lang) ? { lang } : {}) };
    const { state: st } = C().addBookingToTrip(state, { tripId: sug.tripId || '', want: { ...want, kind: sug.kind }, booking, reading, src: 'mail', at, newId });
    const bookingId = st.bookings[st.bookings.length - 1].id;
    return { state: planJobs(st, { bookingId, nowJst, newId }), bookingId };
  }

  /* 自社の予約フォーム（js/intake.js・サイトの予約フォーム）から入れ、予定を作る。email と lang は予約に持つ。{ state, bookingId } */
  function addFromForm(state, { intake, tour, at, nowJst, newId }) {
    const r = C().addFromIntake(state, { intake, tour, at, newId });
    const email = typeof intake.email === 'string' ? intake.email.trim() : '';
    const extra = {
      ...(S().emailOk(email) && email ? { leadEmail: email } : {}),
      ...(S().LANGS.includes(intake.lang) ? { lang: intake.lang } : {})
    };
    const st = Object.keys(extra).length
      ? { ...r.state, bookings: r.state.bookings.map(b => (b.id === r.bookingId ? { ...b, ...extra } : b)) }
      : r.state;
    return { state: planJobs(st, { bookingId: r.bookingId, nowJst, newId }), bookingId: r.bookingId };
  }

  /* ---------- 時刻が来た予定を動かす ---------- */
  function outItem(state, { kind, booking, trip, people, at, newId, askBase }) {
    const shop = state.shop.name || '';
    /* askBase が空のとき（Worker）は印だけを入れ、送るときに予約ごとの鍵のリンクへ差し替える（鍵は名簿に残さない。worker/auto.mjs） */
    const link = askBase ? `${askBase}${booking.id}` : LINK_MARK;
    const { subject, body } = message(kind, { shop, booking, trip, people, link, paper: C().paperOf(state) });
    const toGuest = kind !== 'staff';
    const to = toGuest ? (booking.leadEmail || '') : '';
    return {
      v: S().VERSION, id: newId(), kind, bookingId: booking.id, tripId: trip.id, to, lang: S().LANGS.includes(booking.lang) ? booking.lang : 'ja',
      subject: subject.slice(0, 200), body: body.slice(0, 4000), people: people.map(p => p.id),
      status: !toGuest ? 'notice' : to ? 'queued' : 'unsent', why: toGuest && !to ? 'no-email' : '', at, sentAt: ''
    };
  }

  /* nowJst までに時刻が来た予定を、時刻の順に動かす。{ state, queued: 送る連絡の id } */
  function runDue(state, { nowJst, at, newId, askBase }) {
    if (!S().isJst(nowJst)) throw new Error(`runDue: nowJst は YYYY-MM-DDTHH:MM (${nowJst})`);
    const due = (state.jobs || []).filter(j => j.status === 'waiting' && j.due <= nowJst).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
    if (!due.length) return { state, queued: [] };
    let trips = state.trips;
    const outbox = [...(state.outbox || [])];
    const queued = [];
    const finished = new Map();   // job id → 'done' / 'skipped'
    for (const j of due) {
      const booking = bookingOf(state, j.bookingId);
      const trip = booking ? trips.find(t => t.id === booking.tripId) : null;
      if (!booking || !trip || trip.cancel) { finished.set(j.id, 'skipped'); continue; }
      const push = (kind, people) => {
        const o = outItem(state, { kind, booking, trip, people, at, newId, askBase });
        outbox.push(o);
        if (o.status === 'queued') queued.push(o.id);
      };
      if (j.kind === 'request' || j.kind === 'remind') {
        const people = missingPeople(state, booking.id);
        if (!people.length) { finished.set(j.id, 'skipped'); continue; }
        push(j.kind, people);
      } else if (j.kind === 'eve') {
        const people = missingPeople(state, booking.id);
        if (!people.length) { finished.set(j.id, 'skipped'); continue; }
        push('staff', people);
      } else {
        /* 当日の朝: 便に名簿を作った時刻を付け（便に 1 回）、体調がまだの人に質問を送る */
        if (!trip.rosterAt) trips = trips.map(t => (t.id === trip.id ? { ...t, rosterAt: at } : t));
        const people = needToday(state, booking.id);
        if (people.length) push('today', people);
      }
      finished.set(j.id, 'done');
    }
    const jobs = state.jobs.map(j => (finished.has(j.id) ? { ...j, status: finished.get(j.id), doneAt: at } : j));
    return { state: { ...state, trips, jobs, outbox }, queued };
  }

  /* 送った結果を付ける。ok なら sent、だめなら failed（why は短い印）か unsent（メールの設定が無い） */
  function markSent(state, { id, result, why, at }) {
    if (!['sent', 'failed', 'unsent'].includes(result)) throw new Error(`markSent: result は sent / failed / unsent (${result})`);
    return {
      ...state,
      outbox: (state.outbox || []).map(o => (o.id === id && o.status === 'queued'
        ? { ...o, status: result, why: result === 'sent' ? '' : String(why || '').slice(0, 40), sentAt: result === 'sent' ? at : '' } : o))
    };
  }

  /* 終わって KEEP_DONE_DAYS 日を過ぎた便の、済んだ予定を消し、送った連絡の本文を空にする（名簿を軽く保つ。名簿の 1 MB の上限への備え）。
     宛先・件名・送った結果と時刻は残す（いつ誰に何を送ったかは、名簿と同じく 1 年残る）。何も変わらなければ同じ state を返す */
  const KEEP_DONE_DAYS = 7;
  function compactPast(state, { today }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) throw new Error(`compactPast: today は YYYY-MM-DD (${today})`);
    const cut = dayAdd(today, -KEEP_DONE_DAYS);
    const past = new Set(state.trips.filter(t => t.date && t.date < cut).map(t => t.id));
    if (!past.size) return state;
    const jobs = (state.jobs || []).filter(j => !(past.has(j.tripId) && j.status !== 'waiting'));
    let changed = jobs.length !== (state.jobs || []).length;
    const outbox = (state.outbox || []).map(o => {
      if (!past.has(o.tripId) || o.status === 'queued' || o.body === '') return o;
      changed = true;
      return { ...o, body: '' };
    });
    if (!changed) return state;
    return { ...state, ...(state.jobs ? { jobs } : {}), ...(state.outbox ? { outbox } : {}) };
  }

  /* ---------- 送り直す・届いていた（お店が確かめてから。画面の「書類の自動化」） ---------- */
  /* 元の連絡の why に付ける印。送り直した物は二度と送り直さない（2 回押しても、2 台で押しても新しい連絡は 1 つ）。
     届いていた物は sent にする（sentAt は確かめた時刻） */
  const RESENT = 'resent';
  const CONFIRMED = 'confirmed';
  const liveTrip = (trip, today) => !!trip && !trip.cancel && !(trip.date && trip.date < today);
  /* 送り直せない理由の短い名前。送り直せるなら '' */
  function resendProblem(state, o, today) {
    if (!o) return 'not-found';
    if (o.kind === 'staff' || !['failed', 'unsent'].includes(o.status)) return 'not-failed';
    if (o.why === RESENT) return 'resent';
    const booking = bookingOf(state, o.bookingId);
    const trip = tripOfBooking(state, booking);
    if (!booking || !trip) return 'not-found';
    if (!liveTrip(trip, today)) return trip.cancel ? 'cancel' : 'past';
    if (!booking.leadEmail) return 'no-email';
    return '';
  }
  /* 送れなかった・送れたか分からない連絡を、今の予約から作り直して送る準備をする（送るのは Worker。印の付け方は worker/auto-core.mjs の claimQueued）。
     宛先と人は今の予約から取り直す（お店がメールアドレスを直してから送り直せる）。{ state, problem, id: 新しい連絡の id } */
  function resend(state, { id, nowJst, at, newId, askBase }) {
    if (!S().isJst(nowJst)) throw new Error(`resend: nowJst は YYYY-MM-DDTHH:MM (${nowJst})`);
    const o = (state.outbox || []).find(x => x.id === id);
    const problem = resendProblem(state, o, nowJst.slice(0, 10));
    if (problem) return { state, problem, id: '' };
    const booking = bookingOf(state, o.bookingId);
    const people = o.kind === 'today' ? needToday(state, booking.id) : missingPeople(state, booking.id);
    if (!people.length) return { state, problem: 'done', id: '' };   // もうそろった。送る理由が無い
    const copy = outItem(state, { kind: o.kind, booking, trip: tripOfBooking(state, booking), people, at, newId, askBase });
    return { state: { ...state, outbox: [...state.outbox.map(x => (x.id === id ? { ...x, why: RESENT } : x)), copy] }, problem: '', id: copy.id };
  }
  /* 送れたか分からない連絡が、お客さんに届いていた（お店が確かめた）。{ state, problem } */
  function confirmSent(state, { id, at }) {
    const o = (state.outbox || []).find(x => x.id === id);
    if (!o || o.status !== 'failed' || o.why !== 'maybe-sent') return { state, problem: o ? 'not-maybe' : 'not-found' };
    return { state: { ...state, outbox: state.outbox.map(x => (x.id === id ? { ...x, status: 'sent', why: CONFIRMED, sentAt: at } : x)) }, problem: '' };
  }

  /* お店全体の自動の予定と連絡（画面の「書類の自動化」）。nowJst の日を今日とし、済んだ便・中止の便の物は出さない。
     行は { out | job, booking, trip }。並びは時刻の順。
     maybe: 送れたか分からない / failed: 送れなかった・送っていない（送り直していない物） / ready: 送る準備ができた（sending: 送っている途中）/
     today: 今日の予定（済んだ物も）と、時刻を過ぎてまだ動いていない予定 / later: 明日から先の予定 */
  function board(state, { nowJst }) {
    if (!S().isJst(nowJst)) throw new Error(`board: nowJst は YYYY-MM-DDTHH:MM (${nowJst})`);
    const today = nowJst.slice(0, 10);
    const rowOf = (key) => (x) => {
      const booking = bookingOf(state, x.bookingId);
      return { [key]: x, booking, trip: tripOfBooking(state, booking) };
    };
    const live = (r) => !!r.booking && liveTrip(r.trip, today);
    const order = (f) => (a, b) => (f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0);
    const outs = (state.outbox || []).map(rowOf('out')).filter(live).sort(order(r => r.out.at));
    const jobs = (state.jobs || []).map(rowOf('job')).filter(live).sort(order(r => r.job.due));
    const day = (r) => r.job.due.slice(0, 10);
    return {
      maybe: outs.filter(r => r.out.status === 'failed' && r.out.why === 'maybe-sent'),
      failed: outs.filter(r => ['failed', 'unsent'].includes(r.out.status) && !['maybe-sent', RESENT].includes(r.out.why)),
      ready: outs.filter(r => r.out.status === 'queued').map(r => ({ ...r, sending: r.out.why.startsWith('sending:') })),
      today: jobs.filter(r => day(r) === today || (r.job.status === 'waiting' && day(r) < today)),
      later: jobs.filter(r => r.job.status === 'waiting' && day(r) > today)
    };
  }

  /* 次に予定がある時刻（デモの「時刻を進める」）。無ければ '' */
  function nextDue(state, nowJst) {
    const later = (state.jobs || []).filter(j => j.status === 'waiting' && j.due > nowJst).map(j => j.due).sort();
    return later[0] || '';
  }

  /* 1 件の予約の流れ（画面の B）。起きたことと、これから起きる予定を時刻の順に */
  function timeline(state, bookingId) {
    const b = bookingOf(state, bookingId);
    if (!b) return [];
    const items = [];
    const added = state.log.find(e => e.act === 'add' && e.kind === 'booking' && e.id === bookingId);
    if (added) items.push({ at: added.at, kind: 'added', who: added.who });
    (state.outbox || []).filter(o => o.bookingId === bookingId).forEach(o => items.push({ at: o.at, kind: 'out', out: o }));
    (state.jobs || []).filter(j => j.bookingId === bookingId && j.status === 'waiting').forEach(j => items.push({ at: '', due: j.due, kind: 'plan', job: j }));
    const key = (x) => x.at || `~${x.due}`;   // 起きたことを先に、予定を後に
    return items.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  }

  R.rosterAuto = { REMIND_AT, EVE_AT, MORNING_AT, LINK_MARK, dayAdd, missingPeople, needToday, message, planJobs, addFromReading, addFromForm, runDue, markSent, nextDue, timeline, compactPast, KEEP_DONE_DAYS,
    RESENT, CONFIRMED, resendProblem, resend, confirmSent, board };
})();
