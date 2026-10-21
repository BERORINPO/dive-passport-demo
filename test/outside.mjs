// 外から読む先の検査（test/arch.check.mjs の 8 番が使う）。
// 網は 2 段にする。正規表現を足していくだけだと、書き方の違い（大文字・引用符なし・// で始まる URL・&#58;）で抜けるため。
// (a) HTML と CSS の文字全体から「//」で始まる行き先を全部拾い、ファイルごとの許可と比べる（属性の名前は見ない）
// (b) タグを属性ごとに読み、外の script と、読み込む link（stylesheet・preload・modulepreload・prefetch）に integrity を求める。
//     HTML の中に直に書いてよいスクリプトは importmap だけ（on… の属性・javascript: の URL も禁止）
// 許可は spec/architecture.md の表「外から読む先」だけから読む。散文に書いたサイト名は許可にならない。

const SELF = 'https://self.invalid/';
const SELF_ORIGIN = new URL(SELF).origin;
const LOADING_REL = ['stylesheet', 'preload', 'modulepreload', 'prefetch'];
const INTEGRITY = /^\s*sha(?:256|384|512)-[A-Za-z0-9+/=]+/;

/* 表の行は「| ファイル | 外から読んでよい先 | integrity なしでよい先 |」。先は `…` で囲んだものだけ拾う。前方一致で比べる */
export function allowTable(doc) {
  const start = doc.indexOf('### 外から読む先');
  if (start < 0) return null;
  const end = doc.indexOf('\n#', start + 1);
  const rows = doc.slice(start, end < 0 ? undefined : end).split('\n').filter(l => /^\|\s*[\w./-]+\.(?:html|css)\s*\|/.test(l));
  const ticks = (s) => [...(s || '').matchAll(/`([^`]+)`/g)].map(m => m[1]);
  return Object.fromEntries(rows.map(l => {
    const [, file, allow, bare] = l.split('|').map(s => s.trim());
    return [file, { allow: ticks(allow), bare: ticks(bare) }];
  }));
}

/* 表の書き方の検査。前方一致なので、https:// で始まり / で終わる（またはファイル名まで書いた）物だけを受け付ける。
   `https://cdn.jsdelivr.net` と書くと `https://cdn.jsdelivr.net.evil.com/` まで通ってしまうため */
export function tableProblems(table) {
  const out = [];
  const shapeOk = (p) => {
    let u;
    try { u = new URL(p); } catch { return false; }
    return u.protocol === 'https:' && u.href === p && (p.endsWith('/') || /\/[^/]+\.[a-z0-9]+$/i.test(u.pathname));
  };
  Object.entries(table || {}).forEach(([file, rule]) => {
    rule.allow.filter(p => !shapeOk(p)).forEach(p => out.push(`${file}: 許可の書き方が違う（https:// で始め、/ で終えるかファイル名まで書く）: ${p}`));
    rule.bare.filter(p => !rule.allow.some(a => p.startsWith(a))).forEach(p => out.push(`${file}: integrity なしでよい先が、許可の内側に無い: ${p}`));
  });
  return out;
}

const ENTITY = { colon: ':', sol: '/', bsol: '\\', tab: '\t', newline: '\n', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', period: '.' };
const fromCode = (n) => (n > 0x10ffff ? '�' : String.fromCodePoint(n));
/* 文字参照（&#58; &#x3a; &colon; など）を元の字に戻す。ブラウザは属性の値でこれを戻してから URL として読む */
export function decode(text) {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => fromCode(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_, d) => fromCode(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? m);
}
/* CSS のエスケープ（\2f と書いて / にする）を元の字に戻す */
const cssUnescape = (t) => t.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => fromCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');

/* 外の行き先なら URL、同じ場所なら null。読めなければ 'bad'。URL の中のタブと改行はブラウザが消す */
export function external(value) {
  if (value == null) return null;
  let u;
  try { u = new URL(String(value).replace(/[\t\n\r]/g, '').trim(), SELF); } catch { return 'bad'; }
  return u.origin === SELF_ORIGIN ? null : u;
}

/* (a) の網: 「//」（\\ も同じに読まれる）で始まる行き先を全部拾う。scheme（https: の部分）は有っても無くてもよい。
   HTML と CSS のコメントは先に外す。タブと改行は、空白にした物と消した物の両方で探す（https:/<タブ>/ をブラウザは // と読む）。
   消した物では、行がつながって無い // ができるので（2 行続けたコメントなど）、scheme で始まる物だけ拾う。
   CSS のエスケープを戻した物でも探す */
const DEST = /(?:[a-z][a-z0-9+.-]*:)?[\\/]{2}[^\s"'<>()`,]+/gi;
const SCHEMED = /^[a-z][a-z0-9+.-]*:/i;
export function destinations(text) {
  const base = decode(text.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\sxmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' '));
  const spaced = base.replace(/[\t\r\n]/g, ' ');
  const joined = base.replace(/[\t\r\n]/g, '');
  const all = (t) => [...t.matchAll(DEST), ...cssUnescape(t).matchAll(DEST)].map(m => m[0]);
  return [...new Set([...all(spaced), ...all(joined).filter(d => SCHEMED.test(d))])];
}

/* 属性を 1 つ読む。名前、値（引用符あり・なし）、次に読む位置を返す */
function readAttr(html, start) {
  let i = start;
  let name = '';
  while (i < html.length && !/[\s/>=]/.test(html[i])) name += html[i++];
  while (/\s/.test(html[i] || '')) i += 1;
  if (html[i] !== '=') return { name, value: '', next: i };
  i += 1;
  while (/\s/.test(html[i] || '')) i += 1;
  const q = html[i];
  if (q === '"' || q === "'") {
    const j = html.indexOf(q, i + 1);
    return { name, value: html.slice(i + 1, j < 0 ? html.length : j), next: j < 0 ? html.length : j + 1 };
  }
  let value = '';
  while (i < html.length && !/[\s>]/.test(html[i])) value += html[i++];
  return { name, value, next: i };
}

/* (b) の網: タグを属性ごとに読む。コメントは先に外す。引用符の中の > で切れない。同じ名前の属性は最初の物が効く（ブラウザと同じ） */
export function tags(source) {
  const html = source.replace(/<!--[\s\S]*?-->/g, ' ');
  const lower = html.toLowerCase();
  const out = [];
  const re = /<([a-z][a-z0-9:-]*)/gi;
  let m;
  while ((m = re.exec(html))) {
    let i = m.index + m[0].length;
    const attrs = new Map();
    while (i < html.length && html[i] !== '>') {
      if (/[\s/=]/.test(html[i])) { i += 1; continue; }
      const a = readAttr(html, i);
      if (!attrs.has(a.name.toLowerCase())) attrs.set(a.name.toLowerCase(), decode(a.value));
      i = a.next;
    }
    const tag = m[1].toLowerCase();
    let content = '';
    if (tag === 'script' || tag === 'style') {
      const close = lower.indexOf(`</${tag}`, i);
      content = html.slice(i + 1, close < 0 ? html.length : close);
      re.lastIndex = close < 0 ? html.length : close;   // 中身の < をタグとして読まない
    } else {
      re.lastIndex = i;
    }
    out.push({ tag, attrs, content });
  }
  return out;
}

const allowedBy = (list, u) => list.some(p => u.href.startsWith(p));
const show = (u) => String(u.href || u).slice(0, 80);
const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'srcset', 'action', 'formaction', 'poster', 'data', 'background', 'ping', 'manifest', 'cite', 'icon', 'longdesc', 'lowsrc', 'codebase', 'archive']);
const scheme = (v) => (String(v || '').replace(/[\t\n\r]/g, '').trim().match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];

