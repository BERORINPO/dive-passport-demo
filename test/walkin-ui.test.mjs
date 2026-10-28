// 店頭の QR と「QR を見せる」「SMS で送る」「LINE で送る」のお店の画面（js/walkin-staff.js・js/booking.js）を、
// 小さな作り物の DOM（要素の木・押す・文字を読む）と、index.html と同じ順で読み込んだ本物の画面の部品で確かめる。
// 通信（js/roster-sync.js）と QR の部品（qrcode-generator）だけを差し替える。
// 実行: node test/walkin-ui.test.mjs （Node 18 以上。依存なし）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ---------- 作り物の DOM ---------- */
class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.dataset = {};
    this.own = '';
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }

  append(...kids) { this.children.push(...kids); }

  replaceChildren(...kids) { this.children = kids; }

  set textContent(v) { this.children = []; this.own = String(v); }

  get textContent() { return this.own + this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join(''); }

  closest() { return null; }

  querySelector(sel) { return all(this, sel)[0] || null; }

  /* 押す。onclick はイベントを受ける */
  async click() { for (const fn of this.listeners.click || []) await fn({ target: this, preventDefault() {} }); }
}
const kids = (n) => n.children.filter(c => typeof c !== 'string');
function all(root, sel) {
  const hit = [];
  const test = (n) => (sel.startsWith('.') ? String(n.className).split(/\s+/).includes(sel.slice(1)) : n.tagName === sel.toUpperCase());
  const walk = (n) => { kids(n).forEach(c => { if (test(c)) hit.push(c); walk(c); }); };
  walk(root);
  return hit;
}
const buttons = (root, text) => [...all(root, 'button'), ...all(root, 'a')].filter(b => b.textContent.includes(text));

/* ---------- 画面の部品を index.html と同じ順で読む ---------- */
const SCRIPTS = ['core.js', 'data.js', 'data-sipe.js', 'qr.js', 'roster-schema.js', 'health-redact.js', 'roster-core.js', 'roster-guest.js', 'roster-day.js', 'roster-share.js',
  'roster-auto.js', 'data-samples.js', 'data-big-sample.js', 'photo-mask.js', 'photo-prep.js', 'ai-reader.js', 'roster-sync.js', 'day-roster.js', 'past-trips.js', 'share-roster.js',
  'partner-photo.js', 'intake-photo.js', 'auto-flow.js', 'contact-link.js', 'person-links.js', 'walkin-staff.js', 'api-keys-staff.js', 'booking-add.js', 'booking-edit.js', 'booking.js'];
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), raw: m }; };

function boot({ worker = true } = {}) {
  const nodes = {};
  const body = new FNode('body');
  const document = {
    body, documentElement: new FNode('html'), activeElement: null,
    createElement: (tag) => new FNode(tag),
    getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')),
    querySelector: (sel) => (worker && sel === 'meta[name="redux-worker"]' ? new FNode('meta') : null)
  };
  const qrcode = () => ({ addData() {}, make() {}, getModuleCount: () => 21, isDark: (r, c) => (r + c) % 3 === 0 });
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://dive-passport-demo.example.workers.dev', pathname: '/', hash: '' }, navigator: { language: 'ja' },
    localStorage: memory(), sessionStorage: memory(), setTimeout: () => ({ unref() {} }), clearTimeout() {}, setInterval: () => 0, AbortController, TextEncoder, URL, btoa, console,
    CompressionStream, Blob, Response, qrcode, printed: 0, listeners: {}, CSS: { escape: (s) => s } });
  ctx.addEventListener = (type, fn) => { ctx.listeners[type] = fn; };
  ctx.print = () => { ctx.printed += 1; };
  ctx.window = ctx;
  SCRIPTS.forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  const R = ctx.REDUX;
  R.rosterStore.synced = () => true;
  R.rosterStore.pending = () => 0;
  return { R, ctx, root: document.getElementById('booking'), body, nodes, win: ctx };
}

const AT = '2026-10-27T01:00:00.000Z';
let seq = 0;
const newId = () => `u${(seq += 1)}`;
const KEY = (c) => `${c}`.repeat(43);
const LINK_OF = {};

