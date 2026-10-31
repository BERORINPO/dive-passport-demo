// お店の一覧（D1 の shops。worker/migrations/0003_shops.sql、plan/server.md「お店ごと」）を足す・直す・消す SQL を作る。
// 入れた値を確かめてから、D1 のコンソール（Cloudflare の画面 → D1 → redux-rosters → Console）に貼る 1 文を出す。D1 には自分ではつながない。
// 使い方:
//   node tools/shop.mjs add --id shop-a --name "A ダイブ" --member staff@example.com [--member …] [--site https://shop-a.example.com] [--inbox a@reduxdive.com] [--sender fwd@shop-a.example.com] [--reply-to info@shop-a.example.com]
//   node tools/shop.mjs set-reply-to --id shop-a --reply-to info@shop-a.example.com   返信先（お客さんへのメールの Reply-To）だけを直す。いまある行の他の欄は変えない
//   node tools/shop.mjs paper --id shop-a --name "A ダイブ"   健康の質問を紙で聞く名簿で始める（試用の形。名簿がまだ無いお店だけ。もうあるお店は画面の「健康の質問（お店ごと）」で切り替える）
//   node tools/shop.mjs remove --id shop-a
//   node tools/shop.mjs keep-sample       見本の名簿（default）を、お店を足したあとも見えるようにする行（スタッフは --member で）
// add は同じ id があれば上書きする（--reply-to を付けないと、返信先も空に戻る。返信先だけ直すなら set-reply-to）。1 店目を足すと、見本（default）の名簿は一覧に無い限り誰からも見えなくなる
// 返信先が空のお店は、一覧が 1 店だけなら secret の REPLY_TO、2 店以上なら Reply-To を付けない。2 店目を足す前に、1 店目の返信先を入れておく
import { fileURLToPath } from 'node:url';
import { SHOP_ID, replyAddress } from '../worker/shop-core.mjs';
import '../worker/sync-core.mjs';

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

/* 返信先。Worker が読める形（shop-core.mjs の replyAddress）でなければ止める（読めない値を D1 に入れて、黙って付かなくなるのを防ぐ） */
const replyTo = (text) => {
  const v = replyAddress(String(text || ''));
  if (!v) throw new Error(`返信先のメールアドレスが読めない: ${text}`);
  return v.toLowerCase();
};

/* 引数を { cmd, id, name, members, sites, inbox, senders, replyTo } にする */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const out = { cmd, members: [], sites: [], senders: [], inbox: '', replyTo: '' };
  for (let i = 0; i < rest.length; i += 2) {
    const [k, v] = [rest[i], rest[i + 1]];
    if (v === undefined) throw new Error(`${k} の値が無い`);
    if (k === '--id') out.id = v;
    else if (k === '--name') out.name = v;
    else if (k === '--member') out.members.push(v);
    else if (k === '--site') out.sites.push(v);
    else if (k === '--inbox') out.inbox = v;
    else if (k === '--sender') out.senders.push(v);
    else if (k === '--reply-to') out.replyTo = v;
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
  if (a.cmd === 'set-reply-to') {
    if (!SHOP_ID.test(a.id || '')) throw new Error('--id は英小文字・数字・- の 40 字まで');
    return `UPDATE shops SET reply_to = ${q(replyTo(a.replyTo))} WHERE id = ${q(a.id)};`;
  }
  if (a.cmd === 'paper') return paperSql(a);
  if (a.cmd !== 'add') throw new Error('使えるのは add・set-reply-to・paper・remove・keep-sample');
  if (!SHOP_ID.test(a.id || '')) throw new Error('--id は英小文字・数字・- の 40 字まで');
  const name = String(a.name || '').trim();
  if (!name || name.length > 60) throw new Error('--name（お店の名前、60 字まで）が要る');
  if (!a.members.length) throw new Error('--member（ログインするスタッフのメール）が 1 つは要る');
  const members = [...new Set(a.members.map(m => email(m, 'スタッフ')))];
  const sites = [...new Set(a.sites.map(origin))];
  const inbox = a.inbox ? email(a.inbox, '受け口') : '';
  const senders = [...new Set(a.senders.map(m => email(m, '送り主')))];
  const reply = a.replyTo ? replyTo(a.replyTo) : '';
  const cols = [q(a.id), q(name), q(JSON.stringify(members)), q(JSON.stringify(sites)), q(inbox), q(JSON.stringify(senders)), q(reply)];
  return `INSERT INTO shops (id, name, members, sites, inbox, senders, reply_to) VALUES (${cols.join(', ')}) ` +
    'ON CONFLICT(id) DO UPDATE SET name = excluded.name, members = excluded.members, sites = excluded.sites, inbox = excluded.inbox, senders = excluded.senders, reply_to = excluded.reply_to;';
}

/* 試用のお店は健康の質問を紙で聞く（plan/meibo.md「健康を紙で聞く」、決定ログ 2026-11-01 trial-health-paper）。
   名簿がまだ無いお店に、紙の印と切り替えの記録だけの名簿を置く 1 文。名簿がもうあれば何もしない（ON CONFLICT DO NOTHING。中身を消さない）。
   見本（default）には使わない（デモはアプリで聞く） */
export function paperSql(a, at = new Date().toISOString()) {
  if (!SHOP_ID.test(a.id || '') || a.id === 'default') throw new Error('--id は英小文字・数字・- の 40 字まで（見本の default は除く）');
  const name = String(a.name || '').trim();
  if (!name || name.length > 60) throw new Error('--name（お店の名前、60 字まで）が要る');
  const R = globalThis.REDUX;
  const state = R.rosterCore.setHealthPaper(R.roster.blankState(name), { paper: true, at });
  if (!R.roster.validateState(state).ok) throw new Error('名簿の形が合わない');
  return `INSERT INTO rosters (shop, version, state, updated_at) VALUES (${q(a.id)}, 1, ${q(JSON.stringify(state))}, ${q(at)}) ON CONFLICT(shop) DO NOTHING;`;
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
