/* Worker の読み取りの決まり（core）。外のもの（通信・KV・時計・暗号）は使わない。時刻は受け取る。
   画面と同じ js/roster-schema.js・js/health-redact.js を読み、送られてきた物をもう一度検査してから AI に渡す（画面の検査を信じない）。
   プロンプト・model・max_tokens は Worker が決める。画面から来た指定は使わない */
import '../js/roster-schema.js';
import '../js/health-redact.js';

const R = globalThis.REDUX;

export const MODEL = 'claude-haiku-5-5';
export const MAX_TOKENS = 3000;   // AI の読み取り試験 (2026-10-21) と同じ
/* Claude Haiku 5.5 の料金（100 万トークンあたりのドル。入力が 100K トークン以下のとき）。
   出典: Claude Code の claude-api の参照の表（2026-10-06 時点）と、AI の読み取り試験の run_ocr.py（2026-10-21）。1 件の費用の目安にだけ使う。
   本当の額の歯止めは Anthropic のワークスペースの上限。置いたあと、Console の使用額と KV の month を 1 回見比べる（docs/deploy.md） */
const PRICE_IN = 0.10;
const PRICE_OUT = 0.50;
/* 呼ぶ前に、1 件で使うかもしれない最大の額を見込んでおく。入力は予約メールの上限 2 万字 + プロンプト（写真より多い）、出力は上限まで */
const WORST_IN_TOKENS = 24000;
export const WORST_MICRO = Math.ceil(WORST_IN_TOKENS * PRICE_IN + MAX_TOKENS * PRICE_OUT);   // 100 万分の 1 ドル単位
/* 依頼の本文の上限。写真の base64 + JSON の囲み */
export const MAX_BODY = R.roster.MAX_IMAGE + 2000;

/* 写真（申込書・C カード）は AI の読み取り試験と同じ文。書き方を変えたら、置いたあとの Worker で見本 16 件を読み直す */
const RULES = `あなたはダイビングショップの受付事務を手伝います。この書類から、ダイビングに参加する人ごとに名簿の項目を読み取り、JSON だけを返してください。

決まり:
- 書類に書かれていないこと・読めないことは null にする。推測で埋めない。
- 日付は西暦にする（和暦は変換する）。日まで分からなければ、分かる所まで書く（YYYY-MM、YYYY）。
- cert_course は OW / AOW / RESCUE / JOW / DM / OTHER / NONE のどれか。C カードを持っていない・初めてと分かる人は NONE。分からなければ null。
- 電話番号は書いてあるとおり（ハイフンはあってもなくてもよい）。
- 少しでも自信がない項目は、その項目名を unsure に入れる。
- 健康や病気についての情報が見えても書き写さない。見えたかどうかだけを health_info_visible に書く。
- お店のスタッフや、引用された過去のメールの差出人は参加者に含めない。`;
const PHOTO_FORMAT = `

形式:
{"participants": [{"name": "", "birth_date": "", "phone": "", "address": "", "emergency_name": "", "emergency_relation": "", "emergency_phone": "", "cert_course": "", "cert_date": "", "dive_count": 0, "last_dive": "", "height_cm": 0, "weight_kg": 0, "foot_cm": 0, "unsure": []}], "health_info_visible": false}`;
const PHOTO_PROMPT = RULES + PHOTO_FORMAT;

/* 予約メールだけ、予約そのものも読む（試験では聞いていない部分。置いたあとの確かめで見る）。
   答えを 2 つの JSON に分けさせないよう、形式は 1 つにまとめて見せる。例の値は null にする（0 を書き写させない） */
const MAIL_PROMPT = (today) => `${RULES}

この書類は予約のメールです。参加者のほかに、予約そのものも "booking" に書いてください。
- site: 予約を受けたサイトやフォームの名前。ref: 予約番号。date: 潜る日（YYYY-MM-DD）。start: 集合か開始の時刻（HH:MM、24 時間）。tour: ツアーの名前。people: 人数。lead_name・lead_phone: 代表者の名前と電話。
- 今日は ${today}。年が書かれていない日付は、今日か今日より後の一番近い日にする。
- 分からない所は null にし、少しでも自信がない項目は booking の unsure に入れる。
- 「${R.healthRedact.REDACTED_LINE}」「${R.healthRedact.REDACTED_PART}」は、お店が送らなかった所。中身を推測しない。
- 答えは次の形の JSON 1 つだけ。前後に説明を書かない。

形式:
{"participants": [{"name": null, "birth_date": null, "phone": null, "address": null, "emergency_name": null, "emergency_relation": null, "emergency_phone": null, "cert_course": null, "cert_date": null, "dive_count": null, "last_dive": null, "height_cm": null, "weight_kg": null, "foot_cm": null, "unsure": []}], "booking": {"site": null, "ref": null, "date": null, "start": null, "tour": null, "people": null, "lead_name": null, "lead_phone": null, "unsure": []}, "health_info_visible": false}`;

/* 日付は日本の時刻で決める（便も名簿も沖縄の日付）。core は時計を使わないので、受け取った ms から暦の日を計算する
   （1970-01-01 からの日数を年月日に直す。グレゴリオ暦の 400 年の周期で数える） */