/* 1 つのタグの問題（HTML の中のコード・script・link） */
function tagProblems({ tag, attrs, content }, rule) {
  const out = [];
  const integrity = INTEGRITY.test(attrs.get('integrity') || '');
  attrs.forEach((v, k) => {
    /* URL を受け取る属性は、タブを消して読む（/<タブ>/evil を // と読むため。(a) の網は scheme の無い物を拾わない） */
    if (URL_ATTRS.has(k)) {
      (k === 'srcset' ? v.split(',').map(x => x.trim().split(/\s+/)[0]) : [v]).forEach(x => {
        const u = external(x);
        if (u && u !== 'bad' && !allowedBy(rule.allow, u)) out.push(`外の読み込み先が許可に無い（${k}）: ${show(u)}`);
      });
    }
    if (/^on[a-z]+$/.test(k)) out.push(`HTML の中にコードを書いている（${k}=）`);
    if (/^(?:javascript|vbscript)$/i.test(scheme(v) || '')) out.push(`javascript: の URL を使っている（${k}）`);
  });
  if (tag === 'base') out.push('<base> は使わない（以後の相対の読み込みが全部その先になる）');
  if (tag === 'script') {
    const srcRaw = attrs.get('src') ?? attrs.get('href') ?? attrs.get('xlink:href');   // SVG の script は href で読む
    const type = (attrs.get('type') || '').trim().toLowerCase();
    if (srcRaw !== undefined) {
      const s = scheme(srcRaw);
      if (s && !/^https?$/i.test(s)) out.push(`script の src は http(s) か相対の URL だけ（${s}:）`);
      const src = external(srcRaw);
      if (src && !integrity) out.push(`外のスクリプトに integrity が無い: ${show(src)}`);
    } else if (type === 'importmap') {
      out.push(...importmapProblems(content));
    } else {
      out.push('HTML の中に直に書いてよいスクリプトは importmap だけ（js/ に置く）');
    }
  }
  if (tag === 'link') {
    const rel = (attrs.get('rel') || '').toLowerCase().split(/\s+/);
    const href = external(attrs.get('href'));
    if (href && rel.some(r => LOADING_REL.includes(r)) && !integrity && !(href !== 'bad' && allowedBy(rule.bare, href))) {
      out.push(`外の link（${rel.join(' ')}）に integrity が無い: ${show(href)}`);
    }
  }
  return out;
}

