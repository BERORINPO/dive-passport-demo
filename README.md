# dive-passport-demo

A prototype of a front desk for dive and snorkel shops, plus a "diver passport" that divers fill in once and show at any shop.

- **Demo only.** Every name, shop answer and number in it is made-up sample data.
- Nothing you enter is sent anywhere. It stays in your browser (`localStorage`).
- The QR code holds the shared items in the URL fragment (`#p=...`), which browsers do not send to the server. The read-only page removes it from the address bar after reading it.
- Health answers are never sent to an AI. The health questions in this demo are samples, not an official form.

## Pages

- `index.html`: guest view (pre-booking check, FAQ turtle), diver passport, shop view
- `pass.html`: read-only page opened from the passport QR code

## Lido the turtle (3D and voice)

- The 3D sea turtle (`assets/turtle.glb`) was generated with [Higgsfield](https://higgsfield.ai) on a paid plan. It has no rig; `js/turtle3d.js` moves the head and flippers in the vertex shader. three.js 0.160.0 is loaded from jsDelivr.
- Lido's voice (`audio/*.mp3`) was generated in advance with [ElevenLabs](https://elevenlabs.io) (Starter plan, commercial licence), using the voice "PiropiroRX" from the ElevenLabs Voice Library. Lido only speaks the shop's fixed answers, so no text or speech is generated at runtime and no API key is in this repo.
- To regenerate the voice lines: `node tools/make-voice.mjs` (dry run), then `--go` with `ELEVENLABS_API_KEY_REDUX`, `REDUX_VOICE_JA` and `REDUX_VOICE_EN` set.

## Bookings and the dive roster (in progress)

A booking list and the dive roster required by Okinawa's water-safety ordinance (13 items for divers, 11 for snorkellers, kept for one year). An AI reads booking emails, paper forms and C-card photos to fill the roster; health answers are never sent to it, and paper forms have their health box blacked out before upload. The AI is called through a Cloudflare Worker on the same origin, behind Cloudflare Access and a pass phrase. The public demo uses sample readings instead (`js/data-samples.js`, from the 2026-10-21 reading test).

- What and why: `spec/meibo.md`; the plan: `plan/meibo.md`; roles, boundaries and decisions: `spec/architecture.md`
- Shapes and checks: `js/roster-schema.js`; roster logic (pure): `js/roster-core.js`; health-line redaction for booking emails (pure): `js/health-redact.js`; the AI reader and its sample stand-in: `js/ai-reader.js`

## Test

```
node test/roster.test.mjs
node test/ai-reader.test.mjs
node test/booking-flow.test.mjs
node test/pass.roundtrip.test.mjs
node test/match.eval.mjs --check
node test/arch.check.mjs
```

`harness.yaml` lists the same checks.

---

ダイビング・スノーケル店の受付と、ダイバーが一度入れておけばどの店でも見せられる「パスポート」の試作です。中身はすべて架空の見本データで、入力した内容はどこにも送られません。
