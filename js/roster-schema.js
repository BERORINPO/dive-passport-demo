/* 予約と名簿の形（版 1）。予約・名簿・乗り合いの画面と、AI の読み取り（本物の Worker・見本）が共通で使う契約。
   条例の名簿の項目（沖縄県水難事故の防止及び遊泳者等の安全の確保等に関する条例施行規則 第30条・第36条。令和7年沖縄県公安委員会規則第16号）もここで決める。
   ブラウザでも Node（テスト）でも Worker でも動くように、globalThis.REDUX に足す。依存なし */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const VERSION = 1;
  const KINDS = ['dive', 'snorkel'];
  const SOURCES = ['mail', 'form', 'phone', 'partner'];        // 予約の出どころ: 予約サイトのメール / 自社のフォーム / 電話など / 乗り合いの他店
  const FIELD_SRC = ['mail', 'paper', 'ccard', 'guest', 'staff', 'passport', 'partner'];   // その項目を入れたもの
  const LOG_WHO = ['staff', 'guest', 'ai', 'system'];          // 記録に残す「した人」
  const LOG_ACT = ['add', 'edit', 'ai', 'check', 'print', 'csv', 'remove', 'handover', 'tags', 'aboard', 'cancel', 'reopen', 'ack'];   // handover: 乗り合いの他店から受け取った / tags: 札の番号（2026-10-27 まで）/ aboard: 船の上の確かめ（店ごとに戻った・名前で呼んだ・ポイントを離れた）/ cancel・reopen: 便の中止と取り消し / ack: 相乗りのお店が中止を確かめた
  const CANCEL_REASONS = ['wind', 'storm', 'boat', 'other'];   // 便の中止の理由: 波・風 / 雷・大雨 / 船の故障 / その他
  /* 理由の言葉。ja: 画面の名前 / why: 届く文とお客さんのページの「〜中止です」/ en: お客さんのページ（英語） */
  const CANCEL_TEXT = Object.freeze({
    wind: { ja: '波・風が強い', why: '波・風が強いため', en: 'Strong wind and waves' },
    storm: { ja: '雷・大雨', why: '雷・大雨のため', en: 'Thunder or heavy rain' },
    boat: { ja: '船の故障', why: '船の故障のため', en: 'Boat trouble' },
    other: { ja: 'その他', why: '都合により', en: '' }
  });
  const COURSES = ['', 'OW', 'AOW', 'RESCUE', 'JOW', 'DM', 'OTHER', 'NONE'];               // NONE = C カードなし（体験）
  const TODAY = ['', 'ok', 'unwell'];
  const DOCS = ['mail', 'paper', 'ccard', 'list'];               // list: 乗り合いの他のお店が撮る予約の一覧（予約アプリの画面か紙の名簿）
  /* 船の上の確かめ（trip.checks の stage）。return: そのお店が全員戻った / undo: その戻ったを取り消した / here: 人数が合わないとき、名前で呼んでいた /
     leave: ポイントを離れた。dive は何本目か（leave の数 + 1）。札で数えていた版（2026-10-27 まで）の leave には tags（札の枚数）が付く */
  const CHECK_STAGES = ['leave', 'return', 'undo', 'here'];
  const MAX_CHECKS = 300;
  const MAX_DIVES = 20;
  const HEALTH_QUESTIONS = 5;                                  // data.js の R.HEALTH と同じ数
  const SPO2_DIVES = 3;                                        // 血中酸素を入れる本数（県警の体調チェック表は 3 本目まで）
  const SPO2_MIN = 50;                                         // 指先の機器の数値（%）として受け付ける幅
  const SPO2_MAX = 100;
  const MAX_TEXT = 20000;                                      // 予約メールの本文の上限（文字）
  const MAX_IMAGE = 4000000;                                   // 写真の上限（base64 の文字数、約 3 MB）
  const MAX_PEOPLE = 30;

  /* 書類の自動化（plan/auto.md）。予約の連絡先と言語、自動の予定（jobs）、送る連絡（outbox） */
  const LANGS = ['ja', 'en', 'ko', 'zh'];
  const EMAIL = /^[^\s@<>()"',;:]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/;
  const JOB_KINDS = ['request', 'remind', 'eve', 'morning'];     // お願い / 2 日前にもう一度 / 前日の夜にお店へ / 当日の朝（名簿と体調の質問）
  const JOB_STATUS = ['waiting', 'done', 'skipped'];
  const OUT_KINDS = ['request', 'remind', 'today', 'staff'];      // staff: お店への知らせ（メールでなく画面に出す）
  const OUT_STATUS = ['queued', 'sent', 'failed', 'unsent', 'notice'];   // unsent: 送り先やメールの設定が無くて送っていない
  const MAX_JOBS = 2000;
  const MAX_OUTBOX = 2000;

  /* 名簿の項目。trip は便から入る項目、health は AI に渡さない項目 */
  const it = (key, ja, extra) => ({ key, ja, ...(extra || {}) });
  const ITEMS = {
    dive: [
      it('name', '氏名'), it('birthDate', '生年月日'), it('address', '住所'), it('emergency', '緊急時の連絡先'),
      it('certDate', '認定証取得年月日'), it('courses', '講習受講歴'), it('dives', '潜水経験'),
      it('lastDive', '最後に潜水をした日'), it('history', '既往症', { health: true }),
      it('today', '当日の健康状態', { health: true }), it('when', '潜水日時', { trip: true }),
      it('site', '潜水場所', { trip: true }), it('guide', 'ガイドダイバーの氏名', { trip: true })
    ],
    snorkel: [
      it('name', '氏名'), it('birthDate', '生年月日'), it('address', '住所'), it('emergency', '緊急時の連絡先'),
      it('dives', 'スノーケリング経験'), it('lastDive', '最後にスノーケリングをした日'),
      it('history', '既往症', { health: true }), it('today', '当日の健康状態', { health: true }),
      it('when', 'スノーケリング日時', { trip: true }), it('site', 'スノーケリング場所', { trip: true }),
      it('guide', 'ガイドの氏名', { trip: true })
    ]
  };
  /* AI が読んで埋めてよい人の項目と、その中の項目。健康の項目はここに入れない */
  const AI_FIELDS = ['name', 'birthDate', 'phone', 'address', 'emergency', 'cert', 'dives', 'lastDive', 'sizes'];
  const SUB = { emergency: ['name', 'relation', 'phone'], cert: ['course', 'date'], sizes: ['height', 'weight', 'foot'] };

  /* ---------- 日付（書き方だけでなく、ありえる日か） ---------- */
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  function realDate(s) {
    const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(s);
    if (!m) return false;
    const y = Number(m[1]);
    if (y < 1900 || y > 2100) return false;
    if (m[2] === undefined) return true;
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return false;
    if (m[3] === undefined) return true;
    const d = Number(m[3]);
    return d >= 1 && d <= (mo === 2 && leap(y) ? 29 : MONTH_DAYS[mo - 1]);
  }
  const realTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

  const isStr = (v, max) => typeof v === 'string' && v.length <= max;
  const isDate = (v) => v === '' || (typeof v === 'string' && realDate(v));
  const isDay = (v) => v === '' || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v));
  const isTime = (v) => v === '' || (typeof v === 'string' && realTime(v));
  const isCount = (v, max) => v === '' || (Number.isInteger(v) && v >= 0 && v <= max);
  const isNum = (v, max) => v === '' || (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const onlyKeys = (o, keys) => isObj(o) && Object.keys(o).every(k => keys.includes(k));
  const isList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every(each);
  const isAnswer = (a) => a === 'yes' || a === 'no' || a === null;
  const isId = (v) => isStr(v, 40) && v.length > 0;
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  const result = (errors) => {
    const list = errors.filter(Boolean);
    return { ok: list.length === 0, errors: list };
  };

  /* ---------- 形の見本 ---------- */
  function blankTrip() {
    return { v: VERSION, id: '', date: '', start: '', kind: 'dive', tour: '', boat: '', site: '', guides: [],
      host: '', partners: [], tags: [], checks: [], createdAt: '' };
  }

  function blankBooking() {
    return { v: VERSION, id: '', tripId: '', source: 'phone', site: '', ref: '', leadName: '', leadPhone: '',
      people: 1, shop: '', note: '', createdAt: '' };
  }

  function blankPerson() {
    return {
      v: VERSION, id: '', bookingId: '', name: '', birthDate: '', phone: '', address: '',
      emergency: { name: '', relation: '', phone: '' },
      cert: { course: '', date: '' },
      courses: '', dives: '', lastDive: '',
      sizes: { height: '', weight: '', foot: '' },
      health: { historyAt: '', answers: Array(HEALTH_QUESTIONS).fill(null), todayAt: '', today: '' },
      guide: '', src: {}, unsure: [], checkedAt: ''
    };
  }

  function blankState(shop) {
    return { v: VERSION, shop: { name: shop || '' }, trips: [], bookings: [], people: [], log: [] };
  }

  /* 1 日あとの日付（YYYY-MM-DD）。時計を使わずに数える */
  function nextDay(d) {
    const [y, m, dd] = d.split('-').map(Number);
    const last = m === 2 && leap(y) ? 29 : MONTH_DAYS[m - 1];
    const [ny, nm, nd] = dd < last ? [y, m, dd + 1] : m < 12 ? [y, m + 1, 1] : [y + 1, 1, 1];
    return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
  }

  /* ---------- 検査 ---------- */
  /* cancel は中止した便にだけ付く（blankTrip には入れない。前の版の画面が、中止していない便まで読めなくならないように） */
  const TRIP_SHAPE = [...Object.keys(blankTrip()), 'cancel', 'rosterAt'];
  /* leadEmail（お願いを送る先）と lang（送る言葉）は、書類の自動化で足した。無い予約もある（前の版・電話でメールを聞いていない） */
  const BOOKING_SHAPE = [...Object.keys(blankBooking()), 'leadEmail', 'lang'];
  const emailOk = (v) => v === '' || (isStr(v, 254) && EMAIL.test(v));

  /* 札（乗り合いの札ボード）。お客さんは personId、ガイドは名前とお店（shop が空ならこの店）。番号は便の中で重ならない */
  const tagOk = (x) => isStr(x.no, 10) && x.no !== '' &&
    ((onlyKeys(x, ['personId', 'no']) && isId(x.personId)) ||
     (onlyKeys(x, ['guide', 'shop', 'no']) && isStr(x.guide, 40) && x.guide !== '' && isStr(x.shop, 60)));

  function validateTrip(t) {
    if (!isObj(t) || t.v !== VERSION) return result(['version']);
    return result([
      !onlyKeys(t, TRIP_SHAPE) && 'keys', !isId(t.id) && 'id', !isDay(t.date) && 'date', !isTime(t.start) && 'start',
      !KINDS.includes(t.kind) && 'kind', !isStr(t.tour, 40) && 'tour', !isStr(t.boat, 40) && 'boat',
      !isStr(t.site, 80) && 'site', !isList(t.guides, 10, g => isStr(g, 40)) && 'guides',
      !isStr(t.host, 60) && 'host',
      !(isList(t.partners, 10, s => isStr(s, 60) && s.trim() !== '') && new Set(t.partners).size === t.partners.length) && 'partners',
      !(isList(t.tags, MAX_PEOPLE * 4, tagOk) && new Set(t.tags.map(x => x.no)).size === t.tags.length) && 'tags',
      !isList(t.checks, MAX_CHECKS, checkOk) && 'checks',
      !(t.cancel === undefined || cancelOk(t.cancel)) && 'cancel',
      !(t.rosterAt === undefined || isStr(t.rosterAt, 40)) && 'rosterAt',   // 当日の朝に名簿を作った時刻（書類の自動化）
      !isStr(t.createdAt, 40) && 'createdAt'
    ]);
  }
  /* 船の上の確かめの 1 件。shop は乗るお店（'' はこの店）、person は名前で呼んでいた人 */
  function checkOk(x) {
    return onlyKeys(x, ['at', 'stage', 'missing', 'tags', 'shop', 'dive', 'person']) && isStr(x.at, 40) &&
      CHECK_STAGES.includes(x.stage) && isList(x.missing, MAX_PEOPLE * 4, isId) &&
      (x.tags === undefined || (Number.isInteger(x.tags) && x.tags >= 0 && x.tags <= MAX_PEOPLE * 4)) &&
      (x.shop === undefined || isStr(x.shop, 60)) && (x.dive === undefined || (Number.isInteger(x.dive) && x.dive >= 1 && x.dive <= MAX_DIVES)) &&
      (x.person === undefined || isId(x.person)) &&
      (!['return', 'undo', 'here'].includes(x.stage) || (x.shop !== undefined && x.dive !== undefined)) &&
      (x.stage !== 'here' || x.person !== undefined);
  }
  /* 便の中止。いつ・理由・中止を確かめた相乗りのお店（乗り合いの便だけ）。中止していない便には欄ごと無い */
  function cancelOk(c) {
    return onlyKeys(c, ['at', 'reason', 'acked']) && isStr(c.at, 40) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(c.at) && CANCEL_REASONS.includes(c.reason) &&
      isList(c.acked, 10, x => isStr(x, 60) && x !== '') && new Set(c.acked).size === c.acked.length;
  }

  function validateBooking(b) {
    if (!isObj(b) || b.v !== VERSION) return result(['version']);
    return result([
      !onlyKeys(b, BOOKING_SHAPE) && 'keys', !isId(b.id) && 'id', !isId(b.tripId) && 'tripId', !SOURCES.includes(b.source) && 'source',
      !isStr(b.site, 40) && 'site', !isStr(b.ref, 60) && 'ref', !isStr(b.leadName, 60) && 'leadName',
      !isStr(b.leadPhone, 30) && 'leadPhone',
      !(Number.isInteger(b.people) && b.people >= 1 && b.people <= MAX_PEOPLE) && 'people',
      !(isStr(b.shop, 60) && (b.source !== 'partner' || b.shop.trim() !== '')) && 'shop', !isStr(b.note, 400) && 'note', !isStr(b.createdAt, 40) && 'createdAt',
      !(b.leadEmail === undefined || emailOk(b.leadEmail)) && 'leadEmail', !(b.lang === undefined || LANGS.includes(b.lang)) && 'lang'
    ]);
  }

  /* 自動の予定の 1 件。due は日本の時刻の「YYYY-MM-DDTHH:MM」（core は時計を使わないので、時刻は文字のまま比べる） */
  const isJst = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) && realDate(v.slice(0, 10)) && realTime(v.slice(11));
  function jobOk(j) {
    return onlyKeys(j, ['v', 'id', 'kind', 'bookingId', 'tripId', 'due', 'status', 'doneAt']) && j.v === VERSION && isId(j.id) &&
      JOB_KINDS.includes(j.kind) && isId(j.bookingId) && isId(j.tripId) && isJst(j.due) && JOB_STATUS.includes(j.status) && isStr(j.doneAt, 40);
  }
  /* 送る連絡の 1 件。本文に健康の答えは入れない（roster-auto.js が組む）。people はお願いする人の id */
  function outOk(o) {
    return onlyKeys(o, ['v', 'id', 'kind', 'bookingId', 'tripId', 'to', 'lang', 'subject', 'body', 'people', 'status', 'why', 'at', 'sentAt']) &&
      o.v === VERSION && isId(o.id) && OUT_KINDS.includes(o.kind) && isId(o.bookingId) && isId(o.tripId) && emailOk(o.to) &&
      LANGS.includes(o.lang) && isStr(o.subject, 200) && isStr(o.body, 4000) && isList(o.people, MAX_PEOPLE, isId) &&
      OUT_STATUS.includes(o.status) && isStr(o.why, 40) && isStr(o.at, 40) && isStr(o.sentAt, 40);
  }

  /* consentAt・consentVer は、お客さんが健康の答えに同意した日と同意の文の版（P3 で足した。無くてもよい）。
     heldBy は、乗り合いの他のお店のお客さんで、健康はそのお店が確かめる（答えはこの店に来ない）ときの、そのお店の名前（P5。無くてもよい）。
     heldBy のある人は答えを持たない。todayAt は、そのお店が便の日に当日の体調を確かめた日。
     spo2 は、お店が便の日に測った血中酸素（1 本目から順に、潜る前 pre と潜った後 post。入れていない所は ''。無くてもよい）。
     健康の欄と同じ扱いで、そのお店だけが持つ。heldBy のある人には入れない */
  const isSpo2 = (v) => v === '' || (Number.isInteger(v) && v >= SPO2_MIN && v <= SPO2_MAX);
  const spo2Ok = (list) => list === undefined || (isList(list, SPO2_DIVES, d => onlyKeys(d, ['pre', 'post']) && isSpo2(d.pre) && isSpo2(d.post)) &&
    list.length === SPO2_DIVES);
  const spo2Empty = (list) => list === undefined || list.every(d => d.pre === '' && d.post === '');
  function healthOk(h) {
    return onlyKeys(h, ['historyAt', 'answers', 'todayAt', 'today', 'consentAt', 'consentVer', 'heldBy', 'spo2']) && isDay(h.historyAt) &&
      isList(h.answers, HEALTH_QUESTIONS, isAnswer) && h.answers.length === HEALTH_QUESTIONS &&
      isDay(h.todayAt) && TODAY.includes(h.today) &&
      (h.consentAt === undefined || isDay(h.consentAt)) && (h.consentVer === undefined || isStr(h.consentVer, 20)) &&
      (h.heldBy === undefined || isStr(h.heldBy, 60)) && spo2Ok(h.spo2) &&
      (!h.heldBy || (h.answers.every(a => a === null) && h.today === '' && h.historyAt === '' && spo2Empty(h.spo2)));
  }

  /* 人の項目（AI の答えと名簿の人で同じ検査）。入れ子の中も決まった名前だけ */
  function personFieldsOk(p) {
    const e = p.emergency;
    const c = p.cert;
    const s = p.sizes;
    return [
      !isStr(p.name, 60) && 'name', !isDate(p.birthDate) && 'birthDate', !isStr(p.phone, 30) && 'phone',
      !isStr(p.address, 120) && 'address',
      !(onlyKeys(e, SUB.emergency) && isStr(e.name, 60) && isStr(e.relation, 20) && isStr(e.phone, 30)) && 'emergency',
      !(onlyKeys(c, SUB.cert) && COURSES.includes(c.course) && isDate(c.date)) && 'cert',
      !isCount(p.dives, 100000) && 'dives', !isDate(p.lastDive) && 'lastDive',
      !(onlyKeys(s, SUB.sizes) && isNum(s.height, 250) && isNum(s.weight, 300) && isNum(s.foot, 40)) && 'sizes'
    ];
  }

  const PERSON_KEYS = Object.keys(blankPerson());

  function validatePerson(p) {
    if (!isObj(p) || p.v !== VERSION) return result(['version']);
    return result([
      !onlyKeys(p, PERSON_KEYS) && 'keys', !isId(p.id) && 'id', !isId(p.bookingId) && 'bookingId', ...personFieldsOk(p),
      !isStr(p.courses, 120) && 'courses', !healthOk(p.health) && 'health', !isStr(p.guide, 40) && 'guide',
      !(isObj(p.src) && Object.keys(p.src).every(k => AI_FIELDS.includes(k) || ['courses', 'health', 'guide'].includes(k)) &&
        Object.values(p.src).every(s => FIELD_SRC.includes(s))) && 'src',
      !isList(p.unsure, 20, u => AI_FIELDS.includes(u)) && 'unsure', !isStr(p.checkedAt, 40) && 'checkedAt'
    ]);
  }

  const SENT_KEYS = ['doc', 'size', 'masked', 'mode', 'healthSeen', 'redacted'];
  function sentOk(s) {
    return s === null || (onlyKeys(s, SENT_KEYS) && DOCS.includes(s.doc) && Number.isInteger(s.size) &&
      typeof s.masked === 'boolean' && ['real', 'sample'].includes(s.mode) && typeof s.healthSeen === 'boolean' &&
      Number.isInteger(s.redacted) && s.redacted >= 0);
  }

  /* 人の記録の health は中身を持たない形だけ（答えた数・当日の答えの有無・日・誰が確かめたか・同意の版。roster-core.js の logHealth） */
  const logHealthOk = (h) => h === undefined || (onlyKeys(h, ['answered', 'today', 'todayAt', 'heldBy', 'consentVer']) &&
    Number.isInteger(h.answered) && h.answered >= 0 && h.answered <= HEALTH_QUESTIONS && typeof h.today === 'boolean' &&
    isDay(h.todayAt) && isStr(h.heldBy, 60) && isStr(h.consentVer, 20));

  function logOk(e) {
    return isObj(e) && isStr(e.at, 40) && LOG_WHO.includes(e.who) && LOG_ACT.includes(e.act) &&
      ['trip', 'booking', 'person', 'state'].includes(e.kind) && isStr(e.id, 40) &&
      isList(e.fields, 30, f => isStr(f, 20)) && isObj(e.before) && isObj(e.after) && sentOk(e.sent) &&
      (e.kind !== 'person' || (logHealthOk(e.before.health) && logHealthOk(e.after.health))) &&   // 印刷・受け取りの health は「健康の欄を出したか」の真偽
      (e.demo === undefined || e.demo === true);   // demo: デモで「当日として」答えた印
  }

  /* ---------- 名簿の形の版を上げる（ジンのレビュー 2026-10-27 HIGH 7） ----------
     形を変えるときは VERSION を 1 上げ、MIGRATIONS に「前の版の名簿 → 次の版の名簿」の関数を 1 つ足す（v は名簿・便・予約・人・予定・連絡のすべてに付く。
     bumpAll で上げられる）。読む所（端末の loadRoster・別のタブの保存・サーバーの readStored・済んだ便の行）は、検査の前に upgradeState を通す。
     古い版の画面から届いた名簿は、サーバーが上げずに断る（新しい欄を、それを知らない画面の名簿で消さないため。sync-core.mjs の checkPut）。
     端末の保存場所の名前（redux-roster-v1）は版が変わっても変えない（変えると、前の名簿を読まなくなる） */
  const MIGRATIONS = {};
  const bumpAll = (s, to) => {
    const up = (x) => (isObj(x) ? { ...x, v: to } : x);
    return { ...s, v: to, trips: (s.trips || []).map(up), bookings: (s.bookings || []).map(up), people: (s.people || []).map(up),
      ...(s.jobs ? { jobs: s.jobs.map(up) } : {}), ...(s.outbox ? { outbox: s.outbox.map(up) } : {}) };
  };
  /* steps は { 版: 名簿 → 次の版の名簿 }。target まで順に上げる。上げる道が無い（新しすぎる・途中が欠けた・形が違う）ときは元のまま返す
     （検査に落ちて、呼ぶ側が「読めない」として扱う）。テストは steps を渡して確かめる */
  function upgradeWith(s, steps, target) {
    if (!isObj(s) || !Number.isInteger(s.v) || s.v >= target) return s;
    let cur = s;
    while (cur.v < target) {
      const step = steps[cur.v];
      if (typeof step !== 'function') return s;
      const next = step(cur);
      if (!isObj(next) || next.v !== cur.v + 1) return s;
      cur = next;
    }
    return cur;
  }
  const upgradeState = (s) => upgradeWith(s, MIGRATIONS, VERSION);
  /* この画面より新しい版の名簿か（読み込み直しを頼む） */
  const isNewer = (s) => isObj(s) && Number.isInteger(s.v) && s.v > VERSION;

  function validateState(s) {
    if (!isObj(s) || s.v !== VERSION) return result(['version']);
    const all = (list, fn) => Array.isArray(list) && list.every(x => fn(x).ok);
    return result([
      !(isObj(s.shop) && isStr(s.shop.name, 60)) && 'shop',
      !all(s.trips, validateTrip) && 'trips', !all(s.bookings, validateBooking) && 'bookings',
      !all(s.people, validatePerson) && 'people', !(Array.isArray(s.log) && s.log.every(logOk)) && 'log',
      !(s.jobs === undefined || isList(s.jobs, MAX_JOBS, jobOk)) && 'jobs', !(s.outbox === undefined || isList(s.outbox, MAX_OUTBOX, outOk)) && 'outbox'
    ]);
  }

  /* ---------- AI に送る物 ----------
     依頼: { doc:'mail', text } か { doc, image, masked }。申込書の写真は、健康の欄を塗ってから送る（masked: true）。
     予約の一覧（list）は塗らなくてよいが、健康や備考の欄が写っていればお店が塗ってから送る（画面で確かめる）。
     ほかの項目は受け付けない（健康の項目を紛れ込ませない）。sampleId は見本の読み取りだけが使い、送らない */
  const REQ_KEYS = { mail: ['doc', 'text', 'sampleId'], paper: ['doc', 'image', 'masked', 'sampleId'], ccard: ['doc', 'image', 'masked', 'sampleId'],
    list: ['doc', 'image', 'masked', 'sampleId'] };

  function validateRequest(given) {
    if (!isObj(given) || !DOCS.includes(given.doc)) return result(['doc']);
    /* 値が undefined や null の項目は、無いのと同じに扱う（画面で sampleId: picked?.id と書けるように） */
    const q = Object.fromEntries(Object.entries(given).filter(([, v]) => v != null));
    const base = [!onlyKeys(q, REQ_KEYS[q.doc]) && 'keys', has(q, 'sampleId') && !isStr(q.sampleId, 10) && 'sampleId'];
    if (q.doc === 'mail') {
      const textOk = isStr(q.text, MAX_TEXT) && q.text.trim() !== '';
      return result([...base, !textOk && 'text', textOk && looksEncoded(q.text) && 'encoded']);
    }
    return result([
      ...base,
      !(isStr(q.image, MAX_IMAGE) && /^[A-Za-z0-9+/=]+$/.test(q.image)) && 'image',
      has(q, 'masked') && typeof q.masked !== 'boolean' && 'masked',
      q.doc === 'paper' && q.masked !== true && 'masked'
    ]);
  }

  /* Worker に送る中身。決まった項目だけで組み直す */
  const requestBody = (q) => (q.doc === 'mail' ? { doc: 'mail', text: q.text } : { doc: q.doc, image: q.image, masked: q.masked === true });

  /* 予約メールの健康の行を外す処理は js/health-redact.js（core）。ここは送る物の形だけを決める */

  /* 「メールのソース」を貼ると、本文が quoted-printable や base64 になっていて、健康の言葉が見えない。読まずに断る */
  const ENCODED = /content-transfer-encoding|(=[0-9A-F]{2}){3,}|(^[A-Za-z0-9+/]{60,}={0,2}\r?\n){3,}/m;
  const looksEncoded = (text) => /content-transfer-encoding/i.test(text) || ENCODED.test(text);

  /* ---------- AI の答え（Worker と見本が返す形）。健康の項目は入れない ---------- */
  const READ_PERSON_KEYS = [...AI_FIELDS, 'unsure'];
  const BOOKING_KEYS = ['site', 'ref', 'date', 'start', 'tour', 'people', 'leadName', 'leadPhone', 'leadEmail', 'unsure'];

  function validateReading(x) {
    if (!onlyKeys(x, ['booking', 'people', 'healthSeen']) || typeof x.healthSeen !== 'boolean' ||
      !Array.isArray(x.people) || x.people.length > MAX_PEOPLE) {
      return result(['shape']);
    }
    const b = x.booking;
    const bookingOk = b === null || (onlyKeys(b, BOOKING_KEYS) &&
      isStr(b.site, 40) && isStr(b.ref, 60) && isDay(b.date) && isTime(b.start) && isStr(b.tour, 80) &&
      isCount(b.people, MAX_PEOPLE) && isStr(b.leadName, 60) && isStr(b.leadPhone, 30) && (b.leadEmail === undefined || emailOk(b.leadEmail)) &&
      isList(b.unsure, 10, u => BOOKING_KEYS.includes(u) && u !== 'unsure'));
    const peopleOk = x.people.every(p => onlyKeys(p, READ_PERSON_KEYS) &&
      personFieldsOk(p).every(e => !e) && isList(p.unsure, 20, u => AI_FIELDS.includes(u)));
    return result([!bookingOk && 'booking', !peopleOk && 'people']);
  }

  /* ---------- モデルの JSON（snake_case）を答えの形に直す。知らない項目は捨てる ---------- */
  /* AI の答えの文字。1 行の項目なので、改行は空白にし、見えない制御文字は消す（.ics・CSV・印刷に別の行を差し込ませない） */
  const str = (v, max) => (typeof v === 'string'
    ? v.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, max) : '');
  const date = (v) => { const s = str(v, 10); return realDate(s) ? s : ''; };
  const day = (v) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && realDate(s) ? s : ''; };
  const time = (v) => { const s = str(v, 5); return realTime(s) ? s : ''; };
  const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : '');
  const size = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : '');
  const emailOf = (v) => { const s = str(v, 254); return EMAIL.test(s) ? s : ''; };
  const UNSURE = { name: 'name', birth_date: 'birthDate', phone: 'phone', address: 'address',
    emergency_name: 'emergency', emergency_relation: 'emergency', emergency_phone: 'emergency',
    cert_course: 'cert', cert_date: 'cert', dive_count: 'dives', last_dive: 'lastDive',
    height_cm: 'sizes', weight_kg: 'sizes', foot_cm: 'sizes' };
  const BOOKING_UNSURE = { site: 'site', ref: 'ref', date: 'date', start: 'start', tour: 'tour', people: 'people',
    lead_name: 'leadName', lead_phone: 'leadPhone', lead_email: 'leadEmail' };
  const mapList = (list, table) => [...new Set((Array.isArray(list) ? list : [])
    .filter(u => typeof u === 'string' && has(table, u)).map(u => table[u]))];

  /* C カードは「MIHON HANAKO / 見本 花子」と 2 通りで書かれる。名簿には日本語の方を使う */
  function pickName(v) {
    const parts = str(v, 120).split('/').map(s => s.trim()).filter(Boolean);
    return (parts.find(s => /[^\x00-\x7F]/.test(s)) || parts[0] || '').slice(0, 60);
  }

  function personFromModel(m) {
    const course = str(m.cert_course, 10).toUpperCase();
    return {
      name: pickName(m.name), birthDate: date(m.birth_date), phone: str(m.phone, 30), address: str(m.address, 120),
      emergency: { name: str(m.emergency_name, 60), relation: str(m.emergency_relation, 20), phone: str(m.emergency_phone, 30) },
      cert: { course: COURSES.includes(course) ? course : '', date: date(m.cert_date) },
      dives: count(m.dive_count), lastDive: date(m.last_dive),
      sizes: { height: size(m.height_cm, 250), weight: size(m.weight_kg, 300), foot: size(m.foot_cm, 40) },
      unsure: mapList(m.unsure, UNSURE)
    };
  }

  function bookingFromModel(b) {
    if (!isObj(b)) return null;
    return {
      site: str(b.site, 40), ref: str(b.ref, 60), date: day(b.date), start: time(b.start), tour: str(b.tour, 80),
      people: Number.isInteger(b.people) && b.people >= 0 && b.people <= MAX_PEOPLE ? b.people : '',
      leadName: str(b.lead_name, 60), leadPhone: str(b.lead_phone, 30), leadEmail: emailOf(b.lead_email), unsure: mapList(b.unsure, BOOKING_UNSURE)
    };
  }

  function fromModel(raw) {
    const m = isObj(raw) ? raw : {};
    const people = (Array.isArray(m.participants) ? m.participants : []).filter(isObj).slice(0, MAX_PEOPLE).map(personFromModel);
    return { booking: bookingFromModel(m.booking), people, healthSeen: m.health_info_visible === true };
  }

  R.roster = {
    VERSION, KINDS, SOURCES, FIELD_SRC, LOG_WHO, COURSES, TODAY, DOCS, CHECK_STAGES, MAX_DIVES, CANCEL_REASONS, CANCEL_TEXT, HEALTH_QUESTIONS, SPO2_DIVES, SPO2_MIN, SPO2_MAX, MAX_TEXT, MAX_IMAGE, MAX_PEOPLE,
    ITEMS, AI_FIELDS, SUB, realDate, nextDay, blankTrip, blankBooking, blankPerson, blankState,
    validateTrip, validateBooking, validatePerson, validateState, validateRequest, requestBody,
    validateReading, fromModel,
    LANGS, JOB_KINDS, OUT_KINDS, OUT_STATUS, isJst, emailOk, jobOk, outOk,
    MIGRATIONS, bumpAll, upgradeWith, upgradeState, isNewer
  };
})();
