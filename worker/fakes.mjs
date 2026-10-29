/* Worker の外との境目の見本（Fake）。テストと手元の確かめだけが使い、index.mjs からは読まない（置く物に入らない）。
   - fakeKv: Workers KV の get / put（failing で壊せる）
   - fakeAccess: Access のチームの鍵を作り、JWT を署名し、/cdn-cgi/access/certs を返す
   - fakeAnthropic: Claude API の答え（answer に返したい文、status で失敗）
   - fakeD1: Cloudflare D1 の prepare / bind / first / run / all / batch。roster-db.mjs などが使う文だけを読む（failing で壊せる）
   - fakeShopBinding: redux-ask から見たお店の Worker（Service Binding の SHOP。口は 9 つ。引数と答えは structuredClone を通る） */

/* Cloudflare の fetch と同じく、redirect は follow か manual だけを受け付ける（'error' は Workers で例外になる。ザクのレビュー） */
export function checkRedirect(init) {
  if (init && init.redirect !== undefined && !['follow', 'manual'].includes(init.redirect)) throw new TypeError(`Invalid redirect value: ${init.redirect}`);
}

export function fakeKv() {
  const m = new Map();
  const kv = {
    failing: false,
    puts: [],
    get: async (k) => { if (kv.failing) throw new Error('kv down'); return m.has(k) ? m.get(k) : null; },
    put: async (k, v, opts) => { if (kv.failing) throw new Error('kv down'); kv.puts.push({ k, v, opts }); m.set(k, String(v)); },
    peek: (k) => (m.has(k) ? m.get(k) : null)
  };
  return kv;
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(new TextEncoder().encode(s));

export async function fakeAccess(team, kid = 'key-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const access = {
    team,
    certsUrl: `https://${team}/cdn-cgi/access/certs`,
    certsCalls: 0,
    keys: [{ kid, kty: 'RSA', alg: 'RS256', use: 'sig', n: pub.n, e: pub.e }],
    /* 署名した JWT。head や claims を上書きして壊せる。key に別の鍵を渡すと署名が合わない */
    async sign(claims, head = {}, key = pair.privateKey) {
      const h = b64urlText(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...head }));
      const p = b64urlText(JSON.stringify(claims));
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
      return `${h}.${p}.${b64url(sig)}`;
    }
  };
  return access;
}

export function fakeAnthropic() {
  const api = {
    calls: [],
    status: 200,
    stopReason: 'end_turn',
    usage: { input_tokens: 1200, output_tokens: 400 },
    answer: '{"participants": [], "health_info_visible": false}',
    thinkingFirst: true,
    async respond(init) {
      checkRedirect(init);
      api.calls.push({ headers: new Headers(init.headers), body: JSON.parse(init.body), redirect: init.redirect });
      if (api.status !== 200) return new Response('{"type":"error","error":{"type":"x","message":"secret detail"}}', { status: api.status });
      const content = [...(api.thinkingFirst ? [{ type: 'thinking', thinking: '', signature: 'x' }] : []), { type: 'text', text: api.answer }];
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', content, stop_reason: api.stopReason, usage: api.usage }), { status: 200 });
    }
  };
  return api;
}

/* roster-db.mjs の 6 つの文（名簿の SELECT・INSERT … ON CONFLICT DO NOTHING・版つきの UPDATE・済んだ便を足す・消す・読む）と ask-db.mjs の 6 つの文と
   shop-db.mjs の 2 つの文と limit-db.mjs の 2 つの文と walkin-db.mjs の 7 つの文と intake-db.mjs の 11 の文だけを、本物の D1 と同じ答えの形で返す。batch は本物と同じく 1 つの transaction（途中で失敗したら全部を戻す）。
   知らない文は例外にする（roster-db.mjs に文を足したら、ここにも足してテストを通す。済んだ便の SQL は test/past.test.mjs が node:sqlite でも確かめる） */
const ADD_PAST_SQL = "INSERT INTO roster_past (shop, part, day, keep_until, body, moved_at) SELECT ?1, json_extract(value, '$.part'), json_extract(value, '$.day'), " +
  "json_extract(value, '$.keepUntil'), json_extract(value, '$.body'), ?3 FROM json_each(?2) WHERE COALESCE((SELECT version FROM rosters WHERE shop = ?1), 0) = ?4 " +
  'ON CONFLICT(shop, part) DO NOTHING';