/* 名簿: 今日の便に電話の予約 2 つ（1 つは電話番号なし）、乗り合いの他のお店の予約 1 つ */
function seed(R) {
  let st = R.roster.blankState('B マリン（見本）');
  const trip = R.rosterCore.addTrip(st, { trip: { date: R.today(), start: '08:30', kind: 'dive', tour: '体験ダイビング' }, at: AT, newId });
  st = trip.state;
  const book = (lead, phone, extra = {}) => {
    st = R.rosterCore.addBookingToTrip(st, { tripId: trip.trip.id, want: { date: trip.trip.date, start: '08:30', tour: '体験ダイビング', kind: 'dive' },
      booking: { source: 'phone', leadName: lead, leadPhone: phone, people: 1, ...extra }, reading: null, src: 'staff', at: AT, newId }).state;
    return st.bookings[st.bookings.length - 1];
  };
  const withPhone = book('見本 太郎', '090-1234-5678');
  const noPhone = book('見本 次郎', '');
  const partner = book('他店 花子', '', { source: 'partner', shop: 'C ダイブ' });
  R.rosterStore.apply('roster.replace', { state: st });
  [withPhone, noPhone, partner].forEach((b, i) => { LINK_OF[b.id] = `https://ask.reduxdive.com/ask#k=${KEY('abc'[i])}`; });
  return { trip: trip.trip, withPhone, noPhone, partner };
}

const settle = () => new Promise(r => setImmediate(r));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const decode = (href) => decodeURIComponent(href.split(/&body=|[?]text=/)[1]);

test('予約の行の「QR を見せる」: サーバーにつながる版の、乗り合いでない予約だけ。サーバーにつながらない版・乗り合いの他のお店の予約には出ない', () => {
  const { R, root } = boot();
  const b = seed(R);
  R.renderBooking();
  const rows = all(root, 'li').filter(li => li.className === 'bk');
  assert.equal(rows.length, 3);
  const shown = rows.filter(li => buttons(li, 'QR を見せる').length);
  assert.deepEqual(shown.map(li => li.children.find(c => c.className === 'bk__name').textContent.trim()), ['見本 太郎', '見本 次郎']);
  assert.ok(b.partner);
  const off = boot({ worker: false });
  seed(off.R);
  off.R.renderBooking();
  assert.equal(buttons(off.root, 'QR を見せる').length, 0, 'Worker の印（meta）が無い版には出さない');
  const local = boot();
  seed(local.R);
  local.R.rosterStore.synced = () => false;
  local.R.renderBooking();
  assert.equal(buttons(local.root, 'QR を見せる').length, 0, 'サーバーにつながっていない間は出さない');
});

test('「QR を見せる」を押す: リンクがまだ無いときは、前のリンクが開けなくなると知らせて、作るまで QR は出さない。作ると、その予約のリンクが大きな QR で出る', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const made = [];
  R.rosterSync.askLink = async (id) => { made.push(id); return { ok: true, url: LINK_OF[id], expiresOn: '2026-10-28' }; };
  R.renderBooking();
  const row = all(root, 'li').find(li => li.textContent.includes('見本 太郎'));
  await buttons(row, 'QR を見せる')[0].click();
  assert.deepEqual(made, [], '押しただけではリンクを作らない（前に送ったリンクを止めないため）');
  assert.match(root.textContent, /前に送ったリンクは開けなくなります/);
  assert.equal(all(root, '.qr--big').length, 0);
  await buttons(root, 'リンクを作る')[0].click();
  assert.deepEqual(made, [b.withPhone.id], '押した予約のリンクを 1 回だけ作る');
  const big = all(root, '.qr--big');
  assert.equal(big.length, 1, '大きな QR');
  assert.equal(all(big[0], 'svg').length + all(big[0], '.qr__img').length > 0, true);
  const img = all(big[0], '.qr__img')[0];
  assert.match(img.innerHTML, /<svg viewBox="0 0 29 29"/, 'QR の絵（白地の SVG）');
  await buttons(root, 'QR を閉じる')[0].click();
  assert.equal(all(root, '.qr--big').length, 0);
  await buttons(root, 'QR を見せる')[0].click();
  assert.equal(all(root, '.qr--big').length, 1, '同じ画面で、作ったリンクをもう一度見せられる（作り直さない）');
  assert.deepEqual(made, [b.withPhone.id]);
});

