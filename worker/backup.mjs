/* 名簿の毎日の控えと警報をつなぐ（entry。Cron から呼ぶ。決まりは backup-core.mjs、計画は plan/server.md の「毎日の控えと警報」）。
   控えの置き場所は Workers KV の BACKUP（D1 とは別の保存場所。D1 の 30 日の巻き戻しより長く、1 年残す）。BACKUP が無ければ何もしない。
   1 日 1 回だけ取る（Cron は 1 分ごとに来るので、今日の控えがあれば何もしない）。途中で止まっても、今日の控えを書く前なら次の回にやり直す。
   済んだ便の行は、最後に写した行の時刻（pastcursor）の続きから全部写す（Cron が止まっていた間や、初めて動いた日より前の行も抜けない）。
   警報は運営（ALERT_TO）にメールで送り、KV にも残す（メールの設定がそろうまでは、KV とログだけ） */
import { getRoster, getMovedSince } from './roster-db.mjs';
import { snapshotOf, peopleInPart, baseOf, dropAlert, sizeAlert, alertMail, dayKey, pastKey, alertKey, cursorKey, BACKUP_KEEP_DAYS, LOOKBACK_DAYS } from './backup-core.mjs';
import { mailReady, sendOne } from './mail.mjs';
import { periods } from './read-core.mjs';

const DAY_MS = 86400000;
const KEEP_S = BACKUP_KEEP_DAYS * 86400;
/* 1 回に写す済んだ便の行の数。KV は 1 回の呼び出しで使える回数に上限があり、Cron は全店を 1 回で回るので、小さく区切る（残りは 15 分後の次の回） */
const COPY_PER_RUN = 50;

async function readJson(kv, key) {
  try { return JSON.parse((await kv.get(key)) || 'null'); } catch (e) { return null; }
}

/* 済んだ便の行を、前に写した所（カーソル）の続きから COPY_PER_RUN 行まで写す。同じ行を写し直しても中身は同じなので、先に確かめない（KV の回数を減らす）。
   返すのは写した行の数 */
async function copyPast(env, shop, now) {
  const cursor = (await readJson(env.BACKUP, cursorKey(shop))) || { at: '', part: '' };
  const rows = await getMovedSince(env.DB, shop, cursor.at, COPY_PER_RUN, cursor.part);
  for (const row of rows) {
    const expiration = Math.max(Math.floor(Date.parse(`${row.keepUntil}T00:00:00Z`) / 1000) + 2 * 86400, Math.floor(now / 1000) + 3600);
    await env.BACKUP.put(pastKey(shop, row.part), JSON.stringify({ shop, part: row.part, day: row.day, keepUntil: row.keepUntil, body: row.body }), { expiration });
  }
  if (rows.length) {
    const last = rows[rows.length - 1];
    await env.BACKUP.put(cursorKey(shop), JSON.stringify({ at: last.movedAt, part: last.part }));
  }
  return rows.length;
}

export async function dailyBackup(env, io, shop, note) {
  if (!env.BACKUP || typeof env.BACKUP.get !== 'function') { note.backup = 'off'; return; }
  const now = io.now();
  const today = periods(now).day;
  /* 控えと警報を先に（済んだ便の写しが重くても、こちらは止めない）。写しは毎回、続きから少しずつ */
  const alert = await readJson(env.BACKUP, alertKey(shop, today));
  if ((await env.BACKUP.get(dayKey(shop, today))) === null && alert === null) {
    await snapshotAndAlert(env, shop, now, today, note);
  } else if (alert && alert.mailed === 'pending') {
    /* 警報のメールが送れていなければ、次の Cron でもう一度送る（1 回の失敗でその日の警報が消えない。点検 2026-10-28 運用 C3） */
    await mailAlert(env, shop, today, alert, note);
  }
  note.pastCopied = await copyPast(env, shop, now);
}

/* 今日の控えを取り、直近の控えと比べて警報を出す（名簿が無くて控えを取れなかった日は、警報を残したら終わり。Cron のたびに鳴らさない） */
async function snapshotAndAlert(env, shop, now, today, note) {
  const at = new Date(now).toISOString();
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
  const alert = dropAlert(base, snap, moved) || sizeAlert(snap);
  if (!alert) return;
  note.alert = alert.kind;
  const record = { at, ...alert, mailed: 'pending' };
  await env.BACKUP.put(alertKey(shop, today), JSON.stringify(record), { expirationTtl: KEEP_S });
  await mailAlert(env, shop, today, record, note);
}

/* 警報をメールで送り、送れたら印を付ける（送れなければ pending のまま。メールの設定が無いときも pending で残し、入れたら届く） */
async function mailAlert(env, shop, today, record, note) {
  if (!mailReady(env) || !env.ALERT_TO) { note.alertMail = 'no-config'; return; }
  const mail = alertMail(shop, today, record);
  const sent = await sendOne(env, { id: 'alert', to: env.ALERT_TO, subject: mail.subject, body: mail.text }, 'REDUX');
  note.alertMail = sent.result;
  if (sent.result === 'sent') await env.BACKUP.put(alertKey(shop, today), JSON.stringify({ ...record, mailed: 'sent' }), { expirationTtl: KEEP_S });
}
