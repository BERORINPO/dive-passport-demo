/* Worker の外との境目の見本（Fake）。テストと手元の確かめだけが使い、index.mjs からは読まない（置く物に入らない）。
   - fakeKv: Workers KV の get / put（failing で壊せる）
   - fakeAccess: Access のチームの鍵を作り、JWT を署名し、/cdn-cgi/access/certs を返す
   - fakeAnthropic: Claude API の答え（answer に返したい文、status で失敗）
   - fakeD1: Cloudflare D1 の prepare / bind / first / run。roster-db.mjs が使う 3 つの文だけを読む（failing で壊せる） */

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

/* roster-db.mjs の 3 つの文（SELECT・INSERT … ON CONFLICT DO NOTHING・版つきの UPDATE）と ask-db.mjs の 6 つの文と shop-db.mjs の 2 つの文だけを、本物の D1 と同じ答えの形で返す。
   知らない文は例外にする（roster-db.mjs に文を足したら、ここにも足してテストを通す） */
export function fakeD1() {
  const rows = new Map();
  const links = new Map();   // ask_links（お客さんのリンクの鍵の SHA-256 → 行）
  const shops = new Map();   // shops（お店の一覧）。shopsTable が false のあいだは表が無い D1 と同じ
  const db = {
    shops,
    shopsTable: false,
    /* テストの手伝い: お店を 1 つ足す（本物は D1 のコンソールで INSERT） */
    addShop({ id, name, members = [], sites = [], inbox = '' }) {
      db.shopsTable = true;
      shops.set(id, { id, name, members: JSON.stringify(members), sites: JSON.stringify(sites), inbox });
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
          if (/^SELECT id, name, members, sites, inbox FROM shops$/.test(text)) {
            if (!db.shopsTable) throw new Error('D1_ERROR: no such table: shops: SQLITE_ERROR');
            return { results: [...shops.values()] };
          }
          if (/^SELECT shop FROM rosters$/.test(text)) return { results: [...rows.keys()].map(shop => ({ shop })) };
          throw new Error(`fakeD1: 知らない文 ${text}`);
        }
      });
      return { bind: (...args) => bound(args), all: () => bound([]).all() };
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
