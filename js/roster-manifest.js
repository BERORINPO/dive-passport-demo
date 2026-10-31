/* 乗船者名簿とダイビング計画（純ロジック）。保存・通信・画面・時計は知らない。
   項目は国交省のダイビング船の安全対策ガイドライン（令和 7 年 7 月 24 日公表。推奨で、法の義務ではない）の乗船者名簿（氏名・性別・年齢・住所・緊急連絡先）と
   ダイビング計画（人数・タンクの容量と本数・ポイント・潜水時間）。条例の名簿（roster-core.js の rosterRows）とは別の紙。
   健康の欄は入れない。乗り合いの他のお店のお客さんは、そのお店の名簿に残し、ここでは人数だけ（合同名簿の決まり JOINT_KEYS と同じく、住所・生年月日を他のお店に渡さない） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;
  const D = () => R.rosterDay;

  const SEX_JA = Object.freeze({ m: '男', f: '女', x: 'その他' });
  /* お客さん 1 人に足りないと数える項目（紙の列の順） */
  const PERSON_KEYS = ['name', 'sex', 'age', 'address', 'emergency'];
  const KEY_JA = Object.freeze({ name: '氏名', sex: '性別', age: '年齢（生年月日）', address: '住所', emergency: '緊急連絡先',
    site: 'ポイント', minutes: '潜水時間', tanks: 'タンク', depart: '出港の時刻', watch: '船上の見張り' });
  const DIVES_PER_GUEST = 2;     // タンクの数の見当（お客さん 1 人に 2 本）。お店が直す
  const DEFAULT_TANK = 10;       // 見当に使う容量（L）

  /* 緊急連絡先を 1 行に。電話が無ければ空（足りない） */
  function emergencyText(e) {
    if (!e || !e.phone) return '';
    const who = [e.name, e.relation ? `（${e.relation}）` : ''].join('');
    return [who, e.phone].filter(Boolean).join(' ');
  }

  function guestRow(person, trip) {
    const age = D().ageOn(person.birthDate, trip.date);
    const cells = { name: person.name, sex: SEX_JA[person.sex] || '', age: age === null ? '' : String(age),
      address: person.address, emergency: emergencyText(person.emergency) };
    return { kind: 'guest', personId: person.id, sex: person.sex || '', cells, missing: PERSON_KEYS.filter(k => !cells[k]) };
  }

  /* ガイドはこの店の人。名簿に人として入っていないので、名前だけ（性別・年齢・住所はお店の控え）。足りないとは数えない */
  const guideRow = (name) => ({ kind: 'guide', personId: '', sex: '', cells: { name, sex: '', age: '', address: '', emergency: '' }, missing: [] });

  /* 乗り合いの他のお店ごとのお客さんの人数（予約の人数で数える） */
  function partnerCounts(state, trip) {
    const bookings = C().bookingsOf(state, trip.id).filter(C().isPartnerBooking);
    return trip.partners.map(shop => ({ shop, guests: bookings.filter(b => b.shop === shop).reduce((n, b) => n + b.people, 0) }));
  }

  /* 便の乗船者名簿とダイビング計画。無い便は null */
  function manifest(state, tripId) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return null;
    const plan = { ...S().blankPlan(), ...(trip.plan || {}) };
    const guests = C().peopleOf(state, tripId, { own: true }).map(p => guestRow(p, trip));
    const guides = trip.guides.map(guideRow);
    const partners = partnerCounts(state, trip);
    const partnerGuests = partners.reduce((n, x) => n + x.guests, 0);
    const counts = { guests: guests.length, guides: guides.length, partnerGuests, crew: plan.captain ? 1 : 0 };
    counts.total = counts.guests + counts.guides + counts.partnerGuests + counts.crew;
    const tankTotal = plan.tanks.reduce((n, x) => n + x.count, 0);
    const suggest = { size: DEFAULT_TANK, count: (counts.guests + partnerGuests) * DIVES_PER_GUEST };
    /* 計画で足りない所（紙が空くと船長が困る所）と、確かめる所（2027-04 から努力義務の見張り） */
    const planMissing = [!trip.site && 'site', plan.minutes === '' && 'minutes', tankTotal === 0 && 'tanks', !plan.depart && 'depart'].filter(Boolean);
    const planCheck = plan.watch ? [] : ['watch'];
    const short = guests.filter(r => r.missing.length);
    return { trip, plan, rows: [...guests, ...guides], partners, counts, tankTotal, suggest, planMissing, planCheck,
      short, missingCount: planMissing.length + short.length, checkCount: planCheck.length };
  }

  R.rosterManifest = { SEX_JA, PERSON_KEYS, KEY_JA, DIVES_PER_GUEST, DEFAULT_TANK, emergencyText, manifest };
})();
