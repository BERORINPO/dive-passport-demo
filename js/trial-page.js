/* 実在のお店の試し版のページ（trial.html。entry）。鍵は URL の # の後ろ（#t=…）にあり、/api/trial へは本文で送る（js/ask-api.js）。
   見せるのはお店の公開ホームページの事実だけ。聞けば答える・まとめて書けば入るはお客さまの画面（chat.js・intake.js）と同じ形で、
   AI はお店の答えから選んで訳すだけ。答えが無いことは「お店に確認してください」と返す。体のことは答えない。
   申し込みは送れない（見本）。お店の名簿・予約は作らない（決定ログ 2026-10-29 trial-shops） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const G = R.guestAi;
  const S = R.guestSteps;
  const root = document.getElementById('trial');
  const token = (/^#t=([A-Za-z0-9_-]{22})$/.exec(location.hash) || [])[1] || '';

  /* 聞いた言葉で返す決まった文（AI は作らない） */
  const SAY = {
    none: { ja: 'このページの情報には、その答えがありません。お店に確認してください。', en: "This page doesn't have the answer. Please check with the shop.",
      zh: '本页面的信息中没有这个答案。请向店家确认。', 'zh-Hant': '本頁面的資訊中沒有這個答案。請向店家確認。', ko: '이 페이지 정보에는 답이 없습니다. 가게에 확인해 주세요.' },
    health: { ja: '体のことは、ここでは答えません。参加できるかはお店が確かめます。お店に直接聞いてください。',
      en: 'Health questions are not answered here. The shop checks whether you can join. Please ask the shop directly.',
      zh: '这里不回答身体健康方面的问题。能否参加由店家确认，请直接询问店家。', 'zh-Hant': '這裡不回答身體健康方面的問題。能否參加由店家確認，請直接詢問店家。', ko: '건강에 관한 질문은 여기서 답하지 않습니다. 참가 가능 여부는 가게가 확인합니다. 가게에 직접 문의해 주세요.' },
    busy: { ja: 'いまは答えられません。少し待ってから、もう一度聞いてください。', en: 'Cannot answer right now. Please try again in a moment.',
      zh: '现在无法回答，请稍后再试。', 'zh-Hant': '現在無法回答，請稍後再試。', ko: '지금은 답할 수 없습니다. 잠시 후 다시 물어봐 주세요.' }
  };
  const LANG_NAME = { ja: '日本語', en: '英語', zh: '中国語', ko: '韓国語' };
  const langOf = (t) => (/[가-힯]/.test(t) ? 'ko' : /[぀-ヿ]/.test(t) ? 'ja' : /[一-鿿]/.test(t) ? 'zh' : /[a-z]/i.test(t) ? 'en' : 'ja');
  const touchesHealth = (text) => R.healthRedact.redact(String(text)).redacted > 0;

  let shop = null;

  /* ---------- 上: お店とツアー（事実だけ） ---------- */
  const row = (k, v) => el('div', { class: 'facts__row' }, el('span', { class: 'facts__k', text: k }), el('p', { class: 'facts__v' }, v));
  function tourBlock(t) {
    return el('section', { class: 'trial-tour' },
      el('h3', { class: 'trial-tour__name', text: t.name }),
      el('div', { class: 'facts' },
        t.time ? row('時間', t.time) : null,
        t.facts.map(f => row('', f)),
        row('料金', t.price)));
  }

  /* ---------- 聞けば答える ---------- */
  /* lang: 答えの言葉。読み上げと字形（中国語を日本語の字で描かない）のため */
  /* face: 案内役の表情（答えた = answer、答えが無い・体のこと・混んでいる = sorry。決定ログ 2026-10-29 chara-faces） */
  function answerRow(text, sub, orig, lang = 'ja', face = 'answer') {
    return el('div', { class: 'faq__a' }, el('img', { class: 'faq__mark', src: R.CHARA[face], alt: '', width: 30, height: 30 }),
      el('div', {}, el('p', { lang, text }), sub ? el('small', { text: sub }) : null,
        orig ? el('details', { class: 'faq__orig' }, el('summary', { text: '元の文（日本語）' }), el('p', { lang: 'ja', text: orig })) : null));
  }

  /* 決まった文（SAY）を、AI が見た質問の言葉で。その言葉の文が無ければ画面で見た言葉で */
  /* 中国語は質問の字（繁体字・簡体字）の文を選ぶ。SAY の zh は簡体字。質問の字が分からなければ簡体字 */
  const sayRow = (key, aiLang, pageLang, text) => {
    const pick = (l) => {
      const tag = G.langTag(l, text);
      if (SAY[key][tag]) return [SAY[key][tag], tag];
      return SAY[key][l] ? [SAY[key][l], l === 'zh' ? 'zh-Hans' : l] : null;
    };
    const [say, lang] = pick(aiLang) || pick(pageLang);
    return answerRow(say, '', '', lang, 'sorry');
  };

  let asking = 0;
  async function ask(log, question) {
    const text = question.trim();
    if (!text) return;
    const turn = ++asking;
    const lang = langOf(text);
    log.replaceChildren(el('p', { class: 'faq__asked', text }));
    const steps = S.into(log);
    steps.doing('質問を読んでいます…');
    if (touchesHealth(text)) {
      steps.done('質問を読みました');
      steps.note('体のことなので、ここでは答えません');
      steps.face('sorry'); log.append(sayRow('health', lang, lang, text));
      return;
    }
    const res = await R.askApi.trial({ t: token, kind: 'faq', question: text });
    if (turn !== asking) return;
    const got = res.status === 200 ? G.faqAnswer(res.data, shop.faq.map(f => f.id)) : { ok: false };
    if (!got.ok) { steps.done('質問を読みました'); steps.face('sorry'); log.append(sayRow('busy', lang, lang, text)); return; }
    const a = got.answer;
    if (a.health) { steps.done('質問を読みました'); steps.note('体のことなので、ここでは答えません'); steps.face('sorry'); log.append(sayRow('health', a.lang, lang, text)); return; }
    steps.done(`質問を読みました（${LANG_NAME[a.lang]}）`);
    steps.doing(`お店の答え ${shop.faq.length} 件から探しています…`);
    await S.pause(500);
    if (turn !== asking) return;
    const item = a.faq ? shop.faq.find(f => f.id === a.faq) : null;
    if (!item) {
      steps.done(`お店の答え ${shop.faq.length} 件に、合う物はありませんでした`);
      steps.face('sorry'); log.append(sayRow('none', a.lang, lang, text));
      return;
    }
    steps.done(`「${item.q}」の答えを選びました`);
    if (a.lang !== 'ja') {
      steps.doing(`日本語から${LANG_NAME[a.lang]}に訳しています…`);
      await S.pause(600);
      if (turn !== asking) return;
      steps.done(`${LANG_NAME[a.lang]}に訳しました（元の文は下）`);
      steps.face('answer'); log.append(answerRow(a.answer, `「${item.q}」へのお店の答えを、AI が訳しました`, item.a, G.langTag(a.lang, `${text} ${a.answer}`)));
      return;
    }
    steps.face('answer'); log.append(answerRow(item.a, `「${item.q}」へのお店の答え`));
  }

  function askSection() {
    const log = el('div', { class: 'faq__log', 'aria-live': 'polite' });
    const input = el('input', { class: 'input', type: 'text', maxlength: G.MAX_QUESTION, autocomplete: 'off',
      placeholder: '例: Can I join if I can\'t swim? / 不会游泳也可以参加吗？', 'aria-label': '聞きたいこと' });
    const form = el('form', { class: 'faq__ask' }, input, el('button', { class: 'btn btn--ghost', type: 'submit', text: '聞く' }));
    form.addEventListener('submit', (e) => { e.preventDefault(); const q = input.value; input.value = ''; ask(log, q); });
    const item = (f) => {
      const body = el('div', { hidden: true }, answerRow(f.a, 'お店の答え'));
      const q = el('button', { class: 'faq__q', type: 'button', 'aria-expanded': 'false', text: f.q });
      q.addEventListener('click', () => { const open = q.getAttribute('aria-expanded') !== 'true'; q.setAttribute('aria-expanded', String(open)); body.hidden = !open; });
      return el('li', { class: 'faq__item' }, q, body);
    };
    return el('section', { class: 'guest-sec', id: 'chat' },
      el('div', { class: 'faq__head' }, el('img', { class: 'faq__chara', src: R.CHARA.hello, alt: '', width: 56, height: 56 }),
        el('h2', { class: 'h2', text: '聞きたいことを、そのまま' })),
      form,
      el('p', { class: 'faq__note', text: '日本語・English・中文・한국어で聞けます。AI がこのページのお店の情報から答えを選び、日本語以外は訳して返します。'
        + '無いことは「お店に確認してください」と返します。まちがうこともあるので、大事なことはお店に確かめてください。体のことには答えません。' }),
      log,
      el('details', { class: 'faq__more' }, el('summary', { text: `質問の一覧から探す（${shop.faq.length}）` }), el('ul', { class: 'faq' }, shop.faq.map(item))));
  }

  /* ---------- まとめて書けば入る（申し込みは送れない見本） ---------- */
  const blank = () => ({ tour: shop.tours[0].id, date: '', people: 2, name: '', swim: '', exp: '', worries: [], flightMode: 'unknown', flightDate: '', flightTime: '' });
  let draft = null;
  let bulkText = '';
  let bulkSteps = [];
  let bulkEnd = 'done';   // 終わったときの案内役の表情（入れ終えた = done、読めない = sorry）
  let busy = false;
  let aiFields = new Set();
  const formRoot = el('div', {});
  const LABEL = { tour: 'ツアー', date: '日にち', people: '人数', name: '代表の方のお名前', swim: '泳ぎ', exp: 'ダイビング・スノーケルの経験', worries: '心配なこと',
    flightMode: '潜ったあとの帰りの飛行機', flightDate: '出発の日', flightTime: '出発の時刻' };
  const FLIGHT = [{ id: 'set', ja: '決まっている' }, { id: 'unknown', ja: 'まだ決まっていない' }, { id: 'none', ja: '飛行機には乗らない' }];

  const mark = (key) => (aiFields.has(key) ? el('span', { class: 'ai-mark', text: 'AI が入れた・確かめてください' }) : null);
  const label = (key, forId) => el('label', { class: 'label', for: forId }, LABEL[key], mark(key));
  const touched = (key) => { if (aiFields.delete(key)) renderForm(); };
  const set = (key, v) => { draft = { ...draft, [key]: v }; };
  function choices(key, options, multi) {
    const pick = (id, on) => (multi ? (on ? [...draft[key], id] : draft[key].filter(x => x !== id)) : id);
    const changed = (id) => (e) => { set(key, pick(id, e.target.checked)); touched(key); if (key === 'flightMode') renderForm(); };
    return el('fieldset', { class: 'group', 'data-key': key }, el('legend', { class: 'label' }, LABEL[key], mark(key)),
      el('div', { class: R.choiceClass(options.map(o => o.ja)) }, options.map(o => el('label', { class: 'choice' },
        el('input', { type: multi ? 'checkbox' : 'radio', name: `tr-${key}`, value: o.id, onchange: changed(o.id),
          checked: multi ? draft[key].includes(o.id) : draft[key] === o.id }),
        el('span', { text: o.ja })))));
  }
  const typed = (key, attrs) => (e) => set(key, attrs.type === 'number' ? Number(e.target.value) || 1 : e.target.value);
  const input = (key, attrs) => el('div', { class: 'field', 'data-key': key }, label(key, `tr-${key}`),
    el('input', { class: 'input', id: `tr-${key}`, value: draft[key], ...attrs, oninput: typed(key, attrs), onchange: () => touched(key) }));

  function renderForm() {
    const off = draft.flightMode !== 'set';
    const area = el('textarea', { class: 'input bulk__text', rows: 4, maxlength: G.MAX_FILL, 'aria-label': 'まとめて書く',
      placeholder: '例: 11月20日に大人2人。2人とも泳げなくて、ダイビングは初めて。帰りは翌日の14時の飛行機。', oninput: (e) => { bulkText = e.target.value; } });
    area.value = bulkText;
    const go = el('button', { class: 'btn bulk__go', type: 'button', text: '読み取って入れる', disabled: busy, onclick: readBulk });
    formRoot.replaceChildren(
      el('section', { class: 'bulk' },
        el('div', { class: 'faq__head' }, el('img', { class: 'faq__chara', src: R.CHARA.hello, alt: '', width: 56, height: 56 }),
          el('h2', { class: 'h2', text: 'まとめて書いて、入れてもらう' })),
        area, el('div', { class: 'bulk__row' }, go),
        el('div', {}, bulkSteps.length ? S.view(bulkSteps, bulkEnd) : null),
        el('p', { class: 'faq__note', text: 'メールやメモをそのまま貼っても読めます。体のことは読み取りません。' })),
      el('form', { class: 'form', novalidate: true, onsubmit: (e) => e.preventDefault() },
        el('div', { class: 'field', 'data-key': 'tour' }, label('tour', 'tr-tour'),
          el('select', { class: 'input', id: 'tr-tour', onchange: (e) => { set('tour', e.target.value); touched('tour'); } },
            shop.tours.map(t => el('option', { value: t.id, selected: draft.tour === t.id, text: t.name })))),
        el('div', { class: 'row' }, input('date', { type: 'date' }), input('people', { type: 'number', min: 1, max: 10 })),
        input('name', { type: 'text', maxlength: 60, autocomplete: 'off' }),
        choices('swim', R.SWIM), choices('exp', R.EXP), choices('worries', R.WORRIES.filter(w => w.id !== 'ears'), true),
        choices('flightMode', FLIGHT),
        el('div', { class: 'row' }, input('flightDate', { type: 'date', disabled: off }), input('flightTime', { type: 'time', disabled: off })),
        el('button', { class: 'btn btn--big', type: 'button', disabled: true, text: 'この内容で送る' }),
        el('p', { class: 'faq__note', text: '試し版なので、ここからは送れません。お店には何も届きません。' })));
  }

  function shown(key, v) {
    if (key === 'tour') return (shop.tours.find(t => t.id === v) || {}).name || v;
    const list = { swim: R.SWIM, exp: R.EXP, worries: R.WORRIES, flightMode: FLIGHT }[key];
    if (list) return [].concat(v).map(id => (list.find(o => o.id === id) || {}).ja || id).join('・');
    if (key === 'date' || key === 'flightDate') return v.slice(5).replace('-', '/');
    return String(v);
  }
  function glow(key) { formRoot.querySelector(`[data-key="${key}"]`)?.classList.add('is-glow'); }
  const finish = () => { bulkSteps = bulkSteps.map(s => (s.kind === 'doing' ? { ...s, kind: 'done' } : s)); };

  async function readBulk() {
    if (busy || !bulkText.trim()) return;
    busy = true;
    bulkSteps = [{ kind: 'doing', text: '文を読んでいます…' }];
    renderForm();
    const red = R.healthRedact.redact(bulkText.trim());
    const res = await R.askApi.trial({ t: token, kind: 'fill', text: red.text.slice(0, G.MAX_FILL) });
    const f = res.status === 200 && res.data && res.data.fill ? res.data.fill : null;
    const got = f ? G.fillAnswer({ tour: f.tour, date: f.date, people: f.people, name: f.name, swim: f.swim, exp: f.exp, worries: f.worries,
      flight_mode: f.flightMode, flight_date: f.flightDate, flight_time: f.flightTime, health_info_visible: res.data.healthSeen === true }, R.today()) : null;
    if (!got || !got.ok) { bulkSteps = [{ kind: 'note', text: 'いまは読み取れません。下で 1 つずつ入れてください' }]; bulkEnd = 'sorry'; busy = false; renderForm(); return; }
    const fill = { ...got.fill };
    /* ツアーは種類（dive・snorkel）で返るので、このお店のその種類の最初のツアーにする */
    if (fill.tour) { const t = shop.tours.find(x => x.kind === fill.tour); if (t) fill.tour = t.id; else delete fill.tour; }
    const keys = Object.keys(LABEL).filter(k => k in fill);
    bulkSteps = [{ kind: 'done', text: `${keys.length} か所を読み取りました。入れていきます` }];
    bulkEnd = keys.length ? 'done' : 'sorry';
    if (got.healthSeen || red.redacted > 0) bulkSteps.push({ kind: 'note', text: '体のことは読み取りません。お店に直接伝えてください' });
    for (const key of keys) {
      finish();
      set(key, fill[key]);
      aiFields = new Set([...aiFields, key]);
      bulkSteps = [...bulkSteps, { kind: 'doing', field: true, text: `${LABEL[key]}: ${shown(key, fill[key])}` }];
      renderForm();
      glow(key);
      await S.pause(380);
    }
    finish();
    if (keys.length) bulkSteps.push({ kind: 'note', text: '印の所を確かめてください（試し版なので送れません）' });
    busy = false;
    renderForm();
  }

  /* ---------- 開く ---------- */
  async function open() {
    if (!token) { root.replaceChildren(el('p', { class: 'lead', text: 'このリンクは使えません。' })); return; }
    root.replaceChildren(el('p', { class: 'lead', text: '読み込んでいます…' }));
    const res = await R.askApi.trial({ t: token, kind: 'view' });
    if (res.status !== 200 || !res.data || !Array.isArray(res.data.tours) || !res.data.tours.length) {
      root.replaceChildren(el('p', { class: 'lead', text: res.status === 404 ? 'このリンクは使えません。' : '読み込めませんでした。少し待ってから開き直してください。' }));
      return;
    }
    shop = res.data;
    document.title = `${shop.name}（REDUX の試し版）`;
    draft = blank();
    renderForm();
    R.fill(root,   // お店のことが 0 件のときの null を除く
      el('h1', { class: 'page__h1', text: shop.name }),
      el('p', { class: 'trial-asof', text: `${shop.area}・お店の公開ホームページの情報（${shop.asOf} 時点）から作りました。最新の料金や空きは、お店に確認してください。` }),
      /* 聞く欄を一番上に（ツアーが 6 つあると、下に置いた聞く欄まで 4,000px ほど送らないと届かなかった）。ツアーとお店のことは、その下で読む */
      askSection(),
      el('section', { class: 'guest-sec' }, el('h2', { class: 'h2', text: 'ツアー' }), shop.tours.map(tourBlock)),
      shop.info.length ? el('section', { class: 'guest-sec' }, el('h2', { class: 'h2', text: 'お店のこと' }), el('div', { class: 'facts' }, shop.info.map(i => row(i.k, i.v)))) : null,
      el('div', { class: 'guest-sec' }, formRoot));
  }

  open();
  /* # の後ろの鍵が変わったら、別のお店として開き直す */
  window.addEventListener('hashchange', () => location.reload());
})();
