/* 乗り合い便の決まり（純ロジック）。保存・通信・画面・時計は知らない。
   1 隻に、この店と他のお店（trip.partners）のお客さんとガイドが乗る。他のお店のお客さんは、出どころ partner の予約（shop にそのお店の名前）に入れる。
   他のお店は、予約の一覧か紙の名簿を写真 1 枚撮って渡す（AI が読み、そのお店が確かめる）。
   船の上では、ガイドが口で伝えたら、お店ごとに「全員戻った」を 1 回押す。人数が合わないときだけ、そのお店の名前で呼ぶ
   （札と札ボードは 2026-10-27 にやめた。決定ログ photo-shopcheck）。
   健康の 2 欄（既往症・当日の健康状態）は船にも他のお店にも渡さない。そのお客さんのお店だけが確かめ、ここには「確かめた」印（heldBy）だけを持つ
   （2026-10-22。店から船へ渡すには本人の同意が要り、船の全員の一覧に載せる理由が無い。報告「乗り合い便の名簿と横断の勝ち筋」）。
   便と人を直して記録に残すのは roster-core.js（editTrip・addPerson・editPerson・addCheck・logHandover） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  const MAX_PARTNERS = 10;
  const SHOP_MAX = 60;
  const GUIDE_MAX = 40;
  /* 他のお店が入れてよい人の項目（健康は別に扱う） */
  const PERSON_FIELDS = ['name', 'birthDate', 'phone', 'address', 'emergency', 'cert', 'courses', 'dives', 'lastDive'];

  const isPartner = (b) => C().isPartnerBooking(b);
  const tripById = (state, id) => state.trips.find(t => t.id === id) || null;
  const unique = (list) => [...new Set(list.map(s => String(s || '').trim()).filter(Boolean))];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* ---------- お店 ---------- */
  /* 船を出す店。host が空ならこの店 */
  const boatOwner = (state, trip) => trip.host || state.shop.name;

  /* 乗るお店。この店が先、次に乗り合いのお店を足した順。外したのに予約が残っているお店も最後に入れる（人を見失わない） */
  function shopsOf(state, trip) {
    const names = [...trip.partners];
    C().bookingsOf(state, trip.id).filter(isPartner).forEach(b => { if (!names.includes(b.shop)) names.push(b.shop); });
    return [{ name: state.shop.name, key: '', own: true }, ...names.map(name => ({ name, key: name, own: false }))];
  }

  const shopBookings = (state, tripId, key) => C().bookingsOf(state, tripId).filter(b => (key === '' ? !isPartner(b) : isPartner(b) && b.shop === key));
  function shopPeople(state, tripId, key) {
    const ids = new Set(shopBookings(state, tripId, key).map(b => b.id));
    return state.people.filter(p => ids.has(p.bookingId));
  }

  /* 足すお店の名前の誤り。null なら足せる */
  function shopProblem(state, trip, name) {
    const n = String(name || '').trim();
    if (!n) return 'empty';
    if (n.length > SHOP_MAX) return 'long';
    if (n === state.shop.name || trip.partners.includes(n)) return 'same';
    if (trip.partners.length >= MAX_PARTNERS) return 'many';
    return null;
  }

  function addPartner(state, { tripId, name, at }) {
    const trip = tripById(state, tripId);
    if (!trip) throw new Error(`addPartner: 便が見つからない (${tripId})`);
    const problem = shopProblem(state, trip, name);
    if (problem) return { state, problem };
    return { state: C().editTrip(state, { tripId, patch: { partners: [...trip.partners, String(name).trim()] }, at }), problem: null };
  }

  /* 外せるのは、まだ人のいないお店だけ。船を出す店だったら、この店に戻す */
  function removePartner(state, { tripId, name, at }) {
    const trip = tripById(state, tripId);
    if (!trip) throw new Error(`removePartner: 便が見つからない (${tripId})`);
    if (shopPeople(state, tripId, name).length) return { state, problem: 'people' };
    const patch = { partners: trip.partners.filter(n => n !== name), ...(trip.host === name ? { host: '' } : {}) };
    return { state: C().editTrip(state, { tripId, patch, at }), problem: null };
  }

  /* 船を出す店。空（この店）か、乗り合いのお店のどれか */
  function setHost(state, { tripId, host, at }) {
    const trip = tripById(state, tripId);
    if (!trip) throw new Error(`setHost: 便が見つからない (${tripId})`);
    const h = host === state.shop.name ? '' : String(host || '').trim();
    if (h && !trip.partners.includes(h)) return { state, problem: 'unknown' };
    return { state: C().editTrip(state, { tripId, patch: { host: h }, at }), problem: null };
  }

  /* ---------- 見本の乗り合い便（11/9 の見せ場。中身は js/data-big-sample.js） ---------- */
  /* day の便を 1 つ作り、この店のお客さんを 1 つの予約に、他のお店を 3 店足す */
  function addBigSample(state, { day, at, newId, sample = R.BIG_SAMPLE }) {
    const made = C().addTrip(state, { trip: { date: day, ...sample.trip }, at, newId });
    const tripId = made.trip.id;
    let st = C().editTrip(made.state, { tripId, patch: { guides: [sample.guide] }, at });
    st = C().addBooking(st, { trip: tripById(st, tripId), booking: { source: 'phone', people: sample.own.length, leadName: sample.own[0].name, leadPhone: sample.leadPhone }, src: 'staff', at, newId });
    const booking = st.bookings[st.bookings.length - 1];
    st.people.filter(x => x.bookingId === booking.id).forEach((x, i) => {
      st = C().editPerson(st, { id: x.id, patch: sample.own[i], who: 'staff', at });
    });
    sample.partners.forEach(p => {
      const shop = addPartner(st, { tripId, name: p.shop, at });
      if (shop.problem) throw new Error(`addBigSample: お店を足せない (${p.shop}: ${shop.problem})`);
      const people = addPartnerPeople(shop.state, { tripId, shop: p.shop, people: p.people, guide: p.guide, demo: true, at, newId });
      if (people.problem) throw new Error(`addBigSample: お客さんを足せない (${p.shop}: ${people.problem})`);
      st = people.state;
    });
    return { state: st, tripId };
  }

  /* ---------- 他のお店のお客さん ---------- */
  const partnerGuide = (state, tripId, shop) => (shopPeople(state, tripId, shop).find(p => p.guide) || { guide: '' }).guide;

  /* 健康の答えは持たず、そのお店が確かめた印だけ。当日の体調は、そのお店が便の日に「渡す」を押したら確かめた扱い（handOver） */
  const heldHealth = (shop) => ({ historyAt: '', answers: Array(S().HEALTH_QUESTIONS).fill(null), todayAt: '', today: '',
    consentAt: '', consentVer: '', heldBy: shop });

  /* 他のお店が自分のお客さんを入れる。people は人の項目（name・birthDate・…）。健康の答えが付いていても入れない（そのお店だけが持つ）。ガイドは要る。
     見本（demo）は、そのお店が便の日に当日の体調を確かめたことにして入れ、記録に見本の印を付ける（試作の画面で「そろった」まで見せるため） */
  function addPartnerPeople(state, { tripId, shop, people, guide, demo, at, newId }) {
    const trip = tripById(state, tripId);
    if (!trip) throw new Error(`addPartnerPeople: 便が見つからない (${tripId})`);
    if (!trip.partners.includes(shop)) return { state, problem: 'shop', ids: [] };
    const g = String(guide || '').trim();
    if (!g || g.length > GUIDE_MAX) return { state, problem: 'guide', ids: [] };
    if (!people.length) return { state, problem: null, ids: [] };
    let st = state;
    const ids = [];
    people.forEach(data => {
      const b = shopBookings(st, tripId, shop)[0];
      if (!b) {
        st = C().addBooking(st, { trip, booking: { source: 'partner', shop, people: 1 }, src: 'partner', at, newId });
        ids.push(shopPeople(st, tripId, shop)[0].id);
      } else {
        const r = C().addPerson(st, { bookingId: b.id, at, newId });
        st = r.state;
        ids.push(r.person.id);
      }
      const id = ids[ids.length - 1];
      const patch = { ...Object.fromEntries(PERSON_FIELDS.filter(k => has(data, k)).map(k => [k, data[k]])), guide: g };
      st = C().editPerson(st, { id, patch, who: 'staff', src: 'partner', at });
      const health = { ...heldHealth(shop), todayAt: demo === true ? trip.date : '' };
      st = C().editPerson(st, { id, patch: { health }, who: 'staff', src: 'partner', demo: demo === true, at });
    });
    return { state: st, problem: null, ids };
  }

  /* ガイドを替える（そのお店の全員）。空にはできない。もう付けた札は新しい名前に付け替える（番号は変えない） */
  function setPartnerGuide(state, { tripId, shop, guide, at }) {
    const g = String(guide || '').trim();
    if (!g || g.length > GUIDE_MAX) return { state, problem: 'guide' };
    const people = shopPeople(state, tripId, shop);
    const st = people.reduce((s, p) => C().editPerson(s, { id: p.id, patch: { guide: g }, who: 'staff', src: 'partner', at }), state);
    return { state: unique(people.map(p => p.guide)).reduce((s, from) => C().renameGuideTag(s, { tripId, shop, from, to: g, at }), st), problem: null };
  }

  /* 前の版（健康の 2 欄を同意つきで船に渡せた版、2026-10-21〜22）で入れた他のお店のお客さんの健康の答えを消し、
     そのお店が確かめた印だけにする。便の日に答えていた人は、その日に確かめた扱いのまま残す（当日の欄を「まだ」に戻さない）。
     名簿を読み込むたびに通す（変える人がいなければ同じ state を返す） */
  function holdPartnerHealth(state, { at }) {
    return state.bookings.filter(isPartner).reduce((st, b) => {
      const trip = tripById(st, b.tripId);
      return st.people.filter(p => p.bookingId === b.id && !p.health.heldBy).reduce((s, p) => {
        const onTheDay = !!trip && p.health.todayAt === trip.date;
        /* 血中酸素（roster-day.js の setSpo2）も、そのお店が測るので持たない。入れ子は前の値に重なるので、空の欄で上書きする */
        const spo2 = Array.isArray(p.health.spo2) ? { spo2: p.health.spo2.map(() => ({ pre: '', post: '' })) } : {};
        return C().editPerson(s, { id: p.id, patch: { health: { ...heldHealth(b.shop), todayAt: onTheDay ? trip.date : '', ...spo2 } }, who: 'system', src: 'partner', at });
      }, st);
    }, state);
  }

  /* 他のお店から受け取った（「渡す」を押した）。人数を記録に残す（健康の欄は受け取らない）。
     便の日（today がその日）に押したら、その人たちの当日の体調は、そのお店がその日に確かめたことにする */
  function handOver(state, { tripId, shop, today, at }) {
    const b = shopBookings(state, tripId, shop)[0];
    if (!b) return state;
    const onTheDay = today === tripById(state, tripId).date;
    const st = shopPeople(state, tripId, shop).filter(p => onTheDay && p.health.heldBy && p.health.todayAt !== today)
      .reduce((s, p) => C().editPerson(s, { id: p.id, patch: { health: { todayAt: today } }, who: 'staff', src: 'partner', at }), state);
    return C().logHandover(st, { bookingId: b.id, people: shopPeople(st, tripId, shop).length, health: false, at });
  }

  /* ---------- 写真で渡す（予約の一覧・紙の名簿） ---------- */
  /* AI の読み取りから、船に渡す人の形にする。渡すのは合同名簿に要る物だけ（名前・体験かどうか・緊急時の連絡先）。
     電話・住所・生年月日などを読んでいても渡さない（店から船へ渡す物を少なくする。決定ログ photo-shopcheck）。
     名前の無い行は入れない。unsure は、その 3 つのうち AI に自信が無かった物（お店が確かめてから渡す） */
  const LIST_KEYS = ['name', 'emergency', 'cert'];
  function fromListReading(reading) {
    return reading.people.filter(p => p.name).map(p => ({
      name: p.name,
      emergency: { ...p.emergency },
      cert: { course: p.cert.course === 'NONE' ? 'NONE' : '', date: '' },
      unsure: p.unsure.filter(k => LIST_KEYS.includes(k))
    }));
  }
  /* 渡す前に足りない物。緊急時の連絡先の電話が無い（足りなくても渡せる。合同名簿に空の欄で出る） */
  const listMissing = (row) => (String(row.emergency.phone || '').trim() ? [] : ['emergency']);

  /* 写真から読んだ人を、そのお店のお客さんとして入れる。もういる名前は入れない（同じ写真を 2 回渡しても増えない）。
     rows は fromListReading の形。unsure は入れない（お店が確かめてから渡す） */
  function addPartnerList(state, { tripId, shop, rows, guide, at, newId }) {
    const have = shopPeople(state, tripId, shop);
    const fresh = rows.filter(r => r.name && !have.some(p => C().sameName(p.name, r.name)));
    const people = fresh.map(r => ({ name: r.name, emergency: r.emergency, cert: r.cert }));
    const out = addPartnerPeople(state, { tripId, shop, people, guide, at, newId });
    return { ...out, skipped: rows.length - fresh.length };
  }

  /* ---------- 船に乗る人 ---------- */
  /* 人の種類（合同名簿の小さい字）。他のお店のお客さんは、体験と書かれていなければファン（そのお店が予約の一覧で分けている） */
  function kindLabel(p, trip) {
    if (trip.kind === 'snorkel') return 'スノーケル';
    if (p.cert.course === 'NONE') return '体験';
    return p.cert.course || p.health.heldBy ? 'ファン' : '';
  }

  /* 船に乗る人を、お店ごとに。ガイドが先、次にお客さん */
  function boatGroups(state, tripId) {
    const trip = tripById(state, tripId);
    if (!trip) return null;
    const owner = boatOwner(state, trip);
    const groups = shopsOf(state, trip).map(shop => {
      const people = shopPeople(state, tripId, shop.key);
      const guides = shop.own ? unique([...trip.guides, ...people.map(p => p.guide)]) : unique(people.map(p => p.guide));
      const members = [
        ...guides.map(name => ({ kind: 'guide', name, label: 'ガイド' })),
        ...people.map(p => ({ kind: 'person', name: p.name, person: p, label: kindLabel(p, trip), status: C().status(p, trip) }))
      ];
      return { ...shop, owner: shop.name === owner, members, guides: guides.length, people: people.length };
    });
    return { trip, owner, groups, aboard: groups.reduce((n, g) => n + g.members.length, 0) };
  }

  /* ---------- 合同名簿（印刷） ---------- */
  /* 合同名簿に載せる項目。船の上で要る物だけ。住所・生年月日・C カード・潜水経験と、健康の 2 欄（既往症・当日の健康状態）は、
     各店の条例の名簿（P4）だけに残す（この店のお客さんの分も載せない。船の全員の一覧に健康を載せない） */
  const JOINT_KEYS = ['name', 'shop', 'kind', 'guide', 'emergency'];
  const JOINT_JA = { shop: '店', kind: '種類', guide: 'ガイド' };
  const jointItems = (kind) => JOINT_KEYS.map(key => ({ key, ja: JOINT_JA[key] || S().ITEMS[kind].find(i => i.key === key).ja }));

  /* お店ごとに、お客さんの行（合同名簿の項目）。ガイドは名簿に入れず、人数だけ。blank は空の欄の数 */
  function jointRows(state, tripId) {
    const g = boatGroups(state, tripId);
    if (!g) return null;
    const items = jointItems(g.trip.kind);
    const cellOf = (m, group, key) => (key === 'shop' ? group.name : key === 'kind' ? m.label : C().cellText(m.person, g.trip, key, []));   // 健康の欄は載せないので、質問の短い名前は要らない
    const groups = g.groups.map(group => ({
      name: group.name, own: group.own, owner: group.owner, guides: group.guides,
      rows: group.members.filter(m => m.kind === 'person').map(m => {
        const cells = Object.fromEntries(items.map(i => [i.key, cellOf(m, group, i.key)]));
        return { personId: m.person.id, done: m.status.done, blank: items.filter(i => !cells[i.key]).length, cells };
      })
    }));
    return { trip: g.trip, owner: g.owner, items, groups, people: groups.reduce((n, x) => n + x.rows.length, 0),
      guides: groups.reduce((n, x) => n + x.guides, 0) };
  }

  /* ---------- 船の上: お店ごとに「全員戻った」（決定ログ photo-shopcheck） ---------- */
  /* ガイドが口で「全員戻りました」と伝えたら、そのお店を 1 回押す（今の口頭の確かめのまま、30 人を数えない）。
     全部のお店が戻るまで、ポイントを離れられない。人数が合わないときだけ、そのお店のお客さんの名前を呼んで「いた」を押す。
     何本目かは、ポイントを離れた数 + 1。記録は足すだけ（押し間違いは undo を足して取り消す） */
  const diveNow = (trip) => trip.checks.filter(c => c.stage === 'leave').length + 1;
  const leaves = (trip) => trip.checks.filter(c => c.stage === 'leave');

  /* 今の本の、お店ごとの確かめ。お客さんのいないお店は入れない（ガイドだけのお店は数えない）。
     backAt: 戻ったと押した時刻（取り消したら ''）/ here: 名前で呼んで「いた」を押した人の id */
  function returns(state, tripId) {
    const g = boatGroups(state, tripId);
    if (!g) return null;
    const dive = diveNow(g.trip);
    const now = g.trip.checks.filter(c => c.dive === dive && c.stage !== 'leave');
    const shops = g.groups.filter(group => group.people > 0).map(group => {
      const mine = now.filter(c => c.shop === group.key);
      const last = mine.filter(c => c.stage === 'return' || c.stage === 'undo').pop();
      return {
        key: group.key, name: group.name, own: group.own, owner: group.owner,
        guides: group.members.filter(m => m.kind === 'guide').map(m => m.name),
        people: group.members.filter(m => m.kind === 'person'),
        backAt: last && last.stage === 'return' ? last.at : '',
        here: new Set(mine.filter(c => c.stage === 'here').map(c => c.person))
      };
    });
    const waiting = shops.filter(x => !x.backAt);
    return { trip: g.trip, dive, shops, waiting, allBack: shops.length > 0 && !waiting.length,
      people: shops.reduce((n, x) => n + x.people.length, 0) };
  }

  function shopNow(state, tripId, shop, name) {
    const r = returns(state, tripId);
    if (!r) throw new Error(`${name}: 便が見つからない (${tripId})`);
    return { r, x: r.shops.find(s => s.key === shop) || null };
  }

  /* そのお店が全員戻った。もう戻っていれば何もしない（続けて押しても 1 回） */
  function recordReturn(state, { tripId, shop, at }) {
    const { r, x } = shopNow(state, tripId, shop, 'recordReturn');
    if (!x) return { state, problem: 'shop' };
    if (x.backAt) return { state, problem: null };
    return { state: C().addCheck(state, { tripId, check: { stage: 'return', shop, dive: r.dive }, at }), problem: null };
  }

  /* 押し間違いの「戻った」を取り消す（記録は消さず、取り消しを足す） */
  function undoReturn(state, { tripId, shop, at }) {
    const { r, x } = shopNow(state, tripId, shop, 'undoReturn');
    if (!x || !x.backAt) return { state, problem: null };
    return { state: C().addCheck(state, { tripId, check: { stage: 'undo', shop, dive: r.dive }, at }), problem: null };
  }

  /* 人数が合わないとき、名前で呼んでいた人。そのお店のお客さんだけ */
  function recordHere(state, { tripId, shop, personId, at }) {
    const { r, x } = shopNow(state, tripId, shop, 'recordHere');
    if (!x) return { state, problem: 'shop' };
    if (!x.people.some(m => m.person.id === personId)) return { state, problem: 'person' };
    if (x.here.has(personId)) return { state, problem: null };
    return { state: C().addCheck(state, { tripId, check: { stage: 'here', shop, dive: r.dive, person: personId }, at }), problem: null };
  }

  /* ポイントを離れる。全部のお店が戻っていなければ残さない（problem: waiting）。誰も乗っていなければ残さない（empty） */
  function recordLeave(state, { tripId, at }) {
    const r = returns(state, tripId);
    if (!r) throw new Error(`recordLeave: 便が見つからない (${tripId})`);
    if (!r.shops.length) return { state, problem: 'empty' };
    if (r.waiting.length) return { state, problem: 'waiting' };
    return { state: C().addCheck(state, { tripId, check: { stage: 'leave', dive: r.dive }, at }), problem: null };
  }

  R.rosterShare = {
    MAX_PARTNERS, JOINT_KEYS, boatOwner, shopsOf, shopPeople, shopProblem, addPartner, removePartner, setHost,
    partnerGuide, addPartnerPeople, setPartnerGuide, holdPartnerHealth, handOver, addBigSample,
    fromListReading, listMissing, addPartnerList,
    kindLabel, boatGroups, jointRows, returns, recordReturn, undoReturn, recordHere, recordLeave, leaves
  };
})();
