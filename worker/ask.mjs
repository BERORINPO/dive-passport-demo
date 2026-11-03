/* AI に読ませる 1 回（entry の部品）。上限を先に数え（KV）、Claude API を呼び、使った分を数え、答えの形を確かめる。
   画面からの読み取り（/api/read）と、届いた予約メール（email()）の両方が使う。決まりは read-core.mjs。
   書類の読み取りは 2 つの AI に同時に読ませ、答えが割れた項目を「確かめる」に回す（決定ログ 2026-11-03 second-reader）。
   名簿に入れるのは 1 つ目（MODEL）の答え。確かめ役（CHECK_MODEL）が使えないときは、値のある項目を全部「確かめる」にする */
import { readingFrom, costMicro, periods, limitsFrom, WORST_MICRO, WORST_READ_MICRO, CHECK_MODEL, MODEL } from './read-core.mjs';
import { reserve, spend } from './budget.mjs';
import { callModel } from './anthropic.mjs';
import '../js/read-check.js';

const R = globalThis.REDUX;

/* 1 回の呼び出しの費用。失敗でも usage があればその分、時間切れ・届かないときも Anthropic 側では請求されうるので最大の見込み */
function chargeOf(result, model) {
  if (result.answer) return costMicro(result.answer.usage, model);
  const e = result.error;
  return e.usage ? costMicro(e.usage, model) : e.kind === 'network' ? costMicro(undefined, model) : 0;
}
const settle = (p) => p.then(answer => ({ answer }), error => ({ error }));
const whyOf = (e) => `${e.kind || 'error'}${e.status ? `-${e.status}` : ''}`;

/* 返すのは { ok: true, reading } か { ok: false, status, error, healthSeen }。note にはログに出す短い名前だけを足す。
   上限はお店ごとに数える（shop は必須。無いと budget.mjs が断る） */
export async function askModel(ask, env, io, note, shop, opts = {}) {
  /* opts: お客さま画面の AI は、答えの読み方（parse）と上限（budgetShop・limits。予約メールの読み取りと別に数える）を替える。確かめ役は呼ばない */
  const keys = { ...periods(io.now()), shop: opts.budgetShop || shop };
  const twoReaders = !opts.parse;
  try {
    const got = await reserve(env.BUDGET, keys, opts.limits || limitsFrom(env), twoReaders ? WORST_READ_MICRO : WORST_MICRO);
    if (!got.ok) { note.why = got.why; return { ok: false, status: 429, error: 'limit', which: got.why }; }
  } catch (e) {
    note.why = 'kv';
    return { ok: false, status: 503, error: 'kv' };
  }

  const [first, second] = await Promise.all([settle(callModel(ask, env, io)), twoReaders ? settle(callModel(ask, env, io, CHECK_MODEL)) : null]);
  const micro = chargeOf(first, MODEL) + (second ? chargeOf(second, CHECK_MODEL) : 0);
  let spendKv = '';
  if (micro) await spend(env.BUDGET, keys, micro).catch(() => { spendKv = ',spend-kv'; });
  if (second) note.check = second.error ? `upstream-${whyOf(second.error)}` : 'ok';
  /* 確かめ役の答え（読めなければ null）。健康の情報が見えたと答えていたら、1 つ目が見えていなくても見えた側に倒す */
  const checked = second && second.answer ? readingFrom(second.answer.text, ask.doc) : null;
  const checkerSaw = !!checked && (checked.ok ? checked.reading.healthSeen === true : checked.healthSeen === true);
  if (checked && !checked.ok) note.check = `answer-${checked.error}`.slice(0, 40);

  if (first.error) {
    note.why = `upstream-${whyOf(first.error)}${spendKv}`;
    return { ok: false, status: 502, error: 'upstream', healthSeen: checkerSaw };
  }
  note.stop = first.answer.stopReason;
  if (spendKv) note.why = 'spend-kv';

  const reading = opts.parse ? opts.parse(first.answer.text) : readingFrom(first.answer.text, ask.doc, keys.day);
  if (!reading.ok) {
    /* 読み取りは使えないが、健康の情報が見えたと答えていたら画面に知らせる（送った記録に印を残し、同じ写真を送り直させない） */
    const seen = reading.healthSeen === true || checkerSaw;
    Object.assign(note, { why: `answer-${reading.error}`.slice(0, 40), seen });
    return { ok: false, status: 502, error: 'answer', healthSeen: seen };
  }
  const final = twoReaders ? R.readCheck.crossCheck(reading.reading, checked && checked.ok ? checked.reading : null) : reading.reading;
  note.seen = final.healthSeen;
  return { ok: true, reading: final };
}
