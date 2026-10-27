/* Cloudflare Worker の起動（entry）。本物の fetch と時計をつなぐだけ。中身は handler.mjs と auto.mjs（Cron と届いたメール） */
import { handle } from './handler.mjs';
import { scheduled, receiveMail } from './auto.mjs';

const LIVE = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  fetch: (request, env) => handle(request, env, LIVE),
  scheduled: (event, env, ctx) => { ctx.waitUntil(scheduled(env, LIVE)); },
  email: (message, env) => receiveMail(message, env, LIVE)
};
