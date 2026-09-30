// 데이터 모델 — 작품(work)과 날짜별 플레이 기록(play)을 나눠 관리한다.
//   work: 장르·제목(방탈출은 매장·지점까지)·표지. 이름이 같아도 id 가 다르면 다른 작품 (자동으로 합치지 않음)
//   play: 날짜·평점·한 줄 감상·후기·사진·함께한 사람 + 장르별 항목(details) + 스포일러(spoiler)
// 검증은 화이트리스트 방식: 모르는 필드는 버리고, 형식이 틀리면 필드별 오류 메시지를 돌려준다.
// DOM 에 의존하지 않으므로 브라우저·node 어디서든 import 가능.
import { GENRE_KEYS, LIMITS, MM_FORMATS } from './constants.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NUM_RE = /^-?\d+(\.\d+)?$/;
// 제어문자 + 방향 조작 문자(Trojan Source류) 제거
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const SINGLE_LINE_CTRL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/g;
const MULTI_LINE_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

// ── 장르별 항목 정의 ──────────────────────────────────────────
// details: 일반 기록(목록·검색 미리보기에 나와도 되는 것), spoiler: 기본으로 접어 두는 것
export const DETAIL_KEYS = {
  boardgame: ['players', 'expansions', 'myScore', 'myRank', 'durationMin'],
  murdermystery: ['format', 'durationMin', 'story', 'immersion', 'impression'],
  escaperoom: ['result', 'remainingSec', 'hints', 'difficulty', 'fear'],
};

export const SPOILER_KEYS = {
  boardgame: ['memo'],
  murdermystery: ['role', 'culprit', 'ending', 'memo'],
  escaperoom: ['puzzles', 'memo'],
};

export const SPOILER_LABELS = {
  role: '맡은 역할', culprit: '범인', ending: '결말', puzzles: '문제·풀이 메모', memo: '스포일러 메모',
};

export const isGenre = (g) => GENRE_KEYS.includes(g);
export const isId = (v) => typeof v === 'string' && ID_RE.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v);
export const isIso = (v) => typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));

