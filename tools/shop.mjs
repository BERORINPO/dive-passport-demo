// お店の一覧（D1 の shops。worker/migrations/0003_shops.sql、plan/server.md「お店ごと」）を足す・直す・消す SQL を作る。
// 入れた値を確かめてから、D1 のコンソール（Cloudflare の画面 → D1 → redux-rosters → Console）に貼る 1 文を出す。D1 には自分ではつながない。
// 使い方:
//   node tools/shop.mjs add --id shop-a --name "A ダイブ" --member staff@example.com [--member …] [--site https://shop-a.example.com] [--inbox a@reduxdive.com] [--sender fwd@shop-a.example.com]
//   node tools/shop.mjs remove --id shop-a
//   node tools/shop.mjs keep-sample       見本の名簿（default）を、お店を足したあとも見えるようにする行（スタッフは --member で）
// add は同じ id があれば上書きする。1 店目を足すと、見本（default）の名簿は一覧に無い限り誰からも見えなくなる
import { fileURLToPath } from 'node:url';
import { SHOP_ID } from '../worker/shop-core.mjs';

const EMAIL = /^[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+$/;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function origin(text) {
  let u;
  try { u = new URL(text); } catch (e) { throw new Error(`サイトの住所が読めない: ${text}`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) throw new Error(`サイトは https だけ: ${text}`);
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`サイトは住所の頭だけ（パスを付けない）: ${text}`);
  return u.origin;
}
const email = (text, what) => {
  const e = String(text || '').trim().toLowerCase();
  if (!EMAIL.test(e)) throw new Error(`${what}のメールアドレスが読めない: ${text}`);
  return e;
};

/* 引数を { cmd, id, name, members, sites, inbox, senders } にする */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const out = { cmd, members: [], sites: [], senders: [], inbox: '' };
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]];
    if (v === undefined) throw new Error(`${k} の値が無い`);
    if (k === '--id') out.id = v;
    else if (k === '--name') out.name = v;
    else if (k === '--member') out.members.push(v);
    else if (k === '--site') out.sites.push(v);
    else if (k === '--inbox') out.inbox = v;
    else if (k === '--sender') out.senders.push(v);
    else throw new Error(`知らない指定: ${k}`);
  }
  return out;
}

/* SQL を 1 文作る。値が合わなければ例外 */
export function shopSql(a) {
  if (a.cmd === 'keep-sample') a = { ...a, cmd: 'add', id: 'default', name: a.name || 'B マリン（見本）' };
  if (a.cmd === 'remove') {
    if (!SHOP_ID.test(a.id || '')) throw new Error('--id は英小文字・数字・- の 40 字まで');
    return `DELETE FROM shops WHERE id = ${q(a.id)};`;
  }
  if (a.cmd !== 'add') throw new Error('使えるのは add・remove・keep-sample');
  if (!SHOP_ID.test(a.id || '')) throw new Error('--id は英小文字・数字・- の 40 字まで');
  const name = String(a.name || '').trim();
  if (!name || name.length > 60) throw new Error('--name（お店の名前、60 字まで）が要る');
  if (!a.members.length) throw new Error('--member（ログインするスタッフのメール）が 1 つは要る');
  const members = [...new Set(a.members.map(m => email(m, 'スタッフ')))];
  const sites = [...new Set(a.sites.map(origin))];
  const inbox = a.inbox ? email(a.inbox, '受け口') : '';
  const senders = [...new Set(a.senders.map(m => email(m, '送り主')))];
  const cols = [q(a.id), q(name), q(JSON.stringify(members)), q(JSON.stringify(sites)), q(inbox), q(JSON.stringify(senders))];
  return `INSERT INTO shops (id, name, members, sites, inbox, senders) VALUES (${cols.join(', ')}) ` +
    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, members = excluded.members, sites = excluded.sites, inbox = excluded.inbox, senders = excluded.senders;';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(shopSql(parseArgs(process.argv.slice(2))));
    console.error('↑ この 1 文を D1 のコンソール（redux-rosters）に貼って Execute。スタッフは Access の Policy と ALLOWED_EMAILS にも足す');
  } catch (e) {
    console.error(`止めました: ${e.message}`);
    process.exit(1);
  }
}
