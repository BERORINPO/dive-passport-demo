/* 見本の読み取り（tools/make-samples.mjs が作る。手で直さない）。
   AI の読み取り試験 (2026-10-21) の Haiku の答え。予約の項目はメールの本文から手で書いた。中身はすべて架空。
   SAMPLE_MAILS は見本の予約メールの文面（assets/samples/e*.txt と同じ） */
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
    "phone": "090-1234-0001",
    "address": "沖縄県那覇市見本町1-2-3",
    "emergency": {
     "name": "見本 一郎",
     "relation": "父",
     "phone": "090-1234-0002"
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
     "phone": "090-2222-3333"
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
    "phone": "080-3333-4444",
    "address": "東京都江東区見本1-1-1",
    "emergency": {
     "name": "見本 美和",
     "relation": "母",
     "phone": "080-5555-6666"
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
    "phone": "090-7777-8888",
    "address": "福岡県福岡市見本区5-6-7",
    "emergency": {
     "name": "見本 恵",
     "relation": "妻",
     "phone": "090-9999-0000"
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
    "phone": "070-1111-2222",
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
     "phone": "090-1212-3434"
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
   "leadPhone": "090-1234-5678",
   "unsure": []
  },
  "people": [
   {
    "name": "見本 花子",
    "birthDate": "",
    "phone": "090-1234-5678",
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
   "leadPhone": "+82 10-1234-5678",
   "unsure": [
    "start"
   ]
  },
  "people": [
   {
    "name": "Seo-yeon Kim",
    "birthDate": "1990-06-15",
    "phone": "+82 10-1234-5678",
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
   "leadPhone": "090-4545-6767",
   "unsure": [
    "date",
    "start"
   ]
  },
  "people": [
   {
    "name": "見本 健太",
    "birthDate": "1995-12-24",
    "phone": "090-4545-6767",
    "address": "北海道札幌市見本区3-3-3",
    "emergency": {
     "name": "見本 洋子",
     "relation": "母",
     "phone": "090-8989-0101"
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
   "leadPhone": "090-0101-2323",
   "unsure": [
    "date",
    "start"
   ]
  },
  "people": [
   {
    "name": "見本 大輔",
    "birthDate": "",
    "phone": "090-0101-2323",
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
  "text": "件名: 【予約確定】体験ダイビング（ボート2本） 10/24（土）\n送信者: 予約サイト（見本） <no-reply@yoyaku.example>\n\nB マリン（見本） ご担当者様\n\n以下の予約が確定しました。\n予約番号: YS-20261020-0042\nプラン: 体験ダイビング（ボート2本）\n日時: 2026年10月24日（土） 8:30 集合\n人数: 大人 2 名\n代表者: 見本 花子（ミホン ハナコ）様\n電話番号: 090-1234-5678\nメール: hanako@mail.example\n備考: 同行者は 見本 太郎 です。2人とも潜るのは初めてです。"
 },
 "e2": {
  "note": "海外の予約サイト (英語、2 人)",
  "text": "Subject: New booking: Kerama Fun Dive (2 tanks) - Oct 24, 2026\nFrom: Booking Platform (sample) <noreply@tours.example>\n\nBooking ref: TB-88231\nActivity: Fun Dive, 2 tanks\nDate: Saturday, October 24, 2026\nLead traveler: Seo-yeon Kim\nPhone: +82 10-1234-5678\nParticipants: 2\n\nAnswers to your questions:\n- Date of birth of each participant: Seo-yeon 1990-06-15 / Min-jun 1988-02-03\n- Certification level and year: Seo-yeon Open Water (2018). Min-jun has no certification, wants a Discover Scuba.\n- Hotel for pickup: Sample Hotel Naha"
 },
 "e3": {
  "note": "お店のサイトの問い合わせフォーム (1 人、文が混ざる)",
  "text": "件名: [お問い合わせ] ファンダイビングの予約希望\n送信者: B マリン（見本） お問い合わせフォーム\n\nお名前: 見本 健太\n生年月日: 1995/12/24\nご住所: 北海道札幌市見本区3-3-3\nお電話: 090-4545-6767\nご希望日: 10月24日\nメッセージ:\nアドバンスを2019年に取りました。本数は40本くらいです。最後に潜ったのは今年の6月です。\n緊急連絡先は母の 見本 洋子（090-8989-0101）でお願いします。"
 },
 "e4": {
  "note": "転送されたメール (3 人、引っかけあり)",
  "text": "件名: Fwd: Re: 24日の体験ダイビング\n送信者: 見本 大輔 <daisuke@mail.example>\n\n来週24日に3人でお願いします。メンバーは 見本 大輔、見本 さやか、見本 蓮（息子、12歳）です。\n私（大輔）はCカード持ってます（オープンウォーター）。さやかと蓮は初めてです。\n連絡は 090-0101-2323 までお願いします。\nPS 蓮は24日が誕生日なんです！\n\n> 2026/10/18 B マリン（見本） 山田 <info@bmarine.example> のメッセージ:\n> お問い合わせありがとうございます。担当の山田です。\n> 24日は空きがございます。参加される方のお名前をお知らせください。"
 }
};
})();
