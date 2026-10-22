/* Cloudflare Access を通ったかを、Worker が自分で確かめる（adapter）。
   Access が付ける Cf-Access-Jwt-Assertion を、そのチームの公開鍵（/cdn-cgi/access/certs）で確かめ、
   署名・iss・aud・期限・許可したメールアドレスまで見る。ctx.access だけには頼らない。確かめられなければ通さない。
   io = { fetch, now }（テストでは差し替える）。鍵は 10 分ためておく */

const CERTS_TTL_MS = 10 * 60 * 1000;
const REFRESH_GAP_MS = 60 * 1000;   // 知らない kid での取り直しは 1 分に 1 回まで（kid を変えた JWT で何度も取りに行かせない）
const SKEW_S = 60;   // 時計のずれを 1 分まで許す
let cache = { url: '', at: 0, keys: [] };
let lastTry = -Infinity;   // 最後に取りに行った時刻（取れたかどうかに関係なく。Cloudflare 側が落ちている間も、取りに行く回数を抑える）

const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function certs(url, io, fresh) {
  if (!fresh && cache.url === url && io.now() - cache.at < CERTS_TTL_MS) return cache.keys;
  lastTry = io.now();
  /* 転送には付いて行かない（Workers は redirect: 'error' を受け付けないので manual にし、3xx は !res.ok で断る） */
  const res = await io.fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  cache = { url, at: io.now(), keys };
  return keys;
}

const allowList = (env) => String(env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* { ok: true, email } か { ok: false, why }。why はログ用の短い言葉（トークンの中身は入れない）。
   why が 'certs' のときは、Cloudflare の鍵が取れなかった（こちら側の障害）。呼び出す側は 503 にする */
export async function verifyAccess(request, env, io) {
  const token = request.headers.get('cf-access-jwt-assertion') || '';
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return { ok: false, why: 'no-jwt' };
  let head, claims, sig;
  try {
    head = b64urlJson(parts[0]);
    claims = b64urlJson(parts[1]);
    sig = b64urlBytes(parts[2]);
  } catch (e) {
    return { ok: false, why: 'jwt-shape' };
  }
  if (!head || head.alg !== 'RS256' || typeof head.kid !== 'string') return { ok: false, why: 'alg' };

  /* 「<team>.cloudflareaccess.com」の形で入れる。頭に付けた https:// と、後ろの / は外す */
  const team = String(env.ACCESS_TEAM_DOMAIN || '').trim().replace(/^[a-z]+:\/*/i, '').replace(/\/+$/, '');
  const url = `https://${team}/cdn-cgi/access/certs`;
  let jwk;
  try {
    jwk = (await certs(url, io, false)).find(k => k && k.kid === head.kid);
    if (!jwk && io.now() - lastTry >= REFRESH_GAP_MS) jwk = (await certs(url, io, true)).find(k => k && k.kid === head.kid);   // 鍵が入れ替わった直後
  } catch (e) {
    return { ok: false, why: 'certs' };
  }
  if (!jwk || jwk.kty !== 'RSA') return { ok: false, why: 'kid' };

  let good = false;
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (e) {
    return { ok: false, why: 'verify' };
  }
  if (!good) return { ok: false, why: 'sig' };

  const now = Math.floor(io.now() / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== `https://${team}`) return { ok: false, why: 'iss' };
  if (!env.ACCESS_AUD || !aud.includes(env.ACCESS_AUD)) return { ok: false, why: 'aud' };
  if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < now) return { ok: false, why: 'exp' };
  if (Number.isFinite(claims.nbf) && claims.nbf - SKEW_S > now) return { ok: false, why: 'nbf' };
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !allowList(env).includes(email)) return { ok: false, why: 'email' };
  return { ok: true, email };
}

/* テストで鍵のためを消す */
export const resetAccessCache = () => { cache = { url: '', at: 0, keys: [] }; lastTry = -Infinity; };
