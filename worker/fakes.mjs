/* Worker の外との境目の見本（Fake）。テストと手元の確かめだけが使い、index.mjs からは読まない（置く物に入らない）。
   - fakeKv: Workers KV の get / put（failing で壊せる）
   - fakeAccess: Access のチームの鍵を作り、JWT を署名し、/cdn-cgi/access/certs を返す
   - fakeAnthropic: Claude API の答え（answer に返したい文、status で失敗） */

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
