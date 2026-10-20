# dive-passport-demo

A prototype of a front desk for dive and snorkel shops, plus a "diver passport" that divers fill in once and show at any shop.

- **Demo only.** Every name, shop answer and number in it is made-up sample data.
- Nothing you enter is sent anywhere. It stays in your browser (`localStorage`).
- The QR code holds the shared items in the URL fragment (`#p=...`), which browsers do not send to the server. The read-only page removes it from the address bar after reading it.
- Health answers are never sent to an AI. The health questions in this demo are samples, not an official form.

## Pages

- `index.html`: guest view (pre-booking check, FAQ turtle), diver passport, shop view
- `pass.html`: read-only page opened from the passport QR code

## Test

```
node test/pass.roundtrip.test.mjs
```

---

ダイビング・スノーケル店の受付と、ダイバーが一度入れておけばどの店でも見せられる「パスポート」の試作です。中身はすべて架空の見本データで、入力した内容はどこにも送られません。