test('「SMS で送る」「LINE で送る」: 作ったリンクだけから URL を作る。本文はお店の名前・決まった 1 行・その予約のリンクだけ。電話番号の無い予約には SMS を出さない', async () => {
  const { R, root } = boot();
  const b = seed(R);
  R.rosterSync.askLink = async (id) => ({ ok: true, url: LINK_OF[id], expiresOn: '2026-10-28' });
  R.renderBooking();
  const open = async (name) => {
    await buttons(all(root, 'li').find(li => li.textContent.includes(name)), 'QR を見せる')[0].click();
    await buttons(root, 'リンクを作る')[0].click();
  };
  assert.equal(buttons(root, 'SMS で送る').length, 0, 'リンクを作る前は出さない');
  await open('見本 太郎');
  const [sms] = buttons(root, 'SMS で送る');
  const [line] = buttons(root, 'LINE で送る');
  assert.ok(sms && line);
  assert.ok(sms.attrs.href.startsWith('sms:09012345678?&body='), sms.attrs.href);
  assert.ok(line.attrs.href.startsWith('https://line.me/R/share?text='), line.attrs.href);
  assert.equal(line.attrs.target, '_blank');
  assert.equal(line.attrs.rel, 'noopener noreferrer');
  for (const href of [sms.attrs.href, line.attrs.href]) {
    const text = decode(href);
    assert.equal(text, `B マリン（見本）：ご予約の前にお名前などの入力をお願いします\n${LINK_OF[b.withPhone.id]}`);
    assert.ok(!text.includes(LINK_OF[b.noPhone.id]) && !text.includes('見本 太郎') && !text.includes('090'), '別の予約のリンク・お客さんの名前・電話番号は入らない');
  }
  await buttons(root, '予約の一覧に戻る')[0].click();
  await open('見本 次郎');
  assert.equal(buttons(root, 'SMS で送る').length, 0, '電話番号の無い予約には SMS を出さない');
  assert.match(root.textContent, /電話番号が入っていないので、SMS では送れません/);
  const lineNoPhone = buttons(root, 'LINE で送る')[0];
  assert.equal(decode(lineNoPhone.attrs.href).split('\n')[1], LINK_OF[b.noPhone.id], 'LINE は電話番号が無くても送れる（友だちをスタッフが選ぶ）');
});

test('店頭の QR を作る: 作ると A5 の貼り紙に QR が出て、印刷できる。作り直すときは 2 回押す。鍵つきの URL は画面を読み込み直すと出し直せない', async () => {
  const { R, root, body, win } = boot();
  seed(R);
  let made = 0;
  R.rosterSync.walkins = async () => ({ ok: true, items: [], keyAt: '' });
  R.rosterSync.flushWalkinDrops = async () => 0;
  R.rosterSync.walkinKey = async () => { made += 1; return { ok: true, url: `https://ask.reduxdive.com/walkin#w=${KEY('k')}`, at: AT }; };
  R.renderBooking();
  await buttons(root, '店頭の QR・店頭で入れた人')[0].click();
  await settle();
  assert.match(root.textContent, /店頭で入れた人はいません/);
  assert.equal(all(root, '.poster').length, 0, '作る前は貼り紙なし');
  await buttons(root, '店頭の QR を作る')[0].click();
  await settle();
  assert.equal(made, 1);
  const poster = all(root, '.poster');
  assert.equal(poster.length, 1);
  assert.ok(root.children.includes(poster[0]), '貼り紙は画面の直下（印刷で貼り紙だけを出すため）');
  assert.match(poster[0].textContent, /B マリン（見本）/);
  assert.match(poster[0].textContent, /お申込書は、スマホで書けます/);
  assert.equal(all(poster[0], '.qr__img').length, 1);
  assert.ok(!/health|既往/.test(poster[0].textContent), '貼り紙に健康の質問は無い');
  await buttons(root, 'A5 で印刷')[0].click();
  assert.equal(win.printed, 1);
  assert.equal(body.classList.contains('print-poster'), true, '印刷の間は貼り紙だけ出す');
  win.listeners.afterprint();
  assert.equal(body.classList.contains('print-poster'), false);
  await buttons(root, '作り直す')[0].click();
  assert.equal(made, 1, '1 回目の押下では作り直さない（貼ってある QR が使えなくなる）');
  assert.match(root.textContent, /貼ってある QR は使えなくなります/);
  await buttons(root, 'もう一度押すと作り直す')[0].click();
  assert.equal(made, 2);
});

