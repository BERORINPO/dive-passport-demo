/* 予約メールの本文から、健康や病気に触れていそうな所を外す（純ロジック）。画面の窓口（ai-reader.js）と Worker の両方が使う。
   AI にも書き写さないよう頼んでいるので、これは念のための 2 重目。本当の歯止めは、送る前にお店に見せる確認の画面（P1）。
   外しすぎは構わないが、予約に要る行（名前・住所・日時・連絡先）は残したい。そのために:
   - 比べる前に文字をそろえる（全角半角・ゼロ幅文字を消す・カタカナはひらがなへ・小文字へ）
   - 1 行を文に分けて、健康の言葉がある文から外す（改行の無い 1 段落のメールのため）
   - 健康の文の後ろも外す。止まるのは、空行・次の項目・電話・メール・署名・結び、または予約の話（日付・予約・代表・宿・
     ピックアップ）で「始まる」文の手前。健康の質問のすぐ後の答えの行は、予約の話でも止めない（答えの中に日付や「お願いします」が入るため）
   - 健康の質問（? で終わる、「項目名:」で値が空）は、答えが来るまで空行でも止めない
   - 1 字の言葉（薬・熱・うつ など）は、固有名詞の項目（名前・住所・宿・連絡先。項目名に健康の字が無いもの）の、最初の文の、
     値の最初のかたまり（名前そのもの）と、仮名だけの括弧（ふりがな）では見ない
   - 外した印には健康の言葉を入れない（2 回かけても同じ結果になる） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;
  const fold = (s) => String(s).normalize('NFKC').replace(ZERO_WIDTH, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();
  const words = (list) => new RegExp(list.join('|'));

  const STRONG = words([
    '既往', '持病', '病気', '病院', '入院', '通院', '治療', '服薬', '発作', '発熱', '外傷', '医師', '医者', '主治医', 'かかりつけ', '障害',
    '心臓', '糖尿', '血圧', '体調', '健康', '怪我', '手術', '妊娠', '妊婦', '生理', '月経', '喘息', 'ぜんそく', 'ぜん息', 'てんかん',
    'あれるぎ', 'へるにあ', 'いんすりん', 'すてろいど', '透析', '吸入', '降圧', '風邪', '鬱', 'ぱにっく', 'ぺーすめーかー', 'めまい',
    '骨折', '捻挫', 'ねんざ', '耳抜き', '中耳', '耳鳴', '減圧',
    '哮喘', '氣喘', '气喘', '高血压', '高血壓', '心脏', '心臟', '懷孕', '怀孕', '过敏', '過敏',
    '천식', '임신', '임산', '질병', '병원', '병력', '수술', '심장', '알레르기', '당뇨', '혈압', '건강', '약물', '복용',
    '\\b(?:asthma|pregnan|injur|allerg|diabet|epilep|depress|disab|medic|surg|seizure|prescription|disease|illness|pacemaker|sinus|cancer|health|insulin|inhaler|chemo|decompress|seasick|dialysis|steroid|anxi)',
    '\\b(?:heart|hospital|pills?|drugs?|meds?|sick|lungs?|fever|blood|doctors?|panic|ears?|pains?|painful)\\b',
    '\\b(?:have|has|had|caught) a cold\\b'
  ]);
  const WEAK = words(['病', '症', '患', '薬', '藥', '药', '痛', '炎', '妊', '孕', '術', '障', '疾', '傷', '血', '耳', '肺', '喘', '医', '醫', '熱',
    'うつ', 'かぜ', 'けが']);
  const NOT_HEALTH = /うつぼ|熱帯|熱心|情熱|傷害保険|支障|保障|故障|技術|美術|芸術|戦術/g;

  const DECOR = '[-・*•>■□◆●※]*';
  /* 「項目名:」（fold の後なので : は半角）。8:30 のように数字で挟まれた : は項目名にしない */
  const LABEL = new RegExp(`^\\s*${DECOR}\\s*([^\\s:][^:]{0,40}?)(?:(?<!\\d):|:(?!\\d))`);
  const PROPER_LABEL = /(名前|氏名|ふりがな|代表者?|参加者|同行者|participant|member|name|traveler|guest|住所|address|あどれす|ほてる|hotel|宿|宿泊先|めーる|mail|電話|番号|phone|tel|number)\s*$/;
  /* 答えの行は、前の質問の続き（■ご回答: / Your answer: / Yes: / 内容: など） */
  const ANSWER = new RegExp(`^\\s*${DECOR}\\s*(?:ご|お|your\\s+)?(?:a|ans|answer|答え?|回答|返答|response|reply|yes|no|はい|いいえ|あり|なし|details?|詳細|内容|病名)\\s*[:.]`);
  const PHONE = /\+?\d[\d\s()-]{8,}\d/g;
  const hasPhone = (f) => (f.match(PHONE) || []).some(m => m.replace(/\D/g, '').length >= 9);
  const EMAIL = /\S+@\S+\.\S+/;
  const SIGNATURE = /^\s*(--|__)/;
  const CLOSING = /^\s*(thanks|thank you|best|regards|cheers|よろしく|宜しく|以上)/;
  const BOOKING_START = new RegExp(`^\\s*${DECOR}\\s*(?:\\d{1,2}\\s*(?:月|\\/)\\s*\\d{1,2}|ご?予約|book|reserv|代表|お?名前|氏名|ほてる|hotel|宿|ぴっくあっぷ|pickup|we(?:'re| are)? stay|staying at)`);
  const CHUNK = /[、,(\[【/;]/;                                          // 値のかたまりの区切り（fold の後）
  const KANA_PAREN = /[(\[【][぀-ゟー\s・a-z]+[)\]】]/g;      // 仮名とローマ字だけの括弧（ふりがな）
  const SENTENCE = /(?<=[。．！？!?])|(?<=\.)(?=\s)/;
  const LINES = /\r\n?|[\n\u2028\u2029\u0085]/;
  const REDACTED_LINE = '［この行は送っていません］';
  const REDACTED_PART = '［ここは送っていません］';

  const stops = (f, answerLine) => hasPhone(f) || EMAIL.test(f) || SIGNATURE.test(f) || CLOSING.test(f) ||
    (!answerLine && BOOKING_START.test(f));
  const isNewLabel = (f) => LABEL.test(f) && !ANSWER.test(f);
  const isQuestion = (f) => /[?]\s*$/.test(f) || /:\s*$/.test(f);

  function isHealth(f, weakText) {
    if (STRONG.test(f)) return true;
    return WEAK.test((weakText === undefined ? f : weakText).replace(NOT_HEALTH, ''));
  }
  const properLabel = (label) => !isHealth(label) && PROPER_LABEL.test(label.trim().replace(/\d+$/, '').trim());

  /* 1 字の言葉を見る所。固有名詞の項目なら、項目名と、値の最初のかたまりと、ふりがなの括弧を除く */
  function weakTextOf(pf) {
    const m = LABEL.exec(pf);
    if (!m || !properLabel(m[1])) return pf;
    const value = pf.slice(m[0].length);
    return value.slice(value.split(CHUNK)[0].length).replace(KANA_PAREN, ' ');
  }

  /* state: 0 = 外していない / 1 = 健康の文の続き / 2 = 健康の質問で、答えがまだ来ていない */
  function redactLine(line, state) {
    const f = fold(line);
    if (f.trim() === '') return { text: line, count: 0, state: state === 2 ? 2 : 0 };
    const answerLine = state === 2;
    if (state && !isNewLabel(f) && !stops(f, answerLine)) return { text: REDACTED_LINE, count: 1, state: 1 };
    let open = state > 0 && !isNewLabel(f);
    let first = true;
    let next = 0;
    let count = 0;
    const parts = line.split(SENTENCE).map(part => {
      const pf = fold(part);
      if (pf.trim() === '') return part;
      const hit = isHealth(pf, first ? weakTextOf(pf) : pf) || (open && !stops(pf, answerLine));
      first = false;
      open = hit;
      next = hit ? (isQuestion(pf) ? 2 : 1) : 0;
      if (!hit) return part;
      count += 1;
      return null;
    });
    if (!count) return { text: line, count, state: 0 };
    const kept = parts.filter(p => p !== null && p.trim() !== '');
    return { text: kept.length ? parts.map(p => (p === null ? REDACTED_PART : p)).join('') : REDACTED_LINE, count, state: next };
  }

  function redact(text) {
    let state = 0;
    let redacted = 0;
    const out = String(text).split(LINES).map(line => {
      const r = redactLine(line, state);
      state = r.state;
      redacted += r.count;
      return r.text;
    });
    return { text: out.join('\n'), redacted };
  }

  R.healthRedact = { fold, redact, REDACTED_LINE, REDACTED_PART };
})();
