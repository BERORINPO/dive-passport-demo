/* 見られ方の計測を、どの国からの読み込みで入れるか（core。時計・通信・env を知らない）。決定ログ 2026-10-29 analytics-country。
   EU・EEA・英国・スイスからの読み込みには計測のスクリプトを入れない（cookie を使わない計測でも、同意が要るという見方があるため、最初から外す）。
   国が分からない読み込み（cf.country が無い・XX・T1（Tor））も入れない（計測しない側に倒す） */
import { BEACON, ANALYTICS_SEND_PATH } from './page-headers.mjs';

/* EU 27 か国・EEA の 3 か国（アイスランド・リヒテンシュタイン・ノルウェー）・英国・スイス。ISO 3166-1 alpha-2 */
export const NO_ANALYTICS_COUNTRIES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
  'GB', 'CH'
]);
const NO = new Set(NO_ANALYTICS_COUNTRIES);
const UNKNOWN = new Set(['XX', 'T1']);

export function analyticsOn(country) {
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) return false;
  return !NO.has(country) && !UNKNOWN.has(country);
}

/* 計測のスクリプトのタグ。版を決めた URL と integrity。送る先は同じホストの /cdn-cgi/rum。spa は使わない（ページの中の切り替えを数えない） */
export const BEACON_TAG = `<script defer src="${BEACON.src}" integrity="${BEACON.integrity}" crossorigin="anonymous" `
  + `data-cf-beacon='{"token": "${BEACON.token}", "spa": false, "send": {"to": "${ANALYTICS_SEND_PATH}"}}'></script>`;

/* HTML の最後の </body> の前に 1 つだけ入れる。もう入っていれば何もしない。</body> が無ければ入れない */
export function withBeacon(html) {
  const text = String(html);
  if (text.includes(BEACON.src)) return text;
  const at = text.lastIndexOf('</body>');
  return at < 0 ? text : `${text.slice(0, at)}${BEACON_TAG}\n${text.slice(at)}`;
}
