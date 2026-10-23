/* 11/9 の見せ場の見本: 1 隻に 4 店・お客さん 30 人（この店 9 人 + 他のお店 3 店 × 7 人）。名前・住所・電話はすべて架空
   （電話は使われていない 090-0000 の帯、豪州は架空用の 0491 570 156）。冒険島の答え（乗り合い便は 4〜5 店・30 名以下）に合わせた大きさ。
   健康の答えは入れない（他のお店の分は持たない。この店の分はお客さんのページで答える）。便を作る決まりは roster-share.js の addBigSample */
(() => {
  'use strict';

  const R = (globalThis.REDUX = globalThis.REDUX || {});

  const BIG_OWN_GUIDE = '見本 一郎';
  const person = (name, birthDate, address, emergency, course, dives, lastDive) => ({ name, birthDate, address,
    emergency: { name: emergency[0], relation: emergency[1], phone: emergency[2] }, cert: { course, date: course === 'NONE' ? '' : '2020-04' },
    dives, lastDive });
  const BIG_OWN = [
    person('見本 健', '1990-04-01', '沖縄県那覇市見本町 1-1', ['見本 母', '母', '090-0000-0001'], 'AOW', 85, '2026-08'),
    person('見本 美咲', '1994-07-12', '東京都見本区 2-3', ['見本 健', '夫', '090-0000-0002'], 'OW', 14, '2026-06'),
    person('見本 翔太', '2003-02-20', '福岡県見本市 3-4', ['見本 父', '父', '090-0000-0003'], 'NONE', 0, ''),
    person('見本 由美', '1988-11-05', '', ['見本 弟', '弟', '090-0000-0004'], 'OW', 30, '2025-12'),
    person('Sample Noah', '1979-09-30', '12 Sample St, Sydney', ['Sample Ava', 'wife', '+61-491-570-156'], 'RESCUE', 240, '2026-09'),
    person('見本 和夫', '1962-03-15', '大阪府見本市 5-6', ['見本 和子', '妻', '090-0000-0006'], 'AOW', 410, '2026-09'),
    person('見本 恵', '1999-01-08', '沖縄県浦添市見本 7-8', ['見本 姉', '姉', '090-0000-0007'], 'OW', 9, '2026-03'),
    person('見本 拓也', '1985-06-18', '愛知県見本市 9-1', ['見本 妻', '妻', '090-0000-0008'], 'NONE', 0, ''),
    person('Kim Jiwoo', '1996-12-24', 'Sample-ro 10, Seoul', ['Kim Minho', 'brother', '+82-10-0000-0000'], 'OW', 18, '2026-07')
  ];
  const BIG_PARTNERS = [
    { shop: 'C ダイブ（見本）', guide: '見本 三郎', names: ['見本 一真', '見本 明美', '見本 大地', 'Lena Fischer', '見本 千尋', '見本 悠', '見本 早苗'] },
    { shop: 'D マリン（見本）', guide: '見本 四郎', names: ['見本 春香', '見本 誠', 'Sample Liam', '見本 七海', '見本 浩二', '見本 葵', '見本 修'] },
    { shop: 'E アクア（見本）', guide: '見本 五郎', names: ['見本 結衣', '見本 剛', '見本 瑠美', 'Chen Wei', '見本 陽太', '見本 綾', '見本 茂'] }
  ];
  const partnerPerson = (name, i) => person(name, `${1970 + (i * 7) % 33}-0${1 + (i % 9)}-1${i % 9}`, `見本県見本市 ${i + 1}-1`,
    ['見本 家族', '家族', `090-0000-${String(2000 + i).slice(-4)}`], i % 3 === 0 ? 'NONE' : 'OW', i % 3 === 0 ? 0 : 10 + i, i % 3 === 0 ? '' : '2026-05');


  R.BIG_SAMPLE = Object.freeze({
    trip: { start: '13:00', kind: 'dive', tour: 'ファンダイビング（ボート 2 本）', boat: '見本丸', site: '砂辺' },
    guide: BIG_OWN_GUIDE, leadPhone: '090-0000-0001', own: BIG_OWN,
    partners: (() => { let k = 0; return BIG_PARTNERS.map(p => ({ shop: p.shop, guide: p.guide, people: p.names.map(n => partnerPerson(n, k++)) })); })()
  });
})();
