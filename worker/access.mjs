/* Cloudflare Access を通ったかを、Worker が自分で確かめる（adapter）。
   Access が付ける Cf-Access-Jwt-Assertion を、そのチームの公開鍵（/cdn-cgi/access/certs）で確かめ、
   署名・iss・aud・期限・許可したメールアドレスまで見る。ctx.access だけには頼らない。確かめられなければ通さない。
   io = { fetch, now }（テストでは差し替える）。鍵は 10 分ためておく */

const CERTS_TTL_MS = 10 * 60 * 1000;
const SKEW_S = 60;   // 時計のずれを 1 分まで許す
let cache = { url: '', at: 0, keys: [] };

const b64urlBytes = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function certs(url, io, fresh) {
  if (!fresh && cache.url === url && io.now() - cache.at < CERTS_TTL_MS) return cache.keys;
  const res = await io.fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body = await res.json();
  const keys = Array.isArray(body && body.keys) ? body.keys : [];
  cache = { url, at: io.now(), keys };
  return keys;
}

const allowList = (env) => String(env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

/* { ok: true, email } か { ok: false, why }。why はログ用の短い言葉（トークンの中身は入れない） */
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

  const team = String(env.ACCESS_TEAM_DOMAIN || '').replace(/^https:\/\//, '').replace(/\/+$/, '');
  const url = `https://${team}/cdn-cgi/access/certs`;
  let jwk;
  try {
    jwk = (await certs(url, io, false)).find(k => k && k.kid === head.kid);
    if (!jwk) jwk = (await certs(url, io, true)).find(k => k && k.kid === head.kid);   // 鍵が入れ替わった直後
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

/* 合言葉。header x-redux-code に UTF-8 の base64url で来る（ヘッダに日本語を入れられないため）。
   両方を SHA-256 にしてから、長さの同じ 32 バイトを全部比べる（途中で止めないので、どこまで合ったかが時間に出ない）。空は通さない */
const MAX_CODE_HEADER = 400;
export async function codeOk(header, secret) {
  if (!header || header.length > MAX_CODE_HEADER || !/^[A-Za-z0-9_-]+$/.test(header)) return false;
  let given;
  try { given = new TextDecoder('utf-8', { fatal: true }).decode(b64urlBytes(header)).trim(); } catch (e) { return false; }
  const want = String(secret || '').trim();
  if (!given || !want) return false;
  const sha = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([sha(given), sha(want)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* テストで鍵のためを消す */
export const resetAccessCache = () => { cache = { url: '', at: 0, keys: [] }; };
