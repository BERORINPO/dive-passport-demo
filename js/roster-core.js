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
  const BOOKING_FIELDS = ['source', 'site', 'ref', 'leadName', 'leadPhone', 'people', 'shop', 'note'];
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
  function peopleOf(state, tripId) {
    const ids = new Set(bookingsOf(state, tripId).map(b => b.id));
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
      case 'history': return p.health.historyAt !== '' && p.health.answers.every(a => a !== null);
      case 'today': return p.health.today !== '' && !!trip && p.health.todayAt === trip.date;
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
    return status(p, trip).missing.filter(k => !items.find(i => i.key === k).trip);
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

  /* AI の読み取りから、予約の形を組む */
  function bookingFromReading(reading) {
    const b = reading.booking || {};
    return { source: 'mail', site: b.site || '', ref: b.ref || '', leadName: b.leadName || '', leadPhone: b.leadPhone || '',
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

  /* 予約の一覧の 1 便分。予約ごとに、人のそろい具合を付ける */
  function bookingRows(state, tripId) {
    const trip = state.trips.find(t => t.id === tripId) || null;
    return bookingsOf(state, tripId).map(b => {
      const people = state.people.filter(p => p.bookingId === b.id).map(p => ({ id: p.id, name: p.name, ...status(p, trip), ask: askGuest(p, trip) }));
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
    const who = AI_SRC.includes(src) ? 'ai' : 'staff';
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

  /* その便で、名前が 1 人だけ当てはまる人に入れる。当てはまらなければ null（画面でお店に選んでもらう） */
  function applyReading(state, { tripId, read, src, at }) {
    const target = findByName(peopleOf(state, tripId), read.name);
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
      entry(at, who, 'edit', 'person', id, { fields: keys, before: pick(before, keys), after: pick(after, keys), ...(demo === true ? { demo: true } : {}) }));
  }

  /* ---------- 便で決めること（潜水場所・ガイド）と、名簿を書き出した記録 ---------- */
  const TRIP_EDITABLE = ['site', 'guides'];
  /* お店が便の潜水場所・ガイドを入れる。前と後を記録に残す */
  function editTrip(state, { tripId, patch, at }) {
    const before = state.trips.find(t => t.id === tripId);
    if (!before) throw new Error(`editTrip: 便が見つからない (${tripId})`);
    const clean = Object.fromEntries(Object.keys(patch).filter(k => TRIP_EDITABLE.includes(k)).map(k => [k,
      k === 'site' ? String(patch[k]).trim() : (Array.isArray(patch[k]) ? patch[k] : []).map(g => String(g).trim()).filter(Boolean)]));
    const after = { ...before, ...clean };
    const keys = Object.keys(clean).filter(k => !same(after[k], before[k]));
    if (!keys.length) return state;
    const v = S().validateTrip(after);
    if (!v.ok) throw new Error(`editTrip: 便の形が合わない (${v.errors.join(',')})`);
    return withLog({ ...state, trips: state.trips.map(t => (t.id === tripId ? after : t)) },
      entry(at, 'staff', 'edit', 'trip', tripId, { fields: keys, before: pick(before, keys), after: pick(after, keys) }));
  }

  /* 名簿を印刷した・CSV に書き出した。人数と、健康の欄を入れたかだけを残す（中身は残さない） */
  function logOutput(state, { tripId, act, people, health, at }) {
    if (!['print', 'csv'].includes(act)) throw new Error(`logOutput: act は print / csv (${act})`);
    if (!state.trips.some(t => t.id === tripId)) throw new Error(`logOutput: 便が見つからない (${tripId})`);
    return withLog(state, entry(at, 'staff', act, 'trip', tripId, { after: { people: Number(people) || 0, health: health !== false } }));
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
      case 'history': return historyText(p, healthShort);
      case 'today': return p.health.todayAt === trip.date ? ({ ok: '良好', unwell: '不調あり' }[p.health.today] || '') : '';
      case 'when': return trip.date ? `${slash(trip.date)} ${trip.start}` : '';
      case 'site': return trip.site;
      case 'guide': return p.guide || trip.guides.join('・');
      default: return '';
    }
  }

  function rosterRows(state, tripId, healthShort) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return { items: [], rows: [] };
    const items = S().ITEMS[trip.kind];
    const rows = peopleOf(state, tripId).map(p => ({
      personId: p.id, done: status(p, trip).done,
      cells: Object.fromEntries(items.map(i => [i.key, cellText(p, trip, i.key, healthShort)]))
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
        people: state.people.filter(p => !people.has(p.id)), log },
      entry(at, 'system', 'remove', 'state', '', { after: { trips: trips.size, people: people.size, log: removed } }));
  }

  R.rosterCore = {
    COURSE_JA, peopleOf, bookingsOf, tripOf, sameName, findByName, filled, status, askGuest, tripSummary,
    kindOf, tripList, suggestTrip, addTrip, addBookingToTrip, bookingFromReading, missingForReading, bookingProblems, bookingRows,
    reviewRows, toCheck,
    mergeReading, addBooking, applyReadingTo, applyReading, editPerson, checkPerson, logAi, editTrip, logOutput,
    cellText, rosterRows, toCsv, keepUntil, expired, purgeExpired
  };
})();
