/* 読み取りの答えの見直し（純ロジック）。AI が自信ありと答えた値でも、ありえない値・食い違う値なら「確かめる」に回す。
   AI の読み違いそのものは無くせないので、名簿に黙って入る誤りを減らす（決定ログ 2026-11-03 read-check）。
   見るのは値の形と項目どうしの食い違いだけ。正しい値は作らない（直すのはお店の人）。日付は受け取る（時計を読まない）。
   画面（js/ai-reader.js）と Worker（worker/read-core.mjs）の両方が、読み取りを受け取った所でかける */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const MIN_AGE = 5;            // これより若い・年上の生年月日は、読み違いを疑う
  const MAX_AGE = 100;
  const CERT_MIN_AGE = 8;       // C カードは 8 歳より前には取れない（ジュニアの一番下が 10 歳。余裕を見て 8）
  const MIN_DIGITS = 8;         // 電話の数字の数（国の番号を含めて 8〜15。E.164 の上限が 15）
  const MAX_DIGITS = 15;

  const digitsOf = (v) => String(v || '').replace(/\D/g, '');
  const nameKey = (v) => String(v || '').normalize('NFKC').replace(/\s+/g, '');
  /* 書き方の違う日付（YYYY・YYYY-MM・YYYY-MM-DD）を、短い方の長さにそろえて比べる */
  const prefix = (a, b) => Math.min(a.length, b.length);
  const after = (a, b) => a.slice(0, prefix(a, b)) > b.slice(0, prefix(a, b));
  const before = (a, b) => a.slice(0, prefix(a, b)) < b.slice(0, prefix(a, b));
  const year = (d) => Number(d.slice(0, 4));

  /* 日本の番号（0 で始まる）: 携帯・IP 電話・0800（090・080・070・050・0800）は 11 桁、ほか（固定・0120・0570）は 10 桁。
     + や国の番号から始まる物は、数字が 8〜15 */
  function phoneOk(v) {
    if (!v) return true;
    const s = String(v).trim();
    const d = digitsOf(s);
    if (/^0[1-9]/.test(s)) return d.length === (/^0[5789]0/.test(d) ? 11 : 10);
    return d.length >= MIN_DIGITS && d.length <= MAX_DIGITS;
  }

  /* 1 人分の読み取り（名簿の人と同じ形）を見て、{ 項目: 確かめてほしい理由 } を返す。項目は名簿の AI_FIELDS の名前 */
  function problems(p, today) {
    const out = {};
    const note = (field, why) => { if (!out[field]) out[field] = why; };
    const e = p.emergency || {};
    const c = p.cert || {};
    if (!phoneOk(p.phone)) note('phone', '電話番号の桁の数が合いません');
    if (!phoneOk(e.phone)) note('emergency', '緊急時の連絡先の電話の桁の数が合いません');
    if (e.phone && p.phone && digitsOf(e.phone) === digitsOf(p.phone)) note('emergency', '緊急時の連絡先の電話が、本人の電話と同じです');
    if (e.name && p.name && nameKey(e.name) === nameKey(p.name)) note('emergency', '緊急時の連絡先が、本人の名前です');
    if (p.birthDate) {
      const age = year(today) - year(p.birthDate);
      if (after(p.birthDate, today)) note('birthDate', '生年月日が今日より後です');
      else if (age < MIN_AGE || age > MAX_AGE) note('birthDate', `生年月日から出る年齢（${age} 歳）がありえません`);
    }
    if (c.date && after(c.date, today)) note('cert', 'C カードの取得日が今日より後です');
    else if (c.date && p.birthDate && year(c.date) - year(p.birthDate) < CERT_MIN_AGE) note('cert', `C カードの取得日が、生まれて ${CERT_MIN_AGE} 年より前です`);
    if (c.course === 'NONE' && c.date) note('cert', 'C カードなしなのに、取得日があります');
    if (p.lastDive && after(p.lastDive, today)) note('lastDive', '最後に潜った日が今日より後です');
    else if (p.lastDive && c.date && before(p.lastDive, c.date)) note('lastDive', '最後に潜った日が、C カードの取得日より前です');
    if (p.dives === 0 && c.course && c.course !== 'NONE') note('dives', 'C カードがあるのに、潜った本数が 0 本です');
    else if (p.dives === 0 && p.lastDive) note('dives', '最後に潜った日があるのに、潜った本数が 0 本です');
    return out;
  }

  /* 読み取りの答え全体に印を足す（unsure に入れるだけ。値は変えない）。今日の日付が無ければ、何もしない */
  function flag(reading, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return reading;
    const people = reading.people.map(p => {
      const more = Object.keys(problems(p, today)).filter(f => !p.unsure.includes(f));
      return more.length ? { ...p, unsure: [...p.unsure, ...more] } : p;
    });
    return { ...reading, people };
  }

  /* ---------- 2 つの AI の答えの突き合わせ（決定ログ 2026-11-03 second-reader） ----------
     同じ書類を別の AI（確かめ役）にも読ませ、答えが割れた項目を「確かめる」に回す。名簿に入れるのは 1 つ目の答えの値だけ（混ぜない）。
     書き方の違い（空白・ハイフン・全角半角）は割れたと数えない。片方だけ空なら割れたと数える */
  const norm = (v) => String(v == null ? '' : v).normalize('NFKC').replace(/[\s‐-―−ー\-]/g, '').toLowerCase();
  const SAME = {
    name: (a, b) => norm(a.name) === norm(b.name),
    birthDate: (a, b) => a.birthDate === b.birthDate,
    phone: (a, b) => digitsOf(a.phone) === digitsOf(b.phone),
    address: (a, b) => norm(a.address) === norm(b.address),
    emergency: (a, b) => norm(a.emergency.name) === norm(b.emergency.name) && norm(a.emergency.relation) === norm(b.emergency.relation) &&
      digitsOf(a.emergency.phone) === digitsOf(b.emergency.phone),
    cert: (a, b) => a.cert.course === b.cert.course && a.cert.date === b.cert.date,
    dives: (a, b) => a.dives === b.dives,
    lastDive: (a, b) => a.lastDive === b.lastDive,
    sizes: (a, b) => ['height', 'weight', 'foot'].every(k => a.sizes[k] === b.sizes[k])
  };
  const FIELDS = Object.keys(SAME);
  const BOOKING_KEYS = ['site', 'ref', 'date', 'start', 'tour', 'people', 'leadName', 'leadPhone', 'leadEmail'];
  const sameBooking = (k, a, b) => (k === 'leadPhone' ? digitsOf(a[k]) === digitsOf(b[k]) : norm(a[k]) === norm(b[k]));
  const blankOf = (p, f) => (f === 'emergency' || f === 'cert' || f === 'sizes' ? Object.values(p[f]).every(v => v === '') : p[f] === '');
  const addUnsure = (x, more) => {
    const add = more.filter(f => !x.unsure.includes(f));
    return add.length ? { ...x, unsure: [...x.unsure, ...add] } : x;
  };

  /* 確かめ役の答えが無い（呼べなかった・形が合わない）ときは、値のある項目を全部「確かめる」にする（黙って 1 つの答えで入れない） */
  function markAll(reading) {
    const people = reading.people.map(p => addUnsure(p, FIELDS.filter(f => !blankOf(p, f))));
    const b = reading.booking;
    const booking = b ? addUnsure(b, BOOKING_KEYS.filter(k => b[k] !== '')) : b;
    return { ...reading, people, booking };
  }

  /* first: 名簿に入れる答え。second: 確かめ役の答え（無ければ null）。人は名前で組にする。組にならない人は全項目を確かめる。
     健康の情報が見えた印は、どちらかが見えたと言えば見えた（安全な側） */
  function crossCheck(first, second) {
    if (!second) return markAll(first);
    const left = [...second.people];
    const people = first.people.map(p => {
      const i = left.findIndex(q => p.name && norm(q.name) === norm(p.name));
      const q = i === -1 ? (first.people.length === 1 && left.length === 1 ? left[0] : null) : left[i];
      if (!q) return addUnsure(p, FIELDS.filter(f => !blankOf(p, f)));
      left.splice(left.indexOf(q), 1);
      return addUnsure(p, FIELDS.filter(f => !SAME[f](p, q)));
    });
    const a = first.booking;
    const b = second.booking;
    const booking = a ? addUnsure(a, BOOKING_KEYS.filter(k => (b ? !sameBooking(k, a, b) : a[k] !== ''))) : a;
    return { ...first, people, booking, healthSeen: first.healthSeen === true || second.healthSeen === true };
  }

  R.readCheck = { problems, flag, phoneOk, crossCheck, markAll };
})();