const PUT_WALKIN_KEY_SQL = 'INSERT INTO walkin_keys (shop, hash, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(shop) DO UPDATE SET hash = ?2, created_at = ?3';
const CLAIM_IDEM_SQL = "INSERT INTO api_idempotency (key_id, idem, booking_id, created_at) VALUES (?1, ?2, '', ?3) ON CONFLICT(key_id, idem) DO UPDATE SET booking_id = '', " +
  "created_at = ?3 WHERE (booking_id = '' AND created_at < ?4) OR created_at < ?5";
const TAKE_DAILY_SQL ='INSERT INTO daily_counts (scope, shop, day, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT(scope, shop, day) DO UPDATE SET n = n + 1 WHERE n < ?4';

/* worker/ask-db.mjs の putLink の文（長いので 2 つに分ける） */
const PUT_LINK_RE = new RegExp('^INSERT INTO ask_links \\(hash, shop, booking_id, person_id, expires_on, created_at, day, uses, minted_by\\) ' +
  "VALUES \\(\\?1, \\?2, \\?3, \\?4, \\?5, \\?6, '', 0, \\?7\\)$");

export function fakeD1() {
  const rows = new Map();
  const links = new Map();   // ask_links（お客さんのリンクの鍵の SHA-256 → 行）
  const shops = new Map();   // shops（お店の一覧）。shopsTable が false のあいだは表が無い D1 と同じ
  const past = new Map();    // roster_past（済んだ便）。キーは「お店 + 改行 + part」
  const unread = new Map();  // mail_unread（読めなかった予約メール）。キーは「お店 + 改行 + id」
  const daily = new Map();   // daily_counts（1 日の回数）。キーは「scope + 改行 + お店 + 改行 + 日」、値は n
  const walkinKeys = new Map();   // walkin_keys（店頭の QR の鍵の SHA-256。キーはお店）
  const walkins = new Map();      // walkin_pending（店頭で入れた人）。キーは「お店 + 改行 + id」
  const apiKeys = new Map();      // api_keys（予約の受け口 API の鍵の SHA-256。キーは鍵の id）
  const idem = new Map();         // api_idempotency（同じ予約を 2 回入れない記録）。キーは「鍵の id + 改行 + SHA-256」
  const db = {
    walkinKeys,
    walkins,
    apiKeys,
    idem,
    daily,
    /* テストの手伝い: 1 日の回数をいきなり n にする（上限の手前まで進めるため） */
    setCount(scope, shop, day, n) { daily.set([scope, shop, day].join('\n'), n); },
    past,
    unread,
    shops,
    shopsTable: false,
    /* テストの手伝い: お店を 1 つ足す（本物は D1 のコンソールで INSERT） */
    addShop({ id, name, members = [], sites = [], inbox = '', senders = [] }) {
      db.shopsTable = true;
      shops.set(id, { id, name, members: JSON.stringify(members), sites: JSON.stringify(sites), inbox, senders: JSON.stringify(senders) });
    },
    failing: false,
    writes: 0,
    rows,
    links,
    prepare(sql) {
      const text = sql.replace(/\s+/g, ' ').trim();
      const statement = (args) => ({
        async first() {
          if (db.failing) throw new Error('d1 down');
          if (/^SELECT COUNT\(\*\) AS n FROM ask_links WHERE shop = \?1 AND booking_id = \?2 AND person_id = \?3 AND expires_on >= \?4$/.test(text)) {
            return { n: [...links.values()].filter(l => l.shop === args[0] && l.booking_id === args[1] && l.person_id === args[2] && l.expires_on >= args[3]).length };
          }
          if (/^SELECT shop FROM walkin_keys WHERE hash = \?1$/.test(text)) {
            const hit = [...walkinKeys].find(([, k]) => k.hash === args[0]);
            return hit ? { shop: hit[0] } : null;
          }
          if (/^SELECT id, shop, label FROM api_keys WHERE hash = \?1 AND revoked_at = ''$/.test(text)) {
            const hit = [...apiKeys.values()].find(k => k.hash === args[0] && k.revoked_at === '');
            return hit ? { id: hit.id, shop: hit.shop, label: hit.label } : null;
          }
          if (/^SELECT COUNT\(\*\) AS n FROM api_keys WHERE shop = \?1 AND revoked_at = ''$/.test(text)) {
            return { n: [...apiKeys.values()].filter(k => k.shop === args[0] && k.revoked_at === '').length };
          }
          if (/^SELECT booking_id FROM api_idempotency WHERE key_id = \?1 AND idem = \?2$/.test(text)) {
            const row = idem.get(`${args[0]}\n${args[1]}`);
            return row ? { booking_id: row.booking_id } : null;
          }
          if (/^SELECT created_at FROM walkin_keys WHERE shop = \?1$/.test(text)) {
            const k = walkinKeys.get(args[0]);
            return k ? { created_at: k.created_at } : null;
          }
          if (/^SELECT shop, booking_id, person_id, expires_on, minted_by FROM ask_links WHERE hash = \?1$/.test(text)) {
            const l = links.get(args[0]);
            return l ? { shop: l.shop, booking_id: l.booking_id, person_id: l.person_id, expires_on: l.expires_on, minted_by: l.minted_by } : null;
          }
          if (!/^SELECT version, state FROM rosters WHERE shop = \?1$/.test(text)) throw new Error(`fakeD1: 知らない文 ${text}`);
          const row = rows.get(args[0]);
          return row ? { version: row.version, state: row.state } : null;
        },
        async run() {
          if (db.failing) throw new Error('d1 down');
          let changes = 0;
          if (/^INSERT INTO rosters \(shop, version, state, updated_at\) VALUES \(\?1, 1, \?2, \?3\) ON CONFLICT\(shop\) DO NOTHING$/.test(text)) {
            if (!rows.has(args[0])) { rows.set(args[0], { version: 1, state: args[1], updated_at: args[2] }); changes = 1; }
          } else if (/^UPDATE rosters SET version = version \+ 1, state = \?2, updated_at = \?3 WHERE shop = \?1 AND version = \?4$/.test(text)) {
            const row = rows.get(args[0]);
            if (row && row.version === args[3]) { rows.set(args[0], { version: row.version + 1, state: args[1], updated_at: args[2] }); changes = 1; }
          } else if (/^DELETE FROM ask_links WHERE shop = \?1 AND booking_id = \?2 AND person_id = \?3$/.test(text)) {
            for (const [h, l] of links) if (l.shop === args[0] && l.booking_id === args[1] && l.person_id === args[2]) { links.delete(h); changes += 1; }
          } else if (PUT_LINK_RE.test(text)) {
            if (links.has(args[0])) throw new Error('UNIQUE constraint failed: ask_links.hash');
            links.set(args[0], { shop: args[1], booking_id: args[2], person_id: args[3], expires_on: args[4], created_at: args[5], day: '', uses: 0, minted_by: args[6] });
            changes = 1;
          } else if (/^UPDATE ask_links SET uses = CASE WHEN day = \?2 THEN uses \+ 1 ELSE 1 END, day = \?2 WHERE hash = \?1 AND \(day <> \?2 OR uses < \?3\)$/.test(text)) {
            const l = links.get(args[0]);
            if (l && (l.day !== args[1] || l.uses < args[2])) { l.uses = l.day === args[1] ? l.uses + 1 : 1; l.day = args[1]; changes = 1; }
          } else if (text === PUT_WALKIN_KEY_SQL) {
            if ([...walkinKeys].some(([shop, k]) => shop !== args[0] && k.hash === args[1])) throw new Error('UNIQUE constraint failed: walkin_keys.hash');
            walkinKeys.set(args[0], { hash: args[1], created_at: args[2] });
            changes = 1;
          } else if (/^INSERT INTO api_keys \(id, shop, hash, label, created_at\) VALUES \(\?1, \?2, \?3, \?4, \?5\)$/.test(text)) {
            if (apiKeys.has(args[0]) || [...apiKeys.values()].some(k => k.hash === args[2])) throw new Error('UNIQUE constraint failed: api_keys');
            apiKeys.set(args[0], { id: args[0], shop: args[1], hash: args[2], label: args[3], created_at: args[4], revoked_at: '' });
            changes = 1;
          } else if (/^UPDATE api_keys SET hash = \?3, created_at = \?4 WHERE shop = \?1 AND id = \?2 AND revoked_at = ''$/.test(text)) {
            const k = apiKeys.get(args[1]);
            if (k && k.shop === args[0] && k.revoked_at === '') {
              if ([...apiKeys.values()].some(o => o.id !== k.id && o.hash === args[2])) throw new Error('UNIQUE constraint failed: api_keys.hash');
              k.hash = args[2];
              k.created_at = args[3];
              changes = 1;
            }
          } else if (/^UPDATE api_keys SET revoked_at = \?3 WHERE shop = \?1 AND id = \?2 AND revoked_at = ''$/.test(text)) {
            const k = apiKeys.get(args[1]);
            if (k && k.shop === args[0] && k.revoked_at === '') { k.revoked_at = args[2]; changes = 1; }
          } else if (text === CLAIM_IDEM_SQL) {
            const key = `${args[0]}\n${args[1]}`;
            const row = idem.get(key);
            const takeable = !row || (row.booking_id === '' && row.created_at < args[3]) || row.created_at < args[4];
            if (takeable) { idem.set(key, { booking_id: '', created_at: args[2] }); changes = 1; }
          } else if (/^UPDATE api_idempotency SET booking_id = \?3 WHERE key_id = \?1 AND idem = \?2 AND booking_id = ''$/.test(text)) {
            const row = idem.get(`${args[0]}\n${args[1]}`);
            if (row && row.booking_id === '') { row.booking_id = args[2]; changes = 1; }
          } else if (/^DELETE FROM api_idempotency WHERE key_id = \?1 AND idem = \?2 AND booking_id = ''$/.test(text)) {
            const row = idem.get(`${args[0]}\n${args[1]}`);
            if (row && row.booking_id === '') { idem.delete(`${args[0]}\n${args[1]}`); changes = 1; }
          } else if (/^DELETE FROM api_idempotency WHERE created_at < \?1$/.test(text)) {
            for (const [k, v] of idem) if (v.created_at < args[0]) { idem.delete(k); changes += 1; }
          } else if (/^INSERT INTO walkin_pending \(shop, id, trip_id, body, created_at, expires_on\) VALUES \(\?1, \?2, \?3, \?4, \?5, \?6\)$/.test(text)) {
            const key = `${args[0]}\n${args[1]}`;
            if (walkins.has(key)) throw new Error('UNIQUE constraint failed: walkin_pending.shop, walkin_pending.id');
            walkins.set(key, { shop: args[0], id: args[1], trip_id: args[2], body: args[3], created_at: args[4], expires_on: args[5] });
            changes = 1;
          } else if (/^DELETE FROM walkin_pending WHERE shop = \?1 AND id = \?2$/.test(text)) {
            changes = walkins.delete(`${args[0]}\n${args[1]}`) ? 1 : 0;
          } else if (/^DELETE FROM walkin_pending WHERE expires_on < \?1$/.test(text)) {
            for (const [k, w] of walkins) if (w.expires_on < args[0]) { walkins.delete(k); changes += 1; }
          } else if (text === ADD_PAST_SQL) {
            const row = rows.get(args[0]);
            if ((row ? row.version : 0) === args[3]) {
              for (const p of JSON.parse(args[1])) {
                const key = `${args[0]}\n${p.part}`;
                if (!past.has(key)) { past.set(key, { shop: args[0], part: p.part, day: p.day, keep_until: p.keepUntil, body: p.body, moved_at: args[2] }); changes += 1; }
              }
            }
          } else if (/^DELETE FROM mail_unread WHERE shop = \?1 AND at < \?2$/.test(text)) {
            for (const [k, u] of unread) if (u.shop === args[0] && u.at < args[1]) { unread.delete(k); changes += 1; }
          } else if (/^INSERT INTO mail_unread \(shop, id, at, why\) VALUES \(\?1, \?2, \?3, \?4\) ON CONFLICT\(shop, id\) DO NOTHING$/.test(text)) {
            const key = `${args[0]}\n${args[1]}`;
            if (!unread.has(key)) { unread.set(key, { shop: args[0], id: args[1], at: args[2], why: args[3] }); changes = 1; }
          } else if (/^DELETE FROM mail_unread WHERE shop = \?1 AND id = \?2$/.test(text)) {
            changes = unread.delete(`${args[0]}\n${args[1]}`) ? 1 : 0;
          } else if (/^DELETE FROM roster_past WHERE shop = \?1 AND keep_until < \?2$/.test(text)) {
            for (const [k, p] of past) if (p.shop === args[0] && p.keep_until < args[1]) { past.delete(k); changes += 1; }
          } else if (text === TAKE_DAILY_SQL) {
            const key = [args[0], args[1], args[2]].join('\n');
            if (!daily.has(key)) { daily.set(key, 1); changes = 1; } else if (daily.get(key) < args[3]) { daily.set(key, daily.get(key) + 1); changes = 1; }
          } else if (/^DELETE FROM daily_counts WHERE day < \?1$/.test(text)) {
            for (const k of [...daily.keys()]) if (k.split('\n')[2] < args[0]) { daily.delete(k); changes += 1; }
          } else if (/^DELETE FROM ask_links WHERE expires_on < \?1$/.test(text)) {
            for (const [h, l] of links) if (l.expires_on < args[0]) { links.delete(h); changes += 1; }
          } else {
            throw new Error(`fakeD1: 知らない文 ${text}`);
          }
          db.writes += changes;
          return { success: true, meta: { changes } };
        }
      });
      const bound = (args) => ({
        ...statement(args),
        async all() {
          if (db.failing) throw new Error('d1 down');
          if (/^SELECT id, name, members, sites, inbox, senders FROM shops$/.test(text)) {
            if (!db.shopsTable) throw new Error('D1_ERROR: no such table: shops: SQLITE_ERROR');
            return { results: [...shops.values()] };
          }
          if (/^SELECT name FROM sqlite_master WHERE type = 'table'$/.test(text)) {
            const tables = ['rosters', 'ask_links', 'shops', 'roster_past', 'mail_unread', 'daily_counts', 'walkin_keys', 'walkin_pending', 'api_keys', 'api_idempotency'];
            return { results: tables.filter(t => !(db.missingTables || []).includes(t)).map(name => ({ name })) };
          }
          if (/^SELECT id, label, created_at, revoked_at FROM api_keys WHERE shop = \?1 ORDER BY created_at DESC, id LIMIT \?2$/.test(text)) {
            const newest = (a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? 1 : -1);
            const hit = [...apiKeys.values()].filter(k => k.shop === args[0]).sort(newest).slice(0, args[1]);
            return { results: hit.map(k => ({ id: k.id, label: k.label, created_at: k.created_at, revoked_at: k.revoked_at })) };
          }
          if (/^SELECT shop FROM rosters$/.test(text)) return { results: [...rows.keys()].map(shop => ({ shop })) };
          const MOVED_SQL = 'SELECT part, day, keep_until, body, moved_at FROM roster_past WHERE shop = ?1 AND (moved_at > ?2 OR (moved_at = ?2 AND part > ?4)) ' +
            'ORDER BY moved_at, part LIMIT ?3';
          if (text === MOVED_SQL) {
            const [shop, since, limit, afterPart] = args;
            const hit = [...past.values()].filter(p => p.shop === shop && (p.moved_at > since || (p.moved_at === since && p.part > afterPart)))
              .sort((a, b) => (a.moved_at < b.moved_at ? -1 : a.moved_at > b.moved_at ? 1 : a.part < b.part ? -1 : 1)).slice(0, limit);
            return { results: hit.map(p => ({ part: p.part, day: p.day, keep_until: p.keep_until, body: p.body, moved_at: p.moved_at })) };
          }
          if (/^SELECT id, trip_id, body, created_at FROM walkin_pending WHERE shop = \?1 AND expires_on >= \?2 ORDER BY created_at LIMIT \?3$/.test(text)) {
            const hit = [...walkins.values()].filter(w => w.shop === args[0] && w.expires_on >= args[1]).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)).slice(0, args[2]);
            return { results: hit.map(w => ({ id: w.id, trip_id: w.trip_id, body: w.body, created_at: w.created_at })) };
          }
          if (/^SELECT id, at, why FROM mail_unread WHERE shop = \?1 AND at >= \?2 ORDER BY at DESC LIMIT \?3$/.test(text)) {
            const hit = [...unread.values()].filter(u => u.shop === args[0] && u.at >= args[1]).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, args[2]);
            return { results: hit.map(u => ({ id: u.id, at: u.at, why: u.why })) };
          }
          if (/^SELECT part, day, body FROM roster_past WHERE shop = \?1 AND day >= \?2 AND day <= \?3 AND keep_until >= \?4 ORDER BY day, part LIMIT \?5$/.test(text)) {
            const [shop, from, to, today, limit] = args;
            const hit = [...past.values()].filter(p => p.shop === shop && p.day >= from && p.day <= to && p.keep_until >= today)
              .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.part < b.part ? -1 : 1)).slice(0, limit);
            return { results: hit.map(p => ({ part: p.part, day: p.day, body: p.body })) };
          }
          throw new Error(`fakeD1: 知らない文 ${text}`);
        }
      });
      return { bind: (...args) => bound(args), all: () => bound([]).all() };
    },
    /* 本物と同じく 1 つの transaction。どれかが失敗したら、それまでの書き込みを全部戻して例外にする（failBatch で最後に失敗させられる） */
    async batch(statements) {
      if (db.failing) throw new Error('d1 down');
      const saved = { rows: new Map([...rows].map(([k, v]) => [k, { ...v }])), past: new Map([...past].map(([k, v]) => [k, { ...v }])),
        unread: new Map([...unread].map(([k, v]) => [k, { ...v }])), writes: db.writes };
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        if (db.failBatch) throw new Error('d1 batch failed');
        return out;
      } catch (e) {
        rows.clear(); saved.rows.forEach((v, k) => rows.set(k, v));
        past.clear(); saved.past.forEach((v, k) => past.set(k, v));
        unread.clear(); saved.unread.forEach((v, k) => unread.set(k, v));
        db.writes = saved.writes;
        throw e;
      }
    }
  };
  return db;
}

