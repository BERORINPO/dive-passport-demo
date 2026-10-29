/* お客さんのリンクを「SMS で送る」「LINE で送る」の URL にする（純ロジック）。通信・保存・画面・時計は知らない。
   できるのは文字を組んで URL にするだけで、サーバーは何も送らない: スタッフの携帯の SMS アプリか LINE の「共有」画面が、本文を入れた状態で開き、
   送るのはスタッフが押す（契約も鍵も要らない。2026-10-28）。本文に入る物は、お店の名前・決まった 1 行・その予約のリンクだけ（お客さんの名前は入れない）。
   - sms: は RFC 5724（sms:番号?body=…）。iPhone は ?body= を読まず、& で始まる body を読むので、どちらにも通る ?&body= の形にする
     （StackOverflow の質問 6480462 の回答 50390802 と 58131833 が、iOS 18 / 26 と Android 13 で通ると報告。実機の確かめは PR の確かめ一覧）
   - LINE は公式の URL scheme（https://developers.line.biz/en/docs/messaging-api/using-line-url-scheme/ の Sending text messages）。
     https://line.me/R/share?text={UTF-8 を % でエンコードした本文} が「共有先」の画面を開き、スタッフが友だちを選ぶ */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const LINE_SHARE = 'https://line.me/R/share?text='; // arch-allow: 画面から開くだけの LINE 公式の URL scheme（通信はしない）
  const ASK_LINE = 'ご予約の前にお名前などの入力をお願いします';
  /* 予約の連絡の言葉（lang）が日本語でなければ、英語の 1 行を足す（お願いのメールも日本語でなければ英語。js/roster-auto.js） */
  const ASK_LINE_EN = 'Please fill in your details for the diver list before your tour';
  const SHOP_MAX = 24;
  /* お店のリンク（置いた形では https、手元の確かめでは localhost の http）。/ask と # の後ろの鍵だけ */
  const ASK_URL = /^(?:https:\/\/[A-Za-z0-9.-]{1,120}|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?)\/ask#k=[A-Za-z0-9_-]{43}$/; // arch-allow: リンクの形の検査

  const askUrlOk = (u) => typeof u === 'string' && ASK_URL.test(u);

  /* encodeURIComponent が残す ! ' ( ) * も % にする（LINE の文書の例は ! も %21） */
  const enc = (t) => encodeURIComponent(t).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

  /* 送る本文。お店の名前（長ければ切る）+ 決まった 1 行 + リンク（改行して、リンクが自分の行になるように）。
     lang が日本語以外（en・ko・zh）なら、日本語の行の下に英語の 1 行。lang の無い予約（電話で聞いていない）は日本語だけ */
  function messageText(shopName, url, lang) {
    if (!askUrlOk(url)) return '';
    const shop = String(shopName || '').replace(/\s+/g, ' ').trim().slice(0, SHOP_MAX);
    const en = lang && lang !== 'ja' ? `\n${ASK_LINE_EN}` : '';
    return `${shop ? `${shop}：` : ''}${ASK_LINE}${en}\n${url}`;
  }

  /* 電話番号を sms: に入れる形にする。全角の数字を半角に、空白・ハイフン・括弧を除く。先頭の + は残す。数字が 7〜15 でなければ ''（ボタンを出さない） */
  function smsNumber(phone) {
    const half = String(phone || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[＋]/g, '+');
    const num = half.replace(/[\s\-()（）－ー]/g, '');
    return /^\+?\d{7,15}$/.test(num) ? num : '';
  }

  /* 番号が使えないか、リンクがその形でなければ '' */
  function smsHref(phone, shopName, url, lang) {
    const num = smsNumber(phone);
    const text = messageText(shopName, url, lang);
    return num && text ? `sms:${num}?&body=${enc(text)}` : '';
  }

  /* 宛先を入れない sms:（1 人ずつのリンク用。代表者の番号を入れると、代表者にその人のリンクが届く）。スタッフが送り先を選ぶ */
  function smsHrefNoNumber(shopName, url, lang) {
    const text = messageText(shopName, url, lang);
    return text ? `sms:?&body=${enc(text)}` : '';
  }

  function lineHref(shopName, url, lang) {
    const text = messageText(shopName, url, lang);
    return text ? `${LINE_SHARE}${enc(text)}` : '';
  }

  R.contactLink = { ASK_LINE, ASK_LINE_EN, askUrlOk, messageText, smsNumber, smsHref, smsHrefNoNumber, lineHref };
})();
