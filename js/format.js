// 날짜·숫자 표시 헬퍼 (순수 함수)
import { WEEKDAYS } from './constants.js';

const pad = (n) => String(n).padStart(2, '0');

export function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 어제 날짜 문자열 */
export function yesterdayStr(d = new Date()) {
  return todayStr(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

/** 새 기록의 기본 날짜: 새벽(0~5시)에 쓰면 보통 전날 밤 모임이므로 어제 */
export const LATE_NIGHT_UNTIL = 5;
export function defaultRecordDate(d = new Date()) {
  return d.getHours() < LATE_NIGHT_UNTIL ? yesterdayStr(d) : todayStr(d);
}

export function parseDate(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function monthKey(str) {
  return String(str || '').slice(0, 7);
}

export function fmtMonth(ym) {
  const [y, m] = String(ym).split('-');
  if (!y || !m) return '날짜 없음';
  return `${y}년 ${Number(m)}월`;
}

export function fmtDate(str, { weekday = true, year = true } = {}) {
  const d = parseDate(str);
  if (!d) return '날짜 없음';
  const base = year
    ? `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
    : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return weekday ? `${base} (${WEEKDAYS[d.getDay()]})` : base;
}

/** 카드용 짧은 날짜 '2026.09.28' (잘못된 값이면 '') */
export function fmtDateDot(str) {
  const d = parseDate(str);
  return d ? `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}` : '';
}

export function fmtRemaining(sec) {
  if (sec === null || sec === undefined || sec === '' || !Number.isFinite(Number(sec))) return '';
  const n = Math.max(0, Math.round(Number(sec)));
  const hh = Math.floor(n / 3600);
  const mm = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}

export function fmtMinutes(min) {
  const n = Math.round(Number(min) || 0);
  if (n <= 0) return '';
  const hh = Math.floor(n / 60);
  const mm = n % 60;
  if (hh && mm) return `${hh}시간 ${mm}분`;
  if (hh) return `${hh}시간`;
  return `${mm}분`;
}

export function fmtScore(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? `${v}.0` : v.toFixed(1);
}

export function fmtAvg(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '–';
  return Number(n).toFixed(digits);
}

export function fmtPct(r) {
  if (r === null || r === undefined || !Number.isFinite(Number(r))) return '–';
  return `${Math.round(Number(r) * 100)}%`;
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relTime(iso, now = Date.now()) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, now - t) / 1000;
  if (diff < 45) return '방금';
  if (diff < 3600) return `${Math.round(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.round(diff / 3600)}시간 전`;
  if (diff < 86400 * 2) return '어제';
  return fmtDateTime(iso);
}

export function norm(str) {
  return String(str || '').trim().toLowerCase().normalize('NFC');
}

/** 멤버 이름 비교용 (서버 lib/validate.js normalizeName 과 같은 규칙: 공백 정리 + 대소문자 무시) */
export function nameKey(str) {
  return String(str ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function codePoints(str) {
  return Array.from(String(str || ''));
}

export function clampInt(v, min, max) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
}

export function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function dateStamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

/** 바이트 → 'KB'·'MB' */
export function fmtBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024 * 1024) {
    const kb = b / 1024;
    return `${kb < 10 && kb > 0 ? kb.toFixed(1) : Math.round(kb)}KB`;
  }
  const mb = b / (1024 * 1024);
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)}MB`;
}
