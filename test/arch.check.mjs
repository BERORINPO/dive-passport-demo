// 役割の決まり（spec/architecture.md の表 1）を検査する。
// 1. 表のパスが全部あり、空でない。js/ の下のファイルは全部どこかの役割に入っている
// 2. shared と core は、画面・保存・通信・時計・乱数を使わない
// 3. 外へ通信する fetch は js/ai-reader.js だけ
// 4. shared は core と adapter を使わず、core は adapter を使わない（adapter の名前は adapter のファイルから拾う）
// 5. AI の読み取りには見本（Fake）がある
// 6. この検査自身が、わざと違反を入れた見本で落ちる（何も検査していないのに通る、を防ぐ）
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

/* adapter が R に足す名前: 「R.x =」と、core.js の「window.REDUX = { … }」の 1 段目の名前 */
function adapterNames() {
  const names = new Set();
  (roles.adapter || []).filter(p => existsSync(new URL(p, root))).forEach(p => {
    const src = read(p);
    for (const m of src.matchAll(/\bR\.(\w+)\s*=/g)) names.add(m[1]);
    const block = src.match(/window\.REDUX\s*=\s*\{([\s\S]*?)\n {2}\};/);
    if (block) for (const m of block[1].matchAll(/^ {4}(\w+)\s*(?::|,|\(|$)/gm)) names.add(m[1]);
  });
  return [...names];
}
const ADAPTER = adapterNames();
if (ADAPTER.length < 5) fail(`adapter の名前を拾えていない (${ADAPTER.length} 個)`);
const CORE = ['rosterCore', 'match'];

const PURE_BAN = [
  [/\bdocument\b/, '画面 (document)'], [/\bwindow\b/, 'window'], [/localStorage|sessionStorage|indexedDB/, '保存'],
  [/\bfetch\b|XMLHttpRequest|WebSocket|EventSource/, '通信'], [/\bnavigator\b/, 'navigator'],
  [/\bDate\b|performance\.now/, '時計'], [/Math\.random|\bcrypto\b/, '乱数'], [/\bprocess\b/, '環境変数']
];
const usesNames = (names) => [
  new RegExp(`\\bR\\.(${names.join('|')})\\b`),
  new RegExp(`\\{[^}]*\\b(${names.join('|')})\\b[^}]*\\}\\s*=\\s*(R|globalThis\\.REDUX|window\\.REDUX)\\b`)
];
const rulesFor = {
  shared: [...PURE_BAN, ...usesNames(ADAPTER).map(re => [re, 'adapter']), ...usesNames(CORE).map(re => [re, 'core'])],
  core: [...PURE_BAN, ...usesNames(ADAPTER).map(re => [re, 'adapter'])]
};

/* コメントを外してから見る。「'https://…'」の // はコメントではない */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
  .split('\n').map(l => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));

function violations(src, rules) {
  const raw = src.split('\n');
  const out = [];
  stripComments(src).forEach((code, i) => {
    rules.forEach(([re, what]) => {
      if (!re.test(code)) return;
      if (/\/\/ arch-allow: \S/.test(raw[i])) { allowed += 1; return; }
      out.push({ line: i + 1, what });
    });
  });
  return out;
}

['shared', 'core'].forEach(role => (roles[role] || []).forEach(p => {
  violations(read(p), rulesFor[role]).forEach(v => fail(`${p}:${v.line} ${v.what} を使っている`));
}));
jsFiles.filter(f => f !== 'js/ai-reader.js').forEach(p => {
  violations(read(p), [[/\bfetch\s*\(/, '外への通信 (ai-reader.js 以外)']]).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});
if (!/function readSample\(/.test(read('js/ai-reader.js'))) fail('js/ai-reader.js に見本 (readSample) が無い');

/* AI やお客さんの文字を HTML として入れると XSS になる。文字は textContent（el()）だけで出す。固定の SVG だけ arch-allow */
const HTML_BAN = [[/\.(innerHTML|outerHTML)\s*\+?=|insertAdjacentHTML|document\.write/, 'HTML の文字列を直接入れている']];
[...(roles.entry || []), ...(roles.adapter || [])].filter(p => p.endsWith('.js')).forEach(p => {
  violations(read(p), HTML_BAN).forEach(v => fail(`${p}:${v.line} ${v.what}`));
});

/* 6. わざと違反を入れた見本。どれか 1 つでも見逃したら、この検査が甘い */
const PROBES = [
  'const x = Date.now();', 'const d = new Date;', 'const d = Date();', 'const t = performance.now();',
  'const id = crypto.randomUUID();', 'const r = Math.random();', 'const id = R.newId();', 'const d = R.today();',
  'const { aiReader } = R;', "const u = 'https://x'; fetch(u);", 'document.title = 1;', 'const k = process.env.KEY;'
];
const before = allowed;
PROBES.forEach(code => { if (!violations(code, rulesFor.core).length) fail(`検査が甘い: core の「${code}」を見逃した`); });
['box.innerHTML = name;', 'el.insertAdjacentHTML("beforeend", x);', 'document.write(x);'].forEach(code => {
  if (!violations(code, HTML_BAN).length) fail(`検査が甘い: 「${code}」を見逃した`);
});
allowed = before;

console.log(`files: shared ${roles.shared?.length || 0} / core ${roles.core?.length || 0} / adapter ${roles.adapter?.length || 0} / entry ${roles.entry?.length || 0}`);
console.log(`adapter names: ${ADAPTER.length} / probes: ${PROBES.length} / arch-allow: ${allowed}`);
if (problems.length) {
  problems.forEach(p => console.log(`FAIL ${p}`));
  process.exit(1);
}
console.log('ok   architecture');