const JST_MS = 9 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
function civil(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
const pad = (n, w) => String(n).padStart(w, '0');
export function periods(nowMs) {
  const { y, m, d } = civil(Math.floor((nowMs + JST_MS) / DAY_MS));
  const month = `${pad(y, 4)}-${pad(m, 2)}`;
  return { day: `${month}-${pad(d, 2)}`, month };
}

/* 写真の中身が JPEG か PNG かを、ファイルの先頭の印で見る（画面の言う種類は信じない） */
export function imageType(b64) {
  let head;
  try { head = atob(b64.slice(0, 16)); } catch (e) { return ''; }
  const b = [...head].map(c => c.charCodeAt(0));
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if ([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].every((v, i) => b[i] === v)) return 'image/png';
  return '';
}

/* 送られてきた依頼を検査し、AI に渡す物を組み直す。{ ok, error } か { ok, ask } */
export function checkRequest(given, today) {
  const v = R.roster.validateRequest(given);
  if (!v.ok) return { ok: false, error: v.errors.join(',') };
  const body = R.roster.requestBody(given);
  if (body.doc === 'mail') {
    const { text, redacted } = R.healthRedact.redact(body.text);
    if (text.length > R.roster.MAX_TEXT) return { ok: false, error: 'text' };
    return { ok: true, ask: { doc: 'mail', prompt: MAIL_PROMPT(today), text, size: text.length, redacted } };
  }
  const mediaType = imageType(body.image);
  if (!mediaType) return { ok: false, error: 'image-type' };
  return { ok: true, ask: { doc: body.doc, prompt: PHOTO_PROMPT, image: body.image, mediaType, size: body.image.length, redacted: 0 } };
}

/* 答えの文の中の JSON の塊を、前から順に取り出す（文字列の中の括弧は数えない）。前後の説明・```json の囲み・2 つに分かれた答えに耐える。
   閉じたのに JSON でない塊（書き損じ・説明の括弧）は、中に入らずに後ろへ進む（中の 1 人分の塊を答えと取り違えない）。
   調べる { は先頭から MAX_STARTS 個まで（Workers の CPU 時間の上限への備え） */
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const MAX_STARTS = 20;
function closingBrace(text, start) {
  let depth = 0;
  let quote = false;
  for (let j = start; j < text.length; j += 1) {
    const c = text[j];
    if (quote) {
      if (c === '\\') j += 1;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return j; }
  }
  return -1;
}
function jsonObjects(text) {
  const found = [];
  let i = text.indexOf('{');
  for (let tries = 0; i !== -1 && tries < MAX_STARTS; tries += 1) {
    const end = closingBrace(text, i);
    if (end === -1) { i = text.indexOf('{', i + 1); continue; }   // 閉じない {（説明の文など）。次の { から
    try {
      const v = JSON.parse(text.slice(i, end + 1));
      if (isObj(v)) found.push(v);
    } catch (e) { /* 閉じているのに JSON でない塊。中は見ない */ }
    i = text.indexOf('{', end + 1);
  }
  return found;
}

/* AI の答えの文から JSON を取り出し、答えの形に直して検査する。予約は予約メールのときだけ受け取る。
   参加者の塊と予約の塊が分かれて返ったときは、参加者の塊に予約の項目が無いときだけ足す。
   参加者の塊・予約の塊が 2 つ以上あれば断る（書類に仕込まれた JSON を AI が書き写したとき、どちらが本当か決められない。ザクのレビュー）。
   健康の情報が見えた印は安全な側に倒す: 答えの文のどこかで true と言っていれば true（壊れた答えでも、healthSeen で返す） */
const SAID_HEALTH = /"health_info_visible"\s*:\s*true\b/;
export function readingFrom(text, doc) {
  if (typeof text !== 'string') return { ok: false, error: 'no-json', healthSeen: false };
  const healthSeen = SAID_HEALTH.test(text);
  const fail = (error) => ({ ok: false, error, healthSeen });
  const objects = jsonObjects(text);
  if (!objects.length) return fail(text.includes('{') ? 'json' : 'no-json');
  const people = objects.filter(o => has(o, 'participants'));
  const bookings = objects.filter(o => has(o, 'booking'));
  if (people.length > 1 || bookings.length > 1) return fail('many');
  const base = people[0];
  if (!base && !(doc === 'mail' && bookings.length)) return fail('shape');
  const raw = { ...(base || {}), booking: bookings.length ? bookings[0].booking : undefined };
  if (healthSeen) raw.health_info_visible = true;
  const reading = R.roster.fromModel(doc === 'mail' ? raw : { ...raw, booking: undefined });
  const v = R.roster.validateReading(reading);
  return v.ok ? { ok: true, reading } : fail(v.errors.join(','));
}

/* 上限の判定（数えるのは呼ぶ前）。{ day: 今日呼んだ回数, month: 今月使った額 } と上限から、超えるなら 'day' か 'month' */
export function overLimit(used, limits) {
  if (used.day >= limits.day) return 'day';
  if (used.month + WORST_MICRO > limits.monthMicro) return 'month';
  return '';
}

/* 上限の設定（wrangler.jsonc の vars。文字で来る）。読めない値は 0（= 呼ばない側に倒す） */
export function limitsFrom(vars) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return { day: Math.floor(num(vars.DAILY_LIMIT)), monthMicro: Math.floor(num(vars.MONTHLY_USD) * 1e6) };
}

/* 使った額（100 万分の 1 ドル単位の整数）。usage が無ければ最大の見込みで数える */
export function costMicro(usage) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const inTok = n(usage && usage.input_tokens);
  const outTok = n(usage && usage.output_tokens);
  if (inTok === null || outTok === null) return WORST_MICRO;
  return Math.ceil(inTok * PRICE_IN + outTok * PRICE_OUT);
}
