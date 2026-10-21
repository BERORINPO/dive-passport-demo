/* 予約と名簿の形（版 1）。予約・名簿・乗り合いの画面と、AI の読み取り（本物の Worker・見本）が共通で使う契約。
   条例の名簿の項目（沖縄県水上安全条例施行規則 第30条・第36条）もここで決める。
   ブラウザでも Node（テスト）でも Worker でも動くように、globalThis.REDUX に足す。依存なし */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const VERSION = 1;
  const KINDS = ['dive', 'snorkel'];
  const SOURCES = ['mail', 'form', 'phone', 'partner'];        // 予約の出どころ: 予約サイトのメール / 自社のフォーム / 電話など / 乗り合いの他店
  const FIELD_SRC = ['mail', 'paper', 'ccard', 'guest', 'staff', 'passport', 'partner'];   // その項目を入れたもの
  const LOG_WHO = ['staff', 'guest', 'ai', 'system'];          // 記録に残す「した人」
  const LOG_ACT = ['add', 'edit', 'ai', 'check', 'print', 'csv', 'remove'];
  const COURSES = ['', 'OW', 'AOW', 'RESCUE', 'JOW', 'DM', 'OTHER', 'NONE'];               // NONE = C カードなし（体験）
  const TODAY = ['', 'ok', 'unwell'];
  const DOCS = ['mail', 'paper', 'ccard'];
  const HEALTH_QUESTIONS = 5;                                  // data.js の R.HEALTH と同じ数
  const MAX_TEXT = 20000;                                      // 予約メールの本文の上限（文字）
  const MAX_IMAGE = 4000000;                                   // 写真の上限（base64 の文字数、約 3 MB）
  const MAX_PEOPLE = 30;

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

  /* ---------- 検査 ---------- */
  function validateTrip(t) {
    if (!isObj(t) || t.v !== VERSION) return result(['version']);
    return result([
      !isId(t.id) && 'id', !isDay(t.date) && 'date', !isTime(t.start) && 'start',
      !KINDS.includes(t.kind) && 'kind', !isStr(t.tour, 40) && 'tour', !isStr(t.boat, 40) && 'boat',
      !isStr(t.site, 80) && 'site', !isList(t.guides, 10, g => isStr(g, 40)) && 'guides',
      !isStr(t.host, 60) && 'host', !isList(t.partners, 10, s => isStr(s, 60)) && 'partners',
      !isList(t.tags, MAX_PEOPLE * 4, x => onlyKeys(x, ['personId', 'no']) && isId(x.personId) && isStr(x.no, 10)) && 'tags',
      !isList(t.checks, 50, x => onlyKeys(x, ['at', 'stage', 'missing']) && isStr(x.at, 40) &&
        ['leave', 'return'].includes(x.stage) && isList(x.missing, MAX_PEOPLE * 4, isId)) && 'checks',
      !isStr(t.createdAt, 40) && 'createdAt'
    ]);
  }

  function validateBooking(b) {
    if (!isObj(b) || b.v !== VERSION) return result(['version']);
    return result([
      !isId(b.id) && 'id', !isId(b.tripId) && 'tripId', !SOURCES.includes(b.source) && 'source',
      !isStr(b.site, 40) && 'site', !isStr(b.ref, 60) && 'ref', !isStr(b.leadName, 60) && 'leadName',
      !isStr(b.leadPhone, 30) && 'leadPhone',
      !(Number.isInteger(b.people) && b.people >= 1 && b.people <= MAX_PEOPLE) && 'people',
      !isStr(b.shop, 60) && 'shop', !isStr(b.note, 400) && 'note', !isStr(b.createdAt, 40) && 'createdAt'
    ]);
  }

  function healthOk(h) {
    return onlyKeys(h, ['historyAt', 'answers', 'todayAt', 'today']) && isDay(h.historyAt) &&
      isList(h.answers, HEALTH_QUESTIONS, isAnswer) && h.answers.length === HEALTH_QUESTIONS &&
      isDay(h.todayAt) && TODAY.includes(h.today);
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

  function logOk(e) {
    return isObj(e) && isStr(e.at, 40) && LOG_WHO.includes(e.who) && LOG_ACT.includes(e.act) &&
      ['trip', 'booking', 'person', 'state'].includes(e.kind) && isStr(e.id, 40) &&
      isList(e.fields, 30, f => isStr(f, 20)) && isObj(e.before) && isObj(e.after) && sentOk(e.sent);
  }

  function validateState(s) {
    if (!isObj(s) || s.v !== VERSION) return result(['version']);
    const all = (list, fn) => Array.isArray(list) && list.every(x => fn(x).ok);
    return result([
      !(isObj(s.shop) && isStr(s.shop.name, 60)) && 'shop',
      !all(s.trips, validateTrip) && 'trips', !all(s.bookings, validateBooking) && 'bookings',
      !all(s.people, validatePerson) && 'people', !(Array.isArray(s.log) && s.log.every(logOk)) && 'log'
    ]);
  }

  /* ---------- AI に送る物 ----------
     依頼: { doc:'mail', text } か { doc, image, masked }。申込書の写真は、健康の欄を塗ってから送る（masked: true）。
     ほかの項目は受け付けない（健康の項目を紛れ込ませない）。sampleId は見本の読み取りだけが使い、送らない */
  const REQ_KEYS = { mail: ['doc', 'text', 'sampleId'], paper: ['doc', 'image', 'masked', 'sampleId'], ccard: ['doc', 'image', 'masked', 'sampleId'] };

  function validateRequest(q) {
    if (!isObj(q) || !DOCS.includes(q.doc)) return result(['doc']);
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

  /* 予約メールの本文から、健康や病気に触れていそうな所を外す（念のための 2 重目。AI にも書き写さないよう頼んでいる）。
     外しすぎるのは構わない。予約に要るのは日時・人数・名前・連絡先で、健康の行には無い。
     比べる前に文字をそろえる（全角半角・ゼロ幅文字を消す・カタカナはひらがなへ・小文字へ）。
     健康の言葉がある行から、空行か次の「項目名:」の行までをまとめて外す（質問の行の次の行に答えが来る形のため） */
  const ZERO_WIDTH = /[­​-‏⁠-⁤﻿]/g;
  const fold = (s) => String(s).normalize('NFKC').replace(ZERO_WIDTH, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();
  const HEALTH_WORDS = new RegExp([
    // 日本語。1〜2 字の広い言葉も入れる
    '既往', '持病', '病', '症', '患', '薬', '藥', '药', '痛', '炎', '妊', '孕', '術', '障', '疾', '傷', '血', '耳', '肺', '喘', '医', '醫',
    '入院', '通院', '治療', '発作', '心臓', '糖尿', '体調', '健康', '怪我', 'けが', 'ぜんそく', 'ぜん息', 'てんかん', 'あれるぎ',
    'へるにあ', 'かぜ', '風邪', '熱', 'うつ', '鬱', 'ぱにっく', 'ぺーすめーかー', 'めまい', '骨折', '捻挫', 'ねんざ',
    // 中国語・韓国語
    '心脏', '心臟', '过敏', '過敏', '천식', '임신', '임산', '질병', '병원', '병력', '수술', '심장', '알레르기', '당뇨', '혈압', '건강', '약물', '복용',
    // 英語
    'medical', 'medicine', 'medication', 'asthma', 'pregnan', 'surgery', 'surgical', 'injur', 'health', 'allerg', 'diabet',
    'epilep', 'heart', 'blood', 'seizure', 'hospital', 'prescription', 'disease', 'illness', 'sick', 'fever', 'pacemaker',
    'panic', 'depress', 'lung', 'sinus', 'cancer', 'disab', 'drug', 'pill', 'doctor'
  ].join('|'));
  const LABEL = /^\s*[-・*•>]*\s*[^\s:][^:]{0,40}:/;                            // 「項目名:」で始まる行（fold の後なので : は半角）
  const ANSWER = /^\s*[-・*•>]*\s*(a|ans|answer|答え?|回答|返答)\s*[:.]/;       // 答えの行は、前の質問の続き
  const REDACTED_LINE = '（健康についての行は送っていません）';

  function redactHealthLines(text) {
    let redacted = 0;
    let inBlock = false;
    const out = String(text).split('\n').map(line => {
      const f = fold(line);
      if (inBlock && (f.trim() === '' || (LABEL.test(f) && !ANSWER.test(f)))) inBlock = false;
      if (!inBlock && !HEALTH_WORDS.test(f)) return line;
      inBlock = true;
      redacted += 1;
      return REDACTED_LINE;
    }).join('\n');
    return { text: out, redacted };
  }

  /* 「メールのソース」を貼ると、本文が quoted-printable や base64 になっていて、健康の言葉が見えない。読まずに断る */
  const ENCODED = /content-transfer-encoding|(=[0-9A-F]{2}){3,}|(^[A-Za-z0-9+/]{60,}={0,2}\r?\n){3,}/m;
  const looksEncoded = (text) => /content-transfer-encoding/i.test(text) || ENCODED.test(text);

  /* ---------- AI の答え（Worker と見本が返す形）。健康の項目は入れない ---------- */
  const READ_PERSON_KEYS = [...AI_FIELDS, 'unsure'];
  const BOOKING_KEYS = ['site', 'ref', 'date', 'start', 'tour', 'people', 'leadName', 'leadPhone', 'unsure'];

  function validateReading(x) {
    if (!onlyKeys(x, ['booking', 'people', 'healthSeen']) || typeof x.healthSeen !== 'boolean' ||
      !Array.isArray(x.people) || x.people.length > MAX_PEOPLE) {
      return result(['shape']);
    }
    const b = x.booking;
    const bookingOk = b === null || (onlyKeys(b, BOOKING_KEYS) &&
      isStr(b.site, 40) && isStr(b.ref, 60) && isDay(b.date) && isTime(b.start) && isStr(b.tour, 80) &&
      isCount(b.people, MAX_PEOPLE) && isStr(b.leadName, 60) && isStr(b.leadPhone, 30) &&
      isList(b.unsure, 10, u => BOOKING_KEYS.includes(u) && u !== 'unsure'));
    const peopleOk = x.people.every(p => onlyKeys(p, READ_PERSON_KEYS) &&
      personFieldsOk(p).every(e => !e) && isList(p.unsure, 20, u => AI_FIELDS.includes(u)));
    return result([!bookingOk && 'booking', !peopleOk && 'people']);
  }

  /* ---------- モデルの JSON（snake_case）を答えの形に直す。知らない項目は捨てる ---------- */
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const date = (v) => { const s = str(v, 10); return realDate(s) ? s : ''; };
  const day = (v) => { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && realDate(s) ? s : ''; };
  const time = (v) => { const s = str(v, 5); return realTime(s) ? s : ''; };
  const count = (v) => (Number.isInteger(v) && v >= 0 && v <= 100000 ? v : '');
  const size = (v, max) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max ? v : '');
  const UNSURE = { name: 'name', birth_date: 'birthDate', phone: 'phone', address: 'address',
    emergency_name: 'emergency', emergency_relation: 'emergency', emergency_phone: 'emergency',
    cert_course: 'cert', cert_date: 'cert', dive_count: 'dives', last_dive: 'lastDive',
    height_cm: 'sizes', weight_kg: 'sizes', foot_cm: 'sizes' };
  const BOOKING_UNSURE = { site: 'site', ref: 'ref', date: 'date', start: 'start', tour: 'tour', people: 'people',
    lead_name: 'leadName', lead_phone: 'leadPhone' };
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
      leadName: str(b.lead_name, 60), leadPhone: str(b.lead_phone, 30), unsure: mapList(b.unsure, BOOKING_UNSURE)
    };
  }

  function fromModel(raw) {
    const m = isObj(raw) ? raw : {};
    const people = (Array.isArray(m.participants) ? m.participants : []).filter(isObj).slice(0, MAX_PEOPLE).map(personFromModel);
    return { booking: bookingFromModel(m.booking), people, healthSeen: m.health_info_visible === true };
  }

  R.roster = {
    VERSION, KINDS, SOURCES, FIELD_SRC, LOG_WHO, COURSES, TODAY, DOCS, HEALTH_QUESTIONS, MAX_TEXT, MAX_IMAGE, MAX_PEOPLE,
    ITEMS, AI_FIELDS, SUB, realDate, blankTrip, blankBooking, blankPerson, blankState,
    validateTrip, validateBooking, validatePerson, validateState, validateRequest, requestBody, redactHealthLines,
    validateReading, fromModel
  };
})();
