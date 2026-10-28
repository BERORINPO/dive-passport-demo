/* /api の応答と本文の読み方（entry の部品）。お店の Worker の入口（handler.mjs）と、Access の無い redux-ask の入口（public-handler.mjs）が同じ物を使う。
   決まりごとだけを持ち、道の判断・D1・お店の判定は持たない（redux-ask の束に名簿の道を入れないため、ここには何も足さない） */

export const API_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex',
  'cross-origin-resource-policy': 'same-origin'
};
export const json = (status, data, extra) => new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...(extra || {}) } });

export const isJson = (request) => /^application\/json(\s*;|$)/i.test(request.headers.get('content-type') || '');

/* 本文を上限まで読む。超えたら null（全部は読まない）。
   gzip が true の道（名簿の PUT）は、画面が大きな名簿を gzip で送る（content-encoding: gzip。ジンのレビュー 2026-10-27 MEDIUM 10）。
   中身が本当に gzip の形のときだけほどき、ほどいた後も max までしか読まない（小さく縮めた大きな本文で止めを抜けさせない）。壊れた gzip は例外 */
export async function readCapped(request, max, { gzip = false } = {}) {
  const len = Number(request.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) return null;
  if (!request.body) return '';
  let bytes = await readBytes(request.body, max);
  if (bytes && gzip && bytes[0] === 0x1f && bytes[1] === 0x8b && /^gzip$/i.test((request.headers.get('content-encoding') || '').trim())) {
    bytes = await readBytes(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip')), max);
  }
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

async function readBytes(stream, max) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return all;
}
