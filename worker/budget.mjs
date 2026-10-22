/* 回数と費用の上限（adapter、Workers KV）。数は目安（KV は同時の書き込みで数え漏れがありうる）。
   本当のお金の歯止めは、Anthropic のこの Worker 専用ワークスペースの月の上限。
   数えるのは AI を呼ぶ前。KV が読めない・書けないときは例外にして、呼び出す側が断る。
   合言葉の失敗は数えない（ここに来る前に止める） */

const DAY_TTL_S = 2 * 24 * 3600;
const MONTH_TTL_S = 40 * 24 * 3600;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
export const limitsOf = (env) => ({ day: Math.floor(num(env.DAILY_LIMIT)), monthMicro: Math.floor(num(env.MONTHLY_USD) * 1e6) });

/* 呼ぶ前に 1 回分を取る。{ ok: true } か { ok: false, why: 'day' | 'month' } */
export async function reserve(kv, keys, limits, worstMicro) {
  const [dayRaw, monthRaw] = await Promise.all([kv.get(`day:${keys.day}`), kv.get(`month:${keys.month}`)]);
  const used = Math.floor(num(dayRaw));
  const spent = Math.floor(num(monthRaw));
  if (used >= limits.day) return { ok: false, why: 'day' };
  if (spent + worstMicro > limits.monthMicro) return { ok: false, why: 'month' };
  await kv.put(`day:${keys.day}`, String(used + 1), { expirationTtl: DAY_TTL_S });
  return { ok: true };
}

/* 呼んだあとに、使った額を今月の分に足す */
export async function spend(kv, keys, micro) {
  const spent = Math.floor(num(await kv.get(`month:${keys.month}`)));
  await kv.put(`month:${keys.month}`, String(spent + micro), { expirationTtl: MONTH_TTL_S });
}

/* /api/healthz で見せる今日と今月の残り（数だけ） */
export async function remaining(kv, keys, limits) {
  const [dayRaw, monthRaw] = await Promise.all([kv.get(`day:${keys.day}`), kv.get(`month:${keys.month}`)]);
  return { day: Math.max(0, limits.day - Math.floor(num(dayRaw))), monthMicro: Math.max(0, limits.monthMicro - Math.floor(num(monthRaw))) };
}
