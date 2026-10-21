/* 乗り合い便の決まり（純ロジック）。保存・通信・画面・時計は知らない。
   1 隻に、この店と他のお店（trip.partners）のお客さんとガイドが乗る。他のお店のお客さんは、出どころ partner の予約（shop にそのお店の名前）に入れる。
   札は 1 人 1 枚（ガイドも）。番号は「お店の頭文字-番号」で、一度付けたら変えない。
   便と人を直して記録に残すのは roster-core.js（editTrip・addPerson・editPerson・addTags・addCheck・logHandover） */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  /* 他のお店が「お客さんから、同じ船のお店に健康の答えを渡す同意をもらった」と言った版。お客さん本人の同意（roster-guest.js）とは別 */
  const PARTNER_CONSENT_VER = 'partner-2026-10-21';
  const MAX_PARTNERS = 10;
  const SHOP_MAX = 60;
  const GUIDE_MAX = 40;
  const LEAVE_GUARD_MS = 10000;   // 「全員戻った」を続けて押したのを、2 回目と数えない間
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

  /* ---------- 他のお店のお客さん ---------- */
  const partnerGuide = (state, tripId, shop) => (shopPeople(state, tripId, shop).find(p => p.guide) || { guide: '' }).guide;

  /* 健康の 2 欄を渡しているか。渡していない人（heldBy のある人）が 1 人もいなければ渡している */
  function partnerShares(state, tripId, shop) {
    const people = shopPeople(state, tripId, shop);
    return people.length > 0 && people.every(p => !p.health.heldBy);
  }

  const heldHealth = (shop) => ({ historyAt: '', answers: Array(S().HEALTH_QUESTIONS).fill(null), todayAt: '', today: '',
    consentAt: '', consentVer: '', heldBy: shop });
  /* 渡すにした。他のお店が確かめた日（todayAt）は、答えた日ではないので消す */
  const sharedHealth = (h, today) => ({ ...h, ...(h.heldBy ? { todayAt: '' } : {}), heldBy: '', consentAt: today, consentVer: PARTNER_CONSENT_VER });

  /* 他のお店が自分のお客さんを入れる。people は人の項目（name・birthDate・… と health: { answers, today }）。
     share（同じ船のお店に健康の答えを渡す同意をお客さんからもらった）が無いときは、健康の答えを入れず、そのお店が確かめた印だけ付ける。
     もう人のいるお店が渡さない形なら、share があっても渡さない（混ぜない）。渡す形のお店に share の無い人を足すときは problem: 'share'
     （同意の無い人の答えを入れない。先に印を外してもらう）。
     health.today は答えた日（today）の体調として入れ、便の日に答えた物だけが当日の分になる。見本（demo）は便の日として入れ、記録に印を付ける。ガイドは要る */
  function addPartnerPeople(state, { tripId, shop, people, guide, share, today, demo, at, newId }) {
    const trip = tripById(state, tripId);
    if (!trip) throw new Error(`addPartnerPeople: 便が見つからない (${tripId})`);
    if (!trip.partners.includes(shop)) return { state, problem: 'shop', ids: [] };
    const g = String(guide || '').trim();
    if (!g || g.length > GUIDE_MAX) return { state, problem: 'guide', ids: [] };
    if (!people.length) return { state, problem: null, ids: [] };
    const existing = shopPeople(state, tripId, shop).length > 0;
    const shopShares = existing && partnerShares(state, tripId, shop);
    if (shopShares && share !== true) return { state, problem: 'share', ids: [] };
    const sharing = share === true && (!existing || shopShares);
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
      const h = data.health || {};
      const answers = Array.isArray(h.answers) ? h.answers : null;
      const todayAt = h.today ? (demo === true ? trip.date : today) : '';
      const health = !sharing ? heldHealth(shop)
        : answers ? sharedHealth({ historyAt: today, answers, todayAt, today: h.today || '' }, today)
          : { consentAt: today, consentVer: PARTNER_CONSENT_VER, heldBy: '' };
      st = C().editPerson(st, { id, patch: { health }, who: 'staff', src: 'partner', demo: demo === true && sharing && !!answers && !!h.today, at });
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

  /* 健康の 2 欄を渡すか。渡さないにしたら、入っていた健康の答えも消す（同意が無いなら持たない）。もうその形の人はそのまま */
  function setPartnerShare(state, { tripId, shop, share, today, at }) {
    return shopPeople(state, tripId, shop).filter(p => !!p.health.heldBy === share).reduce((st, p) => C().editPerson(st, {
      id: p.id, who: 'staff', src: 'partner', at,
      patch: { health: share ? sharedHealth(p.health, today) : heldHealth(shop) }
    }), state);
  }

  /* 他のお店から受け取った（「渡す」を押した）。人数と、健康の欄を受け取ったかを記録に残す。
     便の日（today がその日）に押したら、健康の答えを渡さない人の当日の体調は、そのお店がその日に確かめたことにする */
  function handOver(state, { tripId, shop, today, at }) {
    const b = shopBookings(state, tripId, shop)[0];
    if (!b) return state;
    const onTheDay = today === tripById(state, tripId).date;
    const st = shopPeople(state, tripId, shop).filter(p => onTheDay && p.health.heldBy && p.health.todayAt !== today)
      .reduce((s, p) => C().editPerson(s, { id: p.id, patch: { health: { todayAt: today } }, who: 'staff', src: 'partner', at }), state);
    return C().logHandover(st, { bookingId: b.id, people: shopPeople(st, tripId, shop).length, health: partnerShares(st, tripId, shop), at });
  }

  /* ---------- 船に乗る人と札 ---------- */
  /* 人の種類（合同名簿の小さい字） */
  function kindLabel(p, trip) {
    if (trip.kind === 'snorkel') return 'スノーケル';
    if (p.cert.course === 'NONE') return '体験';
    return p.cert.course ? 'ファン' : '';
  }
  const tagKey = (t) => (t.personId ? `p:${t.personId}` : `g:${t.shop}\u0000${t.guide}`);
  const tagNumber = (no) => Number(String(no).split('-').pop()) || 0;
  const prefixOf = (no) => String(no).split('-').slice(0, -1).join('-');

  /* 札の番号の順。番号の無い人はその後ろに、元の順で */
  function byTag(a, b) {
    if (a.tag && b.tag) return tagNumber(a.tag) - tagNumber(b.tag);
    return a.tag ? -1 : b.tag ? 1 : 0;
  }

  /* 船に乗る人を、お店ごとに。ガイドが先、次にお客さん。札の番号があればその順 */
  function boatGroups(state, tripId) {
    const trip = tripById(state, tripId);
    if (!trip) return null;
    const tagOf = new Map(trip.tags.map(t => [tagKey(t), t.no]));
    const owner = boatOwner(state, trip);
    const groups = shopsOf(state, trip).map(shop => {
      const people = shopPeople(state, tripId, shop.key);
      const guides = shop.own ? unique([...trip.guides, ...people.map(p => p.guide)]) : unique(people.map(p => p.guide));
      const members = [
        ...guides.map(name => ({ kind: 'guide', name, label: 'ガイド', tag: tagOf.get(tagKey({ guide: name, shop: shop.key })) || '' })),
        ...people.map(p => ({ kind: 'person', name: p.name, person: p, label: kindLabel(p, trip), status: C().status(p, trip),
          tag: tagOf.get(tagKey({ personId: p.id })) || '' }))
      ].map((m, i) => ({ ...m, order: i })).sort((a, b) => byTag(a, b) || a.order - b.order);
      return { ...shop, owner: shop.name === owner, members, guides: guides.length, people: people.length };
    });
    const all = groups.flatMap(g => g.members);
    return { trip, owner, groups, aboard: all.length, tagged: all.filter(m => m.tag).length, untagged: all.filter(m => !m.tag).length };
  }

  /* お店の札の頭文字。もう付けた札があればそれ、無ければ名前の字で、ほかのお店と重ならない物。まだ人のいないお店は取らない */
  function prefixes(groups) {
    const fixed = groups.map(g => { const t = g.members.find(m => m.tag); return t ? prefixOf(t.tag) : ''; });
    const used = new Set(fixed.filter(Boolean));
    return groups.map((g, i) => {
      if (fixed[i] || !g.members.length) return fixed[i];
      const chars = [...String(g.name).normalize('NFKC').toUpperCase()].filter(c => /[\p{L}\p{N}]/u.test(c));
      const p = chars.find(c => !used.has(c)) || [...Array(groups.length + 1).keys()].map(n => String(n + 1)).find(c => !used.has(c));
      used.add(p);
      return p;
    });
  }

  /* 番号の無い人に札を付ける。お店ごとに、今ある番号の続きから */
  function assignTags(state, { tripId, at }) {
    const g = boatGroups(state, tripId);
    if (!g || !g.untagged) return state;
    const pre = prefixes(g.groups);
    const tags = g.groups.flatMap((group, i) => {
      let next = Math.max(0, ...g.trip.tags.filter(t => prefixOf(t.no) === pre[i]).map(t => tagNumber(t.no))) + 1;
      return group.members.filter(m => !m.tag).map(m => {
        const no = `${pre[i]}-${next++}`;
        return m.kind === 'guide' ? { guide: m.name, shop: group.key, no } : { personId: m.person.id, no };
      });
    });
    return C().addTags(state, { tripId, tags, at });
  }

  /* ---------- 合同名簿（印刷） ---------- */
  /* お店ごとに、お客さんの行（札の番号と条例の項目）。ガイドは名簿に入れず、札だけ */
  function jointRows(state, tripId, healthShort) {
    const g = boatGroups(state, tripId);
    if (!g) return null;
    const items = S().ITEMS[g.trip.kind];
    const groups = g.groups.map(group => ({
      name: group.name, own: group.own, owner: group.owner, guides: group.guides,
      rows: group.members.filter(m => m.kind === 'person').map(m => ({
        personId: m.person.id, tag: m.tag, done: m.status.done,
        cells: Object.fromEntries(items.map(i => [i.key, C().cellText(m.person, g.trip, i.key, healthShort)]))
      }))
    }));
    return { trip: g.trip, owner: g.owner, items, groups, people: groups.reduce((n, x) => n + x.rows.length, 0),
      guides: groups.reduce((n, x) => n + x.guides, 0) };
  }

  /* ---------- ポイントを離れる前 ---------- */
  /* 札ボードで「海の中」が 0 枚になったときに 1 回押す。札の枚数と時刻を残す。
     札の番号が無い人がいる（ボードで数えられない）・誰もいないときは残さない（problem: untagged / empty） */
  function recordLeave(state, { tripId, at }) {
    const g = boatGroups(state, tripId);
    if (!g) throw new Error(`recordLeave: 便が見つからない (${tripId})`);
    if (!g.aboard) return { state, problem: 'empty' };
    if (g.untagged) return { state, problem: 'untagged' };
    return { state: C().addCheck(state, { tripId, stage: 'leave', tags: g.tagged, at }), problem: null };
  }
  const leaveChecks = (trip) => trip.checks.filter(c => c.stage === 'leave');
  /* 続けて押したか。lastMs は前の記録の時刻（ミリ秒。無ければ null）、nowMs は今。時計は画面の側で読む */
  const leaveRepeat = (lastMs, nowMs) => Number.isFinite(lastMs) && nowMs >= lastMs && nowMs - lastMs < LEAVE_GUARD_MS;

  R.rosterShare = {
    PARTNER_CONSENT_VER, MAX_PARTNERS, boatOwner, shopsOf, shopPeople, shopProblem, addPartner, removePartner, setHost,
    partnerGuide, partnerShares, addPartnerPeople, setPartnerGuide, setPartnerShare, handOver,
    kindLabel, boatGroups, assignTags, jointRows, recordLeave, leaveChecks, leaveRepeat
  };
})();
