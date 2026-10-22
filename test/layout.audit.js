/* 4 幅の確かめ（手で回す）。npm の部品を足さないため、ブラウザのコンソールに貼って使う。
   手順（design.md の「確かめ方」）:
     1. node tools/build-site.mjs && node tools/serve-dist.mjs で手元に配る
     2. ブラウザの幅を 320 / 375 / 414 / 768 にして、毎回読み込み直す
     3. このファイルの中身をコンソールに貼る（Claude Code では Browser の javascript_tool に渡す）
   各画面で見るもの: ページ全体の横送り・画面の外へはみ出す物・14px 未満の字（紙は除く）・ボタンの中の字のはみ出し・下の帯のボタンの高さ。
   見本のメールと写真で、予約の一覧 → メール → 写真 → 確かめる画面まで進む。押せなかったボタンは「no: 名前」で返す（文言が変わったらここも直す）
   予約を入れるので、そのブラウザの保存領域（localStorage）に見本の予約が残る。終わったら「デモの予約をすべて消す」を 2 回押すか、使い捨てのプロファイルで回す
   Safari では word-break: auto-phrase が効かず、2 行のボタンが文節の途中で折れる（はみ出しはしない）。iPhone で見るときはそこも見る */
(async () => {
  const wait = (ms = 300) => new Promise(r => setTimeout(r, ms));
  const SCROLLERS = '.paper__wrap, .tabs, .days, .ptabs, .chips, .table-wrap, .chat__log';   // 横に送る作りの所
  const audit = () => {
    const vw = document.documentElement.clientWidth;
    const all = [...document.querySelectorAll('body *')].filter(e => e.offsetParent || getComputedStyle(e).position === 'sticky');
    const show = (e) => `${e.className || e.tagName}「${e.textContent.trim().slice(0, 12)}」`;
    const wide = all.filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1 && !e.closest(SCROLLERS); }).slice(0, 4).map(show);
    const small = all.filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())
      && parseFloat(getComputedStyle(e).fontSize) < 14 && !e.closest('.paper, .board, .tagsheet')).slice(0, 4).map(e => `${show(e)} ${getComputedStyle(e).fontSize}`);
    const spill = all.filter(e => e.matches('button, .btn') && e.scrollWidth > e.clientWidth + 1 && !e.closest(SCROLLERS)).slice(0, 4).map(show);
    const dock = [...new Set([...document.querySelectorAll('.dock .btn')].filter(e => e.offsetParent).map(e => Math.round(e.getBoundingClientRect().height)))];
    const bad = [document.documentElement.scrollWidth > vw && 'ページが横に送れる', wide.length && `はみ出し ${wide}`, small.length && `14px 未満 ${small}`,
      spill.length && `ボタンの外へ ${spill}`, dock.some(h => h < 56) && `下の帯 ${dock}px`].filter(Boolean);
    return bad.length ? bad.join(' / ') : 'ok';
  };
  const missed = [];
  const click = async (label, ms = 400) => {
    const b = [...document.querySelectorAll('main button')].find(x => x.textContent.trim().startsWith(label) && !x.disabled);
    if (!b) { missed.push(label); return; }
    b.click(); await wait(ms);
  };
  const tick = () => document.querySelectorAll('main input[type=checkbox]').forEach(c => { if (!c.checked) c.click(); });
  const out = { width: document.documentElement.clientWidth };
  for (const t of ['guest', 'pass', 'shop', 'booking']) { REDUX.showTab(t); await wait(200); out[t] = audit(); }
  await click('メールを貼る'); await click('見本 1'); await click('AI に送る前の文面を見る'); out.mailPreview = audit();
  await click('この文面を AI で読む', 1200); out.mailResult = audit();
  await click('予約を入れる'); out.list = audit();
  await click('名簿の取り込み'); await click('申込書を撮る'); await click('見本 1', 1500); out.photoMask = audit();
  tick(); await wait(200);
  await click('AI に送る写真を作る', 1500); await click('この写真を AI で読む', 1500); out.photoResult = audit();
  tick(); await wait(200);
  await click('名簿に入れる', 800); out.review = audit();
  await click('あとで確かめる'); await click('予約の一覧に戻る'); await click('今日の名簿'); out.day = audit();
  await click('予約の一覧に戻る'); await click('乗り合い・札'); out.share = audit();
  if (missed.length) out.missed = missed.map(m => `no: ${m}`);
  console.table(out);
  return out;
})();
