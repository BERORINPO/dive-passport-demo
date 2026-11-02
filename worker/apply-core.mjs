/* 案内ページ（shops.html）の申し込みフォームの中身を確かめ、運営者に届けるメールを組む（core。何も読まず、外へも出ない）。
   集めるのはお店の名前と、返事を受け取るアドレスの 2 つだけ。保存はせず、メールで運営者に届けるだけ（決定ログ 2026-11-02 shop-lp-form） */

export const MAX_APPLY_BODY = 2048;
const MAX_SHOP = 80;
const MAX_EMAIL = 120;
/* 宛先の形。空白・改行・山かっこ・引用符を含む物は通さない（見出しへの差し込みを封じる） */
const EMAIL = /^[^\s@<>"',;:\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/* 制御文字（改行を含む）を空白にし、前後の空白を落とす */
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

/* フォームの値（URLSearchParams）→ { ok, shop, email } / { ok: false, error }。
   罠の欄（website。人には見えない）が埋まっていれば trap: 機械の送信とみて、届けずに受け付けたふりをする */
export function checkApply(params) {
  if (clean(params.get('website'))) return { ok: false, error: 'trap' };
  const shop = clean(params.get('shop'));
  const email = clean(params.get('email'));
  if (!shop || shop.length > MAX_SHOP) return { ok: false, error: 'shop' };
  if (!email || email.length > MAX_EMAIL || !EMAIL.test(email)) return { ok: false, error: 'email' };
  return { ok: true, shop, email };
}

/* 運営者に届けるメール。返事はそのまま申し込んだお店へ向くよう Reply-To に入れる */
export function applyMail({ shop, email }, at) {
  return {
    subject: `[REDUX] 試用の申し込み（${shop}）`,
    text: `案内ページ（ask.reduxdive.com/shops）のフォームから、試用の申し込みがありました。\n\n` +
      `お店の名前: ${shop}\n返事を受け取るアドレス: ${email}\n受け付けた時刻: ${at}\n\n` +
      'このメールに返信すると、上のアドレスに届きます。試用の一式（omnes-demand の 試用の一式）の 01 を、このお店あてに整えて送ってください。',
    replyTo: email
  };
}

/* 送ったあとに戻すページの場所（スクリプトは使わず、#sent・#apply-error の :target で文を出す） */
export const APPLY_DONE = '/shops#sent';
export const APPLY_FAILED = '/shops#apply-error';
