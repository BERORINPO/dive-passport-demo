/* Cloudflare Worker の起動（entry）。本物の fetch と時計をつなぐだけ。中身は handler.mjs と auto.mjs（Cron と届いたメール）。
   ShopRpc は redux-ask が Service Binding で呼ぶ口（shop-rpc.mjs。wrangler.ask.jsonc の services） */
import { handle } from './handler.mjs';
import { scheduled, receiveMail } from './auto.mjs';

export { ShopRpc } from './shop-rpc.mjs';

const LIVE = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  fetch: (request, env) => handle(request, env, LIVE),
  scheduled: (event, env, ctx) => { ctx.waitUntil(scheduled(env, LIVE)); },
  email: (message, env) => receiveMail(message, env, LIVE)
};
