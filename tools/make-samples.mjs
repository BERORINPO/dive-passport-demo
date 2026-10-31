// AI の読み取り試験 (2026-10-21) の Haiku の答えから、見本の読み取り js/data-samples.js を作る。
// 人の項目は試験の答えそのもの。予約の項目 (予約サイト・日時・人数など) は試験で聞いていなかったので、メールの本文から手で書いた。
// 実行: node tools/make-samples.mjs <ai-ocr-test フォルダ>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/make-samples.mjs <ai-ocr-test folder>');
  process.exit(2);
}
vm.runInThisContext(readFileSync(new URL('../js/roster-schema.js', import.meta.url), 'utf8'));
const { roster } = globalThis.REDUX;

const BOOKINGS = {
  e1: { site: '予約サイト（見本）', ref: 'YS-20261020-0042', date: '2026-10-24', start: '08:30', tour: '体験ダイビング（ボート2本）',
    people: 2, lead_name: '見本 花子', lead_phone: '090-0000-1701', lead_email: 'hanako@mail.example', unsure: [] },
  e2: { site: 'Booking Platform (sample)', ref: 'TB-88231', date: '2026-10-24', start: '', tour: 'Fun Dive, 2 tanks',
    people: 2, lead_name: 'Seo-yeon Kim', lead_phone: '+82 10-0000-1702', unsure: ['start'] },
  e3: { site: 'お問い合わせフォーム', ref: '', date: '2026-10-24', start: '', tour: 'ファンダイビング',
    people: 1, lead_name: '見本 健太', lead_phone: '090-0000-1801', unsure: ['date', 'start'] },
  e4: { site: 'メール', ref: '', date: '2026-10-24', start: '', tour: '体験ダイビング',
    people: 3, lead_name: '見本 大輔', lead_phone: '090-0101-2323', lead_email: 'daisuke@mail.example', unsure: ['date', 'start'] }
};

const truth = JSON.parse(readFileSync(join(dir, 'samples', 'truth.json'), 'utf8'));
const out = {};
for (const doc of truth) {
  const res = JSON.parse(readFileSync(join(dir, 'results', 'haiku', `${doc.id}.json`), 'utf8'));
  const m = typeof res.text === 'string' ? res.text.match(/\{[\s\S]*\}/) : null;
  if (!m) throw new Error(`${doc.id}: 試験の答えに JSON が無い`);
  const raw = JSON.parse(m[0]);
  const reading = roster.fromModel({ ...raw, booking: BOOKINGS[doc.id] || null });
  const v = roster.validateReading(reading);
  if (!v.ok) throw new Error(`${doc.id}: ${v.errors.join(',')}`);
  out[doc.id] = reading;
}

/* 画面の「見本のメールを入れる」ボタン用に、見本メールの文面も載せる（画面は fetch で読めないため） */
const mails = Object.fromEntries(truth.filter(d => d.id.startsWith('e')).map(d => [d.id, {
  note: d.note,
  text: readFileSync(new URL(`../assets/samples/${d.id}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trimEnd()
}]));

const body = `/* 見本の読み取り（tools/make-samples.mjs が作る。手で直さない）。
   AI の読み取り試験 (2026-10-21) の Haiku の答え。予約の項目はメールの本文から手で書いた。中身はすべて架空。
   SAMPLE_MAILS は見本の予約メールの文面（assets/samples/e*.txt と同じ） */
(() => {
  'use strict';
  const R = (globalThis.REDUX = globalThis.REDUX || {});
  R.SAMPLE_READINGS = ${JSON.stringify(out, null, 1)};
  R.SAMPLE_MAILS = ${JSON.stringify(mails, null, 1)};
})();
`;
writeFileSync(new URL('../js/data-samples.js', import.meta.url), body);
console.log(`wrote ${Object.keys(out).length} sample readings`);