test('店頭で入れた人: 同じ日・同じ名前の予約があれば「その予約にまとめる」、なければ「便を選んで入れる」。入れたら名簿が変わり、行は消え、サーバーの行は名簿が届いてから消す', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const mk = (id, name, extra = {}) => ({ id, tripId: '', at: AT, day: R.today(), name, people: 1, email: '', birthDate: '1990-05-01', address: '那覇市', emergency: { name: '家族', relation: '', phone: '090' }, ...extra });
  const rows = [mk('aaa111', '見本 太郎'), mk('bbb222', '新規 三郎', { tripId: b.trip.id }), mk('ccc333', '却下 四郎')];
  const calls = [];
  R.rosterSync.walkins = async () => ({ ok: true, items: rows.slice(), keyAt: AT });
  R.rosterSync.hideWalkin = (id, mustSync) => calls.push(['hide', id, mustSync]);
  R.rosterSync.flushWalkinDrops = async (o) => { calls.push(['flush', o.synced]); return 0; };
  R.renderBooking();
  await buttons(root, '店頭の QR・店頭で入れた人')[0].click();
  await settle();
  assert.match(root.textContent, /店頭で入れた人/);
  const li = (name) => all(root, 'li').find(x => x.textContent.includes(name) && x.className === 'bk' && x.textContent.includes('生年月日'));
  assert.equal(buttons(li('見本 太郎'), 'その予約にまとめる').length, 1);
  assert.equal(buttons(li('見本 太郎'), '別の予約として入れる').length, 1);
  assert.equal(buttons(li('新規 三郎'), 'その予約にまとめる').length, 0);
  assert.equal(buttons(li('新規 三郎'), '便を選んで入れる').length, 1);
  assert.match(li('新規 三郎').textContent, /希望の便/);
  assert.match(li('却下 四郎').textContent, /便はスタッフに聞く/);

  /* まとめる */
  await buttons(li('見本 太郎'), 'その予約にまとめる')[0].click();
  const lead = R.rosterStore.get().people.find(p => p.bookingId === b.withPhone.id);
  assert.equal(lead.birthDate, '1990-05-01');
  assert.equal(lead.address, '那覇市');
  assert.equal(R.rosterStore.get().bookings.length, 3, '予約は増えない');
  assert.deepEqual(calls.filter(c => c[0] === 'hide'), [['hide', 'aaa111', true]], '入れた行は「名簿が届いてから消す」で隠す');
  assert.equal(all(root, 'li').filter(x => x.textContent.includes('見本 太郎') && x.textContent.includes('生年月日')).length, 0, '行は消える');

  /* 便を選んで入れる */
  await buttons(li('新規 三郎'), '便を選んで入れる')[0].click();
  const select = all(root, 'select')[0];
  assert.ok(select.children.length >= 1);
  await buttons(root, 'この便に入れる')[0].click();
  const state = R.rosterStore.get();
  assert.equal(state.bookings.length, 4);
  const added = state.bookings[state.bookings.length - 1];
  assert.equal(added.leadName, '新規 三郎');
  assert.equal(added.tripId, b.trip.id, '希望の便が既定');
  assert.equal(added.source, 'form');
  assert.ok(R.roster.validateState(state).ok);

  /* 入れない: 2 回押す。名簿は変わらず、サーバーの行をすぐ消す */
  const before = JSON.stringify(R.rosterStore.get());
  await buttons(li('却下 四郎'), '入れない')[0].click();
  assert.match(root.textContent, /もう一度押すと、入力の内容を消します/);
  assert.equal(calls.filter(c => c[0] === 'hide').length, 2, '1 回目の押下では消さない');
  await buttons(root, 'もう一度押すと、入力の内容を消します')[0].click();
  assert.deepEqual(calls.filter(c => c[0] === 'hide').pop(), ['hide', 'ccc333', false]);
  assert.equal(JSON.stringify(R.rosterStore.get()), before, '入れないときは名簿を変えない');
  assert.match(root.textContent, /店頭で入れた人はいません/);
});

