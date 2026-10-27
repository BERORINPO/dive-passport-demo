/* 共通の道具: 言語、要素づくり、日付、保存（このブラウザの中だけ。どこにも送らない） */
(() => {
  'use strict';

  const KEY = 'redux-m1-lite-v2';    // v2: 受付に出どころ（source）と質問票の回答日（medicalAt）を足した
  const langListeners = [];
  const storeListeners = [];
  let state = null;

  /* 真偽の属性は、値を真偽に直してから付ける（'' や 0 を渡して「付いている」にならないように） */
  const BOOL_PROPS = { disabled: 'disabled', checked: 'checked', selected: 'selected', required: 'required', hidden: 'hidden',
    readonly: 'readOnly', multiple: 'multiple', novalidate: 'noValidate' };

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (Object.prototype.hasOwnProperty.call(BOOL_PROPS, k)) { node[BOOL_PROPS[k]] = !!v; return; }
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    });
    children.flat(Infinity).forEach(c => {
      if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
    });
    return node;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

  function freshState() {
    return { intakes: R.seedIntakes(), questions: [], flightHours: { dive: 18 }, medicalDays: R.MEDICAL_DAYS_DEFAULT };
  }

  function load() {
    if (state) return state;
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      state = parsed && Array.isArray(parsed.intakes) ? parsed : freshState();
    } catch (e) {
      // 保存場所が使えない (プライベートウィンドウなど) ときは、見本の受付から始める
      state = freshState();
    }
    return state;
  }

  function save(next) {
    state = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch (e) {
      // 保存できなくても、開いている間は画面の中で動く
    }
    storeListeners.forEach(fn => fn(next));
  }

  /* ダイバーのパスポートは、店の受付とは別の保存場所に置く（本番ではダイバーのスマホと店の端末に分かれる） */
  const PASS_KEY = 'redux-pass-v1';
  const passListeners = [];
  let passport;   // undefined = まだ読んでいない、null = 無い

  function loadPass() {
    if (passport !== undefined) return passport;
    try {
      const raw = localStorage.getItem(PASS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      passport = parsed && R.pass.validate(parsed).ok ? parsed : null;
    } catch (e) {
      // 保存場所が使えない、または中身が壊れているときは、パスポート無しから始める
      passport = null;
    }
    return passport;
  }

  function savePass(next) {
    passport = next;
    try {
      if (next) localStorage.setItem(PASS_KEY, JSON.stringify(next));
      else localStorage.removeItem(PASS_KEY);
    } catch (e) {
      // 保存できなくても、開いている間は画面の中で使える
    }
    passListeners.forEach(fn => fn(next));
  }

  /* 予約と名簿も、受付ともパスポートとも別の保存場所に置く。読み込むときに形を確かめ、保存期間（1 年）を過ぎた便を消す。
     形が合わないときは黙って消さず、元の文字を別のキーに退避してから空で始める（1 年保存の名簿のため）。
     形は roster-schema.js、組み立ては roster-core.js（この 2 つは core.js の後に読む） */
  const ROSTER_KEY = 'redux-roster-v1';
  const ROSTER_SHOP = 'B マリン（見本）';
  const ROSTER_BACKUP = `${ROSTER_KEY}-broken-`;
  const BACKUP_KEEP_MS = 366 * 24 * 60 * 60 * 1000;   // 退避した名簿も 1 年で消す
  const rosterListeners = [];
  let roster = null;
  let rosterNote = null;        // recovered（退避して空から始めた）/ unreadable（退避できず元のまま）/ conflict（別のタブと食い違い）/ newer（別のタブがこの版の知らない形で保存した）
  let rosterLocked = false;     // 読めない名簿を退避できなかった。元の名簿を上書きしないよう、この端末には書かない
  let rosterUnsaved = false;    // 最後の保存が端末に書けなかった

  function writeRoster(next) {
    if (rosterLocked) return false;
    try {
      localStorage.setItem(ROSTER_KEY, JSON.stringify(next));
      rosterUnsaved = false;
      return true;
    } catch (e) {
      rosterUnsaved = true;
      return false;   // 容量切れや、保存を止めているブラウザ。呼ぶ側が知らせる
    }
  }

  /* 退避する名簿の文字から、乗り合いの他のお店のお客さんの健康の答えを外す（2026-10-22 から健康は船に持たない）。
     形の検査に落ちた名簿でも、JSON として読めて予約と人の並びがあれば外す。読めなければ元の文字のまま。外す物が無ければ元の文字のまま返す */
  function stripPartnerHealth(text) {
    let o = null;
    try { o = JSON.parse(text); } catch (e) { return text; }
    if (!o || typeof o !== 'object' || !Array.isArray(o.bookings) || !Array.isArray(o.people)) return text;
    const partner = new Set(o.bookings.filter(b => b && b.source === 'partner').map(b => b.id));
    const answered = (h) => !!h && typeof h === 'object' &&
      ((Array.isArray(h.answers) && h.answers.some(a => a !== null && a !== undefined)) || (typeof h.today === 'string' && h.today !== '') ||
        (Array.isArray(h.spo2) && h.spo2.some(d => !!d && ((d.pre !== '' && d.pre !== undefined) || (d.post !== '' && d.post !== undefined)))));
    if (!o.people.some(p => p && partner.has(p.bookingId) && answered(p.health))) return text;
    const people = o.people.map(p => {
      if (!p || !partner.has(p.bookingId) || !answered(p.health)) return p;
      const { health, ...rest } = p;
      return rest;
    });
    return JSON.stringify({ ...o, people });
  }

  /* 1 年を過ぎた退避を消す。残す退避からも、他のお店のお客さんの健康の答えを外す（前の版で退避した物のため） */
  function tidyBackups() {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(ROSTER_BACKUP)) keys.push(k);
      }
      keys.forEach(k => {
        if (Date.now() - Number(k.slice(ROSTER_BACKUP.length)) > BACKUP_KEEP_MS) { localStorage.removeItem(k); return; }
        const v = localStorage.getItem(k);
        const stripped = v === null ? v : stripPartnerHealth(v);
        if (stripped !== v) localStorage.setItem(k, stripped);
      });
    } catch (e) {
      // 保存場所が使えないときは何もしない
    }
  }

  function loadRoster() {
    if (roster) return roster;
    /* 他のお店のお客さんの健康の答えを消す決まり（roster-share.js）が無いまま名簿を開かない（消し忘れたまま保存し直さない） */
    if (!R.rosterShare) throw new Error('loadRoster: roster-share.js を先に読む');
    tidyBackups();
    let raw = null;
    try { raw = localStorage.getItem(ROSTER_KEY); } catch (e) { /* 保存場所が使えないときは、空の名簿から始める */ }
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    const cleaned = parsed && typeof parsed === 'object' ? R.rosterCore.scrubLog(parsed) : parsed;   // 前の版の記録に残った健康の答えの中身を消す
    if (cleaned && R.roster.validateState(cleaned).ok) {
      const at = new Date().toISOString();
      const kept = R.rosterCore.purgeExpired(cleaned, { today: ymd(new Date()), at });
      /* 前の版で船に渡した他のお店のお客さんの健康の答えを消す（健康は、そのお客さんのお店だけが持つ。roster-share.js）。
         期限切れの便を先に消してから（消える人に記録を足さない）。roster-share.js は index.html でこのファイルより後に読むが、名簿を読むのは画面ができてから */
      roster = R.rosterShare.holdPartnerHealth(kept, { at });
      if (roster !== parsed) writeRoster(roster);   // 書き換えたり期限切れを消したりしたら、保存場所にも入れる
    } else {
      roster = R.roster.blankState(ROSTER_SHOP);
      if (raw) {
        let kept = false;
        try {
          localStorage.setItem(`${ROSTER_BACKUP}${Date.now()}`, stripPartnerHealth(raw));
          kept = true;
        } catch (e) {
          kept = false;
        }
        if (kept) {
          writeRoster(roster);   // 開くたびに同じ物を退避し直さないように、空の名簿で置き換える
          rosterNote = 'recovered';
        } else {
          rosterLocked = true;   // 退避できなかったので、元の名簿を消さないように書かない
          rosterNote = 'unreadable';
        }
      }
    }
    return roster;
  }

  /* 保存できたかを返す（形が合わなければ例外） */
  function saveRoster(next) {
    const v = R.roster.validateState(next);
    if (!v.ok) throw new Error(`rosterStore: 形が合わない (${v.errors.join(',')})`);
    roster = next;
    const saved = writeRoster(next);
    rosterListeners.forEach(fn => fn(next));
    return saved;
  }

  /* 別のタブで名簿が変わったら読み直す（後から保存した方で上書きしない）。テスト（Node）には無いので、あるときだけ */
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('storage', (e) => {
      if (e.key !== ROSTER_KEY || rosterLocked) return;
      /* 別のタブ（新しい版の画面）が、この版の知らない形（足した欄など）で保存した。読み直すと形の検査に落ちて空の名簿で上書きするので、
         読み直さず、この画面からは書かない（新しい方の名簿を消さない）。保存できていない予約があっても、こちらを先に見る
         （「知らせるだけ」にすると、次の保存で新しい方を古い形で上書きしてしまう） */
      let incoming = null;
      try { incoming = e.newValue ? JSON.parse(e.newValue) : null; } catch (err) { incoming = null; }
      if (e.newValue && !(incoming && typeof incoming === 'object' && R.roster.validateState(R.rosterCore.scrubLog(incoming)).ok)) {
        rosterLocked = true;
        rosterNote = 'newer';
        rosterListeners.forEach(fn => fn(roster));
        return;
      }
      if (rosterUnsaved) {   // この画面に保存できていない予約がある。読み直すと消えるので、知らせるだけにする
        rosterNote = 'conflict';
        rosterListeners.forEach(fn => fn(roster));
        return;
      }
      roster = null;
      const next = loadRoster();
      rosterListeners.forEach(fn => fn(next));
    });
  }

  const R = window.REDUX = {
    lang: 'ja',
    L: (o) => (o == null ? '' : typeof o === 'string' ? o : (o[R.lang] != null ? o[R.lang] : o.ja)),
    onLang: (fn) => { langListeners.push(fn); },
    setLang: (lang) => {
      R.lang = lang;
      document.documentElement.lang = lang;
      langListeners.forEach(fn => fn());
    },
    el,
    /* 1 つ選ぶ選択肢の形（design.md の部品）。横につなげるのは、320 幅でも 1 行に収まる短い名前のときだけ。
       2 つなら 8 字まで、3 つなら 5 字まで。長い物（ツアー名・英語）は、2 行に折れないよう罫線の行にする */
    choiceClass: (labels) => (labels.length <= 3 && labels.every(t => String(t).length <= (labels.length <= 2 ? 8 : 5)) ? 'choices' : 'choices choices--rows'),
    /* replaceChildren は null を "null" という文字にしてしまうので、空のものを除いてから入れ替える */
    fill: (node, ...kids) => node.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false)),
    /* 文字のファイルをこの端末に保存する（名簿の CSV・カレンダーの .ics）。ブラウザの「ダウンロード」になる */
    saveFile: (name, text, type) => {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    /* 画面の下に固定する操作の帯（design.md）。左が主、右が副。誤りの文もここに入れて、押したボタンの上に出す */
    dock: (...nodes) => {
      const buttons = nodes.flat().filter(n => n && n.tagName === 'BUTTON').length;
      return el('div', { class: `dock${buttons === 1 ? ' dock--one' : ''}` }, nodes);
    },
    ymd,
    addDays,
    newId: () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    store: {
      get: load,
      update: (fn) => save(fn(load())),
      reset: () => save(freshState()),
      subscribe: (fn) => { storeListeners.push(fn); }
    },
    passStore: {
      get: loadPass,
      set: savePass,
      clear: () => savePass(null),
      subscribe: (fn) => { passListeners.push(fn); }
    },
    rosterStore: {
      get: loadRoster,
      update: (fn) => saveRoster(fn(loadRoster())),
      reset: () => saveRoster(R.roster.blankState(ROSTER_SHOP)),
      note: () => rosterNote,
      subscribe: (fn) => { rosterListeners.push(fn); }
    },
    today: () => ymd(new Date())
  };
})();
