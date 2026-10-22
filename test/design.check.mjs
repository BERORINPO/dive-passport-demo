// 見た目の数値の決まり（design.md の「数値の決まり」）を css/app.css から機械で確かめる。
// 1. 字と背景の組のコントラスト比（WCAG 2.2 の式）。字は屋内で 7:1（店員画面は屋外で使う）、部品の枠は 3:1、
//    押せない物の字は 4.5:1、お客さん画面の暗い設定は 4.5:1。読めない色の書き方は合格にしない
// 2. 暗い画面設定は店員画面に効かない（:root:not([data-layer="staff"]) の変数だけで書く）
// 3. 画面の字は 14px 以上、px で書く（条例の名簿・札ボードの紙と印刷は除く）
// 4. 色は :root の変数だけで決める（変数の外に色を直書きしない）
// 5. この検査自身が、わざと違反を入れた見本で落ちる
// 実行: node test/design.check.mjs（--report で全部の組の比を出す）
import { readFileSync } from 'node:fs';

/* 注釈は、行の数を変えずに空白へ（複数行の注釈の中の色の例を、直書きと数えない） */
export const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));

/* ---------- 小さな CSS の読み取り。規則ごとに、選択子・外側の @media・宣言（行の番号つき）を返す ----------
   複数行の選択子、1 行の @media { .x {…} }、宣言の最後の ; の省略を読む。文字列の中の { ; } は app.css に無い前提 */
export function parseCss(text) {
  const rules = [];
  const stack = [];
  let buf = '';
  let bufLine = 1;
  let line = 1;
  for (const ch of stripComments(text.replace(/\r\n?/g, '\n'))) {
    if (ch === '{') {
      const rule = { prelude: buf.trim().replace(/\s+/g, ' '), ancestors: stack.map(r => r.prelude), decls: [] };
      rules.push(rule);
      stack.push(rule);
      buf = '';
    } else if (ch === ';' || ch === '}') {
      const d = buf.trim();
      const at = d.indexOf(':');
      if (d && at > 0 && stack.length) stack[stack.length - 1].decls.push({ prop: d.slice(0, at).trim().toLowerCase(), value: d.slice(at + 1).trim(), line: bufLine });
      if (ch === '}') stack.pop();
      buf = '';
    } else {
      if (!buf.trim() && ch.trim()) bufLine = line;
      buf += ch;
    }
    if (ch === '\n') line += 1;
  }
  return rules;
}

/* ---------- OKLCH → WCAG の相対輝度。読めない書き方は null（合格にしない） ---------- */
export function luminance(oklch) {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)(%?)\s+([\d.]+)(?:deg)?\s*(?:\/\s*[\d.]+%?\s*)?\)$/.exec(String(oklch).trim());
  if (!m) return null;
  const L = m[2] ? Number(m[1]) / 100 : Number(m[1]);
  const C = m[4] ? (Number(m[3]) / 100) * 0.4 : Number(m[3]);   // C の 100% は 0.4（CSS Color 4）
  const h = (Number(m[5]) * Math.PI) / 180;
  if (![L, C, h].every(Number.isFinite) || L > 1) return null;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const R = clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s);
  const G = clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s);
  const B = clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;   // 線形の sRGB から（WCAG の相対輝度）
}
export const ratio = (y1, y2) => (Math.max(y1, y2) + 0.05) / (Math.min(y1, y2) + 0.05);

/* ---------- 変数（明るい画面と、お客さん画面の暗い設定） ---------- */
const LIGHT_ROOT = ':root';
const DARK_ROOT = ':root:not([data-layer="staff"])';
const isDarkMedia = (a) => /^@media\b.*prefers-color-scheme\s*:\s*dark/.test(a);
export function tokenSets(text) {
  const rules = parseCss(text);
  const pick = (want) => Object.fromEntries(rules.filter(want).flatMap(r => r.decls).filter(d => d.prop.startsWith('--')).map(d => [d.prop.slice(2), d.value]));
  const light = pick(r => r.prelude === LIGHT_ROOT && r.ancestors.length === 0);
  const darkOnly = pick(r => r.prelude === DARK_ROOT && r.ancestors.some(isDarkMedia));
  /* 暗い設定の中に、お客さん画面の変数の塊以外を書かない（:root{ や html { で店員画面まで暗くしない） */
  const misuse = rules.filter(r => r.ancestors.some(isDarkMedia) && r.prelude !== DARK_ROOT).map(r => r.prelude);
  return { light, dark: { ...light, ...darkOnly }, hasDark: Object.keys(darkOnly).length > 0, misuse };
}