test('名簿に入れられなかったとき（便が中止になっていた）は、行を隠さずに知らせる。中止した便は選べない', async () => {
  const { R, root } = boot();
  const b = seed(R);
  R.rosterStore.apply('core.cancelTrip', { tripId: b.trip.id, reason: 'wind' });
  const calls = [];
  const item = { id: 'ddd444', tripId: b.trip.id, at: AT, day: R.today(), name: '見本 太郎', people: 1, email: '', birthDate: '1990-05-01', address: '那覇市', emergency: { name: '家族', relation: '', phone: '090' } };
  R.rosterSync.walkins = async () => ({ ok: true, items: [item], keyAt: '' });
  R.rosterSync.hideWalkin = (id) => calls.push(id);
  R.rosterSync.flushWalkinDrops = async () => 0;
  R.renderBooking();
  await buttons(root, '店頭の QR・店頭で入れた人')[0].click();
  await settle();
  await buttons(root, 'その予約にまとめる')[0].click();
  assert.deepEqual(calls, [], '入れられなかった行は隠さない');
  assert.match(root.textContent, /その便は中止になっています/);
  assert.match(root.textContent, /見本 太郎/, '行は残る');
  await buttons(root, '別の予約として入れる')[0].click();
  assert.match(root.textContent, /この日以降の便がありません/, '中止した便は選べない');
});


test('一覧を読めないとき: 描き直すたびに読みに行かない（電波が無い間に通信を連打しない）。「読み直す」で読み直す', async () => {
  const { R, root } = boot();
  seed(R);
  let reads = 0;
  R.rosterSync.walkins = async () => { reads += 1; return { ok: false, why: 'network' }; };
  R.rosterSync.flushWalkinDrops = async () => 0;
  R.renderBooking();
  await buttons(root, '店頭の QR・店頭で入れた人')[0].click();
  await settle();
  R.renderBooking();
  await settle();
  assert.equal(reads, 1, '読めなくても 1 回だけ');
  assert.match(root.textContent, /一覧を読めませんでした/);
  await buttons(root, '読み直す')[0].click();
  await settle();
  assert.equal(reads, 2);
});

/* ---------- 1 人ずつのリンク（js/person-links.js。決定ログ 2026-10-28 staff-person-links）---------- */
/* seed の便に、メールから読んだ 2 人の予約（AI が読んだ項目が未確認として残る）を足す。代表者の電話つき */
function seedMail(R, trip) {
  const reading = JSON.parse(JSON.stringify(R.SAMPLE_READINGS.e1));
  const st = R.rosterCore.addBookingToTrip(R.rosterStore.get(), { tripId: trip.id, want: { date: trip.date, start: '08:30', tour: '体験ダイビング', kind: 'dive' },
    booking: { source: 'mail', leadName: '花子', leadPhone: '090-9999-0000', people: 2 }, reading, src: 'mail', at: AT, newId }).state;
  R.rosterStore.apply('roster.replace', { state: st });
  const booking = st.bookings[st.bookings.length - 1];
  return { booking, people: st.people.filter(p => p.bookingId === booking.id) };
}
const PERSON_URL = (c) => `https://ask.reduxdive.com/ask#k=${KEY(c)}`;
const openAsk = async (root, name) => buttons(all(root, 'li').find(li => li.className === 'bk' && li.textContent.includes(name)), 'QR を見せる')[0].click();
const blocks = (root) => all(root, '.perlink');
/* 「この人のリンク」(作り直す) を、確かめの 1 回目と作る 2 回目で押す */
const pressTwice = async (root, i, label) => { await buttons(blocks(root)[i], label)[0].click(); await buttons(blocks(root)[i], 'もう一度押すと')[0].click(); };

