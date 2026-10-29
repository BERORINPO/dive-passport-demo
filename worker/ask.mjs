/* AI に読ませる 1 回（entry の部品）。上限を先に数え（KV）、Claude API を呼び、使った分を数え、答えの形を確かめる。
   画面からの読み取り（/api/read）と、届いた予約メール（email()）の両方が使う。決まりは read-core.mjs */
import { readingFrom, costMicro, periods, limitsFrom, WORST_MICRO } from './read-core.mjs';
import { reserve, spend } from './budget.mjs';
import { callModel } from './anthropic.mjs';

/* 返すのは { ok: true, reading } か { ok: false, status, error, healthSeen }。note にはログに出す短い名前だけを足す。
   上限はお店ごとに数える（shop は必須。無いと budget.mjs が断る） */
export async function askModel(ask, env, io, note, shop, opts = {}) {
  /* opts: お客さま画面の AI は、答えの読み方（parse）と上限（budgetShop・limits。予約メールの読み取りと別に数える）を替える */
  const keys = { ...periods(io.now()), shop: opts.budgetShop || shop };
  try {
    const got = await reserve(env.BUDGET, keys, opts.limits || limitsFrom(env));
    if (!got.ok) { note.why = got.why; return { ok: false, status: 429, error: 'limit', which: got.why }; }
  } catch (e) {
    note.why = 'kv';
    return { ok: false, status: 503, error: 'kv' };
  }

  let answer;
  try {
    answer = await callModel(ask, env, io);
  } catch (e) {
    note.why = `upstream-${e.kind || 'error'}${e.status ? `-${e.status}` : ''}`;
    /* 時間切れ・届かないときも、Anthropic 側では請求されうるので最大の見込みで数える */
    const micro = e.usage ? costMicro(e.usage) : e.kind === 'network' ? WORST_MICRO : 0;
    if (micro) await spend(env.BUDGET, keys, micro).catch(() => { note.why += ',spend-kv'; });
    return { ok: false, status: 502, error: 'upstream' };
  }
  note.stop = answer.stopReason;
  await spend(env.BUDGET, keys, costMicro(answer.usage)).catch(() => { note.why = 'spend-kv'; });

  const reading = opts.parse ? opts.parse(answer.text) : readingFrom(answer.text, ask.doc);
  if (!reading.ok) {
    /* 読み取りは使えないが、健康の情報が見えたと答えていたら画面に知らせる（送った記録に印を残し、同じ写真を送り直させない） */
    Object.assign(note, { why: `answer-${reading.error}`.slice(0, 40), seen: reading.healthSeen });
    return { ok: false, status: 502, error: 'answer', healthSeen: reading.healthSeen === true };
  }
  note.seen = reading.reading.healthSeen;
  return { ok: true, reading: reading.reading };
}
