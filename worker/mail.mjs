/* お客さんへの連絡をメールで送る（adapter）。Cloudflare Email Service の Workers binding（EMAIL）を使い、鍵は持たない。
   送り元のアドレス（MAIL_FROM）はお店のドメインを Email Service に載せたあとで決める。設定がそろうまでは送らず、unsent にする。
   見本は worker/fakes.mjs の fakeMail */

/* リンクの先は https だけ（手元の確かめ tools/serve-dist.mjs の localhost だけは http も） */
function linkOk(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname));
  } catch (e) {
    return false;
  }
}

/* 送れる設定がそろっているか（binding・送り元・お客さんに渡すリンクの先） */
export function mailReady(env) {
  return Boolean(env.EMAIL && typeof env.EMAIL.send === 'function' && typeof env.MAIL_FROM === 'string' && env.MAIL_FROM.includes('@')
    && typeof env.APP_URL === 'string' && linkOk(env.APP_URL));
}

/* 1 通送る。返すのは { id, result: 'sent' | 'failed' | 'unsent', why }。why は短い名前だけ（宛先や本文はログに出さない） */
export async function sendOne(env, item, shopName) {
  if (!mailReady(env)) return { id: item.id, result: 'unsent', why: 'no-mail-config' };
  try {
    await env.EMAIL.send({ to: item.to, from: { email: env.MAIL_FROM, name: String(shopName || '').slice(0, 60) || 'REDUX' }, subject: item.subject, text: item.body });
    return { id: item.id, result: 'sent', why: '' };
  } catch (e) {
    return { id: item.id, result: 'failed', why: String((e && e.code) || 'send').slice(0, 40) };
  }
}