test('1 人ずつのリンク: 予約の人ごとに「この人のリンク」が 1 つずつ出て、未確認の項目の数が見える。未確認のない人は「未確認なし」', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const m = seedMail(R, b.trip);
  R.rosterSync.askLink = async () => ({ ok: true, url: PERSON_URL('p'), expiresOn: '2026-10-28' });
  R.renderBooking();
  await openAsk(root, '花子 ほか');
  assert.equal(blocks(root).length, 2, '予約の人の数だけ');
  assert.deepEqual(blocks(root).map(x => buttons(x, 'この人のリンク').length), [1, 1]);
  const counts = R.rosterCore.unconfirmedByPerson(R.rosterStore.get(), m.booking.id).map(x => x.count);
  assert.ok(counts.every(n => n > 0), 'メールから読んだ人には未確認がある');
  blocks(root).forEach((x, i) => assert.match(x.textContent, new RegExp(`未確認 ${counts[i]} 項目`)));
  assert.match(root.textContent, new RegExp(`未確認 2 人・${counts[0] + counts[1]} 項目`));
  await buttons(root, '予約の一覧に戻る')[0].click();
  await openAsk(root, '見本 太郎');
  assert.equal(blocks(root).length, 1);
  assert.match(blocks(root)[0].textContent, /未確認なし/);
  assert.match(root.textContent, /未確認はありません/);
  assert.equal(R.personLinks.rows(R.rosterStore.get(), 'none').length, 0, '人のいない予約には行が無い');
});

test('1 人ずつのリンク: 1 回目の押下では作らず、確かめの文に変わる。もう一度押すと、その人の personId をつけて 1 回だけ作る', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const m = seedMail(R, b.trip);
  const calls = [];
  R.rosterSync.askLink = async (bookingId, personId) => { calls.push([bookingId, personId]); return { ok: true, url: PERSON_URL('q'), expiresOn: '2026-10-28' }; };
  R.renderBooking();
  await openAsk(root, '花子 ほか');
  await buttons(blocks(root)[1], 'この人のリンク')[0].click();
  assert.deepEqual(calls, [], '1 回目の押下では作らない（その人の前のリンクを止めないため）');
  assert.match(blocks(root)[1].textContent, /もう一度押すと、.*前のリンクは開けなくなります/);
  assert.doesNotMatch(blocks(root)[0].textContent, /もう一度押すと/, '確かめの文に変わるのは押した人だけ');
  await buttons(blocks(root)[1], 'もう一度押すと')[0].click();
  assert.deepEqual(calls, [[m.booking.id, m.people[1].id]], '予約の id と、押した人の id');
  assert.equal(all(blocks(root)[1], '.qr--big').length, 1, '作ったら、その人の QR が大きく出る');
  assert.equal(all(blocks(root)[0], '.qr--big').length, 0, '別の人には出ない');
  assert.equal(buttons(blocks(root)[0], 'SMS で送る').length + buttons(blocks(root)[0], 'LINE で送る').length, 0);
});

test('1 人ずつのリンク: QR を見せる・SMS で送る・LINE で送る は、その人のリンクだけを本文に入れる（名前・電話は入れない）。電話の無い予約は SMS を出さない', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const m = seedMail(R, b.trip);
  R.rosterSync.askLink = async (bookingId, personId) => ({ ok: true, url: PERSON_URL(personId === m.people[0].id ? 'a' : 'b'), expiresOn: '2026-10-28' });
  R.renderBooking();
  await openAsk(root, '花子 ほか');
  await pressTwice(root, 0, 'この人のリンク');
  const [sms] = buttons(blocks(root)[0], 'SMS で送る');
  const [line] = buttons(blocks(root)[0], 'LINE で送る');
  assert.ok(sms.attrs.href.startsWith('sms:09099990000?&body='), sms.attrs.href);
  assert.ok(line.attrs.href.startsWith('https://line.me/R/share?text='), line.attrs.href);
  assert.equal(line.attrs.target, '_blank');
  for (const href of [sms.attrs.href, line.attrs.href]) {
    const text = decode(href);
    assert.equal(text, `B マリン（見本）：ご予約の前にお名前などの入力をお願いします\n${PERSON_URL('a')}`);
    assert.ok(!text.includes('花子') && !text.includes('090'), 'お客さんの名前・電話番号は入らない');
  }
  await buttons(blocks(root)[0], 'QR を見せる')[0].click();
  assert.equal(all(root, '.qr--big').length, 0, 'QR を閉じられる');
  await buttons(blocks(root)[0], 'QR を見せる')[0].click();
  assert.equal(all(root, '.qr--big').length, 1);
  await pressTwice(root, 1, 'この人のリンク');
  assert.equal(decode(buttons(blocks(root)[1], 'LINE で送る')[0].attrs.href).split('\n')[1], PERSON_URL('b'), '2 人目は 2 人目のリンク');
  assert.equal(all(root, '.qr--big').length, 1, '見せる QR は 1 つだけ（今作った人に移る）');
  await buttons(root, '予約の一覧に戻る')[0].click();
  await openAsk(root, '見本 次郎');
  await pressTwice(root, 0, 'この人のリンク');
  assert.equal(buttons(blocks(root)[0], 'SMS で送る').length, 0, '電話番号の無い予約には SMS を出さない');
  assert.equal(buttons(blocks(root)[0], 'LINE で送る').length, 1);
});