/* 組と下限。店員画面（明るい・固定）は浜と船で使うので、字は屋内で 7:1（AAA の値。日差しで 2〜3:1 に縮むため）。
   部品の枠は 3:1（1.4.11）。押せない物は WCAG の対象外だが、日差しで消さないよう 4.5:1。お客さん画面の暗い設定は屋内なので 4.5:1（1.4.3） */
const TEXT_7 = [['ink', 'bg'], ['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent-ink', 'accent'], ['you-ink', 'you-bg'],
  ['warn', 'bg'], ['warn', 'surface'], ['warn', 'warn-bg'], ['ok', 'bg'], ['ok', 'surface'], ['ok', 'ok-bg'],
  ['info', 'bg'], ['info', 'surface'], ['info', 'info-bg'], ['accent', 'surface'], ['accent', 'bg'], ['accent', 'accent-soft'],
  ['muted', 'accent-soft'], ['ink', 'accent-soft'], ['ink', 'turtle-bg'], ['ink', 'warn-bg'], ['ink', 'ok-bg'], ['ink', 'info-bg']];
const LINE_3 = [['control', 'surface'], ['control', 'bg']];
/* 紙（画面にも出す）の薄い字。印刷の紙なので 4.5:1 */
const PAPER_45 = [['paper-ink', 'paper-bg'], ['paper-faint', 'paper-bg'], ['paper-ink', 'paper-head']];
const DISABLED_45 = [['disabled-ink', 'disabled-bg'], ['disabled-ink', 'bg'], ['disabled-ink', 'surface']];
const DARK_45 = [['ink', 'bg'], ['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['accent-ink', 'accent'], ['you-ink', 'you-bg'],
  ['warn', 'bg'], ['ok', 'bg'], ['info', 'bg'], ['warn', 'warn-bg'], ['ok', 'ok-bg'], ['info', 'info-bg'], ['accent', 'surface'],
  ['ink', 'turtle-bg'], ['ink', 'warn-bg'], ['disabled-ink', 'disabled-bg']];
const DARK_LINE_3 = [['control', 'surface'], ['control', 'bg']];

export function contrastProblems(set, pairs, min, label, report = []) {
  const out = [];
  for (const [fg, bg] of pairs) {
    if (!set[fg] || !set[bg]) { out.push(`${label}: 変数が無い --${!set[fg] ? fg : bg}`); continue; }
    const y1 = luminance(set[fg]);
    const y2 = luminance(set[bg]);
    if (y1 === null || y2 === null) { out.push(`${label}: 色を読めない --${y1 === null ? fg : bg}: ${y1 === null ? set[fg] : set[bg]}（oklch(L% C H) で書く）`); continue; }
    const r = ratio(y1, y2);
    report.push(`${label} --${fg} / --${bg}: ${r.toFixed(2)}`);
    if (r < min) out.push(`${label}: --${fg} / --${bg} が ${r.toFixed(2)}:1（${min}:1 に足りない）`);
  }
  return out;
}

/* ---------- 字の大きさ ---------- */
/* 紙（条例の名簿・合同名簿・札ボード・切り取る札）は印刷の字の大きさなので除く。
   除くのは、選択子の並びの全部が紙で始まり、押す部品（ボタン・入力）を指していないときだけ */
const PAPER_START = /^\.(paper|board|tagcard|tagsheet)(?![a-zA-Z0-9])/;
const INTERACTIVE = /\b(button|input|select|textarea)\b|\.(btn|linkbtn|input)(?![a-zA-Z0-9-])/;
const MIN_PX = 14;
const isPaper = (prelude) => prelude.split(',').map(s => s.trim()).every(p => PAPER_START.test(p) && !INTERACTIVE.test(p));
const isPrint = (ancestors) => ancestors.some(a => /^@media\b.*\bprint\b/.test(a));
const KEYWORD = /^(inherit|initial|unset|revert|var\()/;
function sizeOf(prop, value) {
  if (KEYWORD.test(value)) return null;
  if (prop === 'font-size') {
    const m = /^(\d*\.?\d+)([a-z%]*)$/.exec(value);
    return m ? { n: Number(m[1]), unit: m[2] } : { n: NaN, unit: value };
  }
  const m = /(?:^|\s)(\d*\.?\d+)(px|rem|em|pt|%|vw|vh|ch|ex)(?=\/|\s|$)/.exec(value);   // font: の省略形の大きさ（太さの 700 などは単位が無い）
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}
export function sizeProblems(text) {
  const out = [];
  for (const r of parseCss(text)) {
    if (r.prelude.startsWith('@') || isPrint(r.ancestors) || isPaper(r.prelude)) continue;
    for (const d of r.decls) {
      if (d.prop !== 'font-size' && d.prop !== 'font') continue;
      const size = sizeOf(d.prop, d.value);
      if (!size) continue;
      if (size.unit !== 'px') out.push(`${d.line}行 ${r.prelude.slice(0, 50)}: ${d.value}（px で書く）`);
      else if (size.n < MIN_PX) out.push(`${d.line}行 ${r.prelude.slice(0, 50)}: ${size.n}px`);
    }
  }
  return out;
}

/* ---------- 色の直書き ---------- */
const TOKEN_RULES = new Set([LIGHT_ROOT, DARK_ROOT]);
const RAW_COLOR = /\b(?:oklch|oklab|lab|lch|hwb|rgba?|hsla?|color)\(|#[0-9a-fA-F]{3,8}\b|\b(?:white|black|red|green|blue|yellow|gr[ae]y|orange|purple|pink|brown|silver|navy|teal|aqua|cyan|magenta|fuchsia|lime|maroon|olive)\b/i;
export function rawColorProblems(text) {
  const out = [];
  for (const r of parseCss(text)) {
    if (TOKEN_RULES.has(r.prelude) || r.prelude.startsWith('@')) continue;
    for (const d of r.decls) if (RAW_COLOR.test(d.value)) out.push(`${d.line}行 ${r.prelude.slice(0, 40)} { ${d.prop}: ${d.value.slice(0, 40)} }`);
  }
  return out;
}

/* ---------- app.css を確かめる ---------- */
const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const problems = [];
const report = [];
const { light, dark, hasDark, misuse } = tokenSets(css);
if (Object.keys(light).length < 10) problems.push(`:root の変数を拾えていない (${Object.keys(light).length} 個)`);
if (!hasDark) problems.push(`暗い画面設定が見つからない。店員画面まで暗くしないよう @media (prefers-color-scheme: dark) { ${DARK_ROOT} { … } } で書く`);
misuse.forEach(p => problems.push(`暗い画面設定の中に「${p}」がある（${DARK_ROOT} の変数だけにする）`));
problems.push(...contrastProblems(light, TEXT_7, 7, '明るい・字', report));
problems.push(...contrastProblems(light, LINE_3, 3, '明るい・枠', report));
problems.push(...contrastProblems(light, PAPER_45, 4.5, '紙・字', report));
problems.push(...contrastProblems(light, DISABLED_45, 4.5, '明るい・押せない', report));
problems.push(...contrastProblems(dark, DARK_45, 4.5, '暗い・字', report));
problems.push(...contrastProblems(dark, DARK_LINE_3, 3, '暗い・枠', report));
sizeProblems(css).forEach(p => problems.push(`字の大きさ: ${p}`));
rawColorProblems(css).forEach(p => problems.push(`変数の外に色を直書き: ${p}`));

/* ---------- わざと違反を入れた見本（検査そのものが甘くなっていないか） ---------- */
const probe = (name, cond) => { if (!cond) problems.push(`検査が甘い: ${name}`); };
const sizes = (t) => sizeProblems(t).length;
const raws = (t) => rawColorProblems(t).length;
probe('12px の字', sizes('.x { font-size: 12px; }') === 1);
probe('font の省略形の 13px', sizes('.x { font: 700 13px/1 var(--f); }') === 1);
probe('font: bold 12px', sizes('.x { font: bold 12px }') === 1);
probe('rem で書いた字', sizes('.x { font-size: 0.75rem; }') === 1);
probe('紙の 11px は通す', sizes('.paper__table { font-size: 11px; }\n.board__zone p { font-size: 12px; }') === 0);
probe('紙と普通の要素を並べた選択子は落とす', sizes('.note, .paper__meta { font-size: 12px; }') === 1);
probe('紙の中のボタンは落とす', sizes('.paper .btn { font-size: 12px; }') === 1);
probe('紙に似た名前の 12px は落とす', sizes('.papers { font-size: 12px; }') === 1);
probe('複数行の選択子の並び', sizes('.a,\n.b {\n  font-size: 12px;\n}') === 1);
probe('1 行の @media の中', sizes('@media (min-width: 1px) { .x { font-size: 12px; } }') === 1);
probe('印刷の中の 12px は通す', sizes('@media print {\n  .x { font-size: 12px; }\n}') === 0);
probe('印刷の後ろの 12px は落とす', sizes('@media print {\n  .x { font-size: 12px; }\n}\n.y { font-size: 12px; }') === 1);
probe('注釈の中の 12px は通す', sizes('/* 前は\n font-size: 12px だった */\n.x { font-size: 16px; }') === 0);
probe('行の番号', /^3行/.test(sizeProblems('.a {}\n\n.b { font-size: 12px; }')[0] || ''));
probe('色の直書き', raws(':root {\n  --a: oklch(50% 0 0);\n}\n.x { color: oklch(40% 0 0); }') === 1);
probe('変数の中の色は通す', raws(':root {\n  --a: oklch(50% 0 0);\n}\n.x { color: var(--a); }') === 0);
probe('暗い設定の変数の中の色は通す', raws(`@media (prefers-color-scheme: dark) {\n  ${DARK_ROOT} {\n    --a: oklch(50% 0 0);\n  }\n}`) === 0);
probe('暗い設定の後ろの直書きは落とす', raws('@media (prefers-color-scheme: dark) {\n  :root:not([data-layer="staff"]) { --a: oklch(50% 0 0); }\n  .y { color: #fff; }\n}') === 1);
probe(':root で始まる別の規則の直書きは落とす', raws(':root[data-layer="staff"] .dock { background: #fff; }') === 1);
probe('色の名前・lab() は落とす', raws('.x { color: white; }\n.y { color: lab(50% 0 0); }') === 2);
probe('white-space は色でない', raws('.x { white-space: nowrap; background: color-mix(in oklch, var(--a) 50%, var(--b)); }') === 0);
probe('注釈の中の色は通す', raws('/* 例\n oklch(50% 0 0) */\n.x { color: var(--a); }') === 0);
probe('#id の選択子は通す', raws('#face { color: var(--a); }') === 0);
probe('暗い設定で :root 全体を暗くすると落とす', tokenSets('@media (prefers-color-scheme: dark) {\n  :root{ --bg: oklch(20% 0 0); }\n}').misuse.length === 1);
probe('暗い設定の中の html も落とす', tokenSets(`@media (prefers-color-scheme: dark) { html { color-scheme: dark; } }`).misuse.length === 1);
probe('% なしの L を読む', Math.abs(luminance('oklch(0.8 0 0)') - luminance('oklch(80% 0 0)')) < 1e-9);
probe('deg 付きの H を読む', Math.abs(luminance('oklch(50% 0.1 185deg)') - luminance('oklch(50% 0.1 185)')) < 1e-9);
probe('読めない色は合格にしない', contrastProblems({ a: 'oklch(80 0.01 85)', b: 'oklch(99% 0 0)' }, [['a', 'b']], 7, 'x').length === 1);
probe('白と黒は 21:1', Math.abs(ratio(luminance('oklch(100% 0 0)'), luminance('oklch(0% 0 0)')) - 21) < 0.1);
probe('灰 L 60% は白に対して 4.5 前後', (() => { const r = ratio(luminance('oklch(60% 0 0)'), luminance('oklch(100% 0 0)')); return r > 3.5 && r < 5.5; })());

if (process.argv.includes('--report')) console.log(report.join('\n'));
if (problems.length) {
  console.log(problems.map(p => `FAIL ${p}`).join('\n'));
  console.log(`${problems.length} 件`);
  process.exit(1);
}
console.log(`ok   design（コントラスト ${report.length} 組・暗い設定は店員画面に効かない・字の大きさ・色の直書き）`);
