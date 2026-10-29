// お客さんのリンクの画面（js/guest-ask.js）を、小さな作り物の DOM と、ask.html と同じ順で読み込んだ本物の画面の部品で確かめる。
// 読み書きの先（js/ask-page.js が渡す source）は見本にする。本物の Worker は呼ばない。
// 守ること: 2 人以上の予約で「送る」は開いている 1 人分だけを送るので、ボタンに誰の分かを書き、送れたら入れる所が残っている次の人へ移る。
// 実行: node test/ask-ui.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.own = '';
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  append(...kids) { this.children.push(...kids); }

  replaceChildren(...kids) { this.children = kids; }

  set textContent(v) { this.children = []; this.own = String(v); }

  get textContent() { return this.own + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }

  /* 押す。送る処理は待たずに走るので、約束が片付くまで回す */
  async click() {
    for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() {} });
    for (let i = 0; i < 5; i += 1) await new Promise(r => setImmediate(r));
  }

  input(value) { (this.listeners.input || []).forEach(fn => fn({ target: { value } })); }
}
const kids = (n) => n.children.filter(c => typeof c !== 'string');
function all(root, test) {
  const hit = [];
  const walk = (n) => { kids(n).forEach(c => { if (test(c)) hit.push(c); walk(c); }); };
  walk(root);
  return hit;
}
const byClass = (root, c) => all(root, n => String(n.className).split(/\s+/).includes(c));
const buttons = (root) => all(root, n => n.tagName === 'BUTTON');
const button = (root, text) => buttons(root).find(b => b.textContent.trim() === text);

const SCRIPTS = ['core.js', 'data.js', 'data-sipe.js', 'roster-schema.js', 'roster-core.js', 'roster-guest.js', 'guest-ask.js'];
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

function boot(lang = 'ja') {
  const nodes = {};
  const document = {
    body: new FNode('body'), documentElement: new FNode('html'), activeElement: null,
    createElement: (tag) => new FNode(tag),
    getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')),
    querySelector: () => null
  };
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://ask.example.test', pathname: '/ask', hash: '', search: '' },
    history: { replaceState() {} }, navigator: { language: lang }, localStorage: memory(), sessionStorage: memory(),
    setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => 0, console, URL, scrolled: 0 });
  ctx.addEventListener = () => {};
  ctx.scrollTo = () => { ctx.scrolled += 1; };
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.lang = lang;
  return { R, ctx, root: document.getElementById('ask') };
}

/* Worker が返す形（askView）の見本。ask は聞く項目、confirm は AI が読んで確かめてほしい項目 */
const person = (id, name, ask, confirm = []) => ({ person: { id, name }, ask, known: [], parts: { emergency: [], cert: [] }, consented: false,
  needsToday: false, todayOpen: false, healthOpen: false, confirm, confirmLeft: [] });
const TRIP = { date: '2026-11-03', start: '09:00', kind: 'dive', tour: '体験ダイビング' };

/* 見本の source: 送った人の聞く項目を空にした view を返す。fail を入れた人は問題を返す */
function source(people, { fail = '' } = {}) {
  let view = { kind: 'booking', shop: 'B マリン（見本）', trip: TRIP, people };
  const sent = [];
  return {
    sent,
    view: () => view,
    async send(id, input) {
      sent.push({ id, input });
      if (id === fail) return { problems: ['birthDate'] };
      view = { ...view, people: view.people.map(x => (x.person.id === id ? { ...x, ask: [] } : x)) };
      return { problems: [] };
    },
    confirm: async () => ({ problems: [] }),
    today: async () => ({ problems: [] }),
    personLink: async () => ({ why: 'gone' })
  };
}

