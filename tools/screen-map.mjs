// REDUX の画面遷移図（draw.io）を作る。画面の一覧と移り先は js/booking.js の render と各 go('...') から拾った（2026-10-28 の main d82fdb1）。
// 画面を足したら、nodes と edges に足して作り直す（図は手で直さない）。
//   node tools/screen-map.mjs → docs/flow/screen-transitions.drawio
//   画像: draw.io の desktop で -x -f png -e -b 20 -s 1.2 -o docs/flow/screen-transitions.drawio.png docs/flow/screen-transitions.drawio
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || new URL('../docs/flow/screen-transitions.drawio', import.meta.url);
const W = 230, H = 80;
/* 並べ方: 起点（予約の一覧・今日の名簿）から右へ木の形に広げ、線が隣の箱どうしだけを結ぶようにする */
const GX = [70, 360];
const C = [690, 980, 1270, 1560, 1850];
const R = Array.from({ length: 13 }, (_, i) => 150 + i * 130);
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#xa;');

const nodes = [
  /* お客さんの端末 */
  ['g1', GX[0], R[0], '予約の前に（お客さま タブ）\nツアー・よく聞かれること（リド）\n日にち・人数・健康の質問', 'guest'],
  ['g2', GX[0], R[1], '送ったあと\n受け付けた・次にすること', 'guest'],
  ['mail', GX[0], R[3], 'お客さんに届くメール\nお店の名前で、足りない項目だけ\n（予約の流れの予定どおり自動で届く）', 'guest'],
  ['a1', GX[1], R[2], 'ask.html（お客さんに聞く画面）\n「まだ」の所だけ入れる\n当日の朝に体調を答える', 'guest'],
  ['p1', GX[1], R[5], 'パスポート タブ\n作る・直す・QR を見せる', 'guest'],
  ['p2', GX[1], R[6], 'pass.html\n読み取り専用（他のお店のスマホ）', 'guest'],
  /* お店の端末 */
  ['s1', C[0], R[0], '受付 タブ\n予約前の確認の一覧・気づく印', 'shop'],
  ['l', C[0], R[2], '予約の一覧（予約と名簿 タブ）\n便ごとの時刻表・! 確かめる', 'hub'],
  ['b10', C[1], R[0], '書類の自動化（画面 10）\n送れたか分からない・送れなかった\n読めなかったメール', 'new'],
  ['f', C[1], R[1], '1 件の予約の流れ\n起きたこと・これからの予定', 'shop'],
  ['m', C[1], R[2], '予約メールの取り込み\n貼る → AI に送る前の文面\n（健康の行は外す）', 'shop'],
  ['ph', C[1], R[3], '電話の予約', 'shop'],
  ['pt', C[1], R[4], '済んだ便（7 日より前）', 'shop'],
  ['d', C[1], R[5], '今日の名簿\n潜水場所・ガイド・そろい具合', 'hub'],
  ['ak', C[2], R[1], 'お客さんに聞くリンク\nリンクを作る・写す', 'shop'],
  ['pp', C[2], R[4], '済んだ便の条例の名簿（紙）', 'paper'],
  ['in', C[2], R[5], '名簿の取り込み\n申込書・C カードを撮る\n健康の欄を塗る → AI が読む', 'shop'],
  ['pr', C[2], R[6], '条例の名簿（紙・A4 横）\n印刷・CSV', 'paper'],
  ['sp', C[2], R[7], '血中酸素を入れる', 'shop'],
  ['ca', C[2], R[8], '便の中止\n理由・知らせる先・文面', 'shop'],
  ['ics', C[2], R[9], 'カレンダー（.ics）・記録', 'shop'],
  ['sh', C[2], R[10], '乗り合い\n船・船を出す店・乗るお店', 'shop'],
  ['rv', C[3], R[5], '確かめる（v12）\n全部の項目をその場で直せる\n健康の 2 項目は直せない', 'new'],
  ['pa', C[3], R[10], '相乗りのお店（その店の役）', 'shop'],
  ['jo', C[3], R[11], '合同名簿（船の全員）', 'shop'],
  ['bo', C[3], R[12], '船の上で\nお店ごとに「全員戻った」', 'shop'],
  ['ppp', C[4], R[9], '相乗りのお店の名簿（紙）', 'paper'],
  ['pph', C[4], R[10], '写真で名前を渡す', 'shop'],
  ['jp', C[4], R[11], '合同名簿（紙・船の上の確認用）', 'paper'],
  ['co', C[4], R[12], '人数が合わない\n名前を呼んで「いた」', 'shop']
];

