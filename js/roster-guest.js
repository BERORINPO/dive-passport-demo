/* お客さんが自分で入れる所（純ロジック）。保存・通信・画面・時計は知らない。
   お店が送ったリンクから開いた人が、その予約の人の「まだ」の所だけを入れる。パスポートからも入れられる。
   お店や AI が入れた所は書き換えない。一部だけ入っている欄（緊急時の連絡先・C カード）は、空の所だけを入れる。
   健康の答え（既往症・当日の体調）は、同意のうえで入れ、同意した日と同意の文の版を名簿に残す。AI には渡さない
   （AI に渡す物は roster-schema.js が決める） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  /* 同意の文の版。文を変えたら、ここも変える（名簿に残り、どの文に同意したかを後で示せる）。
     目的を足すなど前の同意が使えなくなる変え方をしたら、古い版を VALID_CONSENT から外す（同意し直してもらう） */
  const CONSENT_VER = '2026-10-21';
  const VALID_CONSENT = [CONSENT_VER];
  /* 長さの上限は roster-schema.js の人の形と同じ */
  const ADDRESS_MAX = 120;
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
  const blank = (v) => !String(v == null ? '' : v).trim();

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
  /* 聞く所。緊急時の連絡先は、名前か電話が欠けていたら組ごと聞き直して入れ替える（片方だけ別の人の値が混ざらないように）。
     C カードは、分かっている方を残して空の方だけを聞き、片方だけ入れたら自信なしの印を付ける（お店が確かめる） */
  function openParts(p) {
    const e = p.emergency;
    return {
      emergency: blank(e.name) || blank(e.phone) ? [...S().SUB.emergency] : [],
      cert: [p.cert.course === '' && 'course', p.cert.course !== 'NONE' && !isMonth(p.cert.date) && 'date'].filter(Boolean),
      course: p.cert.course,
      date: p.cert.date
    };
  }

  const consented = (p) => isDay(p.health.consentAt || '') && VALID_CONSENT.includes(p.health.consentVer);
  /* 組の片方だけを入れたか（もう片方は前から入っていた） */
  const halfCert = (patch, parts) => !!patch.cert && Object.keys(patch.cert).length === 1 && parts.cert.length === 1;

  /* 予約 1 件と、その人ごとの「まだ」の所。ask は入力の欄で聞く項目、needsToday は当日の体調がまだか */
  function guestView(state, bookingId) {
    const booking = state.bookings.find(b => b.id === bookingId);
    if (!booking) return null;
    const trip = state.trips.find(t => t.id === booking.tripId) || null;
    const items = S().ITEMS[trip ? trip.kind : 'dive'];
    const people = state.people.filter(p => p.bookingId === bookingId).map(person => {
      const missing = C().askGuest(person, trip);
      const known = items.filter(i => !i.trip && !i.health && C().filled(person, trip, i.key)).map(i => i.key);
      return { person, ask: missing.filter(k => k !== TODAY_KEY), needsToday: missing.includes(TODAY_KEY), known,
        parts: openParts(person), consented: consented(person) };
    });
    return { booking, trip, people, items };
  }

  const entryOf = (state, id) => {
    const person = state.people.find(p => p.id === id);
    if (!person) throw new Error(`お客さんの入力: 人が見つからない (${id})`);
    return guestView(state, person.bookingId).people.find(v => v.person.id === id);
  };
  /* 乗り合いの他のお店が健康の答えを持つ人。この店では健康の答えを入れない。
     applyGuest・applyPassport では、askGuest が健康を聞かないので今は届かない（後から入口が増えたときの守り） */
  const held = (entry) => C().isHeld(entry.person);

  /* ---------- 入力の欄 ---------- */
  /* 入力の形: { birthDate, address, emergency: { name, relation, phone }, cert: { course, date }, courses, dives, lastDive, answers, consent }
     聞いた項目（ask）と、一部だけ入っている欄の空の所（parts）だけを見る。返すのは、直してほしい項目の名前の一覧 */
  function guestProblems(input, ask, parts) {
    const x = input || {};
    const e = x.emergency || {};
    const c = x.cert || {};
    const open = parts || { emergency: S().SUB.emergency, cert: ['course', 'date'], course: '' };
    const wants = (k) => ask.includes(k);
    const openE = (k) => open.emergency.includes(k);
    const courseOpen = (wants('certDate') || wants('courses')) && open.cert.includes('course');
    const course = courseOpen ? c.course : open.course;
    return [
      wants('birthDate') && !isDay(x.birthDate) && 'birthDate',
      wants('address') && !text(x.address, ADDRESS_MAX) && 'address',
      wants('emergency') && !((!openE('name') || text(e.name, NAME_MAX)) && (!openE('phone') || text(e.phone, PHONE_MAX)) &&
        (!openE('relation') || (typeof (e.relation || '') === 'string' && (e.relation || '').length <= RELATION_MAX))) && 'emergency',
      /* 取得年月が分かっている人は「なし（体験）」を選べない（年月のある体験、という形を作らない） */
      courseOpen && !(S().COURSES.includes(c.course) && c.course !== '' && !(c.course === 'NONE' && isMonth(open.date))) && 'cert',
      wants('certDate') && open.cert.includes('date') && course !== 'NONE' && !isMonth(c.date) && 'certDate',
      wants('courses') && typeof x.courses === 'string' && x.courses.length > COURSES_MAX && 'courses',
      wants('dives') && !(Number.isInteger(x.dives) && x.dives >= 0 && x.dives <= DIVES_MAX) && 'dives',
      wants('lastDive') && !(x.dives === 0 && wants('dives')) && !isMonth(x.lastDive) && 'lastDive',
      wants('history') && !(Array.isArray(x.answers) && x.answers.length === S().HEALTH_QUESTIONS &&
        x.answers.every(a => a === 'yes' || a === 'no')) && 'history',
      wants('history') && x.consent !== true && 'consent'
    ].filter(Boolean);
  }

  /* 入力を、人の項目に直す。聞いた項目の、空の所だけ。既往症の答えは、答えた日と同意と一緒に入れる */
  function guestPatch(input, ask, today, parts) {
    const x = input;
    const open = parts || { emergency: S().SUB.emergency, cert: ['course', 'date'], course: '' };
    const patch = {};
    if (ask.includes('birthDate')) patch.birthDate = x.birthDate;
    if (ask.includes('address')) patch.address = x.address.trim();
    if (ask.includes('emergency') && open.emergency.length) {
      patch.emergency = Object.fromEntries(open.emergency.map(k => [k, String(x.emergency[k] || '').trim()]));
    }
    if (ask.includes('certDate') || ask.includes('courses')) {
      const cert = {};
      if (open.cert.includes('course')) cert.course = x.cert.course;
      const course = cert.course || open.course;
      if (ask.includes('certDate') && open.cert.includes('date')) cert.date = course === 'NONE' ? '' : x.cert.date;
      if (Object.keys(cert).length) patch.cert = cert;
    }
    if (ask.includes('courses') && typeof x.courses === 'string' && x.courses.trim()) patch.courses = x.courses.trim();
    if (ask.includes('dives')) patch.dives = x.dives;
    if (ask.includes('lastDive') && isMonth(x.lastDive)) patch.lastDive = x.lastDive;
    if (ask.includes('history')) patch.health = { answers: [...x.answers], historyAt: today, consentAt: today, consentVer: CONSENT_VER };
    return patch;
  }

  /* お客さんが入れた。形が合わなければ { problems } を返し、state は変えない */
  function applyGuest(state, { id, input, today, at }) {
    if (!DAY.test(today)) throw new Error(`applyGuest: today は YYYY-MM-DD (${today})`);
    const entry = entryOf(state, id);
    const problems = guestProblems(input, entry.ask, entry.parts);
    if (problems.length) return { state, problems };
    const patch = guestPatch(input, entry.ask, today, entry.parts);
    if (patch.health && held(entry)) return { state, problems: ['held'] };
    const markUnsure = halfCert(patch, entry.parts) ? ['cert'] : [];
    return { state: C().editPerson(state, { id, patch, who: 'guest', src: 'guest', at, markUnsure }), problems: [] };
  }

  /* 当日の体調。day は答えた日。同意がまだなら consent が要る。
     demo は「デモで当日として答えた」印で、記録に残す（本物では Worker の時計で day を決める。plan/meibo.md） */
  function answerToday(state, { id, answer, day, consent, today, demo, at }) {
    if (!['ok', 'unwell'].includes(answer)) throw new Error(`answerToday: answer は ok / unwell (${answer})`);
    if (!DAY.test(day)) throw new Error(`answerToday: day は YYYY-MM-DD (${day})`);
    const entry = entryOf(state, id);
    if (held(entry)) return { state, problems: ['held'] };
    if (!entry.consented && consent !== true) return { state, problems: ['consent'] };
    const agree = entry.consented ? {} : { consentAt: DAY.test(today || '') ? today : day, consentVer: CONSENT_VER };
    return { state: C().editPerson(state, { id, patch: { health: { today: answer, todayAt: day, ...agree } }, who: 'guest', src: 'guest', at, demo: demo === true }),
      problems: [] };
  }

  /* ---------- パスポートから ---------- */
  /* C カードの名前（自由に書いた字・略した字）から、名簿の講習の記号にする。いちばん上の講習を選ぶ */
  const COURSE_WORDS = [
    ['DM', /dive\s*master|divemaster|ダイブ[\s・･]*マスター|\bDM\b/i],
    ['RESCUE', /rescue|レスキュー/i],
    ['AOW', /advanced|アドバンス|\bAOW\b/i],
    ['JOW', /junior|ジュニア|\bJOW\b/i],
    ['OW', /open[\s・･-]*water|オープン[\s・･]*ウォーター|\bOW\b/i]
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
      items.push({ key: 'cert', level: top.level, date: top.date, certs: certs.map(c => ({ course: c.course, date: isMonth(c.date) ? c.date : '', level: c.level })),
        patch: { cert: { course: top.course, date: isMonth(top.date) ? top.date : '' } } });
    }
    if (pass.dives !== '' && pass.dives !== undefined) {
      items.push({ key: 'dives', dives: pass.dives, lastDive: pass.lastDive,
        patch: { dives: pass.dives, ...(isMonth(pass.lastDive) ? { lastDive: pass.lastDive } : {}) } });
    }
    const m = pass.medical;
    const answered = m.form === R.pass.FORM && m.answers.length === S().HEALTH_QUESTIONS && m.answers.every(a => a === 'yes' || a === 'no');
    if (answered && DAY.test(m.answeredAt) && DAY.test(today)) {
      const days = daysBetween(m.answeredAt, today);
      const fresh = days >= 0 && days <= maxDays;
      items.push({ key: 'history', answeredAt: m.answeredAt, days, old: !fresh,
        patch: fresh ? { health: { answers: [...m.answers], historyAt: m.answeredAt } } : null });
    }
    return { items, name: pass.name };
  }

  /* パスポートの物を、この人の「まだ」の所に合わせて絞る。分かっている所は入れない（C カードの講習、本数など）。
     C カードの片方だけを入れるときは、名簿にある方と同じカード（講習か取得年月が同じ物）からだけ取る */
  const sameMonth = (a, b) => isMonth(a) && isMonth(b) && a.slice(0, 7) === b.slice(0, 7);
  function narrow(item, entry) {
    const ask = entry.ask;
    if (item.key === 'cert') {
      if (!(ask.includes('certDate') || ask.includes('courses'))) return null;
      const open = entry.parts.cert;
      const wantDate = ask.includes('certDate') && open.includes('date');
      if (open.includes('course') && (wantDate || !isMonth(entry.parts.date))) return item.patch;   // どちらも空: 一番上のカードを組で
      if (open.includes('course')) {
        const card = item.certs.find(c => sameMonth(c.date, entry.parts.date));
        return card ? { cert: { course: card.course } } : null;
      }
      if (wantDate && entry.parts.course !== 'NONE') {
        const card = item.certs.find(c => c.course === entry.parts.course && isMonth(c.date));
        return card ? { cert: { date: card.date } } : null;
      }
      return null;
    }
    if (item.key === 'dives') {
      const p = {};
      if (ask.includes('dives')) p.dives = item.patch.dives;
      if (ask.includes('lastDive') && item.patch.lastDive) p.lastDive = item.patch.lastDive;
      return Object.keys(p).length ? p : null;
    }
    return ask.includes('history') ? item.patch : null;
  }

  /* パスポートと名簿の名前が、両方あって同じか。どちらかが空なら、同じ人とは確かめられない */
  const namesMatch = (offer, person) => !!offer.name && !!person.name && C().sameName(offer.name, person.name);
  function passportSameName(state, { id, offer }) {
    return namesMatch(offer, entryOf(state, id).person);
  }

  /* この人に入れられる物（選ぶ画面に出す物）。名前が同じと確かめられないと、健康の答えは入れられない（別の人の答えが名簿に入るのを防ぐ） */
  function passportChoices(state, { id, offer }) {
    const entry = entryOf(state, id);
    const sameName = namesMatch(offer, entry.person);
    return offer.items.map(i => {
      const patch = i.patch ? narrow(i, entry) : null;
      const blocked = i.key === 'history' && !sameName ? 'name' : i.old ? 'old' : !patch ? 'none' : '';
      return { ...i, patch: blocked ? null : patch, blocked };
    }).filter(i => i.blocked !== 'none');
  }

  /* 選んだ物だけを入れる。出どころは「パスポート」、した人は「お客さん」。
     名前が違うときは otherName（この人に入れる、の印）が要る。健康の答えを入れるときは、同意がまだなら consent が要る */
  function applyPassport(state, { id, offer, keys, otherName, consent, today, at }) {
    const entry = entryOf(state, id);
    const sameName = namesMatch(offer, entry.person);
    const chosen = passportChoices(state, { id, offer }).filter(i => keys.includes(i.key) && i.patch);
    const problems = [
      !sameName && otherName !== true && 'name',
      chosen.some(i => i.key === 'history') && !entry.consented && consent !== true && 'consent'
    ].filter(Boolean);
    if (problems.length || !chosen.length) return { state, problems };
    const patch = chosen.reduce((acc, i) => ({ ...acc, ...i.patch }), {});
    if (patch.health && held(entry)) return { state, problems: ['held'] };
    if (patch.health && !entry.consented) patch.health = { ...patch.health, consentAt: DAY.test(today || '') ? today : patch.health.historyAt, consentVer: CONSENT_VER };
    const markUnsure = halfCert(patch, entry.parts) ? ['cert'] : [];
    return { state: C().editPerson(state, { id, patch, who: 'guest', src: 'passport', at, markUnsure }), problems: [] };
  }

  R.rosterGuest = { CONSENT_VER, VALID_CONSENT, TODAY_KEY, guestView, openParts, guestProblems, guestPatch, applyGuest, answerToday, courseOf,
    passportOffer, passportChoices, passportSameName, applyPassport, daysBetween };
})();