test('1 人ずつのリンク: 作り直すときも 2 回押す。作り直した人のリンクだけが新しくなる。作れなかったときは知らせ、作る前のリンクを残す', async () => {
  const { R, root } = boot();
  const b = seed(R);
  const m = seedMail(R, b.trip);
  const calls = [];
  const replies = [{ ok: true, url: PERSON_URL('b') }, { ok: true, url: PERSON_URL('c') }, { ok: true, url: PERSON_URL('d') }, { ok: false, why: 404 }];
  R.rosterSync.askLink = async (bookingId, personId) => { calls.push(personId); return { expiresOn: '2026-10-28', ...replies[calls.length - 1] }; };
  R.renderBooking();
  await openAsk(root, '花子 ほか');
  const lineOf = (i) => decode(buttons(blocks(root)[i], 'LINE で送る')[0].attrs.href).split('\n')[1];
  await pressTwice(root, 0, 'この人のリンク');
  await pressTwice(root, 1, 'この人のリンク');
  assert.deepEqual([lineOf(0), lineOf(1)], [PERSON_URL('b'), PERSON_URL('c')]);
  await buttons(blocks(root)[0], 'この人のリンクを作り直す')[0].click();
  assert.equal(calls.length, 2, '作り直しの 1 回目の押下では作らない');
  assert.match(blocks(root)[0].textContent, /もう一度押すと、.*前のリンクは開けなくなります/);
  await buttons(blocks(root)[0], 'もう一度押すと')[0].click();
  assert.deepEqual(calls, [m.people[0].id, m.people[1].id, m.people[0].id]);
  assert.deepEqual([lineOf(0), lineOf(1)], [PERSON_URL('d'), PERSON_URL('c')], '作り直した人だけが新しいリンク');
  assert.equal(buttons(blocks(root)[0], 'この人のリンクを作り直す').length, 1, '確かめの文は実行後に元へ戻る');
  await pressTwice(root, 1, 'この人のリンクを作り直す');
  assert.equal(calls.length, 4);
  assert.match(root.textContent, /サーバーにまだこの予約が届いていません/);
  assert.equal(lineOf(1), PERSON_URL('c'), '作れなかったら、作る前のリンクのまま（サーバーで作り直せていないので、まだ開ける）');
});

/* ---------- お客さんの画面（walkin.html）---------- */
function bootGuest({ hash = `#w=${KEY('g')}`, replies }) {
  const nodes = {};
  const sent = [];
  const document = { body: new FNode('body'), documentElement: new FNode('html'), createElement: (t) => new FNode(t), getElementById: (id) => (nodes[id] = nodes[id] || new FNode('div')) };
  const store = memory();
  const history = { urls: [], replaceState: (a, b, url) => history.urls.push(url) };
  const ctx = vm.createContext({ document, Node: FNode, location: { origin: 'https://ask.reduxdive.com', pathname: '/walkin', hash }, history, navigator: { language: 'ja' },
    localStorage: memory(), sessionStorage: store, setTimeout, clearTimeout, AbortController, TextEncoder, URL, btoa, console, addEventListener() {},
    fetch: async (path, init) => { const body = JSON.parse(init.body); sent.push({ path, body }); const r = replies(body); return new Response(JSON.stringify(r.body), { status: r.status }); } });
  ctx.window = ctx;
  ['core.js', 'ask-api.js', 'walkin-page.js'].forEach(f => vm.runInContext(readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f }));
  return { root: nodes.walkin, sent, history, store, R: ctx.REDUX };
}
const VIEW = { shop: 'B マリン（見本）', today: '2026-10-27', trips: [{ id: 't1', date: '2026-10-27', start: '08:30', tour: '体験ダイビング', kind: 'dive' },
  { id: 't2', date: '2026-10-28', start: '09:00', tour: 'ボートスノーケル', kind: 'snorkel' }] };