/* [から, へ, 文, 点線（端末をまたぐ・データが流れる）, 曲がり角] */
const side = 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;';
const edges = [
  ['g1', 'g2', '送る'], ['g2', 'a1', '名簿の項目も入れる'], ['mail', 'a1', 'リンクを開く'], ['p1', 'p2', 'QR を読む', true],
  ['g1', 's1', '送った内容がお店に入る', true], ['a1', 'l', '答えが名簿に入る', true],
  ['ak', 'a1', 'LINE・メールで送る', true, [[C[2] + W / 2, 132], [GX[1] + W / 2, 132]], 'exitX=0.5;exitY=0;entryX=0.5;entryY=0;'],
  ['l', 'b10', '開く', false, null, side], ['l', 'f', '流れを見る', false, null, side], ['l', 'm', 'メールを貼る', false, null, side],
  ['l', 'ph', '電話の予約', false, null, side], ['l', 'pt', '済んだ便を見る', false, null, side], ['l', 'd', '今日の名簿', false, null, side],
  ['b10', 'f', '流れを見る'], ['m', 'f', 'AI が読んで自動で入れる'], ['f', 'ak', 'リンク'], ['pt', 'pp', '印刷'],
  ['d', 'in', '名簿の取り込み', false, null, side], ['d', 'pr', '名簿を印刷', false, null, side], ['d', 'sp', '入れる', false, null, side],
  ['d', 'ca', '中止にする', false, null, side], ['d', 'ics', '書き出す・記録', false, null, side], ['d', 'sh', '乗り合い', false, null, side],
  ['in', 'rv', '確かめる'],
  ['sh', 'pa', '役で入れる', false, null, side], ['sh', 'jo', '合同名簿を見る', false, null, side], ['sh', 'bo', '船の上で', false, null, side],
  ['pa', 'ppp', '名簿を返す', false, null, side], ['pa', 'pph', '写真で渡す'], ['jo', 'jp', '印刷'], ['bo', 'co', '人数が合わない']
];

const STYLE = {
  guest: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E3F0F4;strokeColor=#3C6E7E;fontSize=12;',
  shop: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFDF8;strokeColor=#5F6B6E;fontSize=12;',
  hub: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFDF8;strokeColor=#11535F;strokeWidth=3;fontStyle=1;fontSize=12;',
  new: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFDF8;strokeColor=#2F6E46;strokeWidth=2;dashed=0;fontSize=12;',
  paper: 'shape=document;whiteSpace=wrap;html=1;boundedLbl=1;fillColor=#FFFFFF;strokeColor=#5F6B6E;fontSize=12;'
};

const cells = [];
cells.push(`<mxCell id="title" value="${esc('REDUX 画面遷移図（2026-10-28、main d82fdb1）')}" style="text;html=1;fontSize=20;fontStyle=1;align=left;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="40" y="10" width="900" height="34" as="geometry"/></mxCell>`);
cells.push(`<mxCell id="note" value="${esc('上のタブ: お客さま／パスポート／受付／予約と名簿。「デモの画面」でお客さんの画面とお店の画面を切り替える。実線 = 画面の中で移る、点線 = 端末をまたぐ（リンク・メール・データ）。太枠 = 起点の画面、緑の枠 = 10/28 に足した画面、波の形 = 紙に出す画面')}" style="text;html=1;fontSize=12;align=left;verticalAlign=middle;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="40" y="44" width="1900" height="30" as="geometry"/></mxCell>`);
cells.push(`<mxCell id="laneG" value="${esc('お客さんの端末（ログインなし）')}" style="swimlane;startSize=30;html=1;fillColor=#F2F8FA;strokeColor=#3C6E7E;fontStyle=1;fontSize=14;" vertex="1" parent="1"><mxGeometry x="40" y="90" width="590" height="960" as="geometry"/></mxCell>`);
cells.push(`<mxCell id="laneS" value="${esc('お店の端末（Cloudflare Access の内側）')}" style="swimlane;startSize=30;html=1;fillColor=#F7F3EC;strokeColor=#5F6B6E;fontStyle=1;fontSize=14;" vertex="1" parent="1"><mxGeometry x="660" y="90" width="1460" height="1720" as="geometry"/></mxCell>`);
for (const [id, x, y, label, kind] of nodes) {
  cells.push(`<mxCell id="${id}" value="${esc(label)}" style="${STYLE[kind]}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${W}" height="${H}" as="geometry"/></mxCell>`);
}
edges.forEach(([a, b, label, dashed, points, ports], i) => {
  const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;fontSize=11;endArrow=block;endFill=1;labelBackgroundColor=#FFFFFF;${ports || ''}${dashed ? 'dashed=1;strokeColor=#3C6E7E;' : 'strokeColor=#5F6B6E;'}`;
  const pts = points ? `<Array as="points">${points.map(([x, y]) => `<mxPoint x="${x}" y="${y}"/>`).join('')}</Array>` : '';
  cells.push(`<mxCell id="e${i}" value="${esc(label)}" style="${style}" edge="1" parent="1" source="${a}" target="${b}"><mxGeometry relative="1"${ports === side ? ' x="0.72"' : ''} as="geometry">${pts}</mxGeometry></mxCell>`);
});

const xml = `<mxfile host="drawio"><diagram id="screens" name="画面遷移図"><mxGraphModel adaptiveColors="auto" dx="2200" dy="1100" grid="1" gridSize="10" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel></diagram></mxfile>`;
writeFileSync(out, xml);
console.log(`wrote ${String(out)}: ${nodes.length} screens, ${edges.length} links`);
