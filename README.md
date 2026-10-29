# dive-passport-demo

A prototype of a front desk for dive and snorkel shops, plus a "diver passport" that divers fill in once and show at any shop.

- **Demo only.** Every name, shop answer and number in it is made-up sample data. Do not enter real customers.
- What you enter stays in your browser (`localStorage`). The public demo never sends it anywhere.
- The QR code holds the shared items in the URL fragment (`#p=...`), which browsers do not send to the server. The read-only page removes it from the address bar after reading it.
- Health answers are never sent to an AI. The health questions in this demo are samples, not an official form.

## Where it runs

| | What it shows | AI |
|---|---|---|
| GitHub Pages (`main`): https://berorinpo.github.io/dive-passport-demo/ | Everything, open to anyone | Sample readings only (`js/data-samples.js`, from the 2026-10-21 reading test) |
| Cloudflare Worker (behind Cloudflare Access, team emails only) | The same pages, plus `/api` on the same origin | Sample by default. Staff can switch to the real Claude API (Haiku); the screen first shows exactly what will be sent. Daily and monthly limits. Setup: `docs/deploy.md` |

## Run it locally

Node 18 or later. No npm packages.

```
node tools/build-site.mjs && node tools/serve-dist.mjs
```

Then open http://127.0.0.1:8106. This serves `dist/` with the same headers (CSP) as the Worker and answers `/api` with a fake Access login and fake AI answers. It never calls Cloudflare or the Claude API.

## Pages

- `index.html`: four tabs — お客さま (guest: pre-booking check and the FAQ with the shop's guide character), パスポート (diver passport), 受付 (shop front desk), 予約と名簿 (bookings and the dive roster)
- `pass.html`: read-only page opened from the passport QR code. It loads no images and no fonts (its CSP blocks them), so it draws with the device's own fonts

## Design (start here if you are changing how it looks)

- `design.md` is the design system: two layers (staff screens stay light and opaque for use on the beach and the boat; guest screens may follow dark mode and get photos and frosted glass), the colour tokens, and the numeric rules (text at least 14px, text colours at least 7:1 indoors, control borders at least 3:1, 56px bottom buttons). Change `design.md` first, then the screens
- Colours and fonts come only from the variables in `css/app.css` `:root`. `node test/design.check.mjs` computes the WCAG ratios from those variables and fails on text under 14px or colours written outside them
- After a visual change, run `test/layout.audit.js` in the browser console at 320 / 375 / 414 / 768px (steps are in the file)
- Fonts are self-hosted (`fonts/`, SIL OFL). The CSP allows no font hosts and only one script CDN (qrcode-generator on cdnjs), so a design that needs Google Fonts, Tailwind's CDN or inline styles will not load

## Guide character

- `assets/chara.png` is the shop's guide character, drawn by the team's designer (shell creature, transparent background, 256 px wide). It has no name yet, so the screens show none. It is shown whole (never cropped to a circle) on guest screens only: beside the FAQ heading (「聞きたいことを、そのまま」 and 「まとめて書いて、入れてもらう」), as the small mark left of each answer, and next to the AI's step lines. The header shows the REDUX logo mark (`assets/logo-mark.png`, cut from the reduxdive.com logo), not the character. Staff screens (front desk, bookings and roster, `pass.html`) do not show it.
- Answers are text only. The earlier 3D turtle (three.js, `turtle.glb`) and its voice lines were removed on 2026-10-28; they are in the git history if the owner wants them back.

## Bookings and the dive roster

A booking list and the dive roster required by Okinawa's water-safety ordinance (13 items for divers, 11 for snorkellers, kept for one year). An AI reads booking emails, paper forms and C-card photos to fill the roster. Health answers are never sent to it: health lines are removed from emails, and paper forms have their health box blacked out on the device before upload. Joint boats (several shops on one boat) get a combined roster and tag board.

- What and why: `spec/meibo.md`. The plan and what comes after the 11/9 presentation: `plan/meibo.md`. Roles, boundaries and decisions: `spec/architecture.md`
- Screens: `js/booking.js` (bookings), `js/intake-photo.js` (form and C-card photos), `js/day-roster.js` (today's roster), `js/share-roster.js` (joint boats), `js/guest-ask.js` (asking the guest)
- Joint boats, 2026-10-23: the boat's shop can cancel a trip once for everyone (reason, who gets told, the message), each partner shop sees it and answers "checked", and the guest page shows that the tour is off. The boat's shop can hand each partner shop its own roster with the dive time, site and that shop's guide filled in; the two health columns stay for that shop to fill. For the 11/9 demo, "見本の乗り合い便を作る（4 店・30 人）" on the booking list fills one boat with four shops
- After a redeploy, reload every open tab (see `docs/deploy.md`)
- Logic (pure): `js/roster-schema.js` (shapes and checks), `js/roster-core.js`, `js/health-redact.js`, `js/photo-mask.js`. The AI reader and its sample stand-in: `js/ai-reader.js`
- Worker: `worker/handler.mjs` (order of checks), `worker/access.mjs` (verifies the Cloudflare Access JWT itself), `worker/budget.mjs` (limits in KV), `worker/anthropic.mjs` (Claude API), `worker/read-core.mjs` (prompts and answer parsing, pure)

## Test

`harness.yaml` lists the checks. To run them by hand:

```
node test/design.check.mjs && node test/worker.test.mjs && node test/roster.test.mjs && node test/guest.test.mjs && node test/day.test.mjs && node test/share.test.mjs && node test/ai-reader.test.mjs && node test/booking-flow.test.mjs && node test/photo-mask.test.mjs && node test/pass.roundtrip.test.mjs && node test/match.eval.mjs --check
node test/arch.check.mjs
```

---

ダイビング・スノーケル店の受付と、ダイバーが一度入れておけばどの店でも見せられる「パスポート」の試作です。中身はすべて架空の見本データです。公開版（GitHub Pages）では、入力した内容はどこにも送られません。

引き継ぐ人へ:

- 見た目を直すとき: まず `design.md`（店員画面とお客さん画面の 2 層の決まりと数値）。色と字は `css/app.css` の `:root` の変数だけで決める。直したら `node test/design.check.mjs` と、幅 4 つで `test/layout.audit.js`
- 手元で動かす: `node tools/build-site.mjs && node tools/serve-dist.mjs` → http://127.0.0.1:8106（Node 18 以上だけ。本物の AI は呼ばない）
- 予約と名簿の中身: `spec/meibo.md`（何を・なぜ）、`plan/meibo.md`（計画と発表の後の作業）、`spec/architecture.md`（役割と決定ログ）
- 本物の AI で読む版（Cloudflare Worker）の置き方: `docs/deploy.md`