/* 1 つのファイル（HTML か CSS）の問題。rule は表の 1 行 */
export function fileProblems(text, rule, isHtml) {
  const out = [];
  destinations(text).forEach(d => {
    const u = external(d);
    if (!u) return;
    if (u === 'bad') out.push(`読めない行き先: ${d.slice(0, 60)}`);
    else if (!allowedBy(rule.allow, u)) out.push(`外の読み込み先が許可に無い: ${show(u)}`);
  });
  if (isHtml) tags(text).forEach(t => out.push(...tagProblems(t, rule)));
  return out;
}

/* 表で許しているのに、そのファイルが使っていない先（表と中身を両方向で合わせる） */
export function unusedAllows(text, rule) {
  const found = destinations(text).map(external).filter(u => u && u !== 'bad');
  return rule.allow.filter(p => !found.some(u => u.href.startsWith(p)));
}

/* importmap: imports と scopes の行き先のうち、ファイル（/ で終わらない物）には 1 つずつ integrity を求める */
export function importmapProblems(json) {
  let map;
  try { map = JSON.parse(json); } catch { return ['importmap が JSON として読めない']; }
  const integ = map.integrity || {};
  const values = [...Object.values(map.imports || {}), ...Object.values(map.scopes || {}).flatMap(o => Object.values(o || {}))];
  return values.map(v => [v, external(v)]).filter(([v, u]) => u && u !== 'bad' && !String(v).trim().endsWith('/') && !integ[u.href] && !integ[v])
    .map(([, u]) => `importmap の ${u.href} に integrity が無い`);
}

/* HTML の importmap を全部合わせる（JS の import を外の URL に直すため） */
export function importmapOf(html) {
  const map = { imports: {}, integrity: {} };
  tags(html).filter(t => t.tag === 'script' && (t.attrs.get('type') || '').trim().toLowerCase() === 'importmap').forEach(t => {
    try {
      const j = JSON.parse(t.content);
      Object.assign(map.imports, j.imports || {});
      Object.assign(map.integrity, j.integrity || {});
    } catch { /* 読めない importmap は fileProblems が FAIL にする */ }
  });
  return map;
}

/* JS の import（静的・動的・export from）を importmap で外の URL に直し、1 つずつ integrity を求める。
   src はコメントを消して文字列を残した物。CDN のファイルの中の import は追えないので、表の注に書いて Network で確かめる */
export function importProblems(src, map) {
  const specs = [
    ...src.matchAll(/\bimport\s*(?:[\w*{}\s,$]+?\s*from\s*)?['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bexport\s*[\w*{}\s,$]*?\s*from\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)
  ].map(m => m[1]);
  const out = [];
  specs.forEach(s => {
    if (/^[a-z][a-z0-9+.-]*:|^[\\/]{2}/i.test(s)) { out.push(`URL で直に import している: ${s}`); return; }
    if (/^\.{1,2}\/|^\/(?!\/)/.test(s)) return;   // ./ ../ / は同じ場所
    const key = map.imports[s] !== undefined ? s
      : Object.keys(map.imports).filter(k => k.endsWith('/') && s.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    if (key === undefined) { out.push(`importmap に無い名前を import している: ${s}`); return; }
    const u = external(map.imports[key] + s.slice(key.length));
    if (u && u !== 'bad' && !map.integrity[u.href]) out.push(`import の先 ${u.href} に integrity が無い`);
  });
  return out;
}
