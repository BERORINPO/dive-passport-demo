/* Worker の読み取りの決まり（core）。外のもの（通信・KV・時計・暗号）は使わない。時刻は受け取る。
   画面と同じ js/roster-schema.js・js/health-redact.js を読み、送られてきた物をもう一度検査してから AI に渡す（画面の検査を信じない）。
   プロンプト・model・max_tokens は Worker が決める。画面から来た指定は使わない */
import '../js/roster-schema.js';
import '../js/health-redact.js';

const R = globalThis.REDUX;

export const MODEL = 'claude-haiku-5-5';
export const MAX_TOKENS = 3000;   // AI の読み取り試験 (2026-10-21) と同じ
/* Claude Haiku 5.5 の料金（100K トークン以下の入力。claude-api の参照 2026-10-06）。1 件の費用の目安にだけ使う */
const PRICE_IN = 0.10;
const PRICE_OUT = 0.50;
/* 呼ぶ前に、1 件で使うかもしれない最大の額を見込んでおく（写真の入力 約 6,000 トークン + 出力の上限） */
export const WORST_MICRO = Math.ceil((6000 * PRICE_IN + MAX_TOKENS * PRICE_OUT));   // 100 万分の 1 ドル単位
/* 依頼の本文の上限。写真の base64 + JSON の囲み */
export const MAX_BODY = R.roster.MAX_IMAGE + 2000;

/* AI の読み取り試験と同じ文。書き方を変えたら、置いたあとの Worker で見本 16 件を読み直す */
const PROMPT = `あなたはダイビングショップの受付事務を手伝います。この書類から、ダイビングに参加する人ごとに名簿の項目を読み取り、JSON だけを返してください。

決まり:
- 書類に書かれていないこと・読めないことは null にする。推測で埋めない。
- 日付は西暦にする（和暦は変換する）。日まで分からなければ、分かる所まで書く（YYYY-MM、YYYY）。
- cert_course は OW / AOW / RESCUE / JOW / DM / OTHER / NONE のどれか。C カードを持っていない・初めてと分かる人は NONE。分からなければ null。
- 電話番号は書いてあるとおり（ハイフンはあってもなくてもよい）。
- 少しでも自信がない項目は、その項目名を unsure に入れる。
- 健康や病気についての情報が見えても書き写さない。見えたかどうかだけを health_info_visible に書く。
- お店のスタッフや、引用された過去のメールの差出人は参加者に含めない。

形式:
{"participants": [{"name": "", "birth_date": "", "phone": "", "address": "", "emergency_name": "", "emergency_relation": "", "emergency_phone": "", "cert_course": "", "cert_date": "", "dive_count": 0, "last_dive": "", "height_cm": 0, "weight_kg": 0, "foot_cm": 0, "unsure": []}], "health_info_visible": false}`;

/* 予約メールだけ、予約そのものも読む。試験では聞いていなかった部分なので、置いたあとの確かめで見る */
const MAIL_PART = (today) => `

この書類は予約のメールです。参加者のほかに、予約そのものも "booking" に書いてください。
- site: 予約を受けたサイトやフォームの名前。ref: 予約番号。date: 潜る日（YYYY-MM-DD）。start: 集合か開始の時刻（HH:MM、24 時間）。tour: ツアーの名前。people: 人数。lead_name・lead_phone: 代表者の名前と電話。
- 今日は ${today}。年が書かれていない日付は、今日か今日より後の一番近い日にする。
- 分からない所は null にし、少しでも自信がない項目は booking の unsure に入れる。
- 「${R.healthRedact.REDACTED_LINE}」「${R.healthRedact.REDACTED_PART}」は、お店が送らなかった所。中身を推測しない。

booking の形式:
{"booking": {"site": "", "ref": "", "date": "", "start": "", "tour": "", "people": 0, "lead_name": "", "lead_phone": "", "unsure": []}}`;

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
    return { ok: true, ask: { doc: 'mail', prompt: PROMPT + MAIL_PART(today), text, size: text.length, redacted } };
  }
  const mediaType = imageType(body.image);
  if (!mediaType) return { ok: false, error: 'image-type' };
  return { ok: true, ask: { doc: body.doc, prompt: PROMPT, image: body.image, mediaType, size: body.image.length, redacted: 0 } };
}

/* AI の答えの文から JSON を取り出し、答えの形に直して検査する。予約は予約メールのときだけ受け取る */
export function readingFrom(text, doc) {
  const m = typeof text === 'string' ? text.match(/\{[\s\S]*\}/) : null;
  if (!m) return { ok: false, error: 'no-json' };
  let raw;
  try { raw = JSON.parse(m[0]); } catch (e) { return { ok: false, error: 'json' }; }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'shape' };
  const reading = R.roster.fromModel(doc === 'mail' ? raw : { ...raw, booking: undefined });
  const v = R.roster.validateReading(reading);
  return v.ok ? { ok: true, reading } : { ok: false, error: v.errors.join(',') };
}

/* 使った額（100 万分の 1 ドル単位の整数）。usage が無ければ最大の見込みで数える */
export function costMicro(usage) {
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  const inTok = n(usage && usage.input_tokens);
  const outTok = n(usage && usage.output_tokens);
  if (inTok === null || outTok === null) return WORST_MICRO;
  return Math.ceil(inTok * PRICE_IN + outTok * PRICE_OUT);
}
