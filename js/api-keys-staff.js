/* 予約の受け口 API の鍵のお店の画面（entry、日本語のみ）。予約の画面（booking.js）から開く。決定ログ 2026-10-28 intake-api。
   お店のサイト・WordPress・Zapier など別のシステムが、予約を REDUX に送るための鍵（API キー）を、スタッフが作る・作り直す・止める。
   - 鍵は連携先ごとに 1 本（名前をつける）。作った鍵はこの画面に 1 回だけ出る（サーバーには SHA-256 しか無いので、出し直せない。忘れたら作り直す）
   - 作り直す・止めるは、同じボタンを 2 回押して実行する（window.confirm は使わない）。作り直すと前の鍵はすぐ使えなくなる
   - 使い方の説明（docs/api.md）へのリンクを置く。住所は build-site.mjs が index.html の meta に入れる（js には外の URL を書かない）
   お店の文字は el() の text で出す（HTML として入れない） */
(() => {
  'use strict';

  const R = window.REDUX;
  const { el } = R;
  const LABEL_MAX = 40;
  const REFRESH_MS = 60000;

  /* items: null（まだ読んでいない）/ 一覧。issued: 作った・作り直した鍵 { id, label, key, endpoint, at }（この画面を離れる・閉じると消える）。
     armed: 2 回押す前の印 'rotate:<id>' / 'revoke:<id>' */
  const st = { items: null, endpoint: '', max: 10, loadedAt: 0, loading: false, error: '', notice: null, issued: null, label: '', busy: false, armed: '', copied: '' };

  const hhmm = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(iso)}`; };
  const synced = () => R.rosterStore.synced();
  const docsUrl = () => {
    const m = document.querySelector('meta[name="redux-api-docs"]');
    return m ? String(m.getAttribute('content') || '') : '';
  };

  async function load(ui, force) {
    /* 読めなかったときも間隔を空ける（読めない間、描き直すたびに読みに行かない）。作る・止めるのあとは force */
    if (!synced() || st.loading || (!force && Date.now() - st.loadedAt < REFRESH_MS)) return;
    st.loading = true;
    const r = await R.rosterSync.apiKeys();
    st.loading = false;
    st.loadedAt = Date.now();
    if (r.ok) { st.items = r.items; st.endpoint = r.endpoint; st.max = r.max; st.error = ''; } else st.error = r.why === 'login' ? 'login' : 'network';
    ui.rerender();
  }

  const active = () => (st.items || []).filter(x => !x.revokedAt);

  /* ---------- 鍵を作る・作り直す・止める ---------- */
  async function create(ui) {
    const label = st.label.trim();
    if (!label || label.length > LABEL_MAX) {
      st.notice = { kind: 'warn', text: `連携先の名前を ${LABEL_MAX} 字までで入れてください（例: 公式サイト）。` };
      ui.rerender();
      return;
    }
    st.busy = true;
    st.armed = '';
    ui.rerender();
    const r = await R.rosterSync.apiKeyCreate(label);
    st.busy = false;
    if (r.ok) {
      st.issued = { id: r.id, label, key: r.key, endpoint: r.endpoint, at: r.at };
      st.label = '';
      st.copied = '';
      st.notice = { kind: 'ok', text: '鍵を作りました。いま写してください。この鍵は、もう一度は出せません。' };
    } else {
      st.notice = { kind: 'warn', text: r.why === 409 ? `鍵は ${st.max} 本までです。使っていない鍵を止めてから作ってください。` : '鍵を作れませんでした。電波を確かめて、もう一度押してください。' };
    }
    ui.rerender();
    await load(ui, true);
  }

  async function rotate(ui, item) {
    if (st.armed !== `rotate:${item.id}`) { st.armed = `rotate:${item.id}`; ui.rerender(); return; }
    st.armed = '';
    st.busy = true;
    ui.rerender();
    const r = await R.rosterSync.apiKeyRotate(item.id);
    st.busy = false;
    if (r.ok) {
      st.issued = { id: r.id, label: item.label, key: r.key, endpoint: r.endpoint, at: r.at };
      st.copied = '';
      st.notice = { kind: 'ok', text: `「${item.label}」の鍵を作り直しました。前の鍵は使えません。新しい鍵をいま写してください。` };
    } else {
      st.notice = { kind: 'warn', text: '作り直せませんでした。電波を確かめて、もう一度押してください。' };
    }
    ui.rerender();
    await load(ui, true);
  }

  async function revoke(ui, item) {
    if (st.armed !== `revoke:${item.id}`) { st.armed = `revoke:${item.id}`; ui.rerender(); return; }
    st.armed = '';
    st.busy = true;
    ui.rerender();
    const r = await R.rosterSync.apiKeyRevoke(item.id);
    st.busy = false;
    if (r.ok) {
      if (st.issued && st.issued.id === item.id) st.issued = null;
      st.notice = { kind: 'ok', text: `「${item.label}」の鍵を止めました。この鍵で送った予約は、もう届きません。` };
    } else {
      st.notice = { kind: 'warn', text: '止められませんでした。電波を確かめて、もう一度押してください。' };
    }
    ui.rerender();
    await load(ui, true);
  }

  function copyKey(ui) {
    const tell = (how) => () => { st.copied = how; ui.rerender(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(st.issued.key).then(tell('ok'), tell('fail'));
    else tell('fail')();
  }

  /* ---------- 画面 ---------- */
  function issuedSection(ui) {
    const it = st.issued;
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, `${it.label} の鍵`, el('small', { text: 'いま 1 回だけ出ます' })),
      el('p', { class: 'url', text: it.key }),
      el('p', { class: 'sheet__note', text: `送り先: ${it.endpoint}` }),
      el('p', { class: 'sheet__note', text: 'この鍵は、この画面を閉じると二度と見られません（サーバーには見えない形でしか残していません）。連携先の設定に貼ってから閉じてください。' +
        '忘れたら「作り直す」で新しい鍵を作ります。ウェブページの中（ブラウザで見えるところ）には書かないでください。' }),
      st.copied === 'ok' ? el('p', { class: 'flag flag--ok', role: 'status', text: '鍵を写しました' }) : null,
      st.copied === 'fail' ? el('p', { class: 'flag flag--warn', role: 'status', text: '写せませんでした。上の鍵を長押しして写してください' }) : null,
      el('div', { class: 'sendrow' },
        el('button', { class: 'btn', type: 'button', text: '鍵を写す', onclick: () => copyKey(ui) }),
        el('button', { class: 'btn btn--ghost', type: 'button', text: '閉じる（もう出ません）', onclick: () => { st.issued = null; st.copied = ''; ui.rerender(); } })));
  }

  function itemLine(ui, item) {
    const revoked = !!item.revokedAt;
    const rotating = st.armed === `rotate:${item.id}`;
    const revoking = st.armed === `revoke:${item.id}`;
    return el('li', { class: 'bk' },
      el('span', { class: 'bk__name', text: item.label }),
      el('span', { class: `st ${revoked ? 'st--wait' : 'st--ok'}`, text: revoked ? '止めた' : '使える' }),
      el('span', { class: 'bk__meta', text: revoked ? `${when(item.revokedAt)} に止めました` : `${when(item.at)} に作りました` }),
      revoked ? null : el('div', { class: 'bk__acts' },
        el('button', { class: 'linkbtn', type: 'button', disabled: st.busy, text: rotating ? 'もう一度押すと作り直す（前の鍵は使えなくなります）' : '作り直す', onclick: () => rotate(ui, item) }),
        el('button', { class: 'linkbtn linkbtn--warn', type: 'button', disabled: st.busy, text: revoking ? 'もう一度押すと止める（この鍵で送れなくなります）' : '止める', onclick: () => revoke(ui, item) })));
  }

  function listSection(ui) {
    const items = st.items;
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, 'API キー', el('small', { text: `使える鍵 ${active().length} / ${st.max} 本` })),
      st.error === 'login' ? el('p', { class: 'flag flag--warn', role: 'status', text: 'ログインが切れました。画面を読み込み直してください。' })
        : st.error ? el('p', { class: 'flag flag--warn', role: 'status', text: '一覧を読めませんでした。電波を確かめてください。' }) : null,
      items === null ? el('p', { class: 'note', text: st.error ? '' : '読み込んでいます…' })
        : items.length ? el('ul', { class: 'bks bks--sheet' }, items.map(x => itemLine(ui, x)))
          : el('p', { class: 'empty', text: 'まだ鍵がありません。下で作ります。' }),
      el('p', { class: 'reset' }, el('button', { class: 'linkbtn linkbtn--muted', type: 'button', disabled: st.loading, text: '読み直す', onclick: () => load(ui, true) })));
  }

  function createSection(ui) {
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, 'API キーを作る', el('small', { text: '連携先ごとに 1 本' })),
      el('label', { class: 'field' }, el('span', { class: 'label', text: '連携先の名前（予約の「予約サイト」の欄に出ます）' }),
        el('input', { class: 'input', type: 'text', maxlength: LABEL_MAX, value: st.label, placeholder: '例: 公式サイト', onchange: (e) => { st.label = e.target.value; } })),
      ui.dock(el('button', { class: 'btn', type: 'button', disabled: st.busy || (st.items !== null && active().length >= st.max),
        text: st.busy ? '作っています…' : 'API キーを作る', onclick: () => create(ui) })));
  }

  function docsSection() {
    const url = docsUrl();
    return el('div', { class: 'sheet' },
      el('p', { class: 'sheet__title' }, '使い方'),
      el('p', { class: 'sheet__note', text: '鍵は、予約を送るサーバー側の設定に貼ります（WordPress の Contact Form 7、Zapier、自社のシステムなど）。' +
        '送り先・送る項目・WordPress と Zapier の設定例・curl での試し方は、説明書にあります。' }),
      url ? el('a', { class: 'linkbtn', href: url, target: '_blank', rel: 'noopener noreferrer', text: '説明書（docs/api.md）を開く' })
        : el('p', { class: 'sheet__note', text: '説明書: docs/api.md（リポジトリの中）' }));
  }

  function render({ ui }) {
    load(ui, false);
    return [
      ...ui.head('API キー', '別のシステムから、予約を送る鍵'),
      st.notice ? el('p', { class: `flag flag--${st.notice.kind}`, role: 'status', text: st.notice.text }) : null,
      synced() ? [st.issued ? issuedSection(ui) : null, listSection(ui), createSection(ui), docsSection()] : el('p', { class: 'empty', text: 'サーバーにつながる版だけで使えます。' }),
      ui.back()
    ];
  }

  /* 予約の一覧の 1 行。サーバーを使わない版には出さない。開くたびに、前に出した鍵は消す */
  function listRow({ ui }) {
    if (!synced()) return null;
    return el('section', { class: 'reset' },
      el('span', { class: 'rd__k', text: 'API キー' }),
      el('button', { class: 'linkbtn', type: 'button', text: '別のシステムから予約を受ける（API キー）',
        onclick: () => { st.issued = null; st.copied = ''; st.notice = null; st.armed = ''; ui.go('apikeys'); } }));
  }

  R.apiKeysStaff = { render, listRow };
})();
