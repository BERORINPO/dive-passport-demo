/* 予約メールの本文から、健康や病気に触れていそうな所を外す（純ロジック）。画面の窓口（ai-reader.js）と Worker の両方が使う。
   AI にも書き写さないよう頼んでいるので、これは念のための 2 重目。
   外しすぎは構わないが、予約に要る行（名前・住所・日時・連絡先）は残したい。そのために:
   - 比べる前に文字をそろえる（全角半角・ゼロ幅文字を消す・カタカナはひらがなへ・小文字へ）
   - 1 行を文に分けて、健康の言葉がある文だけ外す（改行の無い 1 段落のメールのため）
   - 1 字の言葉（薬・熱・うつ など）は名前や地名やツアー名に当たりやすいので、予約の項目の行（名前: 住所: など）では見ない
   - 健康の質問の文は、答えも外す。答えは、空行・次の項目・電話・メール・署名・結びの言葉の手前まで */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const ZERO_WIDTH = /[­​-‏⁠-⁤﻿]/g;
  const fold = (s) => String(s).normalize('NFKC').replace(ZERO_WIDTH, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();
  const words = (list) => new RegExp(list.join('|'));

  const STRONG = words([
    '既往', '持病', '病気', '病院', '入院', '通院', '治療', '服薬', '発作', '発熱', '外傷', '医師', '障害', '心臓', '糖尿', '血圧', '体調',
    '健康', '怪我', 'けが', '手術', '妊娠', '妊婦', '喘息', 'ぜんそく', 'ぜん息', 'てんかん', 'あれるぎ', 'へるにあ', '風邪', '鬱', 'ぱにっく',
    'ぺーすめーかー', 'めまい', '骨折', '捻挫', 'ねんざ', '耳抜き',
    '哮喘', '氣喘', '气喘', '高血压', '高血壓', '心脏', '心臟', '懷孕', '怀孕', '过敏', '過敏',
    '천식', '임신', '임산', '질병', '병원', '병력', '수술', '심장', '알레르기', '당뇨', '혈압', '건강', '약물', '복용',
    '\\b(?:asthma|pregnan|injur|allerg|diabet|epilep|depress|disab|medic|surg|seizure|prescription|disease|illness|pacemaker|panic|sinus|cancer|health)',
    '\\b(?:heart|hospital|pills?|drugs?|sick|lungs?|fever|blood|doctors?)\\b'
  ]);
  const WEAK = words(['病', '症', '患', '薬', '藥', '药', '痛', '炎', '妊', '孕', '術', '障', '疾', '傷', '血', '耳', '肺', '喘', '医', '醫', '熱', 'うつ', 'かぜ']);
  const NOT_HEALTH = /熱帯|熱心|情熱|傷害保険|支障|保障|故障|技術|美術|芸術|戦術/g;

  const LABEL = /^\s*[-・*•>]*\s*([^\s:][^:]{0,40}?)(?<!\d):/;              // 「項目名:」（fold の後なので : は半角）。8:30 は項目名にしない
  const BOOKING_LABEL = /名前|氏名|代表|ふりがな|name|lead|traveler|participant|住所|address|ほてる|hotel|宿|pickup|めーる|mail|電話|phone|tel|つあー|ぷらん|plan|activity|tour|日時|日程|希望日|date|予約|ref|booking|人数/;
  const ANSWER = /^\s*[-・*•>]*\s*(a|ans|answer|答え?|回答|返答)\s*[:.]/;       // 答えの行は、前の質問の続き
  const ENDS_ANSWER = [/\+?\d[\d\s()-]{8,}\d/, /\S+@\S+\.\S+/, /^\s*(--|__)/, /^\s*(thanks|thank you|best|regards|cheers|よろしく|宜しく|以上)/];
  const SENTENCE = /(?<=[。．！？!?])|(?<=\.)(?=\s)/;
  const REDACTED_LINE = '（健康についての行は送っていません）';
  const REDACTED_PART = '（健康についての文を外しました）';

  function isHealth(f, bookingLine) {
    if (STRONG.test(f)) return true;
    return !bookingLine && WEAK.test(f.replace(NOT_HEALTH, ''));
  }
  const isQuestion = (f) => /[?]\s*$/.test(f) || /:\s*$/.test(f);
  const endsAnswer = (f) => f.trim() === '' || (LABEL.test(f) && !ANSWER.test(f)) || ENDS_ANSWER.some(re => re.test(f));
  const bookingLabel = (f) => { const m = LABEL.exec(f); return !!m && BOOKING_LABEL.test(m[1]); };

  /* 1 行を文に分けて外す。answerOpen は「前の文が健康の質問で、答えがまだ来ていない」 */
  function redactLine(line, answerOpen) {
    const f = fold(line);
    if (answerOpen && !endsAnswer(f)) return { text: REDACTED_LINE, count: 1, answerOpen: true };
    const booking = bookingLabel(f);
    let open = false;
    let count = 0;
    const parts = line.split(SENTENCE).map(part => {
      const pf = fold(part);
      const hit = isHealth(pf, booking) || (open && !ENDS_ANSWER.some(re => re.test(pf)));
      open = hit && isQuestion(pf);
      if (!hit) return part;
      count += 1;
      return null;
    });
    if (!count) return { text: line, count, answerOpen: false };
    const kept = parts.filter(p => p !== null && p.trim() !== '');
    return { text: kept.length ? parts.map(p => (p === null ? REDACTED_PART : p)).join('') : REDACTED_LINE, count, answerOpen: open };
  }

  function redact(text) {
    let answerOpen = false;
    let redacted = 0;
    const out = String(text).split('\n').map(line => {
      const r = redactLine(line, answerOpen);
      answerOpen = r.answerOpen;
      redacted += r.count;
      return r.text;
    });
    return { text: out.join('\n'), redacted };
  }

  R.healthRedact = { fold, redact, REDACTED_LINE, REDACTED_PART };
})();
