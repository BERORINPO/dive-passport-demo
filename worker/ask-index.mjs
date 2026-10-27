/* Access を付けない Worker の起動（entry）。設定は wrangler.ask.jsonc。
   置くのは ask.html と、それが読むファイル（dist-ask/）と、お客さんのリンクの /api/ask と、お店のサイトの予約フォームの /api/bookings だけ。
   名簿の D1 はお店の Worker と同じ物を使う。中身は handler.mjs の handlePublic。お店の Worker の Access の設定には触らない
   （plan/meibo.md「お客さんのリンク」・plan/auto.md「予約を受ける口」） */
import { handlePublic } from './handler.mjs';

/* Turnstile の確かめ（site-guard.mjs）は io.fetch で外に出る */
const LIVE = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  fetch: (request, env) => handlePublic(request, env, LIVE)
};