/* mail.mjs の見本。送った物を覚える。fail に E_* の名前を入れると、その名前で失敗する */
export function fakeMail() {
  const mail = {
    sent: [],
    fail: '',
    async send(msg) {
      if (mail.fail) { const e = new Error('send failed'); e.code = mail.fail; throw e; }
      mail.sent.push(msg);
      return { messageId: `m${mail.sent.length}` };
    }
  };
  return mail;
}

/* site-guard.mjs の Turnstile の見本。answer を返す。io.fetch の代わりに respond(init) を呼ぶ */
export function fakeTurnstile() {
  const t = {
    calls: [],
    success: true,
    status: 200,
    hostname: 'site.example.com',
    action: 'booking',
    async respond(init) {
      checkRedirect(init);
      t.calls.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: t.success, hostname: t.hostname, action: t.action }), { status: t.status });
    }
  };
  return t;
}

/* site-guard.mjs の回数の見本（Workers Rate Limiting の limit({ key })）。キーごとに max 回まで通す */
export function fakeRateLimit(max = 5) {
  const used = new Map();
  return {
    used,
    async limit({ key }) {
      const n = (used.get(key) || 0) + 1;
      used.set(key, n);
      return { success: n <= max };
    }
  };
}

/* shop-client.mjs の Service Binding（SHOP）の見本。service は ShopService（shop-service.mjs）。本物の RPC と同じく、引数と答えは structuredClone で
   渡す（素のオブジェクトと配列と文字・数だけが通る）。口は 7 つだけで、service にほかのメソッドがあっても通さない（redux-ask に D1 や名簿を渡さない） */
export function fakeShopBinding(service) {
  const call = (name) => async (...args) => structuredClone(await service[name](...structuredClone(args)));
  const binding = { calls: [] };
  for (const name of ['askView', 'askApply', 'siteHosts', 'siteBooking', 'walkinView', 'walkinSubmit', 'intakeBooking', 'trialView', 'trialAsk']) {
    const run = call(name);
    binding[name] = async (...args) => { binding.calls.push(name); return run(...args); };
  }
  return binding;
}
