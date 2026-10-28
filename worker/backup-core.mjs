/* 名簿の毎日の控えと、人数が急に減ったときの警報の決まり（core）。外のもの（KV・D1・メール・時計）は使わない。
   計画は plan/server.md の「毎日の控えと警報」（ジンのレビュー 2026-10-27 CRITICAL 2: 消えても誰も気付けず、30 日たつと戻せない）。
   - 控え: お店ごと 1 日 1 つ、名簿の本体をそのまま（1 年残す）。済んだ便の行は 1 回だけ（行は書き換わらないので、1 つで足りる）
   - 警報: 直近 LOOKBACK_DAYS 日の控えのうち人がいちばん多かった物（base）と比べ、済んだ便に移った人を除いて
     DROP_MIN 人より多く、かつ DROP_SHARE の割合より多く減ったとき。名簿が無くなった・読めなくなった・0 人になったときは数に関係なく */

import { MAX_ROSTER_BYTES } from './sync-core.mjs';

export const BACKUP_KEEP_DAYS = 366;
export const LOOKBACK_DAYS = 7;
const DROP_MIN = 5;
const DROP_SHARE = 0.3;

export const dayKey = (shop, day) => `day:${shop}:${day}`;
export const pastKey = (shop, part) => `past:${shop}:${part}`;
export const alertKey = (shop, day) => `alert:${shop}:${day}`;
export const cursorKey = (shop) => `pastcursor:${shop}`;

/* 名簿の本体の文字から、控えの中身を作る。people は人の数（警報で比べる。読めない名簿は -1）。shop は戻すときに取り違えないため */
/* D1 にあるはずの表と、それを作る migration（worker/migrations）。足りなければ Cron は止め、番号を出す（点検 2026-10-28 設計 16・運用 H1）。
   migration を足したらここにも足す（test/backup.test.mjs が migrations の CREATE TABLE と突き合わせる） */
export const REQUIRED_TABLES = { rosters: '0001', ask_links: '0002', shops: '0003', roster_past: '0004', mail_unread: '0005', daily_counts: '0006' };
export function missingMigrations(names) {
  const have = new Set(names);
  return [...new Set(Object.entries(REQUIRED_TABLES).filter(([t]) => !have.has(t)).map(([, m]) => m))].sort();
}

export function snapshotOf(text, { shop, version, at }) {
  let people = -1;
  try { const o = JSON.parse(text); if (o && Array.isArray(o.people)) people = o.people.length; } catch (e) { people = -1; }
  return { shop, at, version, people, text };
}

/* 済んだ便の行に入っている人の数 */
export function peopleInPart(body) {
  try { const b = JSON.parse(body); return Array.isArray(b.people) ? b.people.length : 0; } catch (e) { return 0; }
}

/* 比べる相手: 直近の控え（新しい順の並び）のうち、人がいちばん多かった物。読めない控えは除く */
export function baseOf(recent) {
  return recent.filter(s => s && s.people >= 0).reduce((best, s) => (!best || s.people > best.people ? s : best), null);
}

/* base と今日（next。名簿の行が無いときは null）を比べる。moved は base のあとに済んだ便へ移った人の数。
   警報なら { kind, before, after, moved, gone }、でなければ null */
export function dropAlert(base, next, moved) {
  if (!base) return null;
  if (!next) return { kind: 'missing', before: base.people, after: 0, moved, gone: base.people };
  if (next.people < 0) return { kind: 'unreadable', before: base.people, after: -1, moved, gone: base.people };
  const gone = base.people - next.people - moved;
  if (next.people === 0 && gone > 0) return { kind: 'empty', before: base.people, after: 0, moved, gone };
  return gone > DROP_MIN && gone > base.people * DROP_SHARE ? { kind: 'drop', before: base.people, after: next.people, moved, gone } : null;
}

/* 名簿の大きさが上限（1 MB）に近づいたら、運営に知らせる（点検 2026-10-28 設計 12）。70% でサイトからの予約が止まり、100% で受付の端末から保存できなくなる。
   50・70・85% の段で、その日 1 回だけ（人数の警報が出た日は人数の方を出す） */
export const SIZE_STEPS = [85, 70, 50];
export function sizeAlert(snap) {
  if (!snap || typeof snap.text !== 'string') return null;
  const pct = Math.floor(new TextEncoder().encode(snap.text).byteLength * 100 / MAX_ROSTER_BYTES);
  const step = SIZE_STEPS.find(s => pct >= s);
  return step ? { kind: 'size', pct, step, before: snap.people, after: snap.people, moved: 0, gone: 0 } : null;
}

const KIND_JA = { missing: '名簿が無くなりました', unreadable: '名簿が読めない形になりました', empty: '名簿が 0 人になりました', drop: '名簿の人数が急に減りました' };

/* 運営に送る知らせ（名前やお客さんの中身は入れない。数だけ） */
export function alertMail(shop, day, alert) {
  if (alert.kind === 'size') {
    return {
      subject: `[REDUX] 名簿の大きさが上限の ${alert.pct}% です（${shop}、${day}）`,
      text: `お店 ${shop} の名簿の大きさが、上限（1 MB）の ${alert.pct}% になりました（今日 ${Math.max(alert.after, 0)} 人）。\n\n` +
        '70% を超えるとサイトとメールからの予約を受けなくなり、100% で受付の端末から保存できなくなります。' +
        '済んだ便は 7 日で別の行に移ります。先の予約が多い場合は、spec/architecture.md の「便ごとの行に分ける」を進めてください。'
    };
  }
  return {
    subject: `[REDUX] ${KIND_JA[alert.kind]}（${shop}、${day}）`,
    text: `お店 ${shop} の名簿について: ${KIND_JA[alert.kind]}。\n\n直近 ${LOOKBACK_DAYS} 日でいちばん多かった日: ${alert.before} 人\n今日: ${Math.max(alert.after, 0)} 人` +
      `（済んだ便に移った ${alert.moved} 人は除いて ${alert.gone} 人減）\n\n心当たりが無ければ、docs/deploy.md の「控えから戻す」の手順で戻してください。`
  };
}
