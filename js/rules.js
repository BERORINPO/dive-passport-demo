/* 決まった表で印を付ける（AI は使わない）。参加できるかどうかは決めない。お店が気づくための印だけを出す */
(() => {
  'use strict';

  const R = window.REDUX;
  const HOUR = 3600000;

  /* ツアーの終わりから飛行機の出発までの時間。潜らないツアーや、時刻が分からないときは null */
  function flightGap(intake, tour) {
    const f = intake.flight;
    if (!tour.diving || f.mode !== 'set' || !f.date || !f.time) return null;
    const end = new Date(`${intake.date}T${tour.end}:00`);
    const fly = new Date(`${f.date}T${f.time}:00`);
    return (fly - end) / HOUR;
  }

  function healthFlags(health) {
    if (!health.consent) return [{ kind: 'healthMissing', level: 'warn' }];
    const yes = R.HEALTH.filter((q, i) => health.answers[i] === 'yes');
    const missing = health.answers.some(a => a == null);
    return [
      yes.length ? { kind: 'healthYes', level: 'warn', items: yes } : null,
      missing ? { kind: 'healthMissing', level: 'warn' } : null
    ].filter(Boolean);
  }

  function flightFlags(intake, tour, flightHours) {
    const rule = flightHours[tour.id] || 18;
    const gap = flightGap(intake, tour);
    if (gap != null) return [{ kind: gap < rule ? 'flightClose' : 'flightOk', level: gap < rule ? 'warn' : 'ok', gap, rule }];
    if (tour.diving && intake.flight.mode === 'unknown') return [{ kind: 'flightUnknown', level: 'info' }];
    return [];
  }

  /* 健康の質問票の古さ。お店が決めた日数を過ぎていたら印。パスポートからのものは、何日前かも出す */
  const DAY = 24 * HOUR;
  function ageFlags(intake, medicalDays) {
    if (!intake.health.consent || !intake.medicalAt) return [];
    const days = Math.floor((new Date(`${R.today()}T00:00:00`) - new Date(`${intake.medicalAt}T00:00:00`)) / DAY);
    if (days > medicalDays) return [{ kind: 'healthOld', level: 'warn', days, limit: medicalDays }];
    return intake.source === 'passport' ? [{ kind: 'healthAge', level: 'ok', days }] : [];
  }

  /* settings はお店の設定（flightHours: ツアーごとの飛行機の目安、medicalDays: 質問票を何日まで使うか） */
  R.assess = (intake, settings) => {
    const tour = R.TOURS.find(t => t.id === intake.tour) || R.TOURS[0];
    const flightHours = settings.flightHours || {};
    const medicalDays = settings.medicalDays || R.MEDICAL_DAYS_DEFAULT;
    return {
      tour,
      flags: [...healthFlags(intake.health), ...ageFlags(intake, medicalDays), ...flightFlags(intake, tour, flightHours)]
    };
  };

  /* 客に見せる決まった文（お店が書いた文を条件で選ぶだけ） */
  R.guestMessages = (intake, flags) => {
    const T = R.T;
    const has = (k) => flags.some(f => f.kind === k);
    const worry = (k) => intake.worries.includes(k);
    return [
      has('healthYes') && T.msgHealthYes,
      has('healthMissing') && T.msgHealthMissing,
      has('healthOld') && T.msgHealthOld,
      has('flightClose') && T.msgFlightClose,
      has('flightUnknown') && T.msgFlightUnknown,
      (intake.swim === 'none' || intake.swim === 'shallow') && T.msgSwim,
      worry('face') && T.msgFace,
      worry('ears') && T.msgEars,
      worry('deep') && T.msgDeep,
      worry('seasick') && T.msgSeasick
    ].filter(Boolean);
  };
})();
