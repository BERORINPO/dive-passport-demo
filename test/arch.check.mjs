// 役割の決まり（spec/architecture.md の表 1）を検査する。
// 1. 表のパスが全部あり、空でない。js/ の下のファイルは全部どこかの役割に入っている
// 2. shared と core は、画面・保存・通信・時計・乱数を使わない
// 3. 外へ通信する fetch は js/ai-reader.js だけ
// 4. shared は core と adapter を使わず、core は adapter を使わない（adapter の名前は adapter のファイルから拾う）
// 5. AI の読み取りには見本（Fake）がある
// 6. entry と adapter は HTML の文字列を直接入れない（innerHTML など）
// 7. この検査自身が、わざと違反を入れた見本で落ちる（何も検査していないのに通る、を防ぐ）
// 決まりを外すときは、その行に「// arch-allow: 理由」を書く。外した数を毎回出す。
// 実行: node test/arch.check.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const doc = read('spec/architecture.md');
const section = doc.slice(doc.indexOf('## 1.'), doc.indexOf('## 2.'));
const roles = Object.fromEntries(section.split('\n').filter(l => /^\| (shared|core|adapter|entry) \|/.test(l)).map(l => {
  const [, role, paths] = l.split('|').map(s => s.trim());
  return [role, paths.split(/\s+/).filter(Boolean)];
}));

const problems = [];
let allowed = 0;
const fail = (msg) => problems.push(msg);

['shared', 'core', 'adapter', 'entry'].forEach(r => { if (!roles[r] || !roles[r].length) fail(`表 1 に ${r} の行が無い`); });
Object.values(roles).flat().forEach(p => {
  if (!existsSync(new URL(p, root))) fail(`表のパスが無い: ${p}`);
  else if (!read(p).trim()) fail(`表のパスが空: ${p}`);
});
const jsFiles = readdirSync(new URL('js/', root)).filter(f => f.endsWith('.js')).map(f => `js/${f}`);
const listed = new Set(Object.values(roles).flat());
jsFiles.filter(f => !listed.has(f)).forEach(f => fail(`表 1 に無い js: ${f}`));

