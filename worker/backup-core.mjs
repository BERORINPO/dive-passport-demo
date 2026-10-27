/* 名簿の毎日の控えと、人数が急に減ったときの警報の決まり（core）。外のもの（KV・D1・メール・時計）は使わない。
   計画は plan/server.md の「毎日の控えと警報」（ジンのレビュー 2026-10-27 CRITICAL 2: 消えても誰も気付けず、30 日たつと戻せない）。
   - 控え: お店ごと 1 日 1 つ、名簿の本体をそのまま（1 年残す）。済んだ便の行は、移った日に 1 回だけ（行は書き換わらないので、1 つで足りる）
   - 警報: 前の日の控えより人が SHRINK_MIN 人より多く、かつ SHRINK_SHARE の割合より多く減ったとき。済んだ便に移った人は減ったと数えない */

export const BACKUP_KEEP_DAYS = 366;
const DROP_MIN = 5;
const DROP_SHARE = 0.3;

export const dayKey = (shop, day) => `day:${shop}:${day}`;
export const pastKey = (shop, part) => `past:${shop}:${part}`;
export const alertKey = (shop, day) => `alert:${shop}:${day}`;

/* 名簿の本体の文字から、控えの中身を作る。people は人の数（警報で比べる） */
export function snapshotOf(text, { version, at }) {
  let people = 0;
  try { people = JSON.parse(text).people.length; } catch (e) { people = -1; }   // 読めない名簿も、そのまま控える
  return { at, version, people, text };
}

/* 済んだ便の行に入っている人の数 */
export function peopleInPart(body) {
  try { const b = JSON.parse(body); return Array.isArray(b.people) ? b.people.length : 0; } catch (e) { return 0; }
}

/* 前の日の控え（prev）と今日の控え（next）を比べる。moved は今日までに済んだ便へ移った人の数。警報なら { before, after, gone }、でなければ null */
export function dropAlert(prev, next, moved) {
  if (!prev || prev.people < 0 || next.people < 0) return null;
  const gone = prev.people - next.people - moved;
  return gone > DROP_MIN && gone > prev.people * DROP_SHARE ? { before: prev.people, after: next.people, moved, gone } : null;
}

/* 運営に送る知らせ（名前やお客さんの中身は入れない。数だけ） */
export function alertMail(shop, day, alert) {
  return {
    subject: `[REDUX] 名簿の人数が急に減りました（${shop}、${day}）`,
    text: `お店 ${shop} の名簿の人数が、前の日の控えより大きく減りました。\n\n前の日: ${alert.before} 人\n今日: ${alert.after} 人（済んだ便に移った ${alert.moved} 人は除いて ${alert.gone} 人減）\n\n` +
      `心当たりが無ければ、docs/deploy.md の「控えから戻す」の手順で、前の日の控えから戻してください。控えの名前: ${dayKey(shop, day)} の前の日`
  };
}
