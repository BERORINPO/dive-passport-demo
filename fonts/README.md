# fonts/

BIZ UDPGothic（400・700）と BIZ UDGothic（700。英数字の束だけ）。`css/fonts.css` が読む。

- 出どころ: Google Fonts（2026-10-21 に取得。Yosuke が了承）。`tools/get-fonts.mjs` で、Google の CSS に並んだ woff2 を全部取り、`<書体>-<太さ>-<束>.woff2` に名前を付け直した。字の分け方（unicode-range）は Google と同じ
- 作り直すとき: `https://fonts.googleapis.com/css2?family=BIZ+UDGothic:wght@700&family=BIZ+UDPGothic:wght@400;700&display=swap` を、新しい Chrome の User-Agent を付けて取る（付けないと woff2 でない CSS が返る）。それを `node tools/get-fonts.mjs <取った CSS> fonts css/fonts.css` に渡し、BIZ UDGothic の latin・latin-ext 以外の束を外す
- 外から読まない理由: spec/architecture.md の表 1 の注。取りに行った束から、画面に出た字・打った字が分かる
- 大きさ: 250 ファイル・約 5.5MB。画面が取りに行くのは、出ている字を含む束だけ（予約の画面で約 56 個、パスポートの画面で約 28 個）
- BIZ UDGothic は数字の欄にだけ使う（design.md）ので、latin と latin-ext の束だけ置く。それ以外の字は BIZ UDPGothic で描かれる

## ライセンス

SIL Open Font License 1.1。ライセンス本文は同じ場所の `OFL.txt`（google/fonts の `ofl/bizudpgothic/OFL.txt` を 2026-10-21 に取得。`ofl/bizudgothic/OFL.txt` も同じ中身）。OFL.txt の 1 行目の URL は、元の書き方のまま（mincho になっている）。

- Copyright 2022 The BIZ UDGothic Project Authors (https://github.com/googlefonts/morisawa-biz-ud-gothic)
- 各ファイルの中（name の表）にも、上の著作権の行と OFL の URL が入っている
- 字体だけを売ることはできない。こちらでは手を加えていない。Google が束に分けた物（OFL でいう改変版）をそのまま配っている
- 中身の指紋は `SHA256SUMS`（`node tools/font-sums.mjs` で作る。test/arch.check.mjs が突き合わせる）。取り直したら、差分を見てから commit する
- パスポートの画面（pass.html）は、この字体を読まない（spec/architecture.md）
