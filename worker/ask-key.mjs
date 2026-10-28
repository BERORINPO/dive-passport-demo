/* お客さんのリンクの鍵（adapter。暗号）。鍵は 32 バイトの乱数を base64url にし、D1 に置くのは鍵の SHA-256 だけ（置くのは ask-db.mjs）。
   redux-ask は鍵を SHA-256 にしてから、お店の Worker へ渡す（keyHash）。D1 の読み書きはここに無い。決まりは plan/meibo.md「お客さんのリンク」 */

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* 新しい鍵（43 字）。crypto.randomUUID は 122 bit で足りないので使わない */
export function newKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

export async function keyHash(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
