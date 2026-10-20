/* パスポートの中身を、読みやすい行に並べる。パスポートの画面と、見るだけの画面の両方で使う */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el, L } = R;
  const ALL = { medical: true, certNo: true, insurance: true, insuranceNo: true, sizes: true, flight: true };

  const option = (list, id) => {
    const o = list.find(x => x.id === id);
    return o ? L(o) : L(R.TP.notSet);
  };
  const langLabel = (id) => (R.LANGS.find(o => o.id === id) || { label: id }).label;

  function certsText(certs) {
    if (!certs.length) return L(R.TP.none);
    return certs.map(c => [c.agency, c.level, c.no && `#${c.no}`, c.date].filter(Boolean).join(' ')).join(' / ');
  }

  function expText(s) {
    const t = R.TP;
    const dives = s.dives === '' ? L(t.notSet) : `${s.dives} ${L(t.dives)}`;
    return s.lastDive ? `${dives} ・ ${L(t.last)} ${s.lastDive}` : dives;
  }

  function medText(med) {
    const t = R.TP;
    if (med === null) return L(t.notShared);
    if (!med.at) return L(t.notAnswered);
    const yes = med.yes.map(i => L(R.HEALTH[i])).join('、');
    return [
      `${L(t.answeredOn)} ${med.at}`,
      `${L(t.yesItems)}: ${yes || L(t.none)}`,
      med.open ? `${L(t.unanswered)} ${med.open}` : ''
    ].filter(Boolean).join(' ・ ');
  }

  function insText(ins) {
    if (ins === null) return L(R.TP.notShared);
    if (!ins.name) return L(R.TP.notSet);
    return ins.no ? `${ins.name} #${ins.no}` : ins.name;
  }

  function sizesText(sizes) {
    if (sizes === null) return L(R.TP.notShared);
    const parts = [sizes.suit && `${L(R.TP.fSuit)} ${sizes.suit}`, sizes.fins && `${L(R.TP.fFins)} ${sizes.fins}`].filter(Boolean);
    return parts.length ? parts.join(' ・ ') : L(R.TP.notSet);
  }

  function flightText(f) {
    if (f === null) return L(R.TP.notShared);
    return f.date ? `${f.date} ${f.time}`.trim() : L(R.TP.notSet);
  }

  /* 見せる中身（toShare の形）から、[見出し, 中身, 目立たせるか] の行を作る */
  R.shareRows = (s) => {
    const t = R.TP;
    return [
      [t.rName, R.lang === 'ja' ? `${s.name || L(t.notSet)}（${langLabel(s.lang)}）` : `${s.name || L(t.notSet)} (${langLabel(s.lang)})`],
      [t.rSwim, s.swim ? option(R.SWIM, s.swim) : L(t.notSet)],
      [t.rCerts, certsText(s.certs)],
      [t.rExp, expText(s)],
      [t.rMedical, medText(s.med), s.med && s.med.yes.length ? 'warn' : ''],
      [t.rInsurance, insText(s.ins)],
      [t.rSizes, sizesText(s.sizes)],
      [t.rFlight, flightText(s.flight)]
    ];
  };

  R.rowsList = (rows) => el('dl', { class: 'plist' },
    rows.map(([k, v, mark]) => [el('dt', { text: L(k) }), el('dd', { class: mark ? `is-${mark}` : null, text: v })]));

  R.fullShare = (p) => R.pass.toShare(p, ALL);
})();
