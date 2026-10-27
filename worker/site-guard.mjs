/* サイトの予約フォームから届く予約の守り（adapter）。Turnstile（ロボットよけ）の答えを Cloudflare に確かめ、
   1 つの IP からの回数を Workers Rate Limiting（BOOKING_LIMIT・ASK_LIMIT）で数える。見本は worker/fakes.mjs の fakeTurnstile・fakeRateLimit */

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/* Turnstile の答えを確かめる。{ ok } か { ok: false, why }（why は短い名前だけ）。
   答えを出したページの hostname が許したサイトのもので、action が 'booking' のときだけ通す（別のページで解いた答えを使わせない。ザクのレビュー 2026-10-27 M-2） */
export const TURNSTILE_ACTION = 'booking';
export async function verifyTurnstile(env, token, ip, io, hosts) {
  if (typeof token !== 'string' || !token || token.length > 2048) return { ok: false, why: 'turnstile-missing' };
  let r;
  try {
    /* 転送には付いて行かない（Workers は redirect: 'error' を受け付けない。3xx は !r.ok で断る） */
    r = await io.fetch(SITEVERIFY, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, ...(ip ? { remoteip: ip } : {}) }) });
  } catch (e) {
    return { ok: false, why: 'turnstile-network' };
  }
  if (!r.ok) return { ok: false, why: `turnstile-${r.status}` };
  const got = await r.json().catch(() => null);
  if (!got || got.success !== true) return { ok: false, why: 'turnstile-no' };
  if (!hosts.includes(String(got.hostname || '').toLowerCase())) return { ok: false, why: 'turnstile-host' };
  return got.action === TURNSTILE_ACTION ? { ok: true } : { ok: false, why: 'turnstile-action' };
}

/* 1 つの IP からの回数（limiter は BOOKING_LIMIT か ASK_LIMIT）。上限を超えたら false。binding が答えないときも false（受けない側に倒す） */
export async function underLimit(limiter, ip) {
  try {
    const got = await limiter.limit({ key: ip || 'unknown' });
    return Boolean(got && got.success);
  } catch (e) {
    return false;
  }
}
