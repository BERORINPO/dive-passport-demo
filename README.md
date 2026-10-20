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

- The 3D sea turtle (`assets/turtle.glb`) was made with [Higgsfield](https://higgsfield.ai) on a paid plan: a character drawing (GPT Image 2.5) turned into 3D with Tripo H3.1. It has no rig; `js/turtle3d.js` opens the jaw, blinks, and moves the head and flippers in the vertex shader. The numbers that fit the shader to this model are in `js/lido-fit.js`; if the model is replaced, measure the new one with `blender --background --python tools/measure-lido.py -- assets/turtle.glb`. three.js 0.160.0 is loaded from jsDelivr.
- Lido's voice (`audio/*.mp3`) was generated in advance with [ElevenLabs](https://elevenlabs.io) (Starter plan, commercial licence), using the voice "PiropiroRX" from the ElevenLabs Voice Library. Lido only speaks the shop's fixed answers, so no text or speech is generated at runtime and no API key is in this repo.
- To regenerate the voice lines: `node tools/make-voice.mjs` (dry run), then `--go` with `ELEVENLABS_API_KEY_REDUX`, `REDUX_VOICE_JA` and `REDUX_VOICE_EN` set.

## Test

```
node test/pass.roundtrip.test.mjs
node test/match.eval.mjs --check
```

---

ダイビング・スノーケル店の受付と、ダイバーが一度入れておけばどの店でも見せられる「パスポート」の試作です。中身はすべて架空の見本データで、入力した内容はどこにも送られません。
