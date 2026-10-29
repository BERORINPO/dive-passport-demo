/* お店が書く中身（すべてサンプル）。実際のお店では、ここをお店の文に置き換える。
   AI はこの文を作らない。ここにある文から選び、日本語以外で聞かれたら訳すだけ（決定ログ 2026-10-29 guest-ai-ask） */
(() => {
  'use strict';

  const R = window.REDUX;
  const UPDATED = '2026-10-20';

  const CANCEL = {
    ja: '波や風で中止のときは、前日 18 時までにご連絡し、全額お返しします',
    en: "If we cancel for waves or wind, we'll tell you by 6 pm the day before and refund in full"
  };

  R.TOURS = [
    {
      id: 'dive', diving: true, start: '08:30', end: '12:30', price: '18,000',
      name: { ja: '体験ダイビング（ボート・2 本）', en: 'Discover Scuba (boat, 2 dives)' },
      facts: [
        { ja: '海に入るのは 1 本約 40 分 × 2 本。深さは 5〜8 m ほど', en: 'Two dives of about 40 minutes each, about 5–8 m deep' },
        { ja: 'インストラクター 1 人に、お客さま 2 人まで', en: 'Up to 2 guests per instructor' },
        { ja: 'ポイントまで船で約 50 分', en: 'About 50 minutes by boat to the dive site' },
        CANCEL
      ]
    },
    {
      id: 'snorkel', diving: false, start: '09:00', end: '11:30', price: '7,500',
      name: { ja: 'ボートスノーケル（1 回）', en: 'Boat snorkelling (1 session)' },
      facts: [
        { ja: '海に入るのは約 45 分。ライフジャケットは最後まで着けたままです', en: 'About 45 minutes in the water. Life jackets stay on the whole time' },
        { ja: '足のつかない深さです。浮き具につかまって進みます', en: "The water is too deep to stand. You'll hold on to a float" },
        { ja: 'ウミガメに会えない日もあります。料金は同じです', en: "Some days we don't see turtles. The price is the same" },
        CANCEL
      ]
    }
  ];

  /* 予約サイトの口コミで多かった質問の順（写真・中止・総額・泳げない・時間・ウミガメ・集合・船酔い・混雑・子ども）。
     質問から答えを選ぶための言葉は data-match.js にある */
  R.FAQ = [
    { id: 'photo', q: { ja: '写真はもらえる？', en: 'Do we get photos?' },
      a: { ja: '写真は無料で、1 組 20 枚ほどを当日中に LINE でお送りします。動画は別料金（2,000 円）です。',
           en: 'Photos are free: about 20 per group, sent by LINE the same day. Video costs extra (¥2,000).' } },
    { id: 'cancel', q: { ja: '天気が悪いときは？', en: 'What if the weather is bad?' },
      a: { ja: '波や風で中止のときは、前日 18 時までにご連絡し、全額お返しします。当日に場所を変えるときは、出発前にお伝えします。',
           en: "If we cancel for waves or wind, we'll tell you by 6 pm the day before and refund in full. If we change the site on the day, we'll tell you before we leave." } },
    { id: 'total', q: { ja: '料金のほかにかかるお金は？', en: 'Any extra costs?' },
      a: { ja: '表示の料金に、器材・写真・保険が入っています。ほかにかかるのは、動画（希望する方）と駐車場（1 日 500 円）だけです。',
           en: 'The price includes gear, photos and insurance. The only extras are video (if you want it) and parking (¥500 a day).' } },
    { id: 'swim', q: { ja: '泳げなくても大丈夫？', en: "I can't swim well. Is that OK?" },
      a: { ja: '泳げなくても参加できます。ライフジャケットと浮き具を使い、インストラクター 1 人にお客さま 2 人までです。',
           en: "Yes. You'll use a life jacket and a float, and each instructor takes up to 2 guests." } },
    { id: 'time', q: { ja: '海に入るのは何分？', en: 'How long are we in the water?' },
      a: { ja: '体験ダイビングは 1 本約 40 分 × 2 本、スノーケルは約 45 分です。スノーケルはライフジャケットを着けたまま、ガイドのそばで泳ぎます。',
           en: 'Discover Scuba is two dives of about 40 minutes. Snorkelling is about 45 minutes, near the guide, with your life jacket on.' } },
    { id: 'turtle', q: { ja: 'ウミガメに会える？', en: 'Will we see turtles?' },
      a: { ja: 'この 1 か月は、10 回のうち 8 回ほど会えています。会えなかった日も料金は同じです。',
           en: 'This past month we saw turtles on about 8 trips out of 10. The price is the same if we do not.' } },
    { id: 'meet', q: { ja: '集合場所と持ち物は？', en: 'Where do we meet? What to bring?' },
      a: { ja: '集合は〇〇港の 2 番桟橋、出発の 30 分前です。水着とタオルをお持ちください。変更は LINE でお知らせします。',
           en: 'Meet at Pier 2 of ○○ Port, 30 minutes before departure. Bring swimwear and a towel. We send changes by LINE.' } },
    { id: 'seasick', q: { ja: '船酔いが心配', en: 'I get seasick' },
      a: { ja: 'ポイントまで船で約 50 分です。酔いやすい方は、出発の 30 分前に酔い止めを飲んでください。',
           en: 'The boat ride is about 50 minutes. If you get seasick, take medicine 30 minutes before departure.' } },
    { id: 'crowd', q: { ja: '混まない時間は？', en: 'When is it least crowded?' },
      a: { ja: '朝の 1 便目（8:30 出発）が一番すいています。',
           en: 'The first trip of the day (8:30) is the quietest.' } },
    { id: 'kids', q: { ja: '子どもや英語は？', en: 'Kids? English guides?' },
      a: { ja: 'スノーケルは 6 歳から、体験ダイビングは 10 歳から参加できます。英語のガイドは、予約のときにお申し付けください（土日のみ）。',
           en: 'Snorkelling is from age 6, Discover Scuba from age 10. Ask for an English-speaking guide when you book (weekends only).' } },
    { id: 'flight', q: { ja: '帰りの飛行機は？', en: 'Flying home after diving?' },
      a: { ja: '潜った日やその次の日に飛行機に乗る方は、「予約前の確認」で帰りの便の時刻を教えてください。お店が確認します。',
           en: 'If you fly on the day of your dive or the next day, please give us your flight time in "Before you book". The shop will check it.' } }
  ].map(item => ({ ...item, updated: UPDATED }));

  /* 健康の質問（サンプル）。実際は、お店がいつも使っている標準の質問票に置き換える */
  R.HEALTH = [
    { ja: '今、医師の治療を受けている病気がある', en: 'I am being treated by a doctor for a condition', short: '治療中の病気' },
    { ja: '心臓や肺（ぜんそくなど）の病気を言われたことがある', en: 'I have been told I have a heart or lung condition (e.g. asthma)', short: '心臓・肺' },
    { ja: '耳や鼻の病気がある、または耳抜きがうまくできない', en: 'I have ear or sinus problems, or trouble equalising', short: '耳・鼻' },
    { ja: '妊娠している、またはその可能性がある', en: 'I am or may be pregnant', short: '妊娠' },
    { ja: 'この 1 か月の間に、手術や大きなけがをした', en: 'I had surgery or a serious injury in the last month', short: '手術・けが' }
  ];

  R.SWIM = [
    { id: 'none', ja: '泳げない', en: "I can't swim" },
    { id: 'shallow', ja: '足のつく所なら泳げる', en: 'Only where I can stand' },
    { id: '25m', ja: '25 m くらい泳げる', en: 'About 25 m' },
    { id: 'good', ja: '泳ぎは得意', en: 'Confident swimmer' }
  ];
  R.EXP = [
    { id: 'first', ja: '初めて', en: 'First time' },
    { id: 'few', ja: '数回ある', en: 'A few times' },
    { id: 'card', ja: 'C カードを持っている', en: 'I have a C-card' }
  ];
  R.WORRIES = [
    { id: 'face', ja: '水に顔をつけるのが苦手', en: 'Putting my face in the water' },
    { id: 'deep', ja: '深い所が怖い', en: 'Deep water scares me' },
    { id: 'ears', ja: '耳抜きが心配', en: 'Equalising my ears' },
    { id: 'seasick', ja: '船酔いしやすい', en: 'I get seasick' }
  ];
  R.LANGS = [
    { id: 'ja', label: '日本語' }, { id: 'en', label: 'English' },
    { id: 'zh', label: '中文' }, { id: 'ko', label: '한국어' }
  ];

  /* 潜ったあと飛行機に乗るまでの目安。DAN（ダイバーの安全団体）の推奨で、法令ではない。どれを使うかはお店が決める */
  R.FLIGHT_RULES = [
    { h: 12, label: '12 時間（減圧停止なしで 1 本だけ）' },
    { h: 18, label: '18 時間（1 日に何本も、または何日も続けて）' },
    { h: 24, label: '24 時間（減圧停止のある潜水。DAN は「18 時間より十分長く」）' }
  ];

  /* 健康の質問票を何日まで使うか。お店が決める */
  R.MEDICAL_DAYS = [
    { d: 90, label: '90 日' },
    { d: 180, label: '180 日' },
    { d: 365, label: '1 年' }
  ];
  R.MEDICAL_DAYS_DEFAULT = 365;

  /* 客の画面の文。お店の画面は日本語だけ */
  R.T = {
    brandSub: { ja: '受付（試作）', en: 'front desk (prototype)' },
    tabGuest: { ja: 'お客さま', en: 'Guest' },
    tabShop: { ja: '受付', en: 'Front desk' },
    tabBooking: { ja: '予約と名簿', en: 'Bookings' },
    langBtn: { ja: 'English', en: '日本語' },
    demoSwitch: { ja: 'デモの画面', en: 'Demo screens' },
    /* 本物（Worker 版）の札。やることは同じ（4 つの画面を行き来する）だが、「デモ」とは呼ばない */
    screenSwitch: { ja: '画面の切り替え', en: 'Switch screen' },
    aiLiveNote: { ja: '本物の AI にしています。予約メールの文面と写真（健康の所は外して・塗って）を AI に送ります。',
                  en: 'The real AI is on. Booking emails and photos (health parts removed or blacked out) are sent to the AI.' },
    demoNote: { ja: 'デモです。入力した内容はこのブラウザの中だけに残り、どこにも送りません。答えはお店が書いた文から選び、AI は訳すだけで文章を作りません。',
                en: 'Demo. What you enter stays in this browser and is not sent anywhere. Answers are chosen from what the shop wrote; AI only translates them.' },
    demoNoteReal: { ja: 'デモです。中身はすべて架空の見本です。本物の AI にしているので、予約メールの文面と写真（健康の所は外して・塗って）を AI に送ります。',
                    en: 'Demo with made-up sample data only. The real AI is on, so booking emails and photos (health parts removed or blacked out) are sent to the AI.' },
    placeholder: { ja: '例: 泳げなくても大丈夫？', en: "e.g. Can I join if I can't swim?" },
    faqTitle: { ja: '聞きたいことを、そのまま', en: 'Ask in your own words' },
    faqMore: { ja: '質問の一覧から探す', en: 'Browse all questions' },
    /* AI だと最初に言う・まちがいうると言い確かめ先を示す（Apple HIG の Generative AI、GOV.UK Chat の最初の案内。決定ログ 2026-10-29 ai-disclosure） */
    faqNote: { ja: '日本語・English・中文・한국어で聞けます。AI がお店の書いた答えから選び、日本語以外は訳して返します。'
                 + 'まちがうこともあるので、大事なことはお店に確かめてください。体のことには答えません。',
               en: 'Ask in Japanese, English, Chinese or Korean. An AI picks the answer from what the shop wrote and translates it if needed. '
                 + 'It can be wrong, so check anything important with the shop. Health questions are not answered here.' },
    /* 聞けば答えるの手順の行（js/guest-steps.js） */
    stepReading: { ja: '質問を読んでいます…', en: 'Reading your question…' },
    stepRead: { ja: '質問を読みました（{lang}）', en: 'Read your question ({lang})' },
    stepReadPlain: { ja: '質問を読みました', en: 'Read your question' },
    stepHealth: { ja: '体のことなので、ここでは答えません', en: 'This is about health, so it is not answered here' },
    stepSearch: { ja: 'お店の答え {n} 件から探しています…', en: "Searching the shop's {n} answers…" },
    stepChose: { ja: '「{q}」の答えを選びました', en: 'Picked the answer to "{q}"' },
    stepNone: { ja: 'お店の答え {n} 件に、そのまま合う物はありませんでした', en: "None of the shop's {n} answers fits exactly" },
    stepTranslating: { ja: '日本語から{lang}に訳しています…', en: 'Translating from Japanese into {lang}…' },
    stepTranslated: { ja: '{lang}に訳しました（元の文は下）', en: 'Translated into {lang} (original below)' },
    langNames: {
      ja: { ja: '日本語', en: 'Japanese' }, en: { ja: '英語', en: 'English' }, zh: { ja: '中国語', en: 'Chinese' }, ko: { ja: '韓国語', en: 'Korean' }
    },
    /* まとめて書けば入るの手順の行 */
    bulkStepRead: { ja: '{n} か所を読み取りました。入れていきます', en: 'Read {n} fields. Filling them in' },
    bulkStepCheck: { ja: '印の所を確かめて、足りない所を入れてください', en: 'Please check the marked fields and add anything missing' },
    translated: { ja: '「{q}」へのお店の答えを、AI が訳しました', en: "The shop's answer to \"{q}\", translated by AI" },
    original: { ja: '元の文（日本語）', en: 'Original (Japanese)' },
    healthStop: { ja: '体のことは、ここでは答えません。参加できるかはお店が確かめます。お店に直接聞いてください。',
                  en: 'Health questions are not answered here. The shop checks whether you can join. Please ask the shop directly.' },
    ask: { ja: '聞く', en: 'Ask' },
    shopAnswer: { ja: 'お店の答え', en: "Shop's answer" },
    updated: { ja: '更新', en: 'updated' },
    notFound: { ja: 'ごめんね、それにはお店の答えがないんだ。お店の人に聞いてもらおうか？', en: "Sorry, the shop hasn't written an answer for that. Shall I ask the shop?" },
    askShop: { ja: 'お店に聞く', en: 'Ask the shop' },
    answerFor: { ja: '「{q}」へのお店の答え', en: "Shop's answer to \"{q}\"" },
    wrongQuestion: { ja: '聞きたいことと違う → お店に聞く', en: 'Not what I asked → ask the shop' },
    didYouMean: { ja: 'もしかして、このどれかのこと？', en: 'Did you mean one of these?' },
    noneOfThese: { ja: 'どれでもない（お店に聞く）', en: 'None of these (ask the shop)' },
    sent: { ja: 'お店に送ったよ。返事はお店の人から届くね。（デモなので「お店の画面」に入ります）', en: "Sent to the shop. A person will reply. (In this demo it shows up in the shop view.)" },
    /* 本物（Worker 版）では「デモなので」とは言わない。聞いたことは、受付の「お店への質問」に入る */
    sentReal: { ja: '受付の「お店への質問」に入れたよ。', en: "Added to the shop's questions." },
    intakeTitle: { ja: '予約の前に', en: 'Before you book' },
    bulkTitle: { ja: 'まとめて書いて、入れてもらう', en: 'Write it all at once' },
    bulkPlaceholder: { ja: '例: 11月3日に大人2人。山田です。2人とも泳げなくて、ダイビングは初めて。船酔いしやすいです。帰りは11月4日14時の飛行機。',
                       en: 'e.g. 2 adults on 3 Nov. Two of us cannot swim and it is our first dive. Our flight home is on 4 Nov at 14:00.' },
    bulkGo: { ja: '読み取って入れる', en: 'Fill in for me' },
    bulkSelf: { ja: '自分で 1 つずつ入れる', en: 'Fill in myself' },
    bulkReading: { ja: '読み取っています…', en: 'Reading…' },
    bulkNone: { ja: '読み取れる所がありませんでした。下で 1 つずつ入れてください。', en: 'Nothing could be read. Please fill in the form below.' },
    bulkFail: { ja: 'いまは読み取れません。下で 1 つずつ入れてください。', en: 'Cannot read it right now. Please fill in the form below.' },
    bulkHealth: { ja: '体のことは読み取りません。下の「健康の質問」でご自分で答えてください。', en: 'Health details are not read. Please answer the health questions below yourself.' },
    bulkNote: { ja: 'メールやメモをそのまま貼っても読めます。健康の質問は読み取らず、ご自分で答えます。', en: 'You can paste an email or a note. Health questions are not read; you answer them yourself.' },
    aiMark: { ja: 'AI が入れた・確かめてください', en: 'Filled by AI — please check' },
    factTime: { ja: '時間', en: 'Time' },
    factPrice: { ja: '料金', en: 'Price' },
    intakeLead: { ja: '答えてもらうと、お店が当日の準備をしやすくなります。これだけでは予約は決まりません。', en: 'Your answers help the shop prepare. This does not confirm a booking yet.' },
    fTour: { ja: 'ツアー', en: 'Tour' },
    factsTitle: { ja: 'このツアーの中身（予約の前に読んでください）', en: 'What this tour is like (please read before booking)' },
    fDate: { ja: '日にち', en: 'Date' },
    fPeople: { ja: '人数', en: 'Number of people' },
    fName: { ja: '代表の方のお名前', en: 'Name (lead guest)' },
    fLang: { ja: 'ご連絡の言葉', en: 'Language for messages' },
    fEmail: { ja: 'ご連絡用のメールアドレス（名簿の項目のお願いが届きます）', en: 'Email (we will send you a link for the diver list)' },
    fSwim: { ja: '泳ぎ', en: 'Swimming' },
    fExp: { ja: 'ダイビング・スノーケルの経験', en: 'Diving or snorkelling experience' },
    fDives: { ja: '潜った本数', en: 'Number of dives' },
    fWorries: { ja: '心配なこと（いくつでも）', en: 'Anything you are worried about (choose any)' },
    fHealth: { ja: '健康の質問', en: 'Health questions' },
    healthNote: { ja: 'サンプルの質問です。実際は、お店がいつも使っている標準の質問票（PADI などのもの）に置き換えます。', en: "Sample questions. A real shop would use the standard form it already uses (e.g. PADI's)." },
    consent: { ja: '健康の回答は、参加できるかをお店が確かめるためだけに使います。見るのはお店の人だけで、ツアーの 30 日後に消します。AI には送りません。これに同意して答えます。',
               en: 'Your health answers are used only for the shop to check whether you can join. Only shop staff see them, they are deleted 30 days after the tour, and they are never sent to an AI. I agree and will answer.' },
    yes: { ja: 'はい', en: 'Yes' },
    no: { ja: 'いいえ', en: 'No' },
    fFlight: { ja: '潜ったあとの帰りの飛行機', en: 'Your flight home after diving' },
    flightSet: { ja: '決まっている', en: 'Booked' },
    flightUnknown: { ja: 'まだ決まっていない', en: 'Not booked yet' },
    flightNone: { ja: '飛行機には乗らない', en: 'Not flying' },
    fFlightDate: { ja: '出発の日', en: 'Departure date' },
    fFlightTime: { ja: '出発の時刻', en: 'Departure time' },
    submit: { ja: 'この内容で送る', en: 'Send' },
    errTour: { ja: 'ツアーを選んでください', en: 'Please choose a tour' },
    errDate: { ja: '日にちを選んでください', en: 'Please choose a date' },
    errName: { ja: 'お名前を書いてください', en: 'Please enter your name' },
    errEmail: { ja: 'メールアドレスの形を確かめてください', en: 'Please check the email address' },
    doneTitle: { ja: '受け付けました', en: 'Thank you' },
    doneBody: { ja: '予約はまだ決まっていません。お店から LINE かメールでご連絡します。', en: 'Your booking is not confirmed yet. The shop will contact you by LINE or email.' },
    msgHealthYes: { ja: '健康の質問に「はい」がありました。参加できるかは、お店から確認のご連絡をします。医師の確認が必要になることがあります。',
                    en: 'You answered "yes" to a health question. The shop will contact you to check. A doctor\'s note may be needed.' },
    msgHealthMissing: { ja: '健康の質問がまだです。お店からご案内します。', en: 'The health questions are not done yet. The shop will send them to you.' },
    msgHealthOld: { ja: '健康の質問票に答えてから時間がたっているので、お店から答え直しをお願いすることがあります。', en: 'Your health form is a while old, so the shop may ask you to answer it again.' },
    msgFlightClose: { ja: '帰りの便の時刻について、お店からご連絡します。潜ったあとすぐに飛行機に乗ることは勧められていません。',
                      en: 'The shop will contact you about your flight time. Flying soon after diving is not recommended.' },
    msgFlightUnknown: { ja: '帰りの便が決まったら、お店に時刻を教えてください。', en: 'When you book your flight, please tell the shop the time.' },
    msgSwim: { ja: '泳げなくても、ライフジャケットと浮き具を使って参加できます。インストラクターがそばにつきます。', en: "You can join without swimming well: you'll use a life jacket and a float, with an instructor beside you." },
    msgFace: { ja: '前の日に、マスクに水が入ったときの直し方をお送りします。', en: "The day before, we'll send you how to clear water from your mask." },
    msgDeep: { ja: '深い所が怖いことは、ガイドに伝えておきます。', en: "We'll tell your guide that deep water worries you." },
    msgEars: { ja: '前の日に、耳抜きのやり方をお送りします。', en: "The day before, we'll send you how to equalise your ears." },
    msgSeasick: { ja: '酔い止めは、出発の 30 分前に飲んでください。', en: 'Take seasickness medicine 30 minutes before departure.' },
    again: { ja: 'もう 1 件入力する', en: 'Fill in another' },
    seeShop: { ja: 'お店の画面で見る', en: 'See it in the shop view' },
    rosterLead: { ja: '当日の名簿（沖縄県の条例で決まった項目）も、いま入れておくと当日の受付が早く済みます。', en: 'You can also fill in the dive roster now (items required by Okinawa rules). It makes check-in on the day faster.' },
    rosterNow: { ja: '名簿の項目も入れる', en: 'Fill in the roster' }
  };

  /* 見本の受付 4 件（日付は今日から数える）。4 件目はパスポートから来た受付で、質問票が古い */
  R.seedIntakes = () => {
    const today = new Date();
    const d = (n) => R.ymd(R.addDays(today, n));
    const at = (n) => R.addDays(today, n).toISOString();
    return [
      { id: 'seed1', at: at(-1), tour: 'dive', date: d(2), people: 2, name: 'Emily Carter', lang: 'en',
        swim: '25m', exp: 'first', dives: '', worries: ['ears'],
        health: { consent: true, answers: ['no', 'no', 'yes', 'no', 'no'] }, medicalAt: d(-1),
        flight: { mode: 'set', date: d(2), time: '18:30' }, source: 'form', checked: false },
      { id: 'seed2', at: at(-1), tour: 'snorkel', date: d(3), people: 3, name: '佐藤 美咲', lang: 'ja',
        swim: 'none', exp: 'first', dives: '', worries: ['face', 'deep'],
        health: { consent: true, answers: ['no', 'no', 'no', 'no', 'no'] }, medicalAt: d(-1),
        flight: { mode: 'none', date: '', time: '' }, source: 'form', checked: false },
      { id: 'seed4', at: at(-1), tour: 'dive', date: d(3), people: 2, name: 'Lukas Weber', lang: 'en',
        swim: 'good', exp: 'card', dives: '85', worries: [],
        health: { consent: true, answers: ['no', 'no', 'no', 'no', 'no'] }, medicalAt: d(-420),
        flight: { mode: 'set', date: d(4), time: '09:00' }, source: 'passport', checked: false },
      { id: 'seed3', at: at(-2), tour: 'dive', date: d(4), people: 1, name: '王 小明', lang: 'zh',
        swim: 'good', exp: 'card', dives: '12', worries: [],
        health: { consent: false, answers: [null, null, null, null, null] }, medicalAt: '',
        flight: { mode: 'set', date: d(5), time: '10:00' }, source: 'form', checked: true }
    ];
  };
})();
