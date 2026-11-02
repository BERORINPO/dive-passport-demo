/* 申し込みを運営者のメールに届ける（adapter）。Cloudflare Email Service の Workers binding（APPLY_MAIL）を使い、鍵は持たない。
   宛先は secret の APPLY_TO（運営者のアドレス。公開の repo に書かない）だけで、フォームから宛先は選べない。送り元は vars の APPLY_FROM。
   お店の Worker の警報（worker/backup.mjs の ALERT_TO）と同じ送り方。見本はテストの偽の binding */

/* 送れる設定がそろっているか */
export function applyReady(env) {
  return Boolean(env.APPLY_MAIL && typeof env.APPLY_MAIL.send === 'function' && typeof env.APPLY_FROM === 'string' && env.APPLY_FROM.includes('@')
    && typeof env.APPLY_TO === 'string' && env.APPLY_TO.includes('@'));
}

/* 1 通送る。返すのは true / false だけ（宛先も中身もログに出さない） */
export async function sendApply(env, mail) {
  if (!applyReady(env)) return false;
  try {
    await env.APPLY_MAIL.send({ to: env.APPLY_TO, from: { email: env.APPLY_FROM, name: 'REDUX 案内ページ' }, subject: mail.subject, text: mail.text, replyTo: mail.replyTo });
    return true;
  } catch (e) {
    return false;
  }
}