export function isValidDate(v) {
  const m = DATE_RE.exec(String(v || ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function newId(prefix) {
  const c = globalThis.crypto;
  let raw;
  if (c && typeof c.randomUUID === 'function') raw = c.randomUUID().replace(/-/g, '');
  else if (c && typeof c.getRandomValues === 'function') raw = [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  else raw = `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${raw.slice(0, 24)}`;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
export const charLength = (s) => [...String(s)].length;

/** 한 줄 글자: 제어문자 → 공백, 앞뒤 공백 제거 */
export function cleanLine(v) {
  if (v === undefined || v === null) return '';
  return String(v).normalize('NFC').replace(BIDI_RE, '').replace(SINGLE_LINE_CTRL_RE, ' ').replace(/\s+/g, ' ').trim();
}

/** 여러 줄 글자: 줄바꿈은 살림 */
export function cleanText(v) {
  if (v === undefined || v === null) return '';
  return String(v).normalize('NFC').replace(BIDI_RE, '').replace(/\r\n?/g, '\n').replace(MULTI_LINE_CTRL_RE, '').trim();
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUM_RE.test(v.trim())) return Number(v.trim());
  return NaN;
}

// 필드 검사기: 오류는 errors[path] = 메시지 로 모음
function makeChecker() {
  const errors = {};
  const err = (path, msg) => { if (!errors[path]) errors[path] = msg; };
  return {
    errors,
    line(v, path, max, label) {
      const s = cleanLine(v);
      if (charLength(s) > max) err(path, `${label}은(는) ${max}자까지 쓸 수 있어요`);
      return s;
    },
    text(v, path, max, label) {
      const s = cleanText(v);
      if (charLength(s) > max) err(path, `${label}은(는) ${max}자까지 쓸 수 있어요`);
      return s;
    },
    int(v, path, min, max, label) {
      if (isBlank(v)) return null;
      const n = toNumber(v);
      if (!Number.isInteger(n) || n < min || n > max) { err(path, `${label}은(는) ${min}~${max} 사이 정수로 적어 주세요`); return null; }
      return n;
    },
    num(v, path, min, max, label) {
      if (isBlank(v)) return null;
      const n = toNumber(v);
      if (!Number.isFinite(n) || n < min || n > max) { err(path, `${label}은(는) 숫자로 적어 주세요`); return null; }
      return Math.round(n * 100) / 100;
    },
    /** 0.5 단위 별점. 비었거나 0 이면 null(미평가) */
    half(v, path, label) {
      if (isBlank(v)) return null;
      const n = toNumber(v);
      if (!Number.isFinite(n) || n < 0 || n > 5 || !Number.isInteger(n * 2)) { err(path, `${label}은(는) 0.5점 단위로 5점까지예요`); return null; }
      return n === 0 ? null : n;
    },
    oneOf(v, path, list, label) {
      if (isBlank(v)) return null;
      if (!list.includes(v)) { err(path, `${label} 값이 올바르지 않아요`); return null; }
      return v;
    },
  };
}

// ── 작품 ─────────────────────────────────────────────────────

/**
 * 작품 검증·정리.
 * @returns {{ok:true, value:object} | {ok:false, errors:Object<string,string>}}
 */
export function normalizeWork(input, { now = new Date().toISOString() } = {}) {
  const c = makeChecker();
  const src = isPlainObject(input) ? input : {};
  const genre = src.genre;
  if (!isGenre(genre)) c.errors.genre = '장르를 골라 주세요';
  const title = c.line(src.title, 'title', LIMITS.title, '제목');
  if (!title) c.errors.title = '제목을 적어 주세요';
  const out = {
    id: isId(src.id) ? src.id : newId('w'),
    genre: isGenre(genre) ? genre : null,
    title,
    // 매장·지점은 방탈출 작품을 구분하는 정보 (같은 테마명이라도 매장이 다르면 다른 작품)
    store: genre === 'escaperoom' ? c.line(src.store, 'store', LIMITS.store, '매장') : '',
    branch: genre === 'escaperoom' ? c.line(src.branch, 'branch', LIMITS.branch, '지점') : '',
    cover: isId(src.cover) ? src.cover : null,
    createdAt: isIso(src.createdAt) ? src.createdAt : now,
    updatedAt: isIso(src.updatedAt) ? src.updatedAt : now,
  };
  if (src.sample === true) out.sample = true;
  if (Object.keys(c.errors).length) return { ok: false, errors: c.errors };
  return { ok: true, value: out };
}

// ── 플레이 기록 ──────────────────────────────────────────────

function companionsOf(v, c) {
  const list = Array.isArray(v) ? v : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const name = cleanLine(raw);
    if (!name) continue;
    if (charLength(name) > LIMITS.companion) { c.errors.companions = `이름은 ${LIMITS.companion}자까지 쓸 수 있어요`; continue; }
    const k = name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(name);
  }
  if (out.length > LIMITS.companions) c.errors.companions = `함께한 사람은 ${LIMITS.companions}명까지 적을 수 있어요`;
  return out.slice(0, LIMITS.companions);
}

function photosOf(v, c) {
  const list = Array.isArray(v) ? v.filter(isId) : [];
  const out = [...new Set(list)];
  if (out.length > LIMITS.photos) c.errors.photos = `사진은 ${LIMITS.photos}장까지 붙일 수 있어요`;
  return out.slice(0, LIMITS.photos);
}

function detailsFor(genre, v, c) {
  const d = isPlainObject(v) ? v : {};
  const out = {};
  if (genre === 'boardgame') {
    out.players = c.int(d.players, 'details.players', 1, 99, '플레이 인원');
    out.expansions = c.line(d.expansions, 'details.expansions', LIMITS.expansions, '사용한 확장');
    out.myScore = c.num(d.myScore, 'details.myScore', -999999, 9999999, '내 점수');
    out.myRank = c.int(d.myRank, 'details.myRank', 1, 99, '순위');
    if (out.myRank !== null && out.players !== null && out.myRank > out.players) c.errors['details.myRank'] = '순위가 플레이 인원보다 커요';
    out.durationMin = c.int(d.durationMin, 'details.durationMin', 1, 1440, '플레이 시간(분)');
  } else if (genre === 'murdermystery') {
    out.format = c.oneOf(d.format, 'details.format', MM_FORMATS.map((f) => f.key), '플레이 방식');
    out.durationMin = c.int(d.durationMin, 'details.durationMin', 1, 1440, '플레이 시간(분)');
    out.story = c.half(d.story, 'details.story', '스토리');
    out.immersion = c.half(d.immersion, 'details.immersion', '몰입도');
    out.impression = c.text(d.impression, 'details.impression', LIMITS.impression, '스토리·몰입 감상');
  } else if (genre === 'escaperoom') {
    out.result = c.oneOf(d.result, 'details.result', ['success', 'fail'], '탈출 결과');
    // 실패했으면 남은 시간은 의미가 없어서 버림
    out.remainingSec = out.result === 'fail' ? null : c.int(d.remainingSec, 'details.remainingSec', 0, 5 * 3600, '남은 시간');
    out.hints = c.int(d.hints, 'details.hints', 0, 99, '힌트 수');
    out.difficulty = c.int(d.difficulty, 'details.difficulty', 1, 5, '체감 난이도');
    out.fear = c.int(d.fear, 'details.fear', 0, 5, '공포도');
  }
  return out;
}

function spoilerFor(genre, v, c) {
  const s = isPlainObject(v) ? v : {};
  const out = {};
  if (genre === 'murdermystery') {
    out.role = c.line(s.role, 'spoiler.role', LIMITS.role, '맡은 역할');
    out.culprit = c.line(s.culprit, 'spoiler.culprit', LIMITS.culprit, '범인');
    out.ending = c.text(s.ending, 'spoiler.ending', LIMITS.ending, '결말');
  } else if (genre === 'escaperoom') {
    out.puzzles = c.text(s.puzzles, 'spoiler.puzzles', LIMITS.puzzles, '문제·풀이 메모');
  }
  out.memo = c.text(s.memo, 'spoiler.memo', LIMITS.memo, '스포일러 메모');
  return out;
}

/**
 * 플레이 기록 검증·정리. genre 는 연결된 작품의 장르 — 그 장르의 항목만 남긴다.
 * @returns {{ok:true, value:object} | {ok:false, errors:Object<string,string>}}
 */
export function normalizePlay(input, genre, { now = new Date().toISOString() } = {}) {
  const c = makeChecker();
  const src = isPlainObject(input) ? input : {};
  if (!isGenre(genre)) c.errors.genre = '장르를 골라 주세요';
  if (!isId(src.workId)) c.errors.workId = '작품이 연결되지 않았어요';
  if (!isValidDate(src.date)) c.errors.date = isBlank(src.date) ? '플레이 날짜를 골라 주세요' : '날짜 형식이 올바르지 않아요';
  const out = {
    id: isId(src.id) ? src.id : newId('p'),
    workId: isId(src.workId) ? src.workId : null,
    date: isValidDate(src.date) ? src.date : null,
    rating: c.half(src.rating, 'rating', '평점'),
    oneLiner: c.line(src.oneLiner, 'oneLiner', LIMITS.oneLiner, '한 줄 감상'),
    review: c.text(src.review, 'review', LIMITS.review, '상세 후기'),
    companions: companionsOf(src.companions, c),
    photos: photosOf(src.photos, c),
    details: isGenre(genre) ? detailsFor(genre, src.details, c) : {},
    spoiler: isGenre(genre) ? spoilerFor(genre, src.spoiler, c) : {},
    createdAt: isIso(src.createdAt) ? src.createdAt : now,
    updatedAt: isIso(src.updatedAt) ? src.updatedAt : now,
  };
  if (src.sample === true) out.sample = true;
  if (Object.keys(c.errors).length) return { ok: false, errors: c.errors };
  return { ok: true, value: out };
}

// ── 조회 도우미 ──────────────────────────────────────────────

const filled = (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);

/** 이 장르에서 보여 줄 장르별 항목 중 채워진 것이 있는지 */
export function hasDetails(play, genre) {
  const d = (play && play.details) || {};
  return (DETAIL_KEYS[genre] || []).some((k) => filled(d[k]));
}

/** 스포일러 영역에 적힌 것이 있는지 (이 장르에서 쓰는 항목만) */
export function hasSpoiler(play, genre) {
  const s = (play && play.spoiler) || {};
  return (SPOILER_KEYS[genre] || []).some((k) => filled(s[k]));
}

/** '추가 기록'에 들어가는 항목이 하나라도 채워졌는지 (수정할 때 펼쳐 둘지) */
export function hasExtra(play, genre) {
  if (!play) return false;
  return filled(play.review) || filled(play.companions) || hasDetails(play, genre) || hasSpoiler(play, genre);
}

/** 방탈출 매장·지점을 한 줄로 */
export function placeLabel(work) {
  if (!work || work.genre !== 'escaperoom') return '';
  return [work.store, work.branch].filter(Boolean).join(' ');
}

/** 작품 이름 (방탈출은 매장·지점을 덧붙임) — 같은 이름의 작품을 구분해서 보여 줄 때 */
export function workLabel(work) {
  if (!work) return '';
  const place = placeLabel(work);
  return place ? `${work.title} · ${place}` : work.title;
}

/** 같은 이름 비교용 (대소문자·띄어쓰기 무시) */
export function titleKey(s) {
  return cleanLine(s).toLowerCase().replace(/\s+/g, '');
}
