/* パスポートの中身を、URL に入れられる文字にする・戻す（外とのつなぎ）。
   先頭 1 文字: z = 圧縮あり（deflate-raw）、j = 圧縮なし。続きはどちらも base64url。
   中身は URL の # の後ろに置くので、サーバーには送られない */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const MAX_CODE = 4000;     // QR に入れる文字の上限
  const MAX_JSON = 20000;    // 戻したときの大きさの上限（壊れた中身で固まらないように）

  function toB64url(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromB64url(str) {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
    return Uint8Array.from(atob(padded), ch => ch.charCodeAt(0));
  }

  async function pipe(bytes, transform) {
    const out = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  async function encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    if (typeof CompressionStream !== 'function') return 'j' + toB64url(bytes);
    try {
      return 'z' + toB64url(await pipe(bytes, new CompressionStream('deflate-raw')));
    } catch (e) {
      // deflate-raw を持たない古いブラウザ。圧縮なしで続ける
      return 'j' + toB64url(bytes);
    }
  }

  /* 形の合わない文字は例外にする。中身の検査（版・項目）は pass-schema の validateShare で行う */
  async function decode(code) {
    if (typeof code !== 'string' || code.length < 2 || code.length > MAX_CODE || !/^[zj][A-Za-z0-9_-]+$/.test(code)) {
      throw new Error('passport code: bad format');
    }
    const raw = fromB64url(code.slice(1));
    const bytes = code[0] === 'z' ? await pipe(raw, new DecompressionStream('deflate-raw')) : raw;
    if (bytes.length > MAX_JSON) throw new Error('passport code: too large');
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const passUrl = (code, base) => `${new URL('pass.html', base || globalThis.location.href).href}#p=${code}`;

  function codeFromHash(hash) {
    const m = /^#p=([A-Za-z0-9_-]+)$/.exec(hash || '');
    return m ? m[1] : null;
  }

  R.codec = { encode, decode, passUrl, codeFromHash, MAX_CODE };
})();
