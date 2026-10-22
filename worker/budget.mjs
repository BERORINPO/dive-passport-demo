/* 回数と費用の上限（adapter、Workers KV）。KV を読んで書くだけで、超えたかの判定は read-core.mjs の overLimit（core）。
   数は目安（KV は同時の書き込みで数え漏れがありうる。同じキーへの書き込みは 1 秒に 1 回まで）。
   本当のお金の歯止めは、Anthropic のこの Worker 専用ワークスペースの月の上限。
   数えるのは AI を呼ぶ前。KV が読めない・書けないときは例外にして、呼び出す側が断る。
   Access を通らなかった呼び出しは数えない（ここに来る前に止める） */
import { overLimit } from './read-core.mjs';

const DAY_TTL_S = 2 * 24 * 3600;
const MONTH_TTL_S = 40 * 24 * 3600;

const count = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

async function used(kv, keys) {
  const [day, month] = await Promise.all([kv.get(`day:${keys.day}`), kv.get(`month:${keys.month}`)]);
  return { day: count(day), month: count(month) };
}

/* 呼ぶ前に 1 回分を取る。{ ok: true } か { ok: false, why: 'day' | 'month' } */
export async function reserve(kv, keys, limits) {
  const now = await used(kv, keys);
  const why = overLimit(now, limits);
  if (why) return { ok: false, why };
  await kv.put(`day:${keys.day}`, String(now.day + 1), { expirationTtl: DAY_TTL_S });
  return { ok: true };
}

/* 呼んだあとに、使った額を今月の分に足す */
export async function spend(kv, keys, micro) {
  const now = await used(kv, keys);
  await kv.put(`month:${keys.month}`, String(now.month + micro), { expirationTtl: MONTH_TTL_S });
}

/* /api/healthz で見せる今日と今月の残り（数だけ） */
export async function remaining(kv, keys, limits) {
  const now = await used(kv, keys);
  return { day: Math.max(0, limits.day - now.day), monthMicro: Math.max(0, limits.monthMicro - now.month) };
}