/* R に足す名前: 「R.x =」と、core.js の「window.REDUX = { … }」の 1 段目の名前 */
function namesOf(role) {
  const names = new Set();
  (roles[role] || []).filter(p => p.endsWith('.js') && existsSync(new URL(p, root))).forEach(p => {
    const src = read(p);
    for (const m of src.matchAll(/\bR\.(\w+)\s*=/g)) names.add(m[1]);
    const block = src.match(/window\.REDUX\s*=\s*\{([\s\S]*?)\n {2}\};/);
    if (block) for (const m of block[1].matchAll(/^ {4}(\w+)\s*(?::|,|\(|$)/gm)) names.add(m[1]);
  });
  return [...names];
}
const ADAPTER = namesOf('adapter');
const CORE = namesOf('core');
if (ADAPTER.length < 5) fail(`adapter の名前を拾えていない (${ADAPTER.length} 個)`);
if (CORE.length < 2) fail(`core の名前を拾えていない (${CORE.length} 個)`);

const PURE_BAN = [
  [/\bdocument\b/, '画面 (document)'], [/\bwindow\b/, 'window'], [/localStorage|sessionStorage|indexedDB/, '保存'],
  [/\bfetch\b|XMLHttpRequest|WebSocket|EventSource/, '通信'], [/\bnavigator\b/, 'navigator'],
  [/\bDate\b|performance\.now|Intl\.DateTimeFormat|\bTemporal\b/, '時計'], [/Math\.random|\bcrypto\b/, '乱数'], [/\bprocess\b/, '環境変数'],
  [/\bglobalThis\s*\??\.?\s*\[/, 'globalThis[…] (文字の名前で外のものを引く)'],
  [/\beval\b|\bFunction\s*\(|\bReflect\s*\.|\bself\b/, 'eval / Function / Reflect / self (文字の名前で外のものを引く)'],
  [/['"`](?:Date|fetch|localStorage|sessionStorage|indexedDB|document|window|navigator|performance|crypto|process|XMLHttpRequest|WebSocket|EventSource|Temporal)['"`]/,
    '外のものの名前を文字で書いている', true]
];
const DOT = '\\s*\\??\\.\\s*';                                         // R.x / R?.x / R .x
const HUB = `(?:R|globalThis${DOT}REDUX|window${DOT}REDUX)`;
const usesNames = (names, what) => [
  [new RegExp(`\\b${HUB}${DOT}(${names.join('|')})\\b`), what],
  [new RegExp(`\\b${HUB}\\s*(?:\\?\\.)?\\s*\\[\\s*['"\`](${names.join('|')})['"\`]\\s*\\]`), what, true]
];
/* 分割代入（const { aiReader } = R）は複数行にまたがり、入れ子（{ aiReader: { read } }）もありうるので、ファイル全体で全件見る */
const BRACE = '(?:[^{}]|\\{[^{}]*\\})*';
const destructures = (names, what) => [new RegExp(`\\{${BRACE}\\b(${names.join('|')})\\b${BRACE}\\}\\s*=\\s*${HUB}\\b`, 'g'), what, true];
const rulesFor = {
  shared: { line: [...PURE_BAN, ...usesNames(ADAPTER, 'adapter'), ...usesNames(CORE, 'core')],
    file: [destructures(ADAPTER, 'adapter'), destructures(CORE, 'core')] },
  core: { line: [...PURE_BAN, ...usesNames(ADAPTER, 'adapter')], file: [destructures(ADAPTER, 'adapter')] }
};
const HTML_BAN = { line: [[/\.(innerHTML|outerHTML)\s*\+?=|insertAdjacentHTML|document\.write/, 'HTML の文字列を直接入れている'],
  [/\[\s*['"`](?:innerHTML|outerHTML|insertAdjacentHTML)['"`]\s*\]/, 'HTML の文字列を直接入れている', true]], file: [] };
const FETCH_BAN = { line: [[/\bfetch\s*\(/, '外への通信 (ai-reader.js 以外)']], file: [] };

/* コメントを消す。文字列・テンプレート文字列（複数行も）・正規表現の中の // と /* は残す。\ の次の 1 字は読み飛ばす。
   blankStrings のときは文字列の中身も空白にする（見本メールの「Date of birth」を時計と見なさないため）。
   テンプレート文字列の ${ … } の中はコードとして読む。
   / が正規表現の始まりかは、直前の文字で決める（( , = : [ ! & | ? { } ; + - * % < > ~ ^ の後か、行の頭か、return などの後） */
const REGEX_AFTER = /(^|[(,=:[!&|?{};+\-*%<>~^]|\b(return|typeof|case|in|of))\s*$/;
function stripComments(src, blankStrings) {
  let inBlock = false;
  let quote = null;
  const depth = [];   // ${ … } の中の { の深さ。0 の } でテンプレート文字列に戻る
  return src.split('\n').map(line => {
    let out = '';
    if (quote === "'" || quote === '"') quote = null;   // 普通の文字列は行をまたがない
    let regex = false;
    let klass = false;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i];
      const n = line[i + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 1; out += '  '; } else out += ' '; continue; }
      if (c === '\\') { out += quote && blankStrings ? '  ' : c + (n || ''); i += 1; continue; }
      if (quote) {
        if (quote === '`' && c === '$' && n === '{') { depth.push(0); quote = null; out += '${'; i += 1; continue; }
        if (c === quote) { quote = null; out += c; } else out += blankStrings ? ' ' : c;
        continue;
      }
      if (depth.length && c === '{') depth[depth.length - 1] += 1;
      if (depth.length && c === '}') {
        if (depth[depth.length - 1] === 0) { depth.pop(); quote = '`'; out += c; continue; }
        depth[depth.length - 1] -= 1;
      }
      if (regex) {
        out += c;
        if (c === '[') klass = true;
        else if (c === ']') klass = false;
        else if (c === '/' && !klass) regex = false;
        continue;
      }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; i += 1; out += '  '; continue; }
      if (c === '/' && REGEX_AFTER.test(out)) { regex = true; out += c; continue; }
      if (c === "'" || c === '"' || c === '`') quote = c;
      out += c;
    }
    return out;
  });
}

/* 規則の 3 つ目が true なら、文字列の中身を残した方で見る（R['aiReader'] のため）。ほかは中身を空白にした方で見る */
function violations(src, rules) {
  const raw = src.split('\n');
  const code = stripComments(src, true);
  const keep = stripComments(src, false);
  const out = [];
  const hit = (line, what) => {
    if (/\/\/ arch-allow: \S/.test(raw[line] || '')) { allowed += 1; return; }
    out.push({ line: line + 1, what });
  };
  rules.line.forEach(([re, what, keepStrings]) => {
    (keepStrings ? keep : code).forEach((c, i) => { if (re.test(c)) hit(i, what); });
  });
  rules.file.forEach(([re, what, keepStrings]) => {
    const joined = (keepStrings ? keep : code).join('\n');
    for (const m of joined.matchAll(re)) hit(joined.slice(0, m.index).split('\n').length - 1, what);
  });
  return out;
}

['shared', 'core'].forEach(role => (roles[role] || []).forEach(p => {
  violations(read(p), rulesFor[role]).forEach(v => fail(`${p}:${v.line} ${v.what} を使っている`));
}));
jsFiles.filter(f => f !== 'js/ai-reader.js').forEach(p => {
  violations(read(p), FETCH_BAN).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});
[...(roles.entry || []), ...(roles.adapter || [])].filter(p => p.endsWith('.js')).forEach(p => {
  violations(read(p), HTML_BAN).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});
if (!/function readSample\(/.test(read('js/ai-reader.js'))) fail('js/ai-reader.js に見本 (readSample) が無い');

/* 7. わざと違反を入れた見本。どれか 1 つでも見逃したら、この検査が甘い */
const PROBES = [
  [rulesFor.core, 'const x = Date.now();'], [rulesFor.core, 'const d = new Date;'], [rulesFor.core, 'const d = Date();'],
  [rulesFor.core, 'const t = performance.now();'], [rulesFor.core, 'const f = new Intl.DateTimeFormat().format();'],
  [rulesFor.core, 'const id = crypto.randomUUID();'], [rulesFor.core, 'const r = Math.random();'],
  [rulesFor.core, 'const id = R.newId();'], [rulesFor.core, 'const d = R.today();'],
  [rulesFor.core, 'const { aiReader } = R;'], [rulesFor.core, 'const {\n  aiReader\n} = R;'],
  [rulesFor.core, 'const r = globalThis.REDUX.aiReader;'], [rulesFor.core, "const r = R['aiReader'];"],
  [rulesFor.core, "const u = 'https://x'; fetch(u);"], [rulesFor.core, "const s = 'x //'; const t = Date.now();"],
  [rulesFor.core, 'document.title = 1;'], [rulesFor.core, 'const k = process.env.KEY;'],
  [rulesFor.core, 'const r = R?.aiReader;'], [rulesFor.core, 'const r = R .aiReader;'], [rulesFor.core, "const r = R?.['aiReader'];"],
  [rulesFor.core, 'const { aiReader: { read } } = R;'], [rulesFor.core, 'const { aiReader = {} } = R;'],
  [rulesFor.core, 'const { aiReader } = R; // arch-allow: probe\nconst { aiReader: a2 } = R;'],
  [rulesFor.core, 'const n = Temporal.Now.instant();'], [rulesFor.core, 'const re = /[/*]/; const t = Date.now();'],
  [rulesFor.core, 'const s = `x\nhttp://y`; const t = Date.now();'], [rulesFor.core, 'const q = a.replace(/\\//g, "_"); const t = Date.now();'],
  [rulesFor.shared, 'const h = R.rosterCore.status(p);'], [rulesFor.shared, 'const r = R.healthRedact.redact(t);'],
  [HTML_BAN, 'box.innerHTML = name;'], [HTML_BAN, 'el.insertAdjacentHTML("beforeend", x);'], [HTML_BAN, 'document.write(x);'], [HTML_BAN, "box['innerHTML'] = x;"]
];
PROBES.push([rulesFor.core, 'const s = `${Date.now()}`;'], [rulesFor.core, "const f = globalThis['fetch'];"],
  [rulesFor.core, "const f = self['fetch'];"], [rulesFor.core, "const t = Function('return 1')();"], [rulesFor.core, "eval('x');"],
  [rulesFor.core, "const d = Reflect.get(globalThis, 'x');"], [rulesFor.core, "const g = globalThis; const d = g['Date'];"],
  [rulesFor.core, "const { ['aiReader']: a } = R;"],
  [rulesFor.core, 'const s = `a\n${R.today()}\nb`;']);
/* 文字列の中に言葉があるだけなら通る（見本のメールの文面など） */
const CLEAN = ['const s = "Date of birth";', "const u = 'window.document and fetch(x)';", 'const t = `Date: ${n}`;'];
const before = allowed;
PROBES.forEach(([rules, code]) => { if (!violations(code, rules).length) fail(`検査が甘い: 「${code.replace(/\n/g, ' ')}」を見逃した`); });
CLEAN.forEach(code => { if (violations(code, rulesFor.core).length) fail(`検査が厳しすぎる: 「${code}」を違反と見た`); });
allowed = before;

console.log(`files: shared ${roles.shared?.length || 0} / core ${roles.core?.length || 0} / adapter ${roles.adapter?.length || 0} / entry ${roles.entry?.length || 0}`);
console.log(`names: adapter ${ADAPTER.length} / core ${CORE.length} / probes: ${PROBES.length} / arch-allow: ${allowed}`);
if (problems.length) {
  problems.forEach(p => console.log(`FAIL ${p}`));
  process.exit(1);
}
console.log('ok   architecture');
