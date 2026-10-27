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
  /* デモの時計（R.setClockTo で進める）と、日本の時刻のずれ */
  let clockOffset = 0;
  const JST_MS = 9 * 3600 * 1000;

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

  /* 読める退避は、名簿と同じく便の日から 1 年を過ぎた便を消す（退避した日から数えると、便から最大 2 年残るため。ザクのレビュー 2026-10-27） */
  function purgeBackup(text) {
    let o = null;
    try { o = JSON.parse(text); } catch (e) { return text; }
    if (!o || typeof o !== 'object' || !R.roster.validateState(o).ok) return text;
    const kept = R.rosterCore.purgeExpired(o, { today: ymd(new Date()), at: new Date().toISOString() });
    return kept === o ? text : JSON.stringify(kept);
  }

  /* 1 年を過ぎた退避を消す。残す退避からも、他のお店のお客さんの健康の答えと、便の日から 1 年を過ぎた便を外す（前の版で退避した物のため） */
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
        const tidied = v === null ? v : purgeBackup(stripPartnerHealth(v));
        if (tidied !== v) localStorage.setItem(k, tidied);
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

  /* ---------- サーバーの名簿（plan/server.md）。Worker 版で /api/roster が答えたときだけ使う（js/roster-sync.js） ----------
     confirmed はサーバーが最後に認めた名簿と版、queue はまだ認められていない直し（名簿を受けて新しい名簿を返す関数）。
     画面の名簿は confirmed に queue を順に当てた物。サーバーが別の端末の直しで先に進んでいたら、最新に queue を当て直して送り直す。
     電波が無いときは端末に貯め、次に送れたときに送る。読み込み直して関数が消えたあとは、版が同じときだけ端末の名簿をそのまま送る */
  const SYNC_KEY = `${ROSTER_KEY}-sync`;          // { version, pending }
  const OFFLINE_KEPT = ROSTER_BACKUP;   // 送れないうちに別の端末が直したとき、この端末の名簿を残す場所（読めない名簿の退避と同じく 1 年で消える）
  const SYNC_TRIES = 5;
  let sync = null;   // { version, confirmed, queue, flushing } — null はサーバーを使わない（GitHub Pages・手元・D1 がまだ無い）

  function readSyncMeta() {
    try { const m = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); return m && Number.isInteger(m.version) ? m : null; } catch (e) { return null; }
  }
  function writeSyncMeta() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ version: sync.version, pending: sync.queue.length > 0 })); } catch (e) { /* 書けなくても次に送るときに直る */ }
  }
  const isBlank = (s) => !s.trips.length && !s.bookings.length && !s.people.length;

  /* confirmed に queue を当てる。今の名簿に当てられなくなった直し（別の端末が便を消した、など）は外し、外した数を返す */
  function rebase() {
    let s = sync.confirmed || R.roster.blankState(ROSTER_SHOP);
    const kept = [];
    sync.queue.forEach(fn => {
      try { const next = fn(s); if (R.roster.validateState(next).ok) { s = next; kept.push(fn); } } catch (e) { /* 外す */ }
    });
    const dropped = sync.queue.length - kept.length;
    sync.queue = kept;
    return { state: s, dropped };
  }
  function adopt() {
    const { state, dropped } = rebase();
    if (dropped) rosterNote = 'sync-dropped';
    roster = state;
    writeRoster(state);
    writeSyncMeta();
    rosterListeners.forEach(fn => fn(state));
  }

  /* まだ認められていない直しを送る。同時に 2 つは送らない（送っている間の直しは次の回に入る） */
  function flushSync() {
    if (!sync) return Promise.resolve();
    if (sync.flushing) return sync.flushing;
    if (!sync.queue.length) return Promise.resolve();
    sync.flushing = (async () => {
      for (let i = 0; i < SYNC_TRIES && sync.queue.length; i += 1) {
        const sent = sync.queue.length;
        const { state } = rebase();
        const r = await R.rosterSync.push(sync.version, state);
        if (r.ok || r.conflict) {
          sync.version = r.version;
          sync.confirmed = r.state;
          if (r.ok) sync.queue = sync.queue.slice(sent);   // 送ったあとに足された直しは残す
          if (rosterNote === 'sync-offline') rosterNote = null;
          adopt();
          continue;
        }
        rosterNote = 'sync-offline';   // 届かない・サーバーの誤り。直しは端末に残し、次に送る
        writeSyncMeta();
        rosterListeners.forEach(fn => fn(roster));
        break;
      }
    })().finally(() => { sync.flushing = null; });
    return sync.flushing;
  }

  /* 直しは、サーバーに送るたびに当て直す（rebase）。中で R.newId を呼ぶ直しが毎回ちがう id を作ると、
     その id を指す後の直し（予約に予定を足す、など）が当てられずに外れる。1 回目に作った id を、当て直しでも使い回す */
  function stableIds(fn) {
    const made = [];
    return (s) => {
      const real = R.newId;
      let i = 0;
      R.newId = () => (i < made.length ? made[i++] : (made[i++] = real()));
      try { return fn(s); } finally { R.newId = real; }
    };
  }

  function updateRoster(change) {
    const fn = stableIds(change);
    const next = fn(loadRoster());
    if (!sync) return saveRoster(next);
    const saved = saveRoster(next);   // 先に画面と端末に出す（形の検査もここで）
    sync.queue.push(fn);
    writeSyncMeta();
    flushSync();
    return saved;
  }

  /* サーバーにつなぐ。答えなければ端末だけで続ける */
  async function startSync() {
    if (sync || !R.rosterSync || rosterLocked) return false;
    const got = await R.rosterSync.pull();
    if (!got.ok) return false;
    const local = loadRoster();
    const meta = readSyncMeta();
    sync = { version: got.version, confirmed: got.state, queue: [], flushing: null };
    if (got.state === null) {
      if (!isBlank(local)) sync.queue.push(() => local);   // サーバーにまだ名簿が無い: この端末の名簿を最初の名簿として置く
    } else if (meta && meta.pending) {
      if (meta.version === got.version) sync.queue.push(() => local);   // 前に送れなかった直しがある。版が同じならそのまま送る
      else {
        /* 送れないうちに別の端末が直した。この端末の名簿は消さずに退避して、サーバーの名簿にする */
        try { localStorage.setItem(`${OFFLINE_KEPT}${Date.now()}`, purgeBackup(stripPartnerHealth(JSON.stringify(local)))); } catch (e) { /* 残せなくても、サーバーの名簿にする */ }
        rosterNote = 'sync-kept';
      }
    }
    adopt();
    await flushSync();
    return true;
  }

  /* 別の端末の直しを取り込む（画面に戻ってきたとき）。送っていない直しがある間は、送るのを先にする */
  async function refreshSync() {
    if (!sync) return false;
    if (sync.queue.length) { await flushSync(); return true; }
    const got = await R.rosterSync.pull();
    if (!got.ok || got.state === null || got.version === sync.version) return got.ok;
    sync.version = got.version;
    sync.confirmed = got.state;
    adopt();
    return true;
  }

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => { flushSync(); });
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
      update: updateRoster,
      reset: () => updateRoster(() => R.roster.blankState(ROSTER_SHOP)),
      note: () => rosterNote,
      /* サーバーの名簿（Worker 版だけ）。startSync はつないだら true、refresh は別の端末の直しの取り込み、whenSynced は送り終わるまで待つ */
      startSync,
      refresh: refreshSync,
      whenSynced: flushSync,
      synced: () => !!sync,
      subscribe: (fn) => { rosterListeners.push(fn); }
    },
    today: () => ymd(new Date(Date.now() + clockOffset)),
    /* 日本の時刻「YYYY-MM-DDTHH:MM」。書類の自動化の予定と比べる（js/roster-auto.js） */
    nowJst: () => new Date(Date.now() + clockOffset + JST_MS).toISOString().slice(0, 16),
    /* 記録に残す時刻（デモの時計を進めたら、その時刻で残す） */
    nowIso: () => new Date(Date.now() + clockOffset).toISOString(),
    /* デモの「時刻を進める」。日本の時刻まで時計を進める（戻さない。開き直すと元の時計に戻る） */
    setClockTo: (jst) => {
      const target = Date.parse(`${jst}:00+09:00`);
      if (Number.isFinite(target) && target > Date.now() + clockOffset) clockOffset = target - Date.now();
    }
  };
})();
