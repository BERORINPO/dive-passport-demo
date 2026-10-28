// 答えの選び方を、質問の一覧（match-cases.mjs）で採点する。
//   node test/match.eval.mjs         … 前の選び方と今の選び方を並べて出す
//   node test/match.eval.mjs --check … 確認用（test と blind）の誤答が、下の上限を超えたら失敗にする（悪くなっていないかの見張り）
// 数え方:
//   正解   = 合う答えを出した / 答えが無い質問をお店に回した
//   候補   = 「もしかして」で、正しい答えを候補に入れた（客が選べば済む）
//   取り逃し = 答えがあるのに、お店に回した・候補に入れなかった
//   誤答   = 違う答えを出した / 答えが無いのに何か答えた（一番避けたい失敗）
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { dev, test } from './match-cases.mjs';
import { OLD_KEYS } from './match-old-keys.mjs';
import { blind } from './match-blind.mjs';

const ROOT = new URL('../', import.meta.url);
globalThis.window = globalThis;
for (const f of ['js/core.js', 'js/data.js', 'js/data-match.js', 'js/match.js']) {
  vm.runInThisContext(readFileSync(new URL(f, ROOT), 'utf8'));
}
const R = globalThis.REDUX;

/* 前の選び方: 言葉が 1 つでも当たれば、当たりが一番多い答えを出す */
function oldMatch(question) {
  const norm = (s) => s.toLowerCase().replace(/[\s　]/g, '');
  const q = norm(question);
  const best = R.FAQ.reduce((acc, item) => {
    const score = OLD_KEYS[item.id].reduce((n, k) => n + (q.includes(norm(k)) ? 1 : 0), 0);
    return score > acc.score ? { item, score } : acc;
  }, { item: null, score: 0 });
  return best.item ? { status: 'hit', item: best.item, candidates: [] } : { status: 'none', item: null, candidates: [] };
}

function grade(match, cases) {
  const tally = { correct: 0, maybe: 0, missed: 0, wrong: 0 };
  const wrongs = [];
  for (const [q, expect] of cases) {
    const r = match(q);
    const ids = r.candidates.map(c => c.id);
    let kind;
    if (r.status === 'hit') kind = r.item.id === expect ? 'correct' : 'wrong';
    else if (r.status === 'maybe') kind = expect === 'none' || ids.includes(expect) ? 'maybe' : 'missed';
    else kind = expect === 'none' ? 'correct' : 'missed';
    tally[kind] += 1;
    if (kind === 'wrong' || kind === 'missed') wrongs.push(`${kind === 'wrong' ? '誤答' : '取り逃し'}: ${q} → ${r.status}${r.item ? ` ${r.item.id}` : ''}${ids.length ? ` [${ids.join(',')}]` : ''}（正しくは ${expect}）`);
  }
  return { tally, wrongs, n: cases.length };
}

const fmt = ({ tally, n }) => `正解 ${tally.correct} ・ 候補 ${tally.maybe} ・ 取り逃し ${tally.missed} ・ 誤答 ${tally.wrong} （${n} 問）`;

const rows = [['前の選び方', oldMatch], ['今の選び方', R.matchFaq]];
/* 2026-10-20 時点の誤答の数。blind の 2 つ（シャワーとロッカー → 集合、ツアーの料金 → 追加料金）は分かっていて残してある。
   画面では「『○○』へのお店の答え」と出し、違えばすぐお店に回せるので、客は気づける。減らせたらこの数も下げる */
const MAX_WRONG = { '確認用 test': 0, '別の AI が作った blind': 2 };
let over = [];
for (const [setName, cases] of [['調整用 dev', dev], ['確認用 test', test], ['別の AI が作った blind', blind]]) {
  console.log(`\n== ${setName}`);
  for (const [name, fn] of rows) {
    const g = grade(fn, cases);
    console.log(`${name}: ${fmt(g)}`);
    if (name === '今の選び方') {
      g.wrongs.forEach(w => console.log(`   ${w}`));
      if (setName in MAX_WRONG && g.tally.wrong > MAX_WRONG[setName]) over.push(`${setName}: 誤答 ${g.tally.wrong}（上限 ${MAX_WRONG[setName]}）`);
    }
  }
}
if (over.length) console.log(`
誤答が上限を超えた: ${over.join(' / ')}`);
if (process.argv.includes('--check') && over.length) process.exit(1);
