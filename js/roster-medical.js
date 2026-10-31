/* 医師の診断書の一覧（純ロジック）。保存・通信・画面・時計は知らない。
   お店の決まり（roster-core.js の medicalOf。最初の値は roster-schema.js の MEDICAL_DEFAULT）を、便の日の年齢と健康の答えに当てはめるだけ。
   潜ってよいかは医師とお店が決める。健康の答えは「はい」の数しか出さない（どの項目かは名簿で見る）。
   乗り合いの他のお店のお客さん（heldBy）は、そのお店が確かめるので数えない */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const C = () => R.rosterCore;
  const D = () => R.rosterDay;

  /* 人の状態: missing 要るのにまだ / expired 期限切れ / ok 期限内 / unknown 決められない（生年月日か答えがまだ）/ none 要らない */
  const STATUS = ['missing', 'expired', 'ok', 'unknown', 'none'];

  /* 日付に n 日足す（YYYY-MM-DD）。グレゴリオ暦の日の通し番号に直して足し、戻す（時計の部品は使わない） */
  function serial(day) {
    const [y0, m, d] = day.split('-').map(Number);
    const y = m <= 2 ? y0 - 1 : y0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  }
  function fromSerial(z) {
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
    const two = (v) => String(v).padStart(2, '0');
    return `${y}-${two(m)}-${two(d)}`;
  }
  const addDays = (day, n) => fromSerial(serial(day) + n);

  /* 診断書の期限（この日まで有効）。診断日から days 日（診断日を 1 日目と数える） */
  const validUntil = (medAt, days) => addDays(medAt, days - 1);

  /* 1 人の判定。paper: 健康の質問を紙で聞く店（答えはアプリに無いので、年齢の決まりだけで決め、答えは紙で見る） */
  function judge(person, trip, rules, { paper } = {}) {
    const h = person.health;
    const age = D().ageOn(person.birthDate, trip.date);
    const yes = paper ? 0 : h.answers.filter(a => a === 'yes').length;
    const answered = paper || h.answers.every(a => a !== null);
    const byAge = rules.age !== '' && age !== null && age >= rules.age;
    const why = [byAge && 'age', yes > 0 && 'yes'].filter(Boolean);
    const older = rules.olderAge !== '' && age !== null && age >= rules.olderAge;
    const days = older ? rules.olderDays : rules.days;
    const medAt = h.medAt || '';
    const until = medAt ? validUntil(medAt, days) : '';
    const trialOver = person.cert.course === 'NONE' && rules.trialMax !== '' && age !== null && age > rules.trialMax;
    /* 年齢の決まりがあるのに生年月日が無い、または答えがそろっていない人は、要るか決められない */
    const unknown = !why.length && ((rules.age !== '' && age === null) || !answered);
    const status = why.length ? (!medAt ? 'missing' : trip.date > until ? 'expired' : 'ok') : unknown ? 'unknown' : 'none';
    return { person, age, yes, why, older, days, medAt, until, trialOver, paper: !!paper, status };
  }

  /* 便の一覧。無い便は null。並びは 期限切れ → まだ → 期限内 → 決められない → 要らない */
  function medicalList(state, tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return null;
    const rules = C().medicalOf(state);
    const paper = C().paperOf(state);
    const own = C().peopleOf(state, tripId, { own: true });
    const rows = own.filter(p => !C().isHeld(p)).map(p => judge(p, trip, rules, { paper }));
    const order = ['expired', 'missing', 'ok', 'unknown', 'none'];
    const sorted = [...rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const count = (st) => rows.filter(r => r.status === st).length;
    return { trip, rules, paper, rows: sorted, need: sorted.filter(r => r.why.length), unknown: sorted.filter(r => r.status === 'unknown'),
      none: sorted.filter(r => r.status === 'none'), held: own.length - rows.length, trialOver: rows.filter(r => r.trialOver),
      counts: { missing: count('missing'), expired: count('expired'), ok: count('ok'), unknown: count('unknown'), none: count('none') } };
  }

  R.rosterMedical = { STATUS, addDays, validUntil, judge, medicalList };
})();
