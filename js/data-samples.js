/* 見本の読み取り（tools/make-samples.mjs が作る。手で直さない）。
   AI の読み取り試験 (2026-10-21) の Haiku の答え。予約の項目はメールの本文から手で書いた。中身はすべて架空。
   SAMPLE_MAILS は見本の予約メールの文面（assets/samples/e*.txt と同じ）
   電話番号は 2026-10-31 に、実在しうる番号から使われていない番号帯 (090-0000-1xxx など) へ置き換えた（メイの WARN）。
   書類の番号も同じに描き直し、Haiku で取り直して新しい番号を全部正しく読むことを確かめた。番号以外は 2026-10-21 の答えのまま */
(() => {
  'use strict';
  const R = (globalThis.REDUX = globalThis.REDUX || {});
  R.SAMPLE_READINGS = {
 "c1": {
  "booking": null,
  "people": [
   {
    "name": "見本 花子",
    "birthDate": "1998-04-12",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "OW",
     "date": "2023-08-20"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "c2": {
  "booking": null,
  "people": [
   {
    "name": "見本 次郎",
    "birthDate": "1965-02-28",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "AOW",
     "date": "2010-05-09"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "c3": {
  "booking": null,
  "people": [
   {
    "name": "見本 四郎",
    "birthDate": "1985-12-01",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "RESCUE",
     "date": "2015-07-18"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "c4": {
  "booking": null,
  "people": [
   {
    "name": "KIM SEOYEON",
    "birthDate": "1990-06-15",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "OW",
     "date": "2018-09-01"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "c5": {
  "booking": null,
  "people": [
   {
    "name": "見本 さくら",
    "birthDate": "2013-06-08",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "JOW",
     "date": "2024-08-15"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "c6": {
  "booking": null,
  "people": [
   {
    "name": "SMITH, JAMES",
    "birthDate": "1992-03-05",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "AOW",
     "date": "2021-07-17"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "f1": {
  "booking": null,
  "people": [
   {
    "name": "見本 一美",
    "birthDate": "1992-07-03",
    "phone": "090-0000-1101",
    "address": "沖縄県那覇市見本町1-2-3",
    "emergency": {
     "name": "見本 一郎",
     "relation": "父",
     "phone": "090-0000-1102"
    },
    "cert": {
     "course": "OW",
     "date": "2020-08-10"
    },
    "dives": 15,
    "lastDive": "2025-09",
    "sizes": {
     "height": 158,
     "weight": 50,
     "foot": 23.5
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "f2": {
  "booking": null,
  "people": [
   {
    "name": "見本 健二",
    "birthDate": "1975-11-23",
    "phone": "06-0000-1111",
    "address": "大阪府大阪市見本巳2-3-4",
    "emergency": {
     "name": "見本 由美",
     "relation": "妻",
     "phone": "090-0000-1201"
    },
    "cert": {
     "course": "AOW",
     "date": "2008-06-01"
    },
    "dives": 85,
    "lastDive": "2026-03",
    "sizes": {
     "height": 172,
     "weight": 68,
     "foot": 26.5
    },
    "unsure": [
     "address"
    ]
   }
  ],
  "healthSeen": false
 },
 "f3": {
  "booking": null,
  "people": [
   {
    "name": "見本 美咲",
    "birthDate": "2001-01-15",
    "phone": "080-0000-1301",
    "address": "東京都江東区見本1-1-1",
    "emergency": {
     "name": "見本 美和",
     "relation": "母",
     "phone": "080-0000-1302"
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": 0,
    "lastDive": "",
    "sizes": {
     "height": 160,
     "weight": 52,
     "foot": 24
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "f4": {
  "booking": null,
  "people": [
   {
    "name": "見本 拓也",
    "birthDate": "1988-09-09",
    "phone": "090-0000-1401",
    "address": "福岡県福岡市見本区5-6-7",
    "emergency": {
     "name": "見本 恵",
     "relation": "妻",
     "phone": "090-0000-1402"
    },
    "cert": {
     "course": "RESCUE",
     "date": "2016-04-29"
    },
    "dives": 140,
    "lastDive": "2026-08",
    "sizes": {
     "height": 178,
     "weight": 75,
     "foot": 27
    },
    "unsure": [
     "phone"
    ]
   }
  ],
  "healthSeen": false
 },
 "f5": {
  "booking": null,
  "people": [
   {
    "name": "見本 翔太",
    "birthDate": "1999-05-05",
    "phone": "070-0000-1501",
    "address": "神奈川県横浜市見本区8-9-10",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "OW",
     "date": "2022-10-10"
    },
    "dives": 6,
    "lastDive": "2023-05",
    "sizes": {
     "height": 170,
     "weight": 60,
     "foot": 26
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "f6": {
  "booking": null,
  "people": [
   {
    "name": "見本 和子",
    "birthDate": "1983-03-21",
    "phone": "0980-00-1234",
    "address": "沖縄県宮古島市見本1-2",
    "emergency": {
     "name": "見本 和夫",
     "relation": "夫",
     "phone": "090-0000-1601"
    },
    "cert": {
     "course": "AOW",
     "date": "2015-07"
    },
    "dives": 30,
    "lastDive": "2025",
    "sizes": {
     "height": 155,
     "weight": 48,
     "foot": 23
    },
    "unsure": [
     "lastDive"
    ]
   }
  ],
  "healthSeen": false
 },
 "e1": {
  "booking": {
   "site": "予約サイト（見本）",
   "ref": "YS-20261020-0042",
   "date": "2026-10-24",
   "start": "08:30",
   "tour": "体験ダイビング（ボート2本）",
   "people": 2,
   "leadName": "見本 花子",
   "leadPhone": "090-0000-1701",
   "leadEmail": "hanako@mail.example",
   "unsure": []
  },
  "people": [
   {
    "name": "見本 花子",
    "birthDate": "",
    "phone": "090-0000-1701",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": 0,
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   },
   {
    "name": "見本 太郎",
    "birthDate": "",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": 0,
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 },
 "e2": {
  "booking": {
   "site": "Booking Platform (sample)",
   "ref": "TB-88231",
   "date": "2026-10-24",
   "start": "",
   "tour": "Fun Dive, 2 tanks",
   "people": 2,
   "leadName": "Seo-yeon Kim",
   "leadPhone": "+82 10-0000-1702",
   "unsure": [
    "start"
   ]
  },
  "people": [
   {
    "name": "Seo-yeon Kim",
    "birthDate": "1990-06-15",
    "phone": "+82 10-0000-1702",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "OW",
     "date": "2018"
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   },
   {
    "name": "Min-jun",
    "birthDate": "1988-02-03",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": [
     "name"
    ]
   }
  ],
  "healthSeen": false
 },
 "e3": {
  "booking": {
   "site": "お問い合わせフォーム",
   "ref": "",
   "date": "2026-10-24",
   "start": "",
   "tour": "ファンダイビング",
   "people": 1,
   "leadName": "見本 健太",
   "leadPhone": "090-0000-1801",
   "unsure": [
    "date",
    "start"
   ]
  },
  "people": [
   {
    "name": "見本 健太",
    "birthDate": "1995-12-24",
    "phone": "090-0000-1801",
    "address": "北海道札幌市見本区3-3-3",
    "emergency": {
     "name": "見本 洋子",
     "relation": "母",
     "phone": "090-0000-1802"
    },
    "cert": {
     "course": "AOW",
     "date": "2019"
    },
    "dives": 40,
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": [
     "dives",
     "lastDive"
    ]
   }
  ],
  "healthSeen": false
 },
 "e4": {
  "booking": {
   "site": "メール",
   "ref": "",
   "date": "2026-10-24",
   "start": "",
   "tour": "体験ダイビング",
   "people": 3,
   "leadName": "見本 大輔",
   "leadPhone": "090-0000-1901",
   "leadEmail": "daisuke@mail.example",
   "unsure": [
    "date",
    "start"
   ]
  },
  "people": [
   {
    "name": "見本 大輔",
    "birthDate": "",
    "phone": "090-0000-1901",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "OW",
     "date": ""
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": [
     "phone"
    ]
   },
   {
    "name": "見本 さやか",
    "birthDate": "",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   },
   {
    "name": "見本 蓮",
    "birthDate": "",
    "phone": "",
    "address": "",
    "emergency": {
     "name": "",
     "relation": "",
     "phone": ""
    },
    "cert": {
     "course": "NONE",
     "date": ""
    },
    "dives": "",
    "lastDive": "",
    "sizes": {
     "height": "",
     "weight": "",
     "foot": ""
    },
    "unsure": []
   }
  ],
  "healthSeen": false
 }
};
  R.SAMPLE_MAILS = {
 "e1": {
  "note": "予約サイトの通知 (2 人、同行者は名前だけ)",
  "text": "件名: 【予約確定】体験ダイビング（ボート2本） 10/24（土）\n送信者: 予約サイト（見本） <no-reply@yoyaku.example>\n\nB マリン（見本） ご担当者様\n\n以下の予約が確定しました。\n予約番号: YS-20261020-0042\nプラン: 体験ダイビング（ボート2本）\n日時: 2026年10月24日（土） 8:30 集合\n人数: 大人 2 名\n代表者: 見本 花子（ミホン ハナコ）様\n電話番号: 090-0000-1701\nメール: hanako@mail.example\n備考: 同行者は 見本 太郎 です。2人とも潜るのは初めてです。"
 },
 "e2": {
  "note": "海外の予約サイト (英語、2 人)",
  "text": "Subject: New booking: Kerama Fun Dive (2 tanks) - Oct 24, 2026\nFrom: Booking Platform (sample) <noreply@tours.example>\n\nBooking ref: TB-88231\nActivity: Fun Dive, 2 tanks\nDate: Saturday, October 24, 2026\nLead traveler: Seo-yeon Kim\nPhone: +82 10-0000-1702\nParticipants: 2\n\nAnswers to your questions:\n- Date of birth of each participant: Seo-yeon 1990-06-15 / Min-jun 1988-02-03\n- Certification level and year: Seo-yeon Open Water (2018). Min-jun has no certification, wants a Discover Scuba.\n- Hotel for pickup: Sample Hotel Naha"
 },
 "e3": {
  "note": "お店のサイトの問い合わせフォーム (1 人、文が混ざる)",
  "text": "件名: [お問い合わせ] ファンダイビングの予約希望\n送信者: B マリン（見本） お問い合わせフォーム\n\nお名前: 見本 健太\n生年月日: 1995/12/24\nご住所: 北海道札幌市見本区3-3-3\nお電話: 090-0000-1801\nご希望日: 10月24日\nメッセージ:\nアドバンスを2019年に取りました。本数は40本くらいです。最後に潜ったのは今年の6月です。\n緊急連絡先は母の 見本 洋子（090-0000-1802）でお願いします。"
 },
 "e4": {
  "note": "転送されたメール (3 人、引っかけあり)",
  "text": "件名: Fwd: Re: 24日の体験ダイビング\n送信者: 見本 大輔 <daisuke@mail.example>\n\n来週24日に3人でお願いします。メンバーは 見本 大輔、見本 さやか、見本 蓮（息子、12歳）です。\n私（大輔）はCカード持ってます（オープンウォーター）。さやかと蓮は初めてです。\n連絡は 090-0000-1901 までお願いします。\nPS 蓮は24日が誕生日なんです！\n\n> 2026/10/18 B マリン（見本） 山田 <info@bmarine.example> のメッセージ:\n> お問い合わせありがとうございます。担当の山田です。\n> 24日は空きがございます。参加される方のお名前をお知らせください。"
 }
};

  /* 見本のメールはどれも 2026-10-24（土）の予約。画面では、開いた日の 2 日後以降で最初の土曜日にずらして出す
     （過去の便に入らないように。小禄さんの不具合さがし 2026-10-27）。生年月日・予約番号・最後に潜った月は動かさない。
     today は 'YYYY-MM-DD'。時計は読まない（呼ぶ側が今日を渡す） */
  const SAMPLE_DAY = '2026-10-24';
  /* 日付の数（1970-01-01 からの日数）と、その逆。時計を使わずに数える（暦の式。roster-guest.js の dayNumber と同じ） */
  function dayNumber(ymd) {
    const [y0, m, d] = ymd.split('-').map(Number);
    const y = m <= 2 ? y0 - 1 : y0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  }
  function ymdOf(n) {
    const z = n + 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
  }
  const pad = (n) => String(n).padStart(2, '0');
  const weekday = (n) => (((n + 4) % 7) + 7) % 7;   // 1970-01-01 は木曜日。0 が日曜日
  const WEEK_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const WEEK_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTH_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  R.sampleMailDay = (today) => {
    const from = dayNumber(today) + 2;
    const { y, m, d } = ymdOf(from + (6 - weekday(from) + 7) % 7);
    return `${y}-${pad(m)}-${pad(d)}`;
  };
  R.sampleMail = (id, today) => {
    const day = R.sampleMailDay(today);
    const n = dayNumber(day);
    const { y, m, d } = ymdOf(n);
    const w = weekday(n);
    const a = ymdOf(n - 6);
    const asked = `${a.y}/${pad(a.m)}/${pad(a.d)}`;   // e4 で、お店が「24日は空き」と返した日（予約の 6 日前）
    const swaps = {
      e1: [['10/24（土）', `${m}/${d}（${WEEK_JA[w]}）`], ['2026年10月24日（土）', `${y}年${m}月${d}日（${WEEK_JA[w]}）`]],
      e2: [['Saturday, October 24, 2026', `${WEEK_EN[w]}, ${MONTH_EN[m - 1]} ${d}, ${y}`], ['Oct 24, 2026', `${MONTH_EN[m - 1].slice(0, 3)} ${d}, ${y}`]],
      e3: [['ご希望日: 10月24日', `ご希望日: ${m}月${d}日`]],
      e4: [['2026/10/18', asked], ['24日', `${d}日`]]
    }[id] || [];
    const text = swaps.reduce((s, [a, b]) => s.split(a).join(b), R.SAMPLE_MAILS[id].text);
    const reading = JSON.parse(JSON.stringify(R.SAMPLE_READINGS[id]));
    if (reading.booking && reading.booking.date === SAMPLE_DAY) reading.booking.date = day;
    return { text, reading };
  };
})();
