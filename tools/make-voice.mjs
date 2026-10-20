// リドが話す決まった文を、ElevenLabs で先に mp3 にする（公開ページに鍵を置かないため）。
// 何もつけずに実行すると、作る文の一覧と文字数を出すだけ（ElevenLabs には何も送らない）。
//
//   node tools/make-voice.mjs            … 一覧と文字数だけ
//   node tools/make-voice.mjs --go       … まだ無い mp3 を作る
//   node tools/make-voice.mjs --go --force … 全部作り直す
//   node tools/make-voice.mjs --go --only=greet.ja … 1 本だけ作る（試すとき）
//
// 使う環境変数（鍵は画面にもファイルにも出さない）:
//   ELEVENLABS_API_KEY_REDUX  REDUX 用の鍵（VirtualGirl の鍵は使わない）
//   REDUX_VOICE_JA / REDUX_VOICE_EN  声の ID（日本語と英語で同じ声でもよい）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

const ROOT = new URL('../', import.meta.url);
const OUT = new URL('audio/', ROOT);
const MODEL = 'eleven_multilingual_v2';
const API = 'https://api.elevenlabs.io/v1/text-to-speech';

globalThis.window = globalThis;
for (const f of ['js/core.js', 'js/data.js']) vm.runInThisContext(readFileSync(new URL(f, ROOT), 'utf8'));
const R = globalThis.REDUX;

/* 声に出すと変になる書き方だけ直す（画面の文はそのまま） */
const forVoice = (text) => text.replace(/〇〇港/g, '港').replace(/○○ Port/g, 'the port');

function lines() {
  const fixed = [['greet', R.T.greet], ['notFound', R.T.notFound], ['sent', R.T.sent], ['didYouMean', R.T.didYouMean]];
  const faq = R.FAQ.map(f => [`faq-${f.id}`, f.a]);
  return [...fixed, ...faq].flatMap(([key, t]) => ['ja', 'en'].map(lang => ({ key, lang, text: forVoice(t[lang]) })));
}

async function synth(line, apiKey, voiceId) {
  const res = await fetch(`${API}/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: line.text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } })
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`ElevenLabs ${res.status} for ${line.key}.${line.lang}: ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const go = process.argv.includes('--go');
  const force = process.argv.includes('--force');
  const all = lines();
  const file = (l) => new URL(`${l.key}.${l.lang}.mp3`, OUT);
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice('--only='.length);
  const todo = all.filter(l => (force || !existsSync(file(l))) && (!only || `${l.key}.${l.lang}` === only));
  const chars = (list) => list.reduce((n, l) => n + l.text.length, 0);

  all.forEach(l => console.log(`${existsSync(file(l)) ? 'have' : 'make'}  ${l.key}.${l.lang}  ${l.text.length} 字`));
  console.log(`全 ${all.length} 本・${chars(all)} 字 / これから作る ${todo.length} 本・${chars(todo)} 字`);
  if (!go) { console.log('（一覧だけ。作るときは --go）'); return; }

  const apiKey = process.env.ELEVENLABS_API_KEY_REDUX;
  const voices = { ja: process.env.REDUX_VOICE_JA, en: process.env.REDUX_VOICE_EN };
  if (!apiKey || !voices.ja || !voices.en) {
    console.error('ELEVENLABS_API_KEY_REDUX・REDUX_VOICE_JA・REDUX_VOICE_EN を設定してください');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  for (const l of todo) {
    writeFileSync(file(l), await synth(l, apiKey, voices[l.lang]));
    console.log(`made  ${l.key}.${l.lang}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
