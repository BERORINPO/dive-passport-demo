/* AI を呼ぶ回数と費用の上限（adapter、Workers KV）。KV を読んで書くだけで、超えたかの判定は read-core.mjs の overLimit（core）。
   キーにはお店の id を入れる（`day:<お店>:<日>`・`month:<お店>:<月>`。お店ごとに数える）。
   数は目安（KV は同時の書き込みで数え漏れがありうる。同じキーへの書き込みは 1 秒に 1 回まで）。
   正確に数える必要がある外からの 1 日の回数（サイトの予約・メール）は KV でなく D1（limit-db.mjs）。
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

/* keys は { day, month, shop }。shop が無いキーは作らない（全店で 1 つの数に戻らない） */
function keyOf(kind, keys) {
  if (!keys || !keys.shop || !keys[kind]) throw new Error('budget: shop');
  return `${kind}:${keys.shop}:${keys[kind]}`;
}

async function used(kv, keys) {
  const [day, month] = await Promise.all([kv.get(keyOf('day', keys)), kv.get(keyOf('month', keys))]);
  return { day: count(day), month: count(month) };
}

/* 呼ぶ前に 1 回分を取る。{ ok: true } か { ok: false, why: 'day' | 'month' } */
export async function reserve(kv, keys, limits) {
  const now = await used(kv, keys);
  const why = overLimit(now, limits);
  if (why) return { ok: false, why };
  await kv.put(keyOf('day', keys), String(now.day + 1), { expirationTtl: DAY_TTL_S });
  return { ok: true };
}

/* 呼んだあとに、使った額を今月の分に足す */
export async function spend(kv, keys, micro) {
  const now = await used(kv, keys);
  await kv.put(keyOf('month', keys), String(now.month + micro), { expirationTtl: MONTH_TTL_S });
}

/* /api/healthz で見せる今日と今月の残り（数だけ） */
export async function remaining(kv, keys, limits) {
  const now = await used(kv, keys);
  return { day: Math.max(0, limits.day - now.day), monthMicro: Math.max(0, limits.monthMicro - now.month) };
}
