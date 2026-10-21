/* 今日の名簿・カレンダー（.ics）・記録の読み方（純ロジック）。保存・通信・画面・時計は知らない。
   条例の名簿の行と CSV は roster-core.js の rosterRows・toCsv、便を直すのは editTrip */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});
  const S = () => R.roster;
  const C = () => R.rosterCore;

  const when = (t) => `${t.date} ${t.start || '99:99'}`;

  /* ---------- 便で決めること ---------- */
  /* 前の便のポイント（同じ種類で、いちばん近い前の便の潜水場所）。「前の便と同じ」に使う */
  function previousSite(state, trip) {
    const earlier = state.trips.filter(t => t.id !== trip.id && t.kind === trip.kind && t.site && when(t) < when(trip))
      .sort((a, b) => when(b).localeCompare(when(a)));
    return earlier.length ? earlier[0].site : '';
  }

  /* これまでの便で使った名前（入力の候補） */
  const usedSites = (state) => [...new Set(state.trips.map(t => t.site).filter(Boolean))];
  const usedGuides = (state) => [...new Set(state.trips.flatMap(t => t.guides).filter(Boolean))];

  /* ---------- 今日の名簿 ---------- */
  /* 人分け。見てほしい人（確かめる所か、お客さんの入力がまだの所がある人）を上、そろった人を下。
     便で決める項目（潜水日時・場所・ガイド）は、人ではなく便の欄で見せる（tripMissing） */
  /* today（YYYY-MM-DD）より後の便で、当日の健康状態だけがまだの人は morning（当日の朝に答える）に分ける。
     その日の前は、お店が今できることが無いので、見てほしい人に混ぜない。
     乗り合いの他のお店のお客さんは入れない（条例の名簿はお店ごと。合同名簿は roster-share.js） */
  function dayGroups(state, tripId, today) {
    const trip = state.trips.find(t => t.id === tripId);
    if (!trip) return null;
    const items = S().ITEMS[trip.kind];
    const isTrip = (k) => items.find(i => i.key === k).trip;
    const people = C().peopleOf(state, tripId, { own: true }).map(person => {
      const st = C().status(person, trip);
      return { person, unsure: st.unsure, guest: st.missing.filter(k => !isTrip(k)), done: st.done };
    });
    const blank = { ...S().blankPerson(), id: 'trip' };
    const tripMissing = items.filter(i => i.trip && !C().filled(blank, trip, i.key)).map(i => i.key);
    const before = typeof today === 'string' && today < trip.date;
    const onlyMorning = (x) => before && x.unsure.length === 0 && x.guest.length === 1 && x.guest[0] === 'today';
    const needs = (x) => !onlyMorning(x) && (x.unsure.length > 0 || x.guest.length > 0);
    const count = C().bookingsOf(state, tripId).filter(b => b.source !== 'partner').reduce((n, b) => n + b.people, 0);
    return { trip, items, tripMissing, check: people.filter(needs), morning: people.filter(onlyMorning),
      ready: people.filter(x => !needs(x) && !onlyMorning(x)), count };
  }

  /* ---------- カレンダー（.ics） ---------- */
  /* 便ごとに予定を 1 つ。入れるのは時刻・ツアー・人数だけ（名前・電話・健康は入れない）。
     時刻は沖縄の時刻（Asia/Tokyo、夏時間なし）。時刻の無い便は終日の予定にする。
     stamp は書き出した時刻（UTC の YYYYMMDDTHHMMSSZ）。行は CRLF、75 バイトで折り返す（RFC 5545） */
  const KIND_JA = { dive: 'ダイビング', snorkel: 'スノーケル' };
  const HOURS = 3;
  /* 文字の逃がし。改行は CR だけ・LF だけ・CRLF のどれも \n にし、タブ以外の見えない制御文字は消す（別の行を差し込ませない） */
  const icsText = (v) => String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
  const compact = (d) => d.replace(/-/g, '');

  function fold(line) {
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const n = new TextEncoder().encode(ch).length;
      if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join('\r\n ');
  }

  function endOf(start, hours) {
    const [h, m] = start.split(':').map(Number);
    const total = Math.min(h * 60 + m + hours * 60, 23 * 60 + 59);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}${String(total % 60).padStart(2, '0')}00`;
  }

  /* 書き出す便。from 以降（YYYY-MM-DD）、day を渡したらその日だけ */
  function icsTrips(state, { from, day }) {
    return C().tripList(state).filter(t => t.date && (day ? t.date === day : t.date >= from));
  }

  function toIcs(state, { trips, stamp }) {
    if (!/^\d{8}T\d{6}Z$/.test(stamp)) throw new Error(`toIcs: stamp は YYYYMMDDTHHMMSSZ (${stamp})`);
    const shop = state.shop.name || 'REDUX';
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//REDUX//dive-passport-demo//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsText(`${shop} の便`)}`, 'X-WR-TIMEZONE:Asia/Tokyo',
      'BEGIN:VTIMEZONE', 'TZID:Asia/Tokyo', 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0900', 'TZOFFSETTO:+0900', 'TZNAME:JST', 'END:STANDARD', 'END:VTIMEZONE'];
    trips.forEach(t => {
      const count = C().tripSummary(state, t.id).booked;
      const title = `${t.tour || KIND_JA[t.kind]} ${count}人`;
      const time = t.start ? [`DTSTART;TZID=Asia/Tokyo:${compact(t.date)}T${t.start.replace(':', '')}00`, `DTEND;TZID=Asia/Tokyo:${compact(t.date)}T${endOf(t.start, HOURS)}`]
        : [`DTSTART;VALUE=DATE:${compact(t.date)}`, `DTEND;VALUE=DATE:${compact(S().nextDay(t.date))}`];
      lines.push('BEGIN:VEVENT', `UID:trip-${t.id}@redux.invalid`, `DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, ...time, `SUMMARY:${icsText(title)}`,
        ...(t.site ? [`LOCATION:${icsText(t.site)}`] : []), 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  /* ---------- 記録 ---------- */
  /* その便に関わる記録（便・予約・人）を新しい順に。AI に送った記録は便に付かないので、別に返す */
  function tripLog(state, tripId) {
    const bookings = new Set(state.bookings.filter(b => b.tripId === tripId).map(b => b.id));
    const people = new Set(state.people.filter(p => bookings.has(p.bookingId)).map(p => p.id));
    const mine = (e) => (e.kind === 'trip' && e.id === tripId) || (e.kind === 'booking' && bookings.has(e.id)) || (e.kind === 'person' && people.has(e.id));
    const newest = (a, b) => b.at.localeCompare(a.at);
    return {
      entries: state.log.filter(mine).sort(newest),
      ai: state.log.filter(e => e.act === 'ai').sort(newest)
    };
  }

  R.rosterDay = { previousSite, usedSites, usedGuides, dayGroups, icsTrips, toIcs, tripLog };
})();
