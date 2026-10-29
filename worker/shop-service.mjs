/* redux-ask（Access なし）がお店の Worker を呼ぶ 7 つの口（entry。お店の Worker 側）。D1・名簿・お店の一覧に触れるのはここから先だけで、
   redux-ask は D1 の binding を持たない（SEC-13。2026-10-28 ask-service-binding）。
   - askView(hash)                       お客さんのリンクを開く。鍵の SHA-256 から、名前と聞く項目の名前だけを返す
   - askApply(hash, req, origin)         リンクから答える・1 人ずつのリンクを作る（req は鍵を除いた本文）
   - siteHosts(origin)                   予約フォームのサイト（origin）が、どれかのお店の物か。Turnstile の確かめに使うホスト名を返す
   - siteBooking(origin, given)          サイトの予約を、その origin のお店の名簿に入れる（Turnstile と回数は redux-ask が先にかける）
   - walkinView(hash)                    店頭の QR を開く。鍵の SHA-256 から、お店の名前と今日・明日の便の日付・時刻・ツアーの名前だけを返す
   - walkinSubmit(hash, req)             店頭で入れた項目を、名簿と同じ検査にかけて「店頭で入れた人」に置く（名簿の本体には入れない）
   - intakeBooking(hash, given, idem)    予約の受け口 API（POST /api/v1/bookings）。API キーの SHA-256 から、そのお店の名簿に予約を入れる（決定ログ 2026-10-28 intake-api）
   - trialView(t) / trialAsk(t, req)     実在のお店の試し版（trial.html）。鍵から公開の事実だけを返す・AI で答える（名簿・D1 には触れない。決定ログ 2026-10-29 trial-shops）
   どの口も { status, body, note } を返す（siteHosts は { ok, hosts, note } か { ok: false, status, body, note }）。note はログに足す短い理由で、
   中身・名前・メールアドレスは入れない。呼び手が送ってくる値も信じない: 形を確かめ直し（ask-input.mjs）、お店は origin と鍵の行から自分で決める。
   Cloudflare の口は shop-rpc.mjs（WorkerEntrypoint）。ここは素のクラスで、テストは直に呼ぶ（外との境目の見本は fakes.mjs の fakeShopBinding） */
import { askView, askApply } from './ask-route.mjs';
import { takeSiteBooking } from './auto.mjs';
import { HASH_RE, checkApply, checkWalkinApply, idemKeyOf } from './ask-input.mjs';
import { walkinView, walkinSubmit } from './walkin-route.mjs';
import { intakeBooking } from './intake-route.mjs';
import { listShops, shopsWhy } from './shop-db.mjs';
import { shopForOrigin, sitesOf, nameOf } from './shop-core.mjs';
import { TRIAL_SHOPS } from './trial-shops.mjs';
import { checkTrial, trialFor, trialView, trialFaqs, trialLimits } from './trial-core.mjs';
import { checkGuestRequest, guestAnswerFrom } from './guest-ai-core.mjs';
import { periods } from './read-core.mjs';
import { askModel } from './ask.mjs';

const ORIGIN_RE = /^https?:\/\/[A-Za-z0-9.-]{1,120}(?::\d{1,5})?$/;

const dbReady = (env) => Boolean(env.DB && typeof env.DB.prepare === 'function');
const refuse = (status, error, why) => ({ status, body: { error }, note: { why } });
const hostOf = (site) => { try { return new URL(site).hostname.toLowerCase(); } catch (e) { return ''; } };

/* 一覧が使えない・サイトがどのお店の物でもない、のとき { res }（siteHosts は { ok: false, ...res }）。使えるとき { shops, shop } */
async function shopOfOrigin(env, origin) {
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) return { res: refuse(403, 'origin', 'origin') };
  let shops;
  try { shops = await listShops(env.DB, env); } catch (e) { const why = shopsWhy(e, 'db'); return { res: refuse(503, why === 'db' ? 'db' : 'shops', why) }; }
  const shop = shopForOrigin(shops, origin);
  return shop ? { shops, shop } : { res: refuse(403, 'origin', 'origin') };
}

export class ShopService {
  constructor(env, io) {
    this.env = env;
    this.io = io;
  }