test('お客さんの画面: 鍵を URL から消し、便の日付・時刻・ツアーの名前だけを出す。便を選び、名簿の項目（健康は聞かない）を入れて送ると、決めた項目だけが /api/walkin に行く', async () => {
  const g = bootGuest({ replies: (b) => (b.action === 'view' ? { status: 200, body: VIEW } : { status: 202, body: { ok: true } }) });
  await settle();
  assert.deepEqual(g.history.urls, ['/walkin'], '鍵を URL と履歴から消す');
  assert.equal(g.store.getItem('redux-walkin-key'), KEY('g'), 'このタブの間だけ鍵を覚える');
  assert.deepEqual(g.sent[0], { path: '/api/walkin', body: { k: KEY('g'), action: 'view' } });
  assert.match(g.root.textContent, /8:30\s*体験ダイビング/);
  assert.match(g.root.textContent, /今日/);
  assert.match(g.root.textContent, /明日/);
  assert.match(g.root.textContent, /スタッフに聞く/);
  assert.equal(buttons(g.root, '次へ')[0].attrs.disabled === undefined && buttons(g.root, '次へ')[0].disabled, true, '選ぶまで次へは押せない');
  await buttons(g.root, '体験ダイビング')[0].click();
  await buttons(g.root, '次へ')[0].click();
  assert.doesNotMatch(g.root.textContent, /既往|健康の質問|病気|服薬/, '健康の質問はしない');
  assert.match(g.root.textContent, /健康のことは、ここでは聞きません/);
  const inputs = all(g.root, 'input');
  const type = (i, v) => { inputs[i].value = v; return Promise.all((inputs[i].listeners.input || []).map(fn => fn({ target: inputs[i] }))); };
  /* name, people, birthDate, address, 緊急(名前, ご関係, 電話), email */
  await type(0, '見本 太郎'); await type(1, '2'); await type(2, '1990-05-01'); await type(3, '那覇市'); await type(4, '見本 花子'); await type(5, '妻'); await type(6, '090'); await type(7, 'a@b.example');
  await all(g.root, 'form')[0].listeners.submit[0]({ preventDefault() {} });
  await settle();
  assert.deepEqual(g.sent[1].body, { k: KEY('g'), action: 'submit', tripId: 't1', name: '見本 太郎', people: 2, email: 'a@b.example', birthDate: '1990-05-01', address: '那覇市',
    emergency: { name: '見本 花子', relation: '妻', phone: '090' } });
  assert.match(g.root.textContent, /送りました/);
  assert.equal(g.store.getItem('redux-walkin-key'), null, '送ったあとは鍵を覚えない');
});

test('お客さんの画面: 空の欄は送る前に知らせる。鍵が無効（404）・件数の上限（429）・電波なしは、それぞれの文を出す', async () => {
  const g = bootGuest({ replies: (b) => (b.action === 'view' ? { status: 200, body: VIEW } : { status: 400, body: { error: 'input', problems: ['birthDate'] } }) });
  await settle();
  await buttons(g.root, 'スタッフに聞く')[0].click();
  await buttons(g.root, '次へ')[0].click();
  await all(g.root, 'form')[0].listeners.submit[0]({ preventDefault() {} });
  assert.equal(g.sent.length, 1, '空のままでは送らない');
  assert.match(g.root.textContent, /確かめてください: 代表者のお名前/);
  const gone = bootGuest({ replies: () => ({ status: 404, body: { error: 'gone' } }) });
  await settle();
  assert.match(gone.root.textContent, /この QR は使えません/);
  const limit = bootGuest({ replies: () => ({ status: 429, body: { error: 'limit' } }) });
  await settle();
  assert.match(limit.root.textContent, /これ以上受け付けられません/);
  const none = bootGuest({ hash: '', replies: () => ({ status: 200, body: VIEW }) });
  await settle();
  assert.equal(none.sent.length, 0, '鍵が無ければ呼ばない');
  assert.match(none.root.textContent, /この QR は使えません/);
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log(`ok   ${t.name}`); } catch (e) { failed += 1; console.log(`FAIL ${t.name}\n     ${e.stack || e.message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