const flag = (root) => (byClass(root, 'flag')[0] || { textContent: '' }).textContent;
const dockButton = (root) => buttons(byClass(root, 'dock')[0])[0];
const pressed = (root) => byClass(root, 'ptab').filter(t => t.getAttribute('aria-pressed') === 'true').map(t => t.textContent.replace('✓', '').trim());   // 済んだ人の札には ✓ が付く

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('2 人の予約: ボタンに誰の分かを書く。送れたら次の人へ移り、送った人と次の人を知らせる。最後の人を送ると「全員の分」', async () => {
  const { R, ctx, root } = boot();
  const src = source([person('p1', '見本 花子', ['birthDate', 'address']), person('p2', '見本 太郎', ['birthDate'])]);
  R.guestAsk.remote(src);
  assert.deepEqual(pressed(root), ['見本 花子']);
  assert.equal(dockButton(root).textContent, '見本 花子の分を送る');
  await dockButton(root).click();
  assert.deepEqual(src.sent.map(s => s.id), ['p1'], '開いている 1 人分だけを送る');
  assert.deepEqual(pressed(root), ['見本 太郎'], '入れる所が残っている次の人を開く');
  assert.equal(flag(root), '見本 花子の分を送りました。次は 見本 太郎 です');
  assert.equal(dockButton(root).textContent, '見本 太郎の分を送る');
  assert.equal(ctx.scrolled, 1, '次の人の欄の頭に戻す');
  await dockButton(root).click();
  assert.deepEqual(src.sent.map(s => s.id), ['p1', 'p2']);
  assert.equal(flag(root), '全員の分を送りました');
  assert.deepEqual(pressed(root), ['見本 太郎'], '次の人がいなければ移らない');
  assert.ok(byClass(root, 'ptab').every(t => t.textContent.includes('✓')), '2 人とも ✓');
  assert.equal(ctx.scrolled, 1);
});

test('名前の分からない人は「2 人目」と呼ぶ。確かめる項目だけが残る人も「次の人」に入る。前に戻って送り直すときも、残っている人へ回る', async () => {
  const { R, root } = boot();
  const src = source([person('p1', '見本 花子', ['address']), person('p2', '', ['name']), person('p3', '見本 次郎', [], [{ field: 'dives', value: 3, canFix: true }])]);
  R.guestAsk.remote(src);
  await dockButton(root).click();
  assert.equal(flag(root), '見本 花子の分を送りました。次は 2人目 です');
  assert.equal(dockButton(root).textContent, '2人目の分を送る');
  await dockButton(root).click();
  assert.equal(flag(root), '2人目の分を送りました。次は 見本 次郎 です', '確かめる項目だけが残る人へも移る');
});

test('送れなかったら移らず、知らせも出さない（直す所を帯に出す）', async () => {
  const { R, ctx, root } = boot();
  const src = source([person('p1', '見本 花子', ['birthDate']), person('p2', '見本 太郎', ['birthDate'])], { fail: 'p1' });
  R.guestAsk.remote(src);
  await dockButton(root).click();
  assert.deepEqual(pressed(root), ['見本 花子']);
  assert.equal(flag(root), '');
  assert.match(byClass(root, 'errors')[0].textContent, /生年月日/);
  assert.equal(ctx.scrolled, 0);
});

test('1 人の予約は今までどおり「送る」「送りました」。英語では Send for … / Sent for … Next: …', async () => {
  const one = boot();
  one.R.guestAsk.remote(source([person('p1', '見本 花子', ['birthDate'])]));
  assert.equal(dockButton(one.root).textContent, '送る');
  await dockButton(one.root).click();
  assert.equal(flag(one.root), '送りました');
  const en = boot('en');
  en.R.guestAsk.remote(source([person('p1', 'Emily Carter', ['birthDate']), person('p2', '', ['name'])]));
  assert.equal(dockButton(en.root).textContent, 'Send for Emily Carter');
  await dockButton(en.root).click();
  assert.equal(flag(en.root), 'Sent for Emily Carter. Next: Guest 2');
  assert.equal(dockButton(en.root).textContent, 'Send for Guest 2');
  await dockButton(en.root).click();
  assert.equal(flag(en.root), 'Sent for everyone');
});

test('人の札を押して別の人に替えると、知らせは消える（前の人の知らせを残さない）', async () => {
  const { R, root } = boot();
  R.guestAsk.remote(source([person('p1', '見本 花子', ['birthDate']), person('p2', '見本 太郎', ['birthDate']), person('p3', '見本 次郎', ['birthDate'])]));
  await dockButton(root).click();
  assert.ok(flag(root));
  await byClass(root, 'ptab').find(t => t.textContent.includes('見本 次郎')).click();
  assert.equal(flag(root), '');
  assert.equal(dockButton(root).textContent, '見本 次郎の分を送る');
  assert.ok(button(root, '見本 次郎の分を送る'));
});

let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${t.name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
