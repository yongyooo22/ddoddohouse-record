// 날짜·숫자 표시 헬퍼 (순수 함수 — node 테스트 가능)
import { WEEKDAYS } from './constants.js';

const pad = (n) => String(n).padStart(2, '0');

/** 로컬 날짜 'YYYY-MM-DD' */
export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function yesterdayStr(d = new Date()) {
  return todayStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

export function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

/** '2026.09.28 (일)' — 카드·목록의 티켓 날짜 */
export function fmtDate(str, { weekday = true } = {}) {
  const d = parseDate(str);
  if (!d) return '날짜 없음';
  const base = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
  return weekday ? `${base} (${WEEKDAYS[d.getDay()]})` : base;
}

/** '2026년 9월 28일 일요일' — 상세 화면 */
export function fmtDateLong(str) {
  const d = parseDate(str);
  if (!d) return '날짜 없음';
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

/** 목록형의 날짜 칸: { md: '09.28', wd: '일' } */
export function dateParts(str) {
  const d = parseDate(str);
  if (!d) return { md: '--.--', wd: '', year: '' };
  return { md: `${pad(d.getMonth() + 1)}.${pad(d.getDate())}`, wd: WEEKDAYS[d.getDay()], year: String(d.getFullYear()) };
}

export const monthKey = (str) => String(str || '').slice(0, 7);
export const yearOf = (str) => String(str || '').slice(0, 4);

export function fmtMonth(ym) {
  const [y, m] = String(ym).split('-');
  if (!y || !m) return '날짜 없음';
  return `${y}년 ${Number(m)}월`;
}

/** 남은 시간(초) → '12:30' 또는 '1:02:03' */
export function fmtRemaining(sec) {
  if (sec === null || sec === undefined || sec === '' || !Number.isFinite(Number(sec))) return '';
  const n = Math.max(0, Math.round(Number(sec)));
  const hh = Math.floor(n / 3600);
  const mm = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

/** 분 → '1시간 30분' */
export function fmtMinutes(min) {
  const n = Math.round(Number(min) || 0);
  if (n <= 0) return '';
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  if (hh && mm) return `${hh}시간 ${mm}분`;
  if (hh) return `${hh}시간`;
  return `${mm}분`;
}

/** 평점 숫자 '4.5' / '4.0' */
export function fmtRating(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n.toFixed(1) : '';
}

export function dateStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 바이트 → 'KB'·'MB'·'GB' */
export function fmtBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024 * 1024) {
    const kb = b / 1024;
    return `${kb < 10 && kb > 0 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  if (b < 1024 * 1024 * 1024) {
    const mb = b / (1024 * 1024);
    return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)}MB`;
  }
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
