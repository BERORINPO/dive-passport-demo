/* 実在のお店の試し版のページ（trial.html）の決まり（core）。外のものは使わない。
   お店の手を使わずに先に作って渡し、楽さを試してもらうためのページ（決定ログ 2026-10-29 trial-shops）。
   - 開く鍵は URL の # の後ろ（推測されにくい 22 字）。redux-ask の /api/trial へは本文で送る
   - 見せるのはお店の公開ホームページの事実（料金・ツアー・集合・持ち物・よくある質問）だけ。名簿・予約・個人情報は持たない
   - AI はお店の Worker の ShopRpc.trialAsk で、guest-ai-core.mjs と同じ決まり（選ぶ・訳すだけ・体のことは答えない）。上限は試し版ごとに別に数える */

export const TRIAL_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const MAX_TRIAL_BODY = 2000;
const KINDS = ['view', 'faq', 'fill'];
const MAX_QUESTION = 200;
const MAX_FILL = 600;

/* 試し版の AI の上限（wrangler.jsonc の vars に無ければこの値）。1 つの試し版で 1 日 150 回・月 $2 */
export const TRIAL_DAILY = 150;
export const TRIAL_MONTHLY_USD = 2;
export function trialLimits(vars) {
  const num = (v, d) => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : d;
  };
  return { day: Math.floor(num(vars.TRIAL_DAILY_LIMIT, TRIAL_DAILY)), monthMicro: Math.floor(num(vars.TRIAL_MONTHLY_USD, TRIAL_MONTHLY_USD) * 1e6) };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/* redux-ask が受けた本文の形。{ ok, t, req: { kind, question | text } } か { ok: false, error } */
export function checkTrial(given) {
  if (!isObj(given)) return { ok: false, error: 'shape' };
  if (typeof given.t !== 'string' || !TRIAL_TOKEN_RE.test(given.t)) return { ok: false, error: 't' };
  if (!KINDS.includes(given.kind)) return { ok: false, error: 'kind' };
  if (given.kind === 'faq' && !isStr(given.question, MAX_QUESTION)) return { ok: false, error: 'question' };
  if (given.kind === 'fill' && !isStr(given.text, MAX_FILL)) return { ok: false, error: 'text' };
  const req = given.kind === 'view' ? { kind: 'view' } : given.kind === 'faq' ? { kind: 'faq', question: given.question } : { kind: 'fill', text: given.text };
  return { ok: true, t: given.t, req };
}

/* 鍵からお店の試し版を引く（自分の物として持つ鍵だけ。prototype の名前では引かない） */
export const trialFor = (shops, t) => (typeof t === 'string' && Object.prototype.hasOwnProperty.call(shops, t) ? shops[t] : null);

/* 画面に渡す中身。よくある質問の答えも公開の事実なので渡す（出どころの URL は出さない。記録は worker/trial-shops.mjs） */
export function trialView(p) {
  return {
    name: p.name, area: p.area, asOf: p.asOf,
    tours: p.tours.map(t => ({ id: t.id, kind: t.kind, name: t.name, time: t.time, price: t.price, facts: [...t.facts] })),
    info: p.info.map(i => ({ k: i.k, v: i.v })),
    faq: p.faq.map(f => ({ id: f.id, q: f.q, a: f.a }))
  };
}

/* AI に渡すお店の答えの一覧（guest-ai-schema.js の faqs の形） */
export const trialFaqs = (p) => p.faq.map(f => ({ id: f.id, q: f.q, a: f.a }));
