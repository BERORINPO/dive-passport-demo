/* Worker の外との境目の見本（Fake）。テストと手元の確かめだけが使い、index.mjs からは読まない（置く物に入らない）。
   - fakeKv: Workers KV の get / put（failing で壊せる）
   - fakeAccess: Access のチームの鍵を作り、JWT を署名し、/cdn-cgi/access/certs を返す
   - fakeAnthropic: Claude API の答え（answer に返したい文、status で失敗）
   - fakeD1: Cloudflare D1 の prepare / bind / first / run / all / batch。roster-db.mjs などが使う文だけを読む（failing で壊せる） */

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
   shop-db.mjs の 2 つの文だけを、本物の D1 と同じ答えの形で返す。batch は本物と同じく 1 つの transaction（途中で失敗したら全部を戻す）。
   知らない文は例外にする（roster-db.mjs に文を足したら、ここにも足してテストを通す。済んだ便の SQL は test/past.test.mjs が node:sqlite でも確かめる） */
const ADD_PAST_SQL = "INSERT INTO roster_past (shop, part, day, keep_until, body, moved_at) SELECT ?1, json_extract(value, '$.part'), json_extract(value, '$.day'), " +
  "json_extract(value, '$.keepUntil'), json_extract(value, '$.body'), ?3 FROM json_each(?2) WHERE COALESCE((SELECT version FROM rosters WHERE shop = ?1), 0) = ?4 " +
  'ON CONFLICT(shop, part) DO NOTHING';

export function fakeD1() {
  const rows = new Map();
  const links = new Map();   // ask_links（お客さんのリンクの鍵の SHA-256 → 行）
  const shops = new Map();   // shops（お店の一覧）。shopsTable が false のあいだは表が無い D1 と同じ
  const past = new Map();    // roster_past（済んだ便）。キーは「お店 + 改行 + part」
  const unread = new Map();  // mail_unread（読めなかった予約メール）。キーは「お店 + 改行 + id」
  const db = {
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
          if (/^SELECT COUNT\(\*\) AS n FROM ask_links WHERE shop = \?1 AND booking_id = \?2 AND person_id = \?3$/.test(text)) {
            return { n: [...links.values()].filter(l => l.shop === args[0] && l.booking_id === args[1] && l.person_id === args[2]).length };
          }
          if (/^SELECT shop, booking_id, person_id, expires_on FROM ask_links WHERE hash = \?1$/.test(text)) {
            const l = links.get(args[0]);
            return l ? { shop: l.shop, booking_id: l.booking_id, person_id: l.person_id, expires_on: l.expires_on } : null;
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
          } else if (/^INSERT INTO ask_links \(hash, shop, booking_id, person_id, expires_on, created_at, day, uses\) VALUES \(\?1, \?2, \?3, \?4, \?5, \?6, '', 0\)$/.test(text)) {
            if (links.has(args[0])) throw new Error('UNIQUE constraint failed: ask_links.hash');
            links.set(args[0], { shop: args[1], booking_id: args[2], person_id: args[3], expires_on: args[4], created_at: args[5], day: '', uses: 0 });
            changes = 1;
          } else if (/^UPDATE ask_links SET uses = CASE WHEN day = \?2 THEN uses \+ 1 ELSE 1 END, day = \?2 WHERE hash = \?1 AND \(day <> \?2 OR uses < \?3\)$/.test(text)) {
            const l = links.get(args[0]);
            if (l && (l.day !== args[1] || l.uses < args[2])) { l.uses = l.day === args[1] ? l.uses + 1 : 1; l.day = args[1]; changes = 1; }
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
          } else if (/^INSERT INTO mail_unread \(shop, id, at, why\) VALUES \(\?1, \?2, \?3, \?4\)$/.test(text)) {
            const key = `${args[0]}\n${args[1]}`;
            if (unread.has(key)) throw new Error('UNIQUE constraint failed: mail_unread.shop, mail_unread.id');
            unread.set(key, { shop: args[0], id: args[1], at: args[2], why: args[3] });
            changes = 1;
          } else if (/^DELETE FROM mail_unread WHERE shop = \?1 AND id = \?2$/.test(text)) {
            changes = unread.delete(`${args[0]}\n${args[1]}`) ? 1 : 0;
          } else if (/^DELETE FROM roster_past WHERE shop = \?1 AND keep_until < \?2$/.test(text)) {
            for (const [k, p] of past) if (p.shop === args[0] && p.keep_until < args[1]) { past.delete(k); changes += 1; }
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
          if (/^SELECT shop FROM rosters$/.test(text)) return { results: [...rows.keys()].map(shop => ({ shop })) };
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
    hostname: 'aquagate.example.com',
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
