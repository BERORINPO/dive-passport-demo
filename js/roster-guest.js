/* お客さんが自分で入れる所（純ロジック）。保存・通信・画面・時計は知らない。
   お店が送ったリンクから開いた人が、その予約の人の「まだ」の所だけを入れる。パスポートからも入れられる。
   健康の答え（既往症・当日の体調）は、ここで入れて名簿に残すだけで、AI には渡さない（AI に渡す物は roster-schema.js が決める） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  const ADDRESS_MAX = 200;
  const NAME_MAX = 60;
  const PHONE_MAX = 30;
  const RELATION_MAX = 20;
  const COURSES_MAX = 120;
  const DIVES_MAX = 100000;
  /* 「当日の健康状態」は入力の欄でなく、当日の朝に別に答える */
  const TODAY_KEY = 'today';

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const MONTH_ONLY = /^\d{4}-\d{2}$/;
  const isDay = (v) => typeof v === 'string' && DAY.test(v) && S().realDate(v);
  const isMonth = (v) => typeof v === 'string' && (MONTH_ONLY.test(v) || DAY.test(v)) && S().realDate(v);
  const text = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

  /* 日付の数（1970-01-01 からの日数）。時計を使わずに数える（暦の式） */
  function dayNumber(ymd) {
    const [y0, m, d] = ymd.split('-').map(Number);
    const y = m <= 2 ? y0 - 1 : y0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }
  const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

  /* ---------- 開いたリンクの中身 ---------- */
  /* 予約 1 件と、その人ごとの「まだ」の所。ask は入力の欄で聞く項目、needsToday は当日の体調がまだか */
  function guestView(state, bookingId) {
    const booking = state.bookings.find(b => b.id === bookingId);
    if (!booking) return null;
    const trip = state.trips.find(t => t.id === booking.tripId) || null;
    const items = S().ITEMS[trip ? trip.kind : 'dive'];
    const people = state.people.filter(p => p.bookingId === bookingId).map(person => {
      const missing = C().askGuest(person, trip);
      const known = items.filter(i => !i.trip && !i.health && C().filled(person, trip, i.key)).map(i => i.key);
      return { person, ask: missing.filter(k => k !== TODAY_KEY), needsToday: missing.includes(TODAY_KEY), known };
    });
    return { booking, trip, people, items };
  }

  /* ---------- 入力の欄 ---------- */
  /* 入力の形: { birthDate, address, emergency: { name, relation, phone }, cert: { course, date }, courses, dives, lastDive, answers }
     聞いた項目（ask）の所だけを見る。返すのは、直してほしい項目の名前の一覧 */
  function guestProblems(input, ask) {
    const x = input || {};
    const e = x.emergency || {};
    const c = x.cert || {};
    const wants = (k) => ask.includes(k);
    const certNeeded = wants('certDate') || wants('courses');
    const noCard = c.course === 'NONE';
    return [
      wants('birthDate') && !isDay(x.birthDate) && 'birthDate',
      wants('address') && !text(x.address, ADDRESS_MAX) && 'address',
      wants('emergency') && !(text(e.name, NAME_MAX) && text(e.phone, PHONE_MAX) &&
        typeof e.relation === 'string' && e.relation.length <= RELATION_MAX) && 'emergency',
      certNeeded && !(S().COURSES.includes(c.course) && c.course !== '') && 'cert',
      wants('certDate') && !noCard && !isMonth(c.date) && 'certDate',
      wants('courses') && typeof x.courses === 'string' && x.courses.length > COURSES_MAX && 'courses',
      wants('dives') && !(Number.isInteger(x.dives) && x.dives >= 0 && x.dives <= DIVES_MAX) && 'dives',
      wants('lastDive') && !(x.dives === 0 && wants('dives')) && !isMonth(x.lastDive) && 'lastDive',
      wants('history') && !(Array.isArray(x.answers) && x.answers.length === S().HEALTH_QUESTIONS &&
        x.answers.every(a => a === 'yes' || a === 'no')) && 'history'
    ].filter(Boolean);
  }

  /* 入力を、人の項目に直す。聞いた項目の所だけ。既往症の答えは、答えた日（today）と一緒に入れる */
  function guestPatch(input, ask, today) {
    const x = input;
    const patch = {};
    if (ask.includes('birthDate')) patch.birthDate = x.birthDate;
    if (ask.includes('address')) patch.address = x.address.trim();
    if (ask.includes('emergency')) {
      patch.emergency = { name: x.emergency.name.trim(), relation: (x.emergency.relation || '').trim(), phone: x.emergency.phone.trim() };
    }
    /* 取得年月を聞いたときは講習と年月を入れ直す。講習だけを聞いたときは、AI が読んだ年月を残す（cert の一部だけ直す） */
    if (ask.includes('certDate')) patch.cert = { course: x.cert.course, date: x.cert.course === 'NONE' ? '' : x.cert.date };
    else if (ask.includes('courses')) patch.cert = { course: x.cert.course };
    if (ask.includes('courses') && typeof x.courses === 'string' && x.courses.trim()) patch.courses = x.courses.trim();
    if (ask.includes('dives')) patch.dives = x.dives;
    if (ask.includes('lastDive') && isMonth(x.lastDive)) patch.lastDive = x.lastDive;
    if (ask.includes('history')) patch.health = { answers: [...x.answers], historyAt: today };
    return patch;
  }

  /* お客さんが入れた。形が合わなければ { problems } を返し、state は変えない */
  function applyGuest(state, { id, input, today, at }) {
    if (!DAY.test(today)) throw new Error(`applyGuest: today は YYYY-MM-DD (${today})`);
    const person = state.people.find(p => p.id === id);
    if (!person) throw new Error(`applyGuest: 人が見つからない (${id})`);
    const view = guestView(state, person.bookingId);
    const ask = view.people.find(v => v.person.id === id).ask;
    const problems = guestProblems(input, ask);
    if (problems.length) return { state, problems };
    const patch = guestPatch(input, ask, today);
    return { state: C().editPerson(state, { id, patch, who: 'guest', src: 'guest', at }), problems: [] };
  }

  /* 当日の体調。day は答えた日（当日の朝に答える。デモでは便の日として答えられる） */
  function answerToday(state, { id, answer, day, at }) {
    if (!['ok', 'unwell'].includes(answer)) throw new Error(`answerToday: answer は ok / unwell (${answer})`);
    if (!DAY.test(day)) throw new Error(`answerToday: day は YYYY-MM-DD (${day})`);
    return C().editPerson(state, { id, patch: { health: { today: answer, todayAt: day } }, who: 'guest', src: 'guest', at });
  }

  /* ---------- パスポートから ---------- */
  /* C カードの名前（自由に書いた字）から、名簿の講習の記号にする。いちばん上の講習を選ぶ */
  const COURSE_WORDS = [
    ['DM', /dive\s*master|divemaster|ダイブマスター/i], ['RESCUE', /rescue|レスキュー/i],
    ['AOW', /advanced|アドバンス/i], ['JOW', /junior|ジュニア/i], ['OW', /open\s*water|オープン\s*ウォーター/i]
  ];
  const RANK = ['DM', 'RESCUE', 'AOW', 'OW', 'JOW', 'OTHER'];
  function courseOf(level) {
    const hit = COURSE_WORDS.find(([, re]) => re.test(level || ''));
    return hit ? hit[0] : 'OTHER';
  }

  /* パスポートから入れられる物。お客さんが選んでから入れる。
     既往症の答えは、同じ質問票で全部答えてあり、お店の決まり（maxDays 日）より新しいときだけ */
  function passportOffer(pass, { today, maxDays }) {
    if (!pass || !R.pass.validate(pass).ok) return { items: [], name: '' };
    const items = [];
    const certs = pass.certs.map(c => ({ ...c, course: courseOf(c.level) }))
      .sort((a, b) => RANK.indexOf(a.course) - RANK.indexOf(b.course));
    if (certs.length) {
      const top = certs[0];
      items.push({ key: 'cert', level: top.level, date: top.date, patch: { cert: { course: top.course, date: isMonth(top.date) ? top.date : '' } } });
    }
    if (pass.dives !== '' && pass.dives !== undefined) {
      items.push({ key: 'dives', dives: pass.dives, lastDive: pass.lastDive,
        patch: { dives: pass.dives, ...(isMonth(pass.lastDive) ? { lastDive: pass.lastDive } : {}) } });
    }
    const m = pass.medical;
    const answered = m.form === R.pass.FORM && m.answers.length === S().HEALTH_QUESTIONS && m.answers.every(a => a === 'yes' || a === 'no');
    if (answered && DAY.test(m.answeredAt) && DAY.test(today)) {
      const days = daysBetween(m.answeredAt, today);
      if (days >= 0 && days <= maxDays) {
        items.push({ key: 'history', answeredAt: m.answeredAt, days, patch: { health: { answers: [...m.answers], historyAt: m.answeredAt } } });
      } else {
        items.push({ key: 'history', answeredAt: m.answeredAt, days, old: true, patch: null });
      }
    }
    return { items, name: pass.name };
  }

  /* 選んだ物だけを入れる。出どころは「パスポート」、した人は「お客さん」 */
  function applyPassport(state, { id, offer, keys, at }) {
    const chosen = offer.items.filter(i => keys.includes(i.key) && i.patch);
    if (!chosen.length) return state;
    const patch = chosen.reduce((acc, i) => ({ ...acc, ...i.patch }), {});
    return C().editPerson(state, { id, patch, who: 'guest', src: 'passport', at });
  }

  R.rosterGuest = { TODAY_KEY, guestView, guestProblems, guestPatch, applyGuest, answerToday, courseOf, passportOffer, applyPassport, daysBetween };
})();
