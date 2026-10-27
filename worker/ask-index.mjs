/* お客さんのリンクだけの Worker の起動（entry）。設定は wrangler.ask.jsonc（Access を付けない別の Worker）。
   置くのは ask.html と、それが読むファイル（dist-ask/）と /api/ask だけ。名簿の D1 はお店の Worker と同じ物を使う。
   中身は handler.mjs の handleAsk。お店の Worker の Access の設定には触らない（plan/meibo.md「お客さんのリンク」） */
import { handleAsk } from './handler.mjs';

const LIVE = { now: () => Date.now() };

export default {
  fetch: (request, env) => handleAsk(request, env, LIVE)
};
