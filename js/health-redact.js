/* 予約メールの本文から、健康や病気に触れていそうな所を外す（純ロジック）。画面の窓口（ai-reader.js）と Worker の両方が使う。
   AI にも書き写さないよう頼んでいるので、これは念のための 2 重目。本当の歯止めは、送る前にお店に見せる確認の画面（P1）。
   外しすぎは構わないが、予約に要る行（名前・住所・日時・連絡先）は残したい。そのために:
   - 比べる前に文字をそろえる（全角半角・ゼロ幅文字を消す・カタカナはひらがなへ・小文字へ）
   - 1 行を文に分けて、健康の言葉がある文から外す（改行の無い 1 段落のメールのため）
   - 健康の文の後ろも、空行・次の項目・電話・メール・署名・結び・予約の話（日付・人数・お願いします）の手前まで外す
   - 健康の質問（? で終わる、「項目名:」で値が空）は、答えが来るまで空行でも止めない
   - 1 字の言葉（薬・熱・うつ など）は、固有名詞が入る項目（名前・住所・宿・連絡先）の行では、括弧の中だけ見る
   - 外した印には健康の言葉を入れない（2 回かけても同じ結果になる） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const ZERO_WIDTH = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/g;
  const fold = (s) => String(s).normalize('NFKC').replace(ZERO_WIDTH, '')
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();
  const words = (list) => new RegExp(list.join('|'));

  const STRONG = words([
    '既往', '持病', '病気', '病院', '入院', '通院', '治療', '服薬', '発作', '発熱', '外傷', '医師', '障害', '心臓', '糖尿', '血圧', '体調',
    '健康', '怪我', '手術', '妊娠', '妊婦', '生理', '月経', '喘息', 'ぜんそく', 'ぜん息', 'てんかん', 'あれるぎ', 'へるにあ', 'いんすりん',
    '風邪', '鬱', 'ぱにっく', 'ぺーすめーかー', 'めまい', '骨折', '捻挫', 'ねんざ', '耳抜き', '中耳', '耳鳴', '減圧',
    '哮喘', '氣喘', '气喘', '高血压', '高血壓', '心脏', '心臟', '懷孕', '怀孕', '过敏', '過敏',
    '천식', '임신', '임산', '질병', '병원', '병력', '수술', '심장', '알레르기', '당뇨', '혈압', '건강', '약물', '복용',
    '\\b(?:asthma|pregnan|injur|allerg|diabet|epilep|depress|disab|medic|surg|seizure|prescription|disease|illness|pacemaker|sinus|cancer|health|insulin|inhaler|chemo|decompress|seasick)',
    '\\b(?:heart|hospital|pills?|drugs?|sick|lungs?|fever|blood|doctors?|panic|ears?|pains?|painful)\\b'
  ]);
  const WEAK = words(['病', '症', '患', '薬', '藥', '药', '痛', '炎', '妊', '孕', '術', '障', '疾', '傷', '血', '耳', '肺', '喘', '医', '醫', '熱',
    'うつ', 'かぜ', 'けが']);
  const NOT_HEALTH = /うつぼ|熱帯|熱心|情熱|傷害保険|支障|保障|故障|技術|美術|芸術|戦術/g;

  const LABEL = /^\s*[-・*•>]*\s*([^\s:][^:]{0,40}?)(?<!\d):/;                 // 「項目名:」（fold の後なので : は半角）。8:30 は項目名にしない
  const PROPER_LABEL = /(名前|氏名|ふりがな|代表者?|name|traveler|guest|住所|address|あどれす|ほてる|hotel|宿|宿泊先|めーる|mail|電話|番号|phone|tel|number)\s*$/;
  const ANSWER = /^\s*[-・*•>]*\s*(a|ans|answer|答え?|回答|返答|yes|no|はい|いいえ|あり|なし|details?|詳細|内容|病名)\s*[:.]/;  // 前の質問の続き
  const PHONE = /\+?\d[\d\s()-]{8,}\d/g;
  const hasPhone = (f) => (f.match(PHONE) || []).some(m => m.replace(/\D/g, '').length >= 9);
  const BOOKING_TALK = /\d{1,2}\s*(月|\/)\s*\d{1,2}|予約|お願いします|\bbook|\breserv|\d+\s*(名|人)|\d+\s*(people|pax)\b/;
  const STOPS = [hasPhone, (f) => /\S+@\S+\.\S+/.test(f), (f) => /^\s*(--|__)/.test(f),
    (f) => /^\s*(thanks|thank you|best|regards|cheers|よろしく|宜しく|以上)/.test(f), (f) => BOOKING_TALK.test(f)];
  const PAREN = /[(\[［]([^)\]］]*)[)\]］]/g;
  const SENTENCE = /(?<=[。．！？!?])|(?<=\.)(?=\s)/;
  const LINES = /\r\n?|[\n\u2028\u2029\u0085]/;
  const REDACTED_LINE = '［この行は送っていません］';
  const REDACTED_PART = '［ここは送っていません］';

  const stops = (f) => STOPS.some(s => s(f));
  const isNewLabel = (f) => LABEL.test(f) && !ANSWER.test(f);
  const isQuestion = (f) => /[?]\s*$/.test(f) || /:\s*$/.test(f);
  const properLine = (f) => { const m = LABEL.exec(f); return !!m && PROPER_LABEL.test(m[1].trim()); };

  function isHealth(f, proper) {
    if (STRONG.test(f)) return true;
    const area = proper ? (f.match(PAREN) || []).join(' ') : f;
    return WEAK.test(area.replace(NOT_HEALTH, ''));
  }

  /* state: 0 = 外していない / 1 = 健康の文の続き / 2 = 健康の質問で、答えがまだ来ていない */
  function redactLine(line, state) {
    const f = fold(line);
    if (f.trim() === '') return { text: line, count: 0, state: state === 2 ? 2 : 0 };
    if (state && !isNewLabel(f) && !stops(f)) return { text: REDACTED_LINE, count: 1, state: 1 };
    const proper = properLine(f);
    let open = state > 0 && !isNewLabel(f);
    let next = 0;
    let count = 0;
    const parts = line.split(SENTENCE).map(part => {
      const pf = fold(part);
      if (pf.trim() === '') return part;
      const hit = isHealth(pf, proper) || (open && !stops(pf));
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
