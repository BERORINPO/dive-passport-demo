// 名簿の見本を作る（Playwright MCP の browser_run_code_unsafe に filename で渡す。node では動かない。手順は docs/sample-roster.md）。
// 写真と PDF はリポジトリの外に置く（OUT・PHOTO）。中身は架空の人の申込書だけ。
// 先に端末で道具を起動しておく（見本ごとに起動し直す）:
//   node tools/build-site.mjs && SHOP_NAME="〔お店の名前〕" node tools/serve-dist.mjs 8107 --real-ai
// 使い方: 下の CONFIG を書き換えて 2 回走らせる。
//   1 回目 STEP = 'mask'  … 写真を入れて四角を置き、mask.png を書いて止まる（AI には送らない）。mask.png を見て、健康の欄が全部隠れているか確かめる
//   2 回目 STEP = 'send'  … 同じ四角で AI に読ませ、名簿を PDF にする。事業者の名前と人数が合っているかを返す
// 四角は写真全体に対する割合（左上 0,0 〜 右下 1,1）。初めの四角（見本の書式の位置）は消してから置く。
// 毎回新しいブラウザの窓（保存の無い context）で開き、終わったら閉じる（前の見本を混ぜない）。
async (page) => {
  const CONFIG = {
    STEP: 'mask',                                            // 'mask' か 'send'
    SHOP_NAME: '〔お店の名前〕',                               // 道具を起動したときの SHOP_NAME と同じにする
    PHOTO: 'U:/dev/artifacts/omnes-demand-2026-10/marketing/見本づくり/受け取り/〔写真〕.jpg',
    MASKS: [[0.52, 0.32, 0.99, 0.63]],                         // [左, 上, 右, 下]。健康の欄が 2 か所なら 2 つ書く
    OUT: 'U:/dev/artifacts/omnes-demand-2026-10/marketing/見本づくり/',
    URL: 'http://localhost:8107/'
  };

  const ctx = await page.context().browser().newContext({ viewport: { width: 1280, height: 900 } });
  /* mask の回は名簿を道具に書き戻さない（書き戻すと send の回に予約が 2 つになる）。読むのは通す */
  if (CONFIG.STEP !== 'send') await ctx.route('**/api/roster', (r) => (r.request().method() === 'PUT' ? r.abort() : r.continue()));
  const p = await ctx.newPage();
  try {
    await p.goto(CONFIG.URL);
    await p.getByRole('button', { name: '画面の切り替え' }).click().catch(() => {});
    await p.getByRole('tab', { name: '予約と名簿' }).click();
    await p.waitForTimeout(1500);
    const shopShown = (await p.locator('main').innerText()).split('\n')[0].trim();
    if (shopShown !== CONFIG.SHOP_NAME) return { ok: false, why: `店の名前が「${shopShown}」。SHOP_NAME を付けて道具を起動し直す` };
    if ((await p.getByText('まだ予約がありません').count()) === 0) return { ok: false, why: '前の見本が残っている。道具を止めて起動し直す' };

    await p.getByRole('button', { name: '紙の申込書で聞く' }).click();
    await p.getByRole('button', { name: '本物にする' }).click();
    await p.getByRole('button', { name: '電話の予約' }).click();
    await p.getByRole('textbox', { name: '集合の時刻（分かれば）' }).fill('08:30');
    await p.getByRole('textbox', { name: '代表者の名前' }).fill('申込書の見本');
    await p.getByRole('button', { name: '予約を入れる' }).click();
    await p.waitForTimeout(500);
    await p.getByRole('button', { name: '今日の名簿' }).first().click();
    await p.getByRole('button', { name: '名簿の取り込み' }).click();
    await p.getByRole('button', { name: '申込書を撮る' }).click();
    await p.locator('input[type=file]').setInputFiles(CONFIG.PHOTO);
    await p.waitForTimeout(1500);

    await p.getByRole('button', { name: '最後の四角を消す' }).click();
    const cv = p.locator('canvas').first();
    await cv.scrollIntoViewIfNeeded();
    const b = await cv.boundingBox();
    for (const [x0, y0, x1, y1] of CONFIG.MASKS) {
      await p.mouse.move(b.x + x0 * b.width, b.y + y0 * b.height);
      await p.mouse.down();
      await p.mouse.move(b.x + x1 * b.width, b.y + y1 * b.height, { steps: 10 });
      await p.mouse.up();
    }
    await cv.screenshot({ path: CONFIG.OUT + 'mask.png' });
    if (CONFIG.STEP !== 'send') return { ok: true, step: 'mask', check: CONFIG.OUT + 'mask.png を見て、健康の欄（質問の文の頭の字も）が隠れているか確かめる' };

    await p.getByText('健康の欄が黒く隠れているのを確かめた').click();
    await p.getByRole('button', { name: 'AI に送る写真を作る' }).click();
    await p.getByRole('button', { name: 'この写真を AI で読む' }).click();
    const done = p.getByRole('button', { name: '名簿に入れる' });
    const seen = p.getByText('健康の情報が見えた');
    await Promise.race([done.waitFor({ timeout: 40000 }), seen.waitFor({ timeout: 40000 })]);
    if (await seen.count()) return { ok: false, why: 'AI が健康の情報が見えたと答えた。四角を広げて mask からやり直す' };
    const main = await p.locator('main').innerText();
    const at = main.indexOf('AI が申込書から読んだ結果');
    const reading = main.slice(at, main.indexOf('入れる人', at)).trim();
    await done.click();
    await p.getByRole('button', { name: 'あとで確かめる' }).click();
    await p.getByRole('button', { name: '予約の一覧に戻る' }).click();
    await p.getByRole('button', { name: '今日の名簿' }).first().click();
    await p.getByRole('button', { name: '名簿を印刷' }).click();
    await p.waitForTimeout(800);
    const paper = await p.locator('section.paper').innerText();
    const shopOk = paper.includes(`事業者 ${CONFIG.SHOP_NAME}`);
    const peopleOk = /人数 1\b/.test(paper);
    const pdf = `${CONFIG.OUT}名簿の見本_${CONFIG.SHOP_NAME}.pdf`;
    await p.emulateMedia({ media: 'print' });
    await p.pdf({ path: pdf, format: 'A4', landscape: true, printBackground: true });
    return { ok: shopOk && peopleOk, step: 'send', pdf, shopOk, peopleOk, reading };
  } finally {
    await ctx.close();
  }
}