  async askView(hash) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const note = {};
    return { ...(await askView(this.env, this.io, note, hash)), note };
  }

  async askApply(hash, req, origin) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const checked = checkApply(req);
    if (!checked.ok) return refuse(400, 'input', `input-${checked.error}`);
    if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) return refuse(400, 'input', 'input-origin');
    const note = {};
    return { ...(await askApply(this.env, this.io, note, hash, checked, origin)), note };
  }

  /* 店頭の QR（決定ログ 2026-10-28 walkin-qr）。walkinView はお店の名前と今日・明日の便の日付・時刻・ツアーの名前だけを返す */
  async walkinView(hash) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const note = {};
    return { ...(await walkinView(this.env, this.io, note, hash)), note };
  }

  /* walkinSubmit は店頭で入れた項目を、名簿と同じ検査にかけて walkin_pending に置く（名簿の本体には入れない） */
  async walkinSubmit(hash, req) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    const checked = checkWalkinApply(req);
    if (!checked.ok) return refuse(400, 'input', `input-${checked.error}`);
    const note = {};
    return { ...(await walkinSubmit(this.env, this.io, note, hash, req)), note };
  }

  /* 予約の受け口 API。hash は redux-ask が Authorization の鍵から作った SHA-256、given は JSON にした本文、idem は Idempotency-Key（無ければ ''）。
     お店は鍵の行から決める（呼び手が送ってくる値では決めない）。本文の検査はここでかけ直す */
  async intakeBooking(hash, given, idem) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) return refuse(400, 'input', 'input-hash');
    if (!idemKeyOf(idem).ok) return refuse(400, 'input', 'input-idem');
    const note = {};
    return { ...(await intakeBooking(this.env, this.io, note, hash, given, idem)), note };
  }

  /* 試し版を開く。公開の事実だけ（ツアー・料金・集合・持ち物・質問の見出し） */
  trialView(t) {
    const p = trialFor(this.trialShops(), t);
    return p ? { status: 200, body: trialView(p), note: { shop: `trial~${p.id}` } } : refuse(404, 'trial', 'trial-key');
  }

  /* 試し版の AI。req は { kind: 'faq', question } か { kind: 'fill', text }。お店の答えの一覧は鍵から自分で引く（呼び手が送った一覧は使わない）。
     体のことに触れた質問は AI を呼ばずに返す。上限は試し版ごと（`trial~<id>`）に、予約メールの読み取りと別に数える */
  async trialAsk(t, req) {
    const p = trialFor(this.trialShops(), t);
    if (!p) return refuse(404, 'trial', 'trial-key');
    const checked = checkTrial({ ...req, t });
    if (!checked.ok || checked.req.kind === 'view') return refuse(400, 'input', `input-${checked.error || 'kind'}`);
    if (!this.env.BUDGET || typeof this.env.ANTHROPIC_API_KEY !== 'string' || !this.env.ANTHROPIC_API_KEY) return refuse(503, 'config', 'config:ai');
    const given = checked.req.kind === 'faq'
      ? { kind: 'faq', question: checked.req.question, faqs: trialFaqs(p) }
      : { kind: 'fill', text: checked.req.text };
    const guest = checkGuestRequest(given, periods(this.io.now()).day);
    if (!guest.ok) return refuse(400, 'input', `input-${guest.error}`.slice(0, 40));
    const note = { shop: `trial~${p.id}` };
    if (guest.stop) return { status: 200, body: { lang: 'ja', faq: null, answer: '', health: true }, note: { ...note, why: 'health-stop' } };
    const ask = guest.ask;
    const got = await askModel(ask, this.env, this.io, note, note.shop, { limits: trialLimits(this.env), parse: (text) => guestAnswerFrom(text, ask) });
    if (got.ok) return { status: 200, body: got.reading, note };
    return { status: got.status, body: { error: got.error }, note };
  }

  /* 試し版の一覧（テストは env.TRIAL_SHOPS で差し替える） */
  trialShops() { return this.env.TRIAL_SHOPS || TRIAL_SHOPS; }

  async siteHosts(origin) {
    if (!dbReady(this.env)) return { ok: false, ...refuse(503, 'config', 'config:DB') };
    const got = await shopOfOrigin(this.env, origin);
    if (got.res) return { ok: false, ...got.res };
    return { ok: true, hosts: sitesOf(got.shops, got.shop).map(hostOf).filter(Boolean), note: { shop: got.shop } };
  }

  async siteBooking(origin, given) {
    if (!dbReady(this.env)) return refuse(503, 'config', 'config:DB');
    const got = await shopOfOrigin(this.env, origin);
    if (got.res) return got.res;
    const note = { shop: got.shop };
    return { ...(await takeSiteBooking(given, this.env, this.io, note, got.shop, nameOf(got.shops, got.shop, ''))), note };
  }
}
