/* 名簿の毎日の控えと警報をつなぐ（entry。Cron から呼ぶ。決まりは backup-core.mjs、計画は plan/server.md の「毎日の控えと警報」）。
   控えの置き場所は Workers KV の BACKUP（D1 とは別の保存場所。D1 の 30 日の巻き戻しより長く、1 年残す）。BACKUP が無ければ何もしない。
   1 日 1 回だけ取る（Cron は 15 分ごとに来るので、今日の控えがあれば何もしない）。途中で止まっても、今日の控えを書く前なら次の回にやり直す。
   済んだ便の行は、最後に写した行の時刻（pastcursor）の続きから全部写す（Cron が止まっていた間や、初めて動いた日より前の行も抜けない）。
   警報は運営（ALERT_TO）にメールで送り、KV にも残す（メールの設定がそろうまでは、KV とログだけ） */
import { getRoster, getMovedSince } from './roster-db.mjs';
import { snapshotOf, peopleInPart, baseOf, dropAlert, alertMail, dayKey, pastKey, alertKey, cursorKey, BACKUP_KEEP_DAYS, LOOKBACK_DAYS } from './backup-core.mjs';
import { mailReady, sendOne } from './mail.mjs';
import { periods } from './read-core.mjs';

const DAY_MS = 86400000;
const KEEP_S = BACKUP_KEEP_DAYS * 86400;
const PAGE = 500;
const MAX_PAGES = 10;   // 1 回に写すのは 5,000 行まで（残りは次の回）

async function readJson(kv, key) {
  try { return JSON.parse((await kv.get(key)) || 'null'); } catch (e) { return null; }
}

/* 済んだ便の行を、前に写した所の続きから写す。返すのは写した行の数 */
async function copyPast(env, shop, now) {
  let cursor = (await readJson(env.BACKUP, cursorKey(shop))) || { at: '', part: '' };
  let copied = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await getMovedSince(env.DB, shop, cursor.at, PAGE, cursor.part);
    for (const row of rows) {
      if ((await env.BACKUP.get(pastKey(shop, row.part))) === null) {
        const expiration = Math.max(Math.floor(Date.parse(`${row.keepUntil}T00:00:00Z`) / 1000) + 2 * 86400, Math.floor(now / 1000) + 3600);
        await env.BACKUP.put(pastKey(shop, row.part), JSON.stringify({ shop, part: row.part, day: row.day, keepUntil: row.keepUntil, body: row.body }), { expiration });
        copied += 1;
      }
      cursor = { at: row.movedAt, part: row.part };
    }
    await env.BACKUP.put(cursorKey(shop), JSON.stringify(cursor));
    if (rows.length < PAGE) break;
  }
  return copied;
}

export async function dailyBackup(env, io, shop, note) {
  if (!env.BACKUP || typeof env.BACKUP.get !== 'function') { note.backup = 'off'; return; }
  const now = io.now();
  const today = periods(now).day;
  const at = new Date(now).toISOString();
  /* 今日はもう取った（名簿が無くて控えを取れなかった日は、警報を残したら終わり。15 分ごとに鳴らさない） */
  if ((await env.BACKUP.get(dayKey(shop, today))) !== null || (await env.BACKUP.get(alertKey(shop, today))) !== null) return;
  note.pastCopied = await copyPast(env, shop, now);
  /* 直近の控え（昨日から LOOKBACK_DAYS 日前まで）。Cron が止まっていた日があっても、残っている控えと比べる */
  const recent = [];
  for (let i = 1; i <= LOOKBACK_DAYS; i += 1) recent.push(await readJson(env.BACKUP, dayKey(shop, periods(now - i * DAY_MS).day)));
  const base = baseOf(recent);
  const got = await getRoster(env.DB, shop);
  const snap = got.text === null ? null : snapshotOf(got.text, { shop, version: got.version, at });
  if (snap) {
    await env.BACKUP.put(dayKey(shop, today), JSON.stringify(snap), { expirationTtl: KEEP_S });
    note.backup = snap.people;
  }
  const moved = base ? (await getMovedSince(env.DB, shop, base.at, 5000)).reduce((n, r) => n + peopleInPart(r.body), 0) : 0;
  const alert = dropAlert(base, snap, moved);
  if (!alert) return;
  note.alert = alert.kind;
  await env.BACKUP.put(alertKey(shop, today), JSON.stringify({ at, ...alert }), { expirationTtl: KEEP_S });
  if (!mailReady(env) || !env.ALERT_TO) { note.alertMail = 'no-config'; return; }
  const mail = alertMail(shop, today, alert);
  const sent = await sendOne(env, { id: 'alert', to: env.ALERT_TO, subject: mail.subject, body: mail.text }, 'REDUX');
  note.alertMail = sent.result;
}
