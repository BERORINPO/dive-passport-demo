/* Access を付けない Worker（redux-ask）の起動（entry）。設定は wrangler.ask.jsonc。
   置くのは ask.html と、それが読むファイル（dist-ask/）と、お客さんのリンクの /api/ask と、お店のサイトの予約フォームの /api/bookings と、外の死活監視の /api/health だけ。
   D1 は持たない。名簿・鍵の行・お店の一覧は、Service Binding の SHOP（お店の Worker の ShopRpc）の 6 つの口の向こう（2026-10-28 ask-service-binding・walkin-qr）。
   中身は public-handler.mjs の handlePublic。お店の Worker の Access の設定には触らない
   （plan/meibo.md「お客さんのリンク」・plan/auto.md「予約を受ける口」） */
import { handlePublic } from './public-handler.mjs';

/* Turnstile の確かめ（site-guard.mjs）は io.fetch で外に出る */
const LIVE = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  fetch: (request, env) => handlePublic(request, env, LIVE)
};
