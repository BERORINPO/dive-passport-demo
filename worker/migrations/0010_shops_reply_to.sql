-- お店ごとの返信先（Reply-To）。お客さんへの連絡メール（お願い・もう一度・当日の質問）に付けるアドレスで、お客さんの返信（体調などを含む）をそのお店に届ける。
-- 前は secret の REPLY_TO 1 つを全店に付けていたので、2 店目からは別のお店のお客さんの返信が 1 店目に届いた。
-- 空のお店: 一覧が 1 店だけなら今までどおり secret の REPLY_TO、2 店以上なら Reply-To を付けない（別のお店に流さない。worker/shop-core.mjs の replyToFor）。
-- 入れ方: node tools/shop.mjs set-reply-to --id <お店> --reply-to <アドレス>（出た 1 文を D1 のコンソールに貼る）。
-- 欄を足すだけなので、前の版の Worker が動いたままでも先に流せる。ただし新しい版の Worker は、この欄が無い D1 では一覧を読めず 503 になるので、必ず先に流す
ALTER TABLE shops ADD COLUMN reply_to TEXT NOT NULL DEFAULT '';
