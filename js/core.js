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
  const ROSTER_BACKUP = `${ROSTER_KEY}-broken-`;   // 読めなかった名簿の退避（数の上限と、容量切れで消してよいのはこれだけ）
  /* 送れなかった直しの退避（別の端末とぶつかった・サーバーが断った・お店が変わった・版が新しくなった）。端末にしか無いので、
     数の上限も容量切れの整理もかけない（1 年で消すのは同じ）。ジンのレビュー 2026-10-27 */
  const OFFLINE_KEPT = `${ROSTER_KEY}-kept-`;
  const BACKUP_KEEP_MS = 366 * 24 * 60 * 60 * 1000;   // 退避した名簿も 1 年で消す
  /* 退避は新しい 3 つまで。端末の保存場所は 5 MB ほどしか無く、退避がたまると名簿の本体を保存できなくなる（ジンのレビュー 2026-10-27 MEDIUM 9） */
  const BACKUP_MAX = 3;
  const rosterListeners = [];
  let roster = null;
  let rosterNote = null;        // recovered（退避して空から始めた）/ unreadable（退避できず元のまま）/ conflict（別のタブと食い違い）/ newer（別のタブがこの版の知らない形で保存した）
  let rosterLocked = false;     // 読めない名簿を退避できなかった。元の名簿を上書きしないよう、この端末には書かない
  let rosterUnsaved = false;    // 最後の保存が端末に書けなかった
  let rosterLost = false;       // 送れなかった直しを、端末に残せなかった（容量切れなど）

  /* 退避の名前を古い順に（名前の後ろは退避した時刻）。prefix は ROSTER_BACKUP か OFFLINE_KEPT */
  function backupKeys(prefix = ROSTER_BACKUP) {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) keys.push(k);
      }
    } catch (e) { /* 保存場所が使えない */ }
    return keys.sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  }
  /* 新しい keep 個だけ残す */
  function pruneBackups(keep) {
    const keys = backupKeys();
    keys.slice(0, Math.max(0, keys.length - keep)).forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* 消せなくても続ける */ } });
  }

  function writeRoster(next) {
    if (rosterLocked) return false;
    const text = JSON.stringify(next);
    try {
      localStorage.setItem(ROSTER_KEY, text);
      rosterUnsaved = false;
      return true;
    } catch (e) {
      /* 容量切れ: 名簿の本体を先に守る。古い退避から 1 つずつ消して、もう一度書く（本体はサーバーにもある。退避は端末にしか無いが、本体より後に回す） */
      for (const k of backupKeys()) {
        try {
          localStorage.removeItem(k);
          localStorage.setItem(ROSTER_KEY, text);
          rosterUnsaved = false;
          return true;
        } catch (e2) { /* まだ足りない */ }
      }
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
      /* 前の版は、送れなかった直しも -broken- に残していた。名簿の形をしている物（読めた物）は直しの退避なので、同じ時刻のまま -kept- に移してから整理する
         （端末にしか無い直しを、数の上限で消さない。ジンのレビュー 2026-10-27） */
      backupKeys().forEach(k => {
        let o = null;
        try { o = JSON.parse(localStorage.getItem(k)); } catch (e) { return; }
        if (!o || typeof o !== 'object' || !R.roster.validateState(R.roster.upgradeState(o)).ok) return;
        localStorage.setItem(`${OFFLINE_KEPT}${k.slice(ROSTER_BACKUP.length)}`, localStorage.getItem(k));
        localStorage.removeItem(k);
      });
      pruneBackups(BACKUP_MAX);
      [ROSTER_BACKUP, OFFLINE_KEPT].forEach(prefix => backupKeys(prefix).forEach(k => {
        if (Date.now() - Number(k.slice(prefix.length)) > BACKUP_KEEP_MS) { localStorage.removeItem(k); return; }
        const v = localStorage.getItem(k);
        const tidied = v === null ? v : purgeBackup(stripPartnerHealth(v));
        if (tidied !== v) localStorage.setItem(k, tidied);
      }));
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
    /* 前の形の版の名簿は今の版に上げ、前の版の記録に残った健康の答えの中身を消す */
    const cleaned = parsed && typeof parsed === 'object' ? R.rosterCore.scrubLog(R.roster.upgradeState(parsed)) : parsed;
    if (R.roster.isNewer(parsed)) {
      /* 新しい版の画面が保存した名簿。この画面では読めないので、退避も上書きもせず、読み込み直しを頼む（新しい方を消さない） */
      roster = R.roster.blankState(ROSTER_SHOP);
      rosterLocked = true;
      rosterNote = 'newer';
    } else if (cleaned && R.roster.validateState(cleaned).ok) {
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
          pruneBackups(BACKUP_MAX);
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
  const SYNC_KEY = `${ROSTER_KEY}-sync`;          // { version, pending, shop }
  const SYNC_TRIES = 5;
  let sync = null;   // { version, confirmed, queue, flushing, allowShrink } — null はサーバーを使わない（GitHub Pages・手元・D1 がまだ無い）
  /* この端末の名簿を残してから、サーバーの名簿にする（送れなかった・断られた直しを消さないため。読めない名簿の退避と同じく 1 年で消える） */
  function keepLocal(state) {
    const text = purgeBackup(stripPartnerHealth(JSON.stringify(state)));
    try {
      localStorage.setItem(`${OFFLINE_KEPT}${Date.now()}`, text);
    } catch (e) {
      /* 容量切れ: 読めなかった名簿の退避を古い順に消して、もう一度。それでも残せなければ、画面に知らせる（黙って消さない） */
      const saved = backupKeys().some(k => {
        try { localStorage.removeItem(k); localStorage.setItem(`${OFFLINE_KEPT}${Date.now()}`, text); return true; } catch (e2) { return false; }
      });
      if (!saved) rosterLost = true;
    }
  }

  function readSyncMeta() {
    try { const m = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null'); return m && Number.isInteger(m.version) ? m : null; } catch (e) { return null; }
  }
  function writeSyncMeta() {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify({ version: sync.version, pending: sync.queue.length > 0, shop: sync.shop })); } catch (e) { /* 書けなくても次に送るときに直る */ }
  }
  const isBlank = (s) => !s.trips.length && !s.bookings.length && !s.people.length;

  /* confirmed に queue を当てる。今の名簿に当てられなくなった直し（別の端末が便を消した、など）は外し、外した数を返す */
  /* 端末の名簿まるごとで置き換える直し（開き直したときの、送れていなかった名簿）。元にした版 v からサーバーの版が進んでいたら当てない
     （別の端末の直しを古い名簿で消さない。済んだ便も古い中身で移さない。ジンのレビュー 2026-10-27）。当てないときは、端末の名簿を別の場所に残す */
  function replaceWith(local, v) {
    let kept = false;
    return () => {
      if (sync.version === v) return local;
      if (!kept) { keepLocal(local); kept = true; rosterNote = 'sync-kept'; }
      throw new Error('replaceWith: 版が進んだ');
    };
  }

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
    /* 外した直しは、この端末で見えていた名簿（外す前）ごと別の場所に残す（黙って消さない。Codex のレビュー 2026-10-28） */
    if (dropped && rosterNote !== 'sync-kept') { keepLocal(roster); rosterNote = 'sync-dropped'; }
    roster = state;
    writeRoster(state);
    writeSyncMeta();
    rosterListeners.forEach(fn => fn(state));
  }

  /* まだ認められていない直しを送る。同時に 2 つは送らない（送っている間の直しは次の回に入る） */
  /* サーバーの名簿がこの画面より新しい版のとき。送るのを止め、端末だけで続ける（読み込み直すまで） */
  function stopSync(note = 'sync-newer') {
    sync.queue = [];
    sync.stopped = true;
    rosterNote = note;
    rosterListeners.forEach(fn => fn(roster));
  }

  function flushSync() {
    if (!sync || sync.stopped) return Promise.resolve();
    if (sync.flushing) return sync.flushing;
    if (!sync.queue.length) return Promise.resolve();
    sync.flushing = (async () => {
      for (let i = 0; i < SYNC_TRIES && sync.queue.length; i += 1) {
        const sent = sync.queue.length;
        const { state } = rebase();
        const r = await R.rosterSync.push(sync.version, state, { allowShrink: sync.allowShrink, shop: sync.shop });
        if ((r.ok || r.conflict || r.shrink) && r.shop !== sync.shop) r.why = 'shop';   // 答えの名簿が別のお店の物（念のため）
        if (r.why === 'shop') {
          /* ログインしたお店が変わった（開いたままの画面で、別のお店の人がログインし直した）。前のお店の直しを送らず、端末の名簿を残して止める */
          keepLocal(state);
          stopSync('sync-shop-changed');
          break;
        }
        if (r.ok || r.conflict) {
          sync.version = r.version;
          sync.confirmed = r.state;
          if (r.ok) { sync.queue = sync.queue.slice(sent); sync.allowShrink = false; }   // 送ったあとに足された直しは残す
          if (['sync-offline', 'sync-login'].includes(rosterNote)) rosterNote = null;
          adopt();
          continue;
        }
        if (r.shrink || r.why === 400 || r.why === 413) {
          /* サーバーが断った（人が大きく消える・中身が合わない）。送り直しても通らないので、この端末の名簿を残してからサーバーの名簿に戻す */
          keepLocal(state);
          sync.queue = [];
          sync.allowShrink = false;
          sync.version = r.shrink ? r.version : sync.version;
          sync.confirmed = r.shrink ? r.state : sync.confirmed;
          rosterNote = r.shrink ? 'sync-shrink' : 'sync-rejected';
          adopt();
          break;
        }
        if (r.why === 'newer') {
          /* サーバーの名簿が、この画面より新しい版になった（置き直した）。送ると新しい欄を消すので送らず、端末の名簿を残して止める。読み込み直してもらう */
          keepLocal(state);
          stopSync();
          break;
        }
        rosterNote = r.why === 'login' ? 'sync-login' : 'sync-offline';   // ログイン切れ・届かない・サーバーの誤り。直しは端末に残し、次に送る
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
    if (!sync || sync.stopped) return saveRoster(next);
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
    if (!got.ok) {
      if (got.why === 'newer') { rosterNote = 'sync-newer'; rosterListeners.forEach(fn => fn(loadRoster())); }
      return false;
    }
    const local = loadRoster();
    const meta = readSyncMeta();
    sync = { version: got.version, confirmed: got.state, queue: [], flushing: null, allowShrink: false, shop: got.shop };
    /* この端末の名簿が、ログインしたお店の物か（ジンのレビュー 2026-10-27 HIGH 8）。前にサーバーとつないだときのお店を覚えている。
       覚えていない端末（つないだことが無い・前の版）の名簿は、1 店だけだった頃の物（default）とみなす。
       違うお店の名簿は送らず（他のお店の名簿に混ぜない）、別の場所に残して、このお店の名簿にする */
    const localShop = meta && typeof meta.shop === 'string' ? meta.shop : 'default';
    if (localShop !== got.shop) {
      if (!isBlank(local)) { keepLocal(local); rosterNote = 'sync-shop'; }
    } else if (got.state === null) {
      if (!isBlank(local)) sync.queue.push(replaceWith(local, got.version));   // サーバーにまだ名簿が無い: この端末の名簿を最初の名簿として置く
    } else if (meta && meta.pending) {
      /* 前に送れなかった直しがある。版が同じならそのまま送る。ただし端末の名簿が空（読めなくて空から始めた、など）なら送らない
         （空の名簿で、サーバーの名簿をまるごと上書きしない。ジンのレビュー 2026-10-27 CRITICAL） */
      if (meta.version === got.version && !isBlank(local)) sync.queue.push(replaceWith(local, got.version));
      else if (!isBlank(local)) {
        /* 送れないうちに別の端末が直した。この端末の名簿は消さずに退避して、サーバーの名簿にする */
        keepLocal(local);
        rosterNote = 'sync-kept';
      }
    }
    adopt();
    await flushSync();
    return true;
  }

  /* 別の端末の直しを取り込む（画面に戻ってきたとき）。送っていない直しがある間は、送るのを先にする */
  async function refreshSync() {
    if (!sync || sync.stopped) return false;
    if (sync.queue.length) { await flushSync(); return true; }
    const got = await R.rosterSync.pull();
    if (got.ok && got.shop !== sync.shop) { keepLocal(roster); stopSync('sync-shop-changed'); return false; }   // 別のお店の名簿を取り込まない
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
      try { incoming = e.newValue ? R.roster.upgradeState(JSON.parse(e.newValue)) : null; } catch (err) { incoming = null; }
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
      /* デモの予約をすべて消す。サーバーには「わざと消す」と伝える（人が大きく消える書き込みは、これ以外では断られる） */
      reset: () => { if (sync) sync.allowShrink = true; return updateRoster(() => R.roster.blankState(ROSTER_SHOP)); },
      note: () => (rosterLost ? 'sync-lost' : rosterNote),
      /* サーバーの名簿（Worker 版だけ）。startSync はつないだら true、refresh は別の端末の直しの取り込み、whenSynced は送り終わるまで待つ */
      startSync,
      refresh: refreshSync,
      whenSynced: flushSync,
      synced: () => !!sync,
      /* 済んで 7 日を過ぎた便（サーバーが便ごとに分けて置いた物。読むだけ）。サーバーを使わないときは { ok: false, why: 'local' } */
      past: (from, to) => (sync ? R.rosterSync.past(from, to) : Promise.resolve({ ok: false, why: 'local' })),
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
