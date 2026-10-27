/* お店の名簿をサーバーに置く決まり（core）。外のもの（通信・D1・時計・暗号）は使わない。今日と今の時刻は受け取る。
   画面と同じ js/roster-schema.js・js/roster-core.js・js/roster-share.js を読み、送られてきた名簿をもう一度確かめて直してから置く（画面の検査を信じない）。
   計画は plan/server.md */
import '../js/roster-schema.js';
import '../js/roster-core.js';
import '../js/roster-share.js';

const R = globalThis.REDUX;

/* 名簿 1 つの上限。D1 の 1 行は 2 MB まで。1 年分の予約が入る見込み（超えたら便ごとに分けて持つ形へ直す。plan/server.md） */
export const MAX_ROSTER_BYTES = 1000000;
/* 依頼の本文の上限。名簿 + { base, state } の囲み */
export const MAX_PUT_BODY = MAX_ROSTER_BYTES + 4096;
/* お店は今は 1 つ。複数のお店を受けるときに、Access のメールからお店を決める表を足す */
export const SHOP_DEFAULT = 'default';

const bytes = (text) => new TextEncoder().encode(text).byteLength;

/* 置く前に直す: 記録の中身を消し、保存期間を過ぎた便を消し、他のお店のお客さんの健康の答えを外す（画面の loadRoster と同じ順） */
function tidy(state, { today, at }) {
  const kept = R.rosterCore.purgeExpired(state, { today, at });
  return R.rosterShare.holdPartnerHealth(kept, { at });
}

/* PUT の本文 { base, state } を確かめる。返すのは { ok, base, state, text } か { ok: false, error } */
export function checkPut(given, { today, at }) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) return { ok: false, error: 'shape' };
  const { base, state } = given;
  if (!Number.isInteger(base) || base < 0) return { ok: false, error: 'base' };
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, error: 'state' };
  const scrubbed = R.rosterCore.scrubLog(state);
  const v = R.roster.validateState(scrubbed);
  if (!v.ok) return { ok: false, error: `state:${v.errors.slice(0, 3).join(',')}` };
  const next = tidy(scrubbed, { today, at });
  const text = JSON.stringify(next);
  if (bytes(text) > MAX_ROSTER_BYTES) return { ok: false, error: 'size' };
  return { ok: true, base, state: next, text };
}

/* 置いてある名簿の文字を読み直す。形の検査に落ちたら null（壊れた物を画面に広げない）。期限切れの便は、読むときにも消す */
export function readStored(text, { today, at }) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object' || !R.roster.validateState(parsed).ok) return null;
  return tidy(parsed, { today, at });
}
