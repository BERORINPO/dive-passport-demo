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
  let rosterNote = null;        // recovered（退避して空から始めた）/ unreadable（退避できず元のまま）/ conflict（別のタブと食い違い）
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

  function dropOldBackups() {
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(ROSTER_BACKUP) && Date.now() - Number(k.slice(ROSTER_BACKUP.length)) > BACKUP_KEEP_MS) old.push(k);
      }
      old.forEach(k => localStorage.removeItem(k));
    } catch (e) {
      // 保存場所が使えないときは何もしない
    }
  }

  function loadRoster() {
    if (roster) return roster;
    dropOldBackups();
    let raw = null;
    try { raw = localStorage.getItem(ROSTER_KEY); } catch (e) { /* 保存場所が使えないときは、空の名簿から始める */ }
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    if (parsed && R.roster.validateState(parsed).ok) {
      roster = R.rosterCore.purgeExpired(parsed, { today: ymd(new Date()), at: new Date().toISOString() });
      if (roster !== parsed) writeRoster(roster);   // 期限切れを消したら、保存場所からも消す
    } else {
      roster = R.roster.blankState(ROSTER_SHOP);
      if (raw) {
        let kept = false;
        try {
          localStorage.setItem(`${ROSTER_BACKUP}${Date.now()}`, raw);
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
