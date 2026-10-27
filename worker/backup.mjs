/* 名簿の毎日の控えと警報をつなぐ（entry。Cron から呼ぶ。決まりは backup-core.mjs、計画は plan/server.md の「毎日の控えと警報」）。
   控えの置き場所は Workers KV の BACKUP（D1 とは別の保存場所。D1 の 30 日の巻き戻しより長く、1 年残す）。BACKUP が無ければ何もしない。
   1 日 1 回だけ取る（Cron は 15 分ごとに来るので、今日の控えがあれば何もしない）。途中で止まっても、今日の控えを書く前なら次の回にやり直す。
   警報は運営（ALERT_TO）にメールで送り、KV にも残す（メールの設定がそろうまでは、KV とログだけ） */
import { getRoster, getMovedSince } from './roster-db.mjs';
import { snapshotOf, peopleInPart, dropAlert, alertMail, dayKey, pastKey, alertKey, BACKUP_KEEP_DAYS } from './backup-core.mjs';
import { mailReady, sendOne } from './mail.mjs';
import { periods } from './read-core.mjs';

const DAY_MS = 86400000;
const KEEP_S = BACKUP_KEEP_DAYS * 86400;
const MAX_MOVED = 1000;

export async function dailyBackup(env, io, shop, note) {
  if (!env.BACKUP || typeof env.BACKUP.get !== 'function') { note.backup = 'off'; return; }
  const now = io.now();
  const today = periods(now).day;
  const yesterday = periods(now - DAY_MS).day;
  const at = new Date(now).toISOString();
  if ((await env.BACKUP.get(dayKey(shop, today))) !== null) return;   // 今日はもう取った
  const got = await getRoster(env.DB, shop);
  if (got.text === null) return;
  const snap = snapshotOf(got.text, { version: got.version, at });
  let prev = null;
  try { prev = JSON.parse((await env.BACKUP.get(dayKey(shop, yesterday))) || 'null'); } catch (e) { prev = null; }
  /* 前の控えのあとに済んだ便へ移した行を、1 回だけ写す（行は書き換わらない）。消える日（keep_until の次の日）まで残す */
  const since = prev && typeof prev.at === 'string' ? prev.at : new Date(now - 2 * DAY_MS).toISOString();
  const moved = await getMovedSince(env.DB, shop, since, MAX_MOVED);
  for (const row of moved) {
    if ((await env.BACKUP.get(pastKey(shop, row.part))) !== null) continue;   // もう写した
    const expiration = Math.max(Math.floor(Date.parse(`${row.keepUntil}T00:00:00Z`) / 1000) + 2 * 86400, Math.floor(now / 1000) + 3600);
    await env.BACKUP.put(pastKey(shop, row.part), JSON.stringify({ part: row.part, day: row.day, keepUntil: row.keepUntil, body: row.body }), { expiration });
  }
  await env.BACKUP.put(dayKey(shop, today), JSON.stringify(snap), { expirationTtl: KEEP_S });
  Object.assign(note, { backup: snap.people, moved: moved.length });
  const alert = dropAlert(prev, snap, moved.reduce((n, r) => n + peopleInPart(r.body), 0));
  if (!alert) return;
  note.alert = alert.gone;
  await env.BACKUP.put(alertKey(shop, today), JSON.stringify({ at, ...alert }), { expirationTtl: KEEP_S });
  if (!mailReady(env) || !env.ALERT_TO) { note.alertMail = 'no-config'; return; }
  const mail = alertMail(shop, today, alert);
  const sent = await sendOne(env, { id: 'alert', to: env.ALERT_TO, subject: mail.subject, body: mail.text }, 'REDUX');
  note.alertMail = sent.result;
}
