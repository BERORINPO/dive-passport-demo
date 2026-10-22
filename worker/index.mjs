/* Cloudflare Worker の起動（entry）。本物の fetch と時計をつなぐだけ。中身は handler.mjs */
import { handle } from './handler.mjs';

const LIVE = { fetch: (input, init) => fetch(input, init), now: () => Date.now() };

export default {
  fetch: (request, env) => handle(request, env, LIVE)
};
