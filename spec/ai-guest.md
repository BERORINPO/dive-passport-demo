# お客さんに見せる AI の振る舞い（spec）

お客さまの画面（「聞きたいことを、そのまま」「まとめて書いて、入れてもらう」）と試し版（trial.html）の AI が、何をして何をしないか。
根拠は調査報告「UI UX デザインのOSSと手法」（U:/dev/artifacts/consult-window-2026-10/reports）の 3 番: Apple HIG の Generative AI、GOV.UK Chat の実験報告、Shape of AI、Carbon for AI、EU AI Act 50 条。
直すときは、この表の行を先に直してから画面を直す。行ごとの「今」は 2026-10-29（PR #85 まで）。

## 決まり

| # | 決まり | 根拠 | 今 | どこで |
|---|---|---|---|---|
| 1 | 最初に AI だと言う。何をするか（お店の答えから選ぶ・訳す）、まちがいうること、確かめ先（お店）を、聞く欄の下に出す | Apple HIG・EU AI Act 50 条・GOV.UK Chat の最初の案内 | 済 | js/data.js `faqNote`、js/trial-page.js（決定ログ ai-disclosure） |
| 2 | AI は答えを作らない。お店が書いた答えから 1 つ選び、日本語以外なら訳すだけ。合う物が無ければ「お店に確認して」 | Apple HIG（人が書いたと誤認させない） | 済 | worker/guest-ai-core.mjs `FAQ_PROMPT`、js/guest-ai-schema.js `faqAnswer` |
| 3 | 体のことは、AI に送る前に判定して断り、行き先（お店）を言う。参加できるかを AI が決めない | Apple HIG（害につながる場面で生成しない）・GOV.UK Chat（生成の前に判定） | 済 | js/health-redact.js、worker/guest-ai-core.mjs `checkGuestRequest` |
| 4 | 何をしているかを 1 行ずつ出す（「質問を読みました（英語）」「〇件から探しています」「訳しました」）。「処理中」だけにしない | Apple HIG・Shape of AI の Stream of Thought | 済 | js/guest-steps.js（決定ログ guest-ai-steps） |
| 5 | 答えの出どころを見せる。訳した答えには、元の日本語の文と、どの質問への答えか | Apple HIG | 済 | js/chat.js `translatedCard`、js/trial-page.js `answerRow` |
| 6 | 答えの言葉の lang を付ける。中国語は質問と同じ字で訳し、zh-Hant・zh-Hans で印を付ける | W3C | 済 | 決定ログ ai-disclosure・zh-script |
| 7 | AI が入れた欄には印。人が入れた欄は上書きしない。人が直したら印を「AI の値に戻す」に替える | Shape of AI の Auto-fill・Carbon の revert | 済 | js/intake.js（決定ログ bulk-keep-own・bulk-revert） |
| 8 | 送るのは人のボタンだけ。AI は送らない・予約を確定しない | Apple HIG（本人に代わって重要な操作をする前に確認） | 済 | js/intake.js |
| 9 | 答えが聞きたいことと違うとき、お店に回す道を答えの下に出す | GOV.UK Chat・NN/g | 済 | js/chat.js「聞きたいことと違う → お店に聞く」 |
| 10 | お客さんに見せる文に、お店の画面の言葉（「受付」「お店への質問」など）を出さない | Nielsen H2 | 済（この PR） | js/data.js `sentReal` |
| 11 | 答えが役に立ったかを、任意で押せる（良い・良くない） | Apple HIG | まだ | 何をどこに残すか（お店の画面に数を出すか）を決めてから |
| 12 | 偽の急ぎ（「残り 2 枠」「今だけ」）を AI に作らせない | 消費者庁の方針（2026-09） | 済（作れない） | 2 の決まり（お店の答えを選ぶだけ）で起きない |

## 数えること（まだ）

報告の 9 番。AI 側は「お店の答えで答えた数」「お店に確認へ回した数」「体のことで断った数」を、中身を残さずに数える。今は KV に呼んだ回数と費用だけ（worker/budget.mjs）。
