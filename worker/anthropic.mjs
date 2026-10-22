/* Claude API を呼ぶ（adapter）。request は毎回ここで新しく組み立てる。
   送るヘッダは x-api-key・anthropic-version・content-type の 3 つだけ（画面から来た Cookie・Access の JWT は送らない）。
   SDK を使わず fetch で書くのは、この repo が npm の部品を入れない作りで、送るヘッダを 3 つに決めているため（spec/architecture.md の決定ログ）。
   エラーの本文は返さない（状態の番号だけ）。io = { fetch } */
import { MODEL, MAX_TOKENS } from './read-core.mjs';

const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = 25000;

export class UpstreamError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;       // http / network / refusal / empty
    this.status = status || 0;
  }
}

/* ask は read-core.mjs の checkRequest が組み直した物。{ text, usage, stopReason } を返す */
export async function callModel(ask, env, io) {
  const content = ask.doc === 'mail'
    ? [{ type: 'text', text: `${ask.prompt}\n\n--- 書類 ---\n${ask.text}` }]
    : [{ type: 'image', source: { type: 'base64', media_type: ask.mediaType, data: ask.image } }, { type: 'text', text: ask.prompt }];
  let res;
  try {
    res = await io.fetch(URL_MESSAGES, {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content }] }),
      redirect: 'error',   // 別の所へ転送されても、鍵の付いた要求を付いて行かせない
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (e) {
    throw new UpstreamError('network');
  }
  if (!res.ok) throw new UpstreamError('http', res.status);
  let body;
  try { body = await res.json(); } catch (e) { throw new UpstreamError('empty', res.status); }
  const usage = body && body.usage;
  if (body && body.stop_reason === 'refusal') throw Object.assign(new UpstreamError('refusal', 200), { usage });
  /* 考えた所（thinking）は使わず、答えの文だけをつなぐ */
  const text = (Array.isArray(body && body.content) ? body.content : [])
    .filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  if (!text) throw Object.assign(new UpstreamError('empty', 200), { usage });
  return { text, usage, stopReason: typeof body.stop_reason === 'string' ? body.stop_reason.slice(0, 20) : '' };
}
