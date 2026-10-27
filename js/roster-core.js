/* 名簿の判定と組み立て（純ロジック）。保存・通信・画面・時計は知らない。
   受け取るのは state と、日時の文字（at）と id を作る関数（newId）。返すのは新しい state か値で、受け取った物は変えない。
   条例の項目は roster-schema.js の ITEMS */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;

  const COURSE_JA = { OW: 'オープンウォーター', AOW: 'アドバンスド', RESCUE: 'レスキュー', JOW: 'ジュニア',
    DM: 'ダイブマスター', OTHER: 'その他', NONE: 'なし（体験）' };
  const FIELD_OF = { certDate: 'cert', courses: 'cert' };      // 名簿の項目 → 人の項目（unsure と src の名前）
  const SIMPLE = ['name', 'birthDate', 'phone', 'address', 'dives', 'lastDive'];
  const AI_SRC = ['mail', 'paper', 'ccard'];
  const EDIT_WHO = ['staff', 'guest', 'system'];                 // 人やお店が直すときの「した人」
  const EDIT_SRC = ['guest', 'staff', 'passport', 'partner'];    // 人やお店が直すときの「出どころ」
  const BOOKING_FIELDS = ['source', 'site', 'ref', 'leadName', 'leadPhone', 'leadEmail', 'lang', 'people', 'shop', 'note'];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* 中身が同じか（key の順は問わない） */
  function same(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every(k => has(b, k) && same(a[k], b[k]));
  }
  const MONTH = /^\d{4}-\d{2}/;                                 // 月まで分かっていれば、日は無くてよい項目

  /* ---------- 探す ---------- */
  const bookingsOf = (state, tripId) => state.bookings.filter(b => b.tripId === tripId);
  /* 乗り合いの他のお店の予約（出どころ partner。shop にそのお店の名前） */
  const isPartnerBooking = (b) => b.source === 'partner';
  /* 健康の答えを乗り合いの他のお店が持っている人（この店は答えを持たない） */
  const isHeld = (p) => !!p.health.heldBy;
  /* own: 乗り合いの他のお店の予約を除く。条例の名簿は、お店ごとに自分のお客さんの分を作る */
  function peopleOf(state, tripId, { own } = {}) {
    const ids = new Set(bookingsOf(state, tripId).filter(b => !own || !isPartnerBooking(b)).map(b => b.id));
    return state.people.filter(p => ids.has(p.bookingId));
  }
  function tripOf(state, person) {
    const b = state.bookings.find(x => x.id === person.bookingId);
    return b ? state.trips.find(t => t.id === b.tripId) || null : null;
  }

  /* 名前の比べ方: 全角半角・大文字小文字・記号をそろえ、空白の有無と、姓と名の順の違いは同じとみなす */
  function nameKeys(s) {
    const t = String(s || '').normalize('NFKC').toLowerCase().replace(/[-,.・'’]/g, '');
    const words = t.split(/\s+/).filter(Boolean);
    return words.length ? [words.join(''), [...words].sort().join(' ')] : [];
  }
  function sameName(a, b) {
    const [ja, sa] = nameKeys(a);
    const [jb, sb] = nameKeys(b);
    return !!ja && (ja === jb || sa === sb);
  }
  /* 1 人だけ当てはまるときだけ返す。いない・2 人以上なら null（お店に選んでもらう） */
  function findByName(people, name) {
    const hits = people.filter(p => sameName(p.name, name));
    return hits.length === 1 ? hits[0] : null;
  }

  /* ---------- そろっているか ---------- */
  function filled(p, trip, key) {
    switch (key) {
      case 'name': return p.name.trim() !== '';
      case 'birthDate': return /^\d{4}-\d{2}-\d{2}$/.test(p.birthDate);
      case 'address': return p.address.trim() !== '';
      case 'emergency': return p.emergency.name.trim() !== '' && p.emergency.phone.trim() !== '';
      case 'certDate': return p.cert.course === 'NONE' || MONTH.test(p.cert.date);
      case 'courses': return p.courses.trim() !== '' || p.cert.course !== '';
      case 'dives': return p.dives !== '';
      case 'lastDive': return MONTH.test(p.lastDive) || p.dives === 0;
      case 'history': return isHeld(p) || (p.health.historyAt !== '' && p.health.answers.every(a => a !== null));
      /* 他のお店が確かめる人（heldBy）は、そのお店が便の日に「渡す」を押したら（todayAt がその日）そろう */
      case 'today': return !!trip && p.health.todayAt === trip.date && (isHeld(p) || p.health.today !== '');
      case 'when': return !!trip && trip.date !== '' && trip.start !== '';
      case 'site': return !!trip && trip.site.trim() !== '';
      case 'guide': return p.guide.trim() !== '' || (!!trip && trip.guides.length > 0);
      default: return false;
    }
  }

  /* missing: 空の項目。unsure: AI が自信なしと言い、まだ誰も確かめていない項目 */
  function status(p, trip) {
    const items = S().ITEMS[trip ? trip.kind : 'dive'];
    const missing = items.filter(i => !filled(p, trip, i.key)).map(i => i.key);
    const unsure = items.filter(i => !i.trip && !i.health && filled(p, trip, i.key) &&
      p.unsure.includes(FIELD_OF[i.key] || i.key)).map(i => i.key);
    return { missing, unsure, done: missing.length === 0 && unsure.length === 0 };
  }

  /* お客さんに聞く項目（便とお店が決める項目は除く） */
  function askGuest(p, trip) {
    const items = S().ITEMS[trip ? trip.kind : 'dive'];
    const heldKey = (k) => isHeld(p) && (k === 'history' || k === 'today');   // 健康は他のお店が確かめる人には聞かない
    return status(p, trip).missing.filter(k => !items.find(i => i.key === k).trip && !heldKey(k));
  }

  function tripSummary(state, tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    const people = peopleOf(state, tripId);
    return {
      booked: bookingsOf(state, tripId).reduce((n, b) => n + b.people, 0),
      listed: people.length,
      done: people.filter(p => status(p, trip).done).length
    };
  }

  /* ---------- 記録（足すだけ。消さない、書き換えない） ---------- */
  const entry = (at, who, act, kind, id, extra) => ({ at, who, act, kind, id, fields: [], before: {}, after: {}, sent: null, ...extra });
  const withLog = (state, ...entries) => ({ ...state, log: [...state.log, ...entries] });
  const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));

  /* AI に送った記録。量と、塗った印と、健康の情報が見えたかだけで、中身は残さない */
  function logAi(state, { at, sent }) {
    if (!sent) return state;   // 送る前に断ったときは、送った記録も無い
    const { doc, size, masked, mode, healthSeen, redacted } = sent;
    return withLog(state, entry(at, 'ai', 'ai', 'state', '', { sent: { doc, size, masked, mode, healthSeen, redacted } }));
  }

  /* ---------- AI の読み取りを人に入れる ----------
     空の所だけ埋め、人やお店が入れた所は上書きしない。人やお店がわざと空にした項目（出どころがあるのに空）は埋めない。
     人やお店が一部だけ入れていた項目の空の所を埋めたときは、出どころを変えない。元の出どころが AI なら、新しい読み取りに替える。
     AI が自信なしと言った項目は、埋めたら必ず自信なしの印を付ける（お店が確かめるまで「そろった」にしない） */
  const blankValue = (v) => v === '' || v == null;
  const isBlank = (p, field) => (S().SUB[field] ? S().SUB[field].every(k => blankValue(p[field][k])) : blankValue(p[field]));
  const clearedByPerson = (p, field) => has(p.src, field) && !AI_SRC.includes(p.src[field]) && isBlank(p, field);

  function fillParts(p, read, key) {
    const keys = S().SUB[key].filter(k => blankValue(p[key][k]) && !blankValue(read[key][k]));
    return keys.length ? { ...p[key], ...pick(read[key], keys) } : null;
  }

  /* 緊急連絡先は名前と電話の組。空なら読み取りをそのまま入れ、一部だけ入っているときは同じ人だと分かるときだけ空の所を埋める
     （同じ名前か、名前が空で電話が同じ）。別の人の電話を混ぜない */
  function fillEmergency(p, read) {
    if (isBlank(p, 'emergency')) return fillParts(p, read, 'emergency');
    const pe = p.emergency;
    const re = read.emergency;
    const samePerson = pe.name ? !!re.name && sameName(pe.name, re.name) : !!pe.phone && pe.phone === re.phone;
    return samePerson ? fillParts(p, read, 'emergency') : null;
  }

  /* C カードのコースと取得日は組で扱う。違うコースの日を混ぜない */
  function fillCert(p, read) {
    const pc = p.cert;
    const rc = read.cert;
    if (pc.course && pc.date) return null;
    if (!pc.course && !pc.date) return rc.course || rc.date ? { course: rc.course, date: rc.date } : null;
    if (pc.course) return pc.course === rc.course && rc.date ? { course: pc.course, date: rc.date } : null;
    return rc.course && rc.date === pc.date ? { course: rc.course, date: pc.date } : null;
  }

  function mergeReading(p, read, src) {
    const next = { ...p, src: { ...p.src } };
    const got = [];
    const put = (field, value) => {
      if (value == null || clearedByPerson(p, field)) return;   // 潜った本数の 0 も値
      next[field] = value;
      got.push(field);
      if (isBlank(p, field) || AI_SRC.includes(p.src[field])) next.src[field] = src;
    };
    SIMPLE.forEach(f => { if (blankValue(p[f]) && !blankValue(read[f])) put(f, read[f]); });
    put('emergency', fillEmergency(p, read));
    put('sizes', fillParts(p, read, 'sizes'));
    put('cert', fillCert(p, read));
    next.unsure = [...new Set([...p.unsure, ...read.unsure.filter(u => got.includes(u))])];
    return { person: next, fields: got };
  }

  /* ---------- 便 ----------
     便は「日付・開始時刻・ツアー」で 1 つ。予約をどの便に入れるかはお店が画面で決める（ここは候補を出すだけ）。
     候補: 同じ日・同じ種類で開始時刻まで同じ便があればそれ。時刻の分からない予約は、その日・その種類の便が 1 つだけならそれ */
  const TRIP_FIELDS = ['date', 'start', 'kind', 'tour', 'boat', 'site', 'guides', 'host', 'partners'];
  const SNORKEL = /snorkel|スノーケ|シュノーケ|すのーけ|しゅのーけ/i;   // スノーケリング・シュノーケル体験 なども
  const kindOf = (tour) => (SNORKEL.test(String(tour || '')) ? 'snorkel' : 'dive');
  const byStart = (a, b) => (a.start || '99:99').localeCompare(b.start || '99:99');

  /* 便の一覧（日付、開始時刻の順。時刻の決まっていない便はその日の最後） */
  const tripList = (state) => [...state.trips].sort((a, b) => a.date.localeCompare(b.date) || byStart(a, b));

  /* kind はお店が選んだ種類。空ならツアーの名前から決める */
  function suggestTrip(state, { date, start, tour, kind: chosen }) {
    const kind = chosen || kindOf(tour);
    const candidates = state.trips.filter(t => t.date === date && t.kind === kind).sort(byStart);
    const exact = start ? candidates.find(t => t.start === start) : null;
    const tripId = exact ? exact.id : !start && candidates.length === 1 ? candidates[0].id : null;
    return { kind, candidates, tripId };
  }

  function addTrip(state, { trip, at, newId }) {
    const fields = TRIP_FIELDS.filter(k => has(trip, k) && trip[k] !== undefined);
    const t = { ...S().blankTrip(), ...pick(trip, fields), id: newId(), createdAt: at };
    const v = S().validateTrip(t);
    if (!v.ok) throw new Error(`addTrip: 便の形が合わない (${v.errors.join(',')})`);
    return { state: withLog({ ...state, trips: [...state.trips, t] }, entry(at, 'staff', 'add', 'trip', t.id, { fields })), trip: t };
  }

  /* 予約を便に入れる。tripId の便が無ければ、want（日付・時刻・ツアー・種類）から便を作ってから入れる */
  function addBookingToTrip(state, { tripId, want, booking, reading, src, at, newId }) {
    let st = state;
    let trip = st.trips.find(t => t.id === tripId);
    if (!trip) {
      const made = addTrip(st, { trip: { date: want.date, start: want.start || '', kind: want.kind || kindOf(want.tour),
        tour: String(want.tour || '').slice(0, 40) }, at, newId });
      st = made.state;
      trip = made.trip;
    }
    return { state: addBooking(st, { trip, booking, reading, src, at, newId }), trip };
  }

  /* ---------- 自社の予約フォーム（予約前の確認、js/intake.js）から（決定ログ form-to-roster） ---------- */
  /* 予約前の確認で送られた中身を、予約の一覧と名簿に入れる形にする。名簿に入れるのは代表者の名前と、ダイビングの経験だけ。
     健康の答えは入れない: 予約前の確認の同意は「参加できるかを確かめるためだけ・ツアーの 30 日後に消す」で、
     1 年残す条例の名簿とは使い道と残す長さが違う。名簿の健康の欄は、お客さんに聞く画面で本人が名簿の同意をして答える。
     tour は R.TOURS の 1 つ（日本語の名前・開始時刻・ダイビングか） */
  function bookingFromIntake(intake, tour) {
    const kind = tour.diving ? 'dive' : 'snorkel';
    const people = Number.isInteger(intake.people) ? Math.min(Math.max(intake.people, 1), S().MAX_PEOPLE) : 1;
    const lead = { name: String(intake.name || '').trim().slice(0, 60) };
    if (kind === 'dive' && intake.exp === 'first') Object.assign(lead, { dives: 0, cert: { course: 'NONE', date: '' } });
    if (kind === 'dive' && intake.exp === 'card' && /^\d{1,5}$/.test(String(intake.dives || ''))) lead.dives = Number(intake.dives);
    return {
      want: { date: intake.date, start: tour.start || '', tour: tour.name.ja, kind },
      booking: { source: 'form', leadName: lead.name, people },   // 出どころの名前（自社のフォーム）が画面に出るので、サイトの欄は空
      lead
    };
  }

  /* 予約前の確認を、同じ日・同じ種類・同じ開始時刻の便に入れる（無ければ便を作る）。{ state, bookingId } */
  function addFromIntake(state, { intake, tour, at, newId }) {
    const f = bookingFromIntake(intake, tour);
    const { tripId } = suggestTrip(state, f.want);
    const { state: st } = addBookingToTrip(state, { tripId, want: f.want, booking: f.booking, reading: null, src: 'guest', at, newId });
    const booking = st.bookings[st.bookings.length - 1];
    const lead = st.people.find(p => p.bookingId === booking.id);
    return { state: editPerson(st, { id: lead.id, patch: f.lead, who: 'guest', src: 'guest', at }), bookingId: booking.id };
  }

  /* AI の読み取りから、予約の形を組む */
  function bookingFromReading(reading) {
    const b = reading.booking || {};
    return { source: 'mail', site: b.site || '', ref: b.ref || '', leadName: b.leadName || '', leadPhone: b.leadPhone || '', leadEmail: b.leadEmail || '',
      people: Number.isInteger(b.people) && b.people >= 1 ? b.people : 1 };
  }

  /* 読み取りから予約を入れたら、お客さんに聞くことになる項目。予約を入れるときと同じ組み立てで数える */
  function missingForReading(reading, kind) {
    const trip = { ...S().blankTrip(), id: 'preview', kind, date: (reading.booking && reading.booking.date) || '' };
    let n = 0;
    const st = addBooking({ ...S().blankState(''), trips: [trip] },
      { trip, booking: bookingFromReading(reading), reading, src: 'mail', at: '', newId: () => `preview${(n += 1)}` });
    const people = peopleOf(st, trip.id);
    const keys = new Set(people.flatMap(p => askGuest(p, trip)));
    return { unknown: people.filter(p => !p.name).length, items: S().ITEMS[kind].filter(i => keys.has(i.key) && i.key !== 'name') };
  }

  /* 手で入れる予約の誤り。誤りのある項目の名前を返す（date / people / leadName / leadPhone / note） */
  function bookingProblems({ date, people, leadName, leadPhone, note }) {
    const b = { ...S().blankBooking(), id: 'check', tripId: 'check', leadName, leadPhone, people, note };
    const bad = S().validateBooking(b).errors.filter(e => ['people', 'leadName', 'leadPhone', 'note'].includes(e));
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && S().realDate(date);
    return [...(dateOk ? [] : ['date']), ...bad];
  }

  /* 確かめる画面の行。名簿の項目のうち読み取りで入る項目を、名簿と同じ書き方で、出どころと自信なしの印を付けて返す */
  const REVIEW_KEYS = ['name', 'birthDate', 'address', 'emergency', 'certDate', 'courses', 'dives', 'lastDive'];
  /* 名簿の項目に無くても AI が読む項目。自信なしの印があれば、確かめる画面に出す（見せないまま印を外さない） */
  const EXTRA_REVIEW = { phone: '電話', sizes: '身長・体重・足', cert: 'C カード' };
  function extraText(p, field) {
    if (field === 'phone') return p.phone;
    if (field === 'cert') return `${COURSE_JA[p.cert.course] || ''} ${p.cert.date}`.trim();
    const s = p.sizes;
    return [s.height !== '' && `${s.height} cm`, s.weight !== '' && `${s.weight} kg`, s.foot !== '' && `足 ${s.foot} cm`].filter(Boolean).join(' ');
  }
  function reviewRows(p, trip) {
    const rows = S().ITEMS[trip.kind].filter(i => REVIEW_KEYS.includes(i.key)).map(i => {
      const field = FIELD_OF[i.key] || i.key;
      return { key: i.key, field, label: i.ja, text: cellText(p, trip, i.key, []), src: p.src[field] || '',
        unsure: p.unsure.includes(field), filled: filled(p, trip, i.key) };
    });
    const shown = new Set(rows.map(r => r.field));
    const extra = p.unsure.filter(f => !shown.has(f) && has(EXTRA_REVIEW, f))
      .map(f => ({ key: f, field: f, label: EXTRA_REVIEW[f], text: extraText(p, f), src: p.src[f] || '', unsure: true, filled: true }));
    return [...rows, ...extra];
  }

  /* 確かめる必要がある人（AI が自信なしと言った所が残っている人）。便ごと */
  const toCheck = (state, tripId) => peopleOf(state, tripId).filter(p => p.unsure.length > 0);

  /* 予約の一覧の 1 便分。予約ごとに、人のそろい具合を付ける。
     heldToday: 当日の体調を他のお店が便の日に確かめるのを待っている（お客さんにも便の項目にも足りない物は無い） */
  function bookingRows(state, tripId) {
    const trip = state.trips.find(t => t.id === tripId) || null;
    return bookingsOf(state, tripId).map(b => {
      const people = state.people.filter(p => p.bookingId === b.id).map(p => {
        const st = status(p, trip);
        return { id: p.id, name: p.name, ...st, ask: askGuest(p, trip), heldToday: isHeld(p) && st.missing.includes('today') };
      });
      return { booking: b, people, done: people.filter(p => p.done).length };
    });
  }

  /* ---------- 予約を足す（読み取りから・手入力から）。名前の分からない人は空の行で人数分そろえる ---------- */
  function addBooking(state, { trip, booking, reading, src, at, newId }) {
    const given = booking || {};
    if (has(given, 'people') && given.people !== '' && given.people !== undefined && !Number.isInteger(given.people)) {
      throw new Error(`addBooking: 人数は数で渡す (${JSON.stringify(given.people)})`);
    }
    const fields = BOOKING_FIELDS.filter(k => has(given, k) && given[k] !== undefined);   // 予約の形の項目だけ拾う（読み取りの date や unsure を混ぜない）
    const b = { ...S().blankBooking(), ...pick(given, fields), id: newId(), tripId: trip.id, createdAt: at };
    const want = Number.isInteger(b.people) && b.people >= 1 ? Math.min(b.people, S().MAX_PEOPLE) : 1;
    const people = (reading ? reading.people : []).slice(0, S().MAX_PEOPLE)
      .map(r => mergeReading({ ...S().blankPerson(), id: newId(), bookingId: b.id }, r, src).person);
    while (people.length < want) people.push({ ...S().blankPerson(), id: newId(), bookingId: b.id });
    const fixed = { ...b, people: Math.max(want, people.length) };
    const v = S().validateBooking(fixed);
    if (!v.ok) throw new Error(`addBooking: 予約の形が合わない (${v.errors.join(',')})`);
    const who = AI_SRC.includes(src) ? 'ai' : src === 'guest' ? 'guest' : 'staff';   // guest: お客さんが自社の予約フォームから入れた
    return withLog(
      { ...state, bookings: [...state.bookings, fixed], people: [...state.people, ...people] },
      entry(at, who, 'add', 'booking', fixed.id, { fields }),
      ...people.map(p => entry(at, who, 'add', 'person', p.id, { fields: Object.keys(p.src) }))
    );
  }

  /* 写真の読み取り（C カード・申込書）を、決まった人に入れる。前と後を記録に残す */
  function applyReadingTo(state, { personId, read, src, at }) {
    const target = state.people.find(p => p.id === personId);
    if (!target) return null;
    const { person, fields } = mergeReading(target, read, src);
    if (!fields.length) return { state, personId, fields };
    return {
      state: withLog({ ...state, people: state.people.map(p => (p.id === personId ? person : p)) },
        entry(at, 'ai', 'edit', 'person', personId, { fields, before: pick(target, fields), after: pick(person, fields) })),
      personId, fields
    };
  }

  /* その便の自分の店のお客さんで、名前が 1 人だけ当てはまる人に入れる。当てはまらなければ null（画面でお店に選んでもらう）。
     乗り合いの他のお店のお客さんには入れない（自分の店の申込書だから） */
  function applyReading(state, { tripId, read, src, at }) {
    const target = findByName(peopleOf(state, tripId, { own: true }), read.name);
    return target ? applyReadingTo(state, { personId: target.id, read, src, at }) : null;
  }

  /* ---------- 人やお店が直す。直した項目は「確かめ済み」になり、前と後を記録に残す ----------
     who は記録の「した人」（staff / guest / system）、src はその項目の出どころ（guest / staff / passport / partner）。
     入れ子の項目（緊急連絡先・C カード・サイズ・健康）は、渡した所だけ前の値に重ねる（{ emergency: { phone } } でよい）。
     値の形は roster-schema.js のとおりに渡す（潜った本数は数。フォームの文字は画面で数に直す）。
     引数や直した後の形が違えば例外にする。画面は try / catch で受け、入れた値を消さずにお客さんへ知らせる */
  const EDITABLE = [...SIMPLE, 'emergency', 'cert', 'courses', 'sizes', 'health', 'guide'];
  const NESTED = ['emergency', 'cert', 'sizes', 'health'];
  const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  /* 記録に残す前と後。健康の答えは中身を残さず、答えた数・当日の答えの有無・誰が確かめたか・同意の版だけにする。
     同意を取り消したら答えを消すので、記録にも残さない。書き換えたことは、いつ・誰が・どの項目かで分かる */
  const logHealth = (h) => ({ answered: (Array.isArray(h.answers) ? h.answers : []).filter(a => a !== null && a !== undefined).length,
    today: !!h.today, todayAt: typeof h.todayAt === 'string' ? h.todayAt : '', heldBy: h.heldBy || '', consentVer: h.consentVer || '' });
  const logPick = (o, keys) => Object.fromEntries(keys.map(k => [k, k === 'health' ? logHealth(o.health) : o[k]]));
  /* 前の版で記録に残った健康の答えの中身を、logHealth の形に書き換える。保存から読み込むとき、形の検査の前に 1 回（決定ログ health-log） */
  function scrubLog(state) {
    const old = (side) => isPlain(side) && isPlain(side.health) && has(side.health, 'answers');
    const fix = (side) => (old(side) ? { ...side, health: logHealth(side.health) } : side);
    if (!Array.isArray(state.log) || !state.log.some(e => isPlain(e) && (old(e.before) || old(e.after)))) return state;
    return { ...state, log: state.log.map(e => (isPlain(e) ? { ...e, before: fix(e.before), after: fix(e.after) } : e)) };
  }

  /* demo: デモで「当日として」答えたなど、本当の時刻と違う形で入れた印。記録に残す。
     markUnsure: 組の片方だけを別の出どころで入れた項目（C カードの講習と年月など）。出どころを入れた方にし、自信なしの印を付けて、お店の「確かめる」に必ず出す */
  function editPerson(state, { id, patch, who, src, at, demo, markUnsure }) {
    if (!EDIT_WHO.includes(who)) throw new Error(`editPerson: who は ${EDIT_WHO.join(' / ')} のどれか (${who})`);
    const from = src || (who === 'guest' ? 'guest' : 'staff');
    if (!EDIT_SRC.includes(from)) throw new Error(`editPerson: src は ${EDIT_SRC.join(' / ')} のどれか (${from})`);
    const before = state.people.find(p => p.id === id);
    if (!before) throw new Error(`editPerson: 人が見つからない (${id})`);
    const full = Object.fromEntries(Object.keys(patch).filter(k => EDITABLE.includes(k))
      .map(k => [k, NESTED.includes(k) && isPlain(patch[k]) ? { ...before[k], ...patch[k] } : patch[k]]));
    const keys = Object.keys(full).filter(k => !same(full[k], before[k]));
    if (!keys.length) return state;
    /* 入れ子の一部だけ直したときは、触っていない所（AI が読んだ電話など）を確かめ済みにしない。自信なしの印と AI の出どころを残す */
    const partial = (k) => has(S().SUB, k) && isPlain(patch[k]) && !S().SUB[k].every(x => has(patch[k], x));
    const flagged = (markUnsure || []).filter(k => keys.includes(k) && S().AI_FIELDS.includes(k));
    const srcOf = (k) => (!flagged.includes(k) && partial(k) && AI_SRC.includes(before.src[k]) ? before.src[k] : from);
    const kept = before.unsure.filter(u => !keys.includes(u) || partial(u));
    const after = { ...before, ...pick(full, keys), src: { ...before.src, ...Object.fromEntries(keys.map(k => [k, srcOf(k)])) },
      unsure: [...kept, ...flagged.filter(k => !kept.includes(k))] };
    const v = S().validatePerson(after);
    if (!v.ok) throw new Error(`editPerson: 直した後の形が合わない (${v.errors.join(',')})`);
    return withLog({ ...state, people: state.people.map(p => (p.id === id ? after : p)) },
      entry(at, who, 'edit', 'person', id, { fields: keys, before: logPick(before, keys), after: logPick(after, keys), ...(demo === true ? { demo: true } : {}) }));
  }

  /* ---------- 便で決めること（潜水場所・ガイド・船・乗り合いのお店）と、名簿を書き出した記録 ---------- */
  const TRIP_TEXT = ['site', 'boat', 'host'];
  const TRIP_LIST = ['guides', 'partners'];
  const TRIP_EDITABLE = [...TRIP_TEXT, ...TRIP_LIST];
  /* お店が便の潜水場所・ガイド・船・乗り合いのお店を入れる。前と後を記録に残す */
  function editTrip(state, { tripId, patch, at }) {
    const before = state.trips.find(t => t.id === tripId);
    if (!before) throw new Error(`editTrip: 便が見つからない (${tripId})`);
    const clean = Object.fromEntries(Object.keys(patch).filter(k => TRIP_EDITABLE.includes(k)).map(k => [k,
      TRIP_TEXT.includes(k) ? String(patch[k]).trim() : (Array.isArray(patch[k]) ? patch[k] : []).map(g => String(g).trim()).filter(Boolean)]));
    const merged = { ...before, ...clean };
    /* 中止を確かめたお店は、今の相乗りのお店だけ（外したお店の「確かめた」を残さない） */
    const after = merged.cancel && clean.partners
      ? { ...merged, cancel: { ...merged.cancel, acked: merged.cancel.acked.filter(s => merged.partners.includes(s)) } } : merged;
    const keys = Object.keys(clean).filter(k => !same(after[k], before[k]));
    if (!keys.length) return state;
    const v = S().validateTrip(after);
    if (!v.ok) throw new Error(`editTrip: 便の形が合わない (${v.errors.join(',')})`);
    const st = withLog({ ...state, trips: state.trips.map(t => (t.id === tripId ? after : t)) },
      entry(at, 'staff', 'edit', 'trip', tripId, { fields: keys, before: pick(before, keys), after: pick(after, keys) }));
    /* ガイドの名前を直した（人数が同じで、同じ位置の名前が変わった）なら、札を新しい名前に付け替える。番号は変えない */
    if (!keys.includes('guides') || before.guides.length !== after.guides.length) return st;
    return before.guides.reduce((s, from, i) => renameGuideTag(s, { tripId, shop: '', from, to: after.guides[i], at }), st);
  }

  /* 名簿を印刷した・CSV に書き出した。人数と、健康の欄を入れたかだけを残す（中身は残さない）。
     paper: 乗り合いの合同名簿（joint）・札ボード（board）。条例の名簿なら渡さない */
  function logOutput(state, { tripId, act, people, health, paper, at }) {
    if (!['print', 'csv'].includes(act)) throw new Error(`logOutput: act は print / csv (${act})`);
    if (!state.trips.some(t => t.id === tripId)) throw new Error(`logOutput: 便が見つからない (${tripId})`);
    const kind = ['joint', 'board', 'partner'].includes(paper) ? { paper } : {};
    return withLog(state, entry(at, 'staff', act, 'trip', tripId, { after: { people: Number(people) || 0, health: health !== false, ...kind } }));
  }

  /* ---------- 乗り合い（決まりは roster-share.js。ここは形を確かめて、記録を残すだけ） ---------- */
  const replaceTrip = (state, trip) => ({ ...state, trips: state.trips.map(t => (t.id === trip.id ? trip : t)) });
  function tripOrThrow(state, tripId, who) {
    const t = state.trips.find(x => x.id === tripId);
    if (!t) throw new Error(`${who}: 便が見つからない (${tripId})`);
    return t;
  }
  function checkedTrip(after, who) {
    const v = S().validateTrip(after);
    if (!v.ok) throw new Error(`${who}: 便の形が合わない (${v.errors.join(',')})`);
    return after;
  }

  /* ---------- 便の中止 ----------
     乗り合いの便では、相乗りのお店の画面とお客さんのページに出す（試作は端末の中だけ。本物の送り先はメールか LINE で後から）。
     中止は取り消せる（reopenTrip）。前と後を記録に残す */
  function cancelTrip(state, { tripId, reason, at }) {
    const before = tripOrThrow(state, tripId, 'cancelTrip');
    if (before.cancel) return state;
    const after = checkedTrip({ ...before, cancel: { at, reason, acked: [] } }, 'cancelTrip');
    return withLog(replaceTrip(state, after), entry(at, 'staff', 'cancel', 'trip', tripId, { after: { reason } }));
  }
  function reopenTrip(state, { tripId, at }) {
    const before = tripOrThrow(state, tripId, 'reopenTrip');
    if (!before.cancel) return state;
    const { cancel, ...open } = before;   // 欄ごと消す（中止していない便と同じ形に戻す）
    const after = checkedTrip(open, 'reopenTrip');
    return withLog(replaceTrip(state, after), entry(at, 'staff', 'reopen', 'trip', tripId, { before: { reason: before.cancel.reason } }));
  }
  /* 相乗りのお店が中止の知らせを確かめた（自分のお客さんへの連絡はそのお店がする） */
  function ackCancel(state, { tripId, shop, at }) {
    const before = tripOrThrow(state, tripId, 'ackCancel');
    if (!before.cancel || !before.partners.includes(shop) || before.cancel.acked.includes(shop)) return state;
    const after = checkedTrip({ ...before, cancel: { ...before.cancel, acked: [...before.cancel.acked, shop] } }, 'ackCancel');
    return withLog(replaceTrip(state, after), entry(at, 'staff', 'ack', 'trip', tripId, { after: { shop } }));
  }

  /* 予約に 1 人足す（空の行）。人数が足りなくなれば、予約の人数も増やす */
  function addPerson(state, { bookingId, at, newId }) {
    const b = state.bookings.find(x => x.id === bookingId);
    if (!b) throw new Error(`addPerson: 予約が見つからない (${bookingId})`);
    const count = state.people.filter(p => p.bookingId === bookingId).length + 1;
    if (count > S().MAX_PEOPLE) throw new Error(`addPerson: 1 つの予約は ${S().MAX_PEOPLE} 人まで`);
    const person = { ...S().blankPerson(), id: newId(), bookingId };
    const grown = count > b.people;
    const booking = grown ? { ...b, people: count } : b;
    return {
      state: withLog({ ...state, bookings: state.bookings.map(x => (x.id === bookingId ? booking : x)), people: [...state.people, person] },
        ...(grown ? [entry(at, 'staff', 'edit', 'booking', b.id, { fields: ['people'], before: { people: b.people }, after: { people: count } })] : []),
        entry(at, 'staff', 'add', 'person', person.id)),
      person
    };
  }

  /* ガイドの名前を直したとき、その人の札を新しい名前に付け替える（番号は変えない）。新しい名前の札がもうあれば何もしない。
     札は 2026-10-27 に新しく付けなくなった（決定ログ photo-shopcheck）。前の版で付けた札だけが対象 */
  function renameGuideTag(state, { tripId, shop, from, to, at }) {
    const before = tripOrThrow(state, tripId, 'renameGuideTag');
    const guideTag = (name) => (t) => !t.personId && t.shop === shop && t.guide === name;
    if (from === to || !before.tags.some(guideTag(from)) || before.tags.some(guideTag(to))) return state;
    const after = checkedTrip({ ...before, tags: before.tags.map(t => (guideTag(from)(t) ? { ...t, guide: to } : t)) }, 'renameGuideTag');
    return withLog(replaceTrip(state, after), entry(at, 'staff', 'tags', 'trip', tripId, { after: { renamed: 1, tags: after.tags.length } }));
  }

  /* 船の上の確かめを 1 件足す（roster-schema.js の CHECK_STAGES）。決まり（何本目か・そろったか）は roster-share.js。
     check は { stage, shop, dive, person }（使う物だけ）。記録には同じ物を残す（名前は残さず、人は id で） */
  function addCheck(state, { tripId, check, at }) {
    const before = tripOrThrow(state, tripId, 'addCheck');
    const keep = Object.fromEntries(['stage', 'shop', 'dive', 'person'].filter(k => check[k] !== undefined).map(k => [k, check[k]]));
    const after = checkedTrip({ ...before, checks: [...before.checks, { at, missing: [], ...keep }] }, 'addCheck');
    return withLog(replaceTrip(state, after), entry(at, 'staff', 'aboard', 'trip', tripId, { after: keep }));
  }

  /* 乗り合いの他のお店から、お客さんを受け取った。人数と、健康の欄を受け取ったかだけを残す */
  function logHandover(state, { bookingId, people, health, at }) {
    if (!state.bookings.some(b => b.id === bookingId)) throw new Error(`logHandover: 予約が見つからない (${bookingId})`);
    return withLog(state, entry(at, 'staff', 'handover', 'booking', bookingId, { after: { people: Number(people) || 0, health: health === true } }));
  }

  /* お店が全部を確かめた。自信なしの印を外す */
  function checkPerson(state, { id, at }) {
    const p = state.people.find(x => x.id === id);
    if (!p) return state;
    return withLog({ ...state, people: state.people.map(x => (x.id === id ? { ...x, unsure: [], checkedAt: at } : x)) },
      entry(at, 'staff', 'check', 'person', id, { fields: [...p.unsure] }));
  }

  /* ---------- 条例の名簿（印刷・CSV） ---------- */
  const slash = (d) => d.replace(/-/g, '/');
  /* 1 つでも未回答があれば空（「なし」と印刷しない） */
  function historyText(p, healthShort) {
    const h = p.health;
    if (!h.historyAt || h.answers.some(a => a === null)) return '';
    const yes = h.answers.map((a, i) => (a === 'yes' ? healthShort[i] : null)).filter(Boolean);
    return yes.length ? `あり（${yes.join('・')}）` : 'なし';
  }
  /* 乗り合いの他のお店のお客さん。健康は、そのお店が確かめる（答えはこの店に来ない） */
  const heldText = (p) => (isHeld(p) ? `${p.health.heldBy}が確かめた` : '');
  function emergencyText(e) {
    if (!e.name && !e.phone) return '';
    return `${e.name}${e.relation ? `（${e.relation}）` : ''} ${e.phone}`.trim();
  }
  function cellText(p, trip, key, healthShort) {
    const unit = trip.kind === 'dive' ? '本' : '回';
    switch (key) {
      case 'name': return p.name;
      case 'birthDate': return slash(p.birthDate);
      case 'address': return p.address;
      case 'emergency': return emergencyText(p.emergency);
      case 'certDate': return p.cert.course === 'NONE' ? 'なし（体験）' : slash(p.cert.date);
      case 'courses': return p.courses || COURSE_JA[p.cert.course] || '';
      case 'dives': return p.dives === '' ? '' : p.dives === 0 ? 'なし（初めて）' : `${p.dives} ${unit}`;
      case 'lastDive': return p.lastDive ? slash(p.lastDive) : p.dives === 0 ? 'なし' : '';
      case 'history': return isHeld(p) ? heldText(p) : historyText(p, healthShort);
      case 'today': return p.health.todayAt !== trip.date ? '' : isHeld(p) ? heldText(p) : ({ ok: '良好', unwell: '不調あり' }[p.health.today] || '');
      case 'when': return trip.date ? `${slash(trip.date)} ${trip.start}` : '';
      case 'site': return trip.site;
      case 'guide': return p.guide || trip.guides.join('・');
      default: return '';
    }
  }

  /* own: 自分の店のお客さんだけ（条例の名簿）。乗り合いの合同名簿は roster-share.js の jointRows。
     shop: 乗り合いの相乗りのお店に返す、そのお店のお客さんだけの名簿。潜水日時・場所は船を出すこの店が持つ物を入れ、
     健康の 2 欄はこの店が持たない（そのお店が確かめる）ので「お店が記入」と出す */
  const SHOP_FILLS = 'お店が記入';
  function rosterRows(state, tripId, healthShort, { own, shop } = {}) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return { items: [], rows: [] };
    const items = S().ITEMS[trip.kind];
    if (shop !== undefined && !shop) return { items, rows: [] };   // お店の名前が空なら、便の全員に落とさない
    const ids = shop ? new Set(bookingsOf(state, tripId).filter(b => isPartnerBooking(b) && b.shop === shop).map(b => b.id)) : null;
    const people = shop ? state.people.filter(p => ids.has(p.bookingId)) : peopleOf(state, tripId, { own });
    const healthKey = new Set(items.filter(i => i.health).map(i => i.key));
    const doneOf = (p) => { const st = status(p, trip); return shop ? st.unsure.length === 0 && st.missing.every(k => healthKey.has(k)) : st.done; };
    const rows = people.map(p => ({
      personId: p.id, done: doneOf(p),
      cells: Object.fromEntries(items.map(i => [i.key, shop && i.health ? SHOP_FILLS : cellText(p, trip, i.key, healthShort)]))
    }));
    return { items, rows };
  }

  /* 表計算に貼っても式として動かないように、= + - @ で始まる中身の前に ' を付ける。頭の空白や全角の記号も見る */
  const FORMULA = /^[\t\r]|^[\s　]*[=+\-@＝＋－＠]/;
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    const safe = FORMULA.test(s) ? `'${s}` : s;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }
  function toCsv({ items, rows }) {
    const lines = [items.map(i => i.ja), ...rows.map(r => items.map(i => r.cells[i.key]))];
    return '\uFEFF' + lines.map(l => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- 保存の期間（作った日から 1 年） ---------- */
  function keepUntil(day) {
    const [y, m, d] = day.split('-');
    return m === '02' && d === '29' ? `${Number(y) + 1}-03-01` : `${Number(y) + 1}-${m}-${d}`;
  }
  const expired = (trip, today) => trip.date !== '' && today > keepUntil(trip.date);

  /* 保存期間を過ぎた便を、予約・人・その記録ごと消す。消した件数だけを記録に残す。
     どの便にも付かない記録（AI に送った量など）は、記録した日から 1 年で消す。
     記録の日時は UTC なので、1 日の余裕を見る（早く消しすぎない） */
  function purgeExpired(state, { today, at }) {
    const trips = new Set(state.trips.filter(t => expired(t, today)).map(t => t.id));
    const bookings = new Set(state.bookings.filter(b => trips.has(b.tripId)).map(b => b.id));
    const people = new Set(state.people.filter(p => bookings.has(p.bookingId)).map(p => p.id));
    const gone = { trip: trips, booking: bookings, person: people };
    const ofGone = (e) => has(gone, e.kind) && gone[e.kind].has(e.id);
    const tooOld = (e) => e.id === '' && today > keepUntil(S().nextDay(e.at.slice(0, 10)));
    const log = state.log.filter(e => !ofGone(e) && !tooOld(e));
    const removed = state.log.length - log.length;
    if (!trips.size && !removed) return state;
    return withLog(
      { ...state, trips: state.trips.filter(t => !trips.has(t.id)), bookings: state.bookings.filter(b => !bookings.has(b.id)),
        people: state.people.filter(p => !people.has(p.id)), log,
        /* 書類の自動化の予定と送る連絡も、便と一緒に消す（送る連絡には名前とメールアドレスが入るので、名簿と同じく 1 年まで） */
        ...(state.jobs ? { jobs: state.jobs.filter(j => !bookings.has(j.bookingId)) } : {}),
        ...(state.outbox ? { outbox: state.outbox.filter(o => !bookings.has(o.bookingId)) } : {}) },
      entry(at, 'system', 'remove', 'state', '', { after: { trips: trips.size, people: people.size, log: removed } }));
  }

  R.rosterCore = {
    COURSE_JA, isPartnerBooking, isHeld, peopleOf, bookingsOf, tripOf, sameName, findByName, filled, status, askGuest, tripSummary,
    kindOf, tripList, suggestTrip, addTrip, addBookingToTrip, bookingFromIntake, addFromIntake, bookingFromReading, missingForReading, bookingProblems, bookingRows,
    reviewRows, toCheck, scrubLog,
    mergeReading, addBooking, applyReadingTo, applyReading, editPerson, checkPerson, logAi, editTrip, logOutput,
    addPerson, renameGuideTag, addCheck, logHandover, cancelTrip, reopenTrip, ackCancel,
    cellText, rosterRows, toCsv, keepUntil, expired, purgeExpired
  };
})();
