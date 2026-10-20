/* パスポートの画面と、見るだけの画面の文（日英）と選択肢 */
(() => {
  'use strict';

  const R = window.REDUX;

  R.AGENCIES = ['PADI', 'SSI', 'NAUI', 'CMAS', 'SDI', 'BSAC', 'JCS', 'その他 / Other'];
  R.SUITS = ['', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

  /* QR で見せる項目を選ぶチェック */
  R.SHARE_ITEMS = [
    { id: 'medical', ja: '健康の質問票（答えた日と「はい」の項目だけ）', en: 'Health form (date and "yes" items only)' },
    { id: 'certNo', ja: 'C カードの番号', en: 'C-card numbers' },
    { id: 'insurance', ja: '保険の名前', en: 'Insurance provider' },
    { id: 'insuranceNo', ja: '保険の番号', en: 'Insurance number' },
    { id: 'sizes', ja: '器材のサイズ', en: 'Gear sizes' },
    { id: 'flight', ja: '帰りの便', en: 'Flight home' }
  ];

  R.TP = {
    tab: { ja: 'パスポート', en: 'Passport' },
    title: { ja: 'ダイバーのパスポート', en: 'Diver passport' },
    lead: { ja: '一度入れておけば、REDUX を使うお店では予約前の確認が 1 タップで埋まります。ほかのお店では QR を見せられます。中身はこのスマホの中だけに残り、見せるたびに、渡す項目をあなたが選びます。',
            en: "Fill it in once. At REDUX shops, the pre-booking check fills in with one tap; at other shops you can show a QR code. It stays on this phone, and you choose what to share each time." },
    create: { ja: 'パスポートを作る', en: 'Create my passport' },
    sample: { ja: '見本を入れる', en: 'Use a sample' },
    edit: { ja: '直す', en: 'Edit' },
    remove: { ja: 'パスポートを消す', en: 'Delete passport' },
    confirmRemove: { ja: 'このスマホからパスポートを消します。元に戻せません。よろしいですか？', en: 'This deletes the passport from this phone and cannot be undone. Continue?' },
    save: { ja: '保存する', en: 'Save' },
    cancel: { ja: 'やめる', en: 'Cancel' },
    saved: { ja: '保存しました', en: 'Saved' },
    invalid: { ja: '入力を見直してください', en: 'Please check your entries' },
    fName: { ja: 'お名前', en: 'Name' },
    fLang: { ja: 'ご連絡の言葉', en: 'Language' },
    fSwim: { ja: '泳ぎ', en: 'Swimming' },
    fCerts: { ja: 'C カード（3 枚まで）', en: 'C-cards (up to 3)' },
    fAgency: { ja: '団体', en: 'Agency' },
    fLevel: { ja: 'ランク', en: 'Level' },
    fNo: { ja: '番号（任意）', en: 'Number (optional)' },
    fCertDate: { ja: '取った月', en: 'Month certified' },
    addCert: { ja: 'C カードを足す', en: 'Add a C-card' },
    delCert: { ja: 'この C カードを消す', en: 'Remove this card' },
    fDives: { ja: '潜った本数', en: 'Logged dives' },
    fLastDive: { ja: '最後に潜った月', en: 'Last dive (month)' },
    fMedical: { ja: '健康の質問票', en: 'Health form' },
    medicalNote: { ja: 'サンプルの質問です。答えはこのスマホの中だけに残り、AI には送りません。答えを変えると、答えた日が今日になります。',
                   en: 'Sample questions. Your answers stay on this phone and are never sent to an AI. Changing an answer resets the date to today.' },
    fInsurance: { ja: '保険の名前', en: 'Insurance provider' },
    fInsuranceNo: { ja: '保険の番号（任意）', en: 'Insurance number (optional)' },
    fSuit: { ja: 'ウエットスーツのサイズ', en: 'Wetsuit size' },
    fFins: { ja: 'フィンのサイズ', en: 'Fin size' },
    fFlight: { ja: '帰りの便（旅行ごとに入れ直す）', en: 'Flight home (update for each trip)' },
    rName: { ja: 'お名前', en: 'Name' },
    rSwim: { ja: '泳ぎ', en: 'Swimming' },
    rCerts: { ja: 'C カード', en: 'C-cards' },
    rExp: { ja: '経験', en: 'Experience' },
    rMedical: { ja: '健康の質問票', en: 'Health form' },
    rInsurance: { ja: '保険', en: 'Insurance' },
    rSizes: { ja: '器材', en: 'Gear' },
    rFlight: { ja: '帰りの便', en: 'Flight home' },
    none: { ja: 'なし', en: 'None' },
    notSet: { ja: '未入力', en: 'Not set' },
    notShared: { ja: '見せていません', en: 'Not shared' },
    dives: { ja: '本', en: 'dives' },
    last: { ja: '最後', en: 'last' },
    answeredOn: { ja: '答えた日', en: 'answered' },
    yesItems: { ja: '「はい」', en: '"Yes"' },
    unanswered: { ja: '未回答', en: 'unanswered' },
    notAnswered: { ja: 'まだ答えていません', en: 'Not answered yet' },
    shareTitle: { ja: 'お店に見せる', en: 'Show a shop' },
    shareLead: { ja: '見せる項目を選んで QR を出します。お店のスマホのカメラで読むと、見るだけの画面が開きます。',
                 en: "Choose what to share, then show the QR code. When the shop scans it with a phone camera, a read-only page opens." },
    showQr: { ja: 'QR を出す', en: 'Show QR code' },
    hideQr: { ja: '隠す', en: 'Hide' },
    openHere: { ja: 'この画面で開いてみる', en: 'Open it here' },
    qrNote: { ja: 'QR は 2 分で消えます。中身は QR を読んだスマホの中だけで開き、どこにも送られません。',
              en: 'The QR code disappears after 2 minutes. It opens only on the phone that scans it and is not sent anywhere.' },
    qrFail: { ja: 'QR を出せませんでした。下の文字（URL）をお店に見せてください。', en: "Couldn't draw the QR code. Show the shop the link below instead." },
    fromPass: { ja: 'パスポートがあります', en: 'You have a passport' },
    fillFromPass: { ja: 'パスポートで埋める', en: 'Fill in from my passport' },
    filledNote: { ja: 'パスポートから入れました。健康の質問票は {date} に答えたものです。直してもかまいません。',
                  en: 'Filled in from your passport. Your health form was answered on {date}. You can still change anything.' },
    filledNoMedical: { ja: 'パスポートから入れました。健康の質問票はまだなので、下で答えてください。', en: 'Filled in from your passport. Please answer the health form below.' },
    saveToPass: { ja: 'この答えをパスポートに保存する', en: 'Save these answers to my passport' },
    updatePass: { ja: 'パスポートをこの答えで新しくする', en: 'Update my passport with these answers' },
    saveLead: { ja: '保存すると、次のお店では予約前の確認が 1 タップで埋まります。', en: 'Save it and the next shop will fill in with one tap.' },
    savedToPass: { ja: 'パスポートに保存しました。「パスポート」のタブで、C カードや保険も足せます。', en: 'Saved to your passport. Add C-cards and insurance in the Passport tab.' },
    viewerTitle: { ja: 'ダイバーのパスポート（見るだけ）', en: 'Diver passport (read-only)' },
    viewerNote: { ja: 'この画面の中身は、このスマホの中だけで開いています。どこにも送られず、閉じると消えます。参加できるかを決めるのはお店です。',
                  en: 'This page opened only on this phone. Nothing is sent anywhere, and it disappears when closed. The shop decides whether the diver can join.' },
    viewerBad: { ja: 'このパスポートは読めませんでした。もう一度 QR を出してもらってください。', en: "This passport couldn't be read. Please ask the diver to show the QR code again." },
    viewerEmpty: { ja: 'パスポートの中身がありません。ダイバーの QR から開いてください。', en: "There's no passport here. Open it from a diver's QR code." },
    viewerCta: { ja: 'REDUX を使うと、予約前の確認がこのパスポートで 1 タップで埋まります', en: 'With REDUX, your booking check fills in from this passport in one tap' },
    viewerCtaLink: { ja: 'REDUX の受付を見る →', en: 'See REDUX front desk →' },
    selfDeclared: { ja: '本人が入力した内容です。C カードは団体の照会で確かめてください。', en: 'Entered by the diver. Please verify C-cards with the agency.' }
  };

  /* 見本のパスポート（デモを早く見せるため） */
  R.samplePass = () => ({
    ...R.pass.blank(),
    name: 'Emily Carter', lang: 'en', swim: '25m',
    certs: [{ agency: 'PADI', level: 'Open Water Diver', no: '2401A23456', date: '2024-05' }],
    dives: 14, lastDive: '2026-03',
    medical: { form: R.pass.FORM, answeredAt: R.today(), answers: ['no', 'no', 'yes', 'no', 'no'] },
    insurance: { name: 'DAN Asia-Pacific', no: 'AP-00012345' },
    sizes: { suit: 'M', fins: '24-25' },
    flight: { date: R.ymd(R.addDays(new Date(), 4)), time: '18:30' },
    updatedAt: new Date().toISOString()
  });
})();
