// 입력 검증 — 화이트리스트 방식. 알 수 없는 필드는 버리고, 형식·길이가 틀리면 거부한다.
// DOM/Node 전용 API에 의존하지 않으므로 브라우저·node 어디서든 import 가능.

export const TYPES = ['boardgame', 'murdermystery', 'escaperoom'];
export const BLOCK_KEY = { boardgame: 'bg', murdermystery: 'mm', escaperoom: 'er' };
export const BG_MODES = ['competitive', 'coop', 'team'];
export const MM_FORMATS = ['box', 'store', 'online'];
export const MM_OUTCOMES = ['win', 'lose', 'draw'];
export const MM_CULPRIT_RESULTS = ['caught', 'escaped'];
// 보드게임·머미(보드게임형): 이번 판에 쓴 게임이 내 소장인지, 대여한 것인지 (예전 기록 — 지금은 게임 정보의 owned)
export const OWNERSHIPS = ['mine', 'borrowed'];
// 게임 정보(게임·작품·테마)는 모든 종류를 등록. 소장 여부는 보드게임·머미만 (방탈출 테마는 소장 개념 없음)
export const GAME_TYPES = TYPES;
export const OWNABLE_TYPES = ['boardgame', 'murdermystery'];
export const MM_SCORE_KEYS = ['story', 'deduction', 'roleplay', 'balance', 'production'];
export const ER_SCORE_KEYS = ['story', 'interior', 'puzzle', 'device'];
export const MEMBER_COLORS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10'];

export const LIMITS = Object.freeze({
  title: 80,
  oneLiner: 100,
  review: 5000,
  tag: 15,
  tags: 10,
  recordMembers: 20,
  memberName: 20,
  memberEmoji: 4, // code point 기준
  place: 40,
  expansion: 60,
  bgResults: 20,
  publisher: 40,
  store: 40,
  gm: 20,
  character: 30,
  mmRoles: 20,
  brand: 40,
  branch: 40,
  genre: 20,
  lender: 20,
  photos: 4,
  gameMemo: 100,
  gameGenre: 15,
  gameGenres: 10,
  gamePlayers: 99,
  gameTime: 1440,
});

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;
// 제어문자 + 방향 조작 문자(Trojan Source류) 제거용
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
const SINGLE_LINE_CTRL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/g;
const MULTI_LINE_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

class ValidationError extends Error {
  constructor(field) {
    super(`invalid:${field}`);
    this.field = field;
  }
}

const fail = (field) => {
  throw new ValidationError(field);
};

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// 객체 기본 속성 이름(__proto__, constructor, toString …)은 id로 쓰면 해시→객체 변환에서
// 사라지거나 엉뚱한 값과 부딪히므로 거부한다
const RESERVED_IDS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

export function isValidId(v) {
  return typeof v === 'string' && ID_RE.test(v) && !RESERVED_IDS.has(v);
}

export function isValidDate(v) {
  if (typeof v !== 'string') return false;
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function isIsoTimestamp(v) {
  return typeof v === 'string' && ISO_RE.test(v) && Number.isFinite(Date.parse(v));
}

/** 문자열 길이(code point 기준) */
export function charLength(s) {
  return [...s].length;
}

/** 이름 중복 비교용 정규화 (공백 정리 + 대소문자 무시) */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ── 필드 단위 검사기 ─────────────────────────────────────────

function text(v, field, max, { min = 0, multiline = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(field);
  let s = v.normalize('NFC').replace(BIDI_RE, '');
  s = multiline
    ? s.replace(/\r\n?/g, '\n').replace(MULTI_LINE_CTRL_RE, '')
    : s.replace(SINGLE_LINE_CTRL_RE, ' ');
  s = s.trim();
  const len = charLength(s);
  if (len < min || len > max) fail(field);
  return s;
}

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) return Number(v.trim());
  return NaN;
}

/** 정수 범위. 비어 있으면 def(기본값, null 가능) */
function int(v, field, min, max, def) {
  if (isBlank(v)) return def;
  const n = toNumber(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(field);
  return n;
}

/** 0~5, 0.5 단위 별점/점수. 비어 있으면 0(미평가) */
function half(v, field) {
  if (isBlank(v)) return 0;
  const n = toNumber(v);
  if (!Number.isFinite(n) || n < 0 || n > 5 || !Number.isInteger(n * 2)) fail(field);
  return n;
}

/** 자유 숫자(보드게임 점수). 비어 있으면 null */
function score(v, field) {
  if (isBlank(v)) return null;
  const n = toNumber(v);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) fail(field);
  return n;
}

function bool(v, field, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') fail(field);
  return v;
}

function boolOrNull(v, field) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') fail(field);
  return v;
}

function oneOf(v, field, list, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!list.includes(v)) fail(field);
  return v;
}

function idField(v, field) {
  if (!isValidId(v)) fail(field);
  return v;
}

function list(v, field, max) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) fail(field);
  return v;
}

function obj(v, field) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) fail(field);
  return v;
}

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((it) => (seen.has(it[key]) ? false : seen.add(it[key])));
}

function scores(v, field, keys) {
  const src = obj(v, field);
  const out = {};
  for (const k of keys) out[k] = half(src[k], `${field}.${k}`);
  return out;
}

// ── 종류별 상세 블록 ─────────────────────────────────────────

function bgBlock(v) {
  const b = obj(v, 'bg');
  const mode = oneOf(b.mode, 'bg.mode', BG_MODES, 'competitive');
  const ownership = oneOf(b.ownership, 'bg.ownership', OWNERSHIPS, null);
  const results = uniqueBy(
    list(b.results, 'bg.results', LIMITS.bgResults).map((r) => {
      if (!isPlainObject(r)) fail('bg.results');
      return {
        memberId: idField(r.memberId, 'bg.results.memberId'),
        score: score(r.score, 'bg.results.score'),
        rank: int(r.rank, 'bg.results.rank', 1, 20, null),
        winner: bool(r.winner, 'bg.results.winner'),
      };
    }),
    'memberId',
  );
  return {
    place: text(b.place, 'bg.place', LIMITS.place),
    // 실제로 한 시간 (게임 정보의 예상 시간과 별개). 적지 않았으면 null — 0분으로 저장하지 않음
    playTimeMin: int(b.playTimeMin, 'bg.playTimeMin', 0, 1440, null),
    mode,
    results,
    // 협력 모드일 때만 의미 있음
    coopWin: mode === 'coop' ? boolOrNull(b.coopWin, 'bg.coopWin') : null,
    expansion: text(b.expansion, 'bg.expansion', LIMITS.expansion),
    ownership,
    // 빌려준 사람은 빌렸을 때만 의미 있음
    lender: ownership === 'borrowed' ? text(b.lender, 'bg.lender', LIMITS.lender) : '',
  };
}

function mmBlock(v) {
  const b = obj(v, 'mm');
  const roles = uniqueBy(
    list(b.roles, 'mm.roles', LIMITS.mmRoles).map((r) => {
      if (!isPlainObject(r)) fail('mm.roles');
      return {
        memberId: idField(r.memberId, 'mm.roles.memberId'),
        character: text(r.character, 'mm.roles.character', LIMITS.character),
        culprit: bool(r.culprit, 'mm.roles.culprit'),
        outcome: oneOf(r.outcome, 'mm.roles.outcome', MM_OUTCOMES, null),
        mvp: bool(r.mvp, 'mm.roles.mvp'),
      };
    }),
    'memberId',
  );
  const format = oneOf(b.format, 'mm.format', MM_FORMATS, 'store');
  // 소장 여부는 집에서 하는 보드게임형일 때만 의미 있음 (매장형·온라인은 매장·제작사 것)
  const ownership = format === 'box' ? oneOf(b.ownership, 'mm.ownership', OWNERSHIPS, null) : null;
  return {
    publisher: text(b.publisher, 'mm.publisher', LIMITS.publisher),
    format,
    store: text(b.store, 'mm.store', LIMITS.store),
    gm: text(b.gm, 'mm.gm', LIMITS.gm),
    playerCount: int(b.playerCount, 'mm.playerCount', 1, 20, null),
    playTimeMin: int(b.playTimeMin, 'mm.playTimeMin', 0, 1440, null),
    roles,
    // 배역·범인을 스포일러로 가림 (기록 전체의 스포일러와 별개로)
    roleSpoiler: bool(b.roleSpoiler, 'mm.roleSpoiler'),
    culpritResult: oneOf(b.culpritResult, 'mm.culpritResult', MM_CULPRIT_RESULTS, null),
    scores: scores(b.scores, 'mm.scores', MM_SCORE_KEYS),
    difficulty: half(b.difficulty, 'mm.difficulty'),
    replay: bool(b.replay, 'mm.replay'),
    ownership,
    lender: ownership === 'borrowed' ? text(b.lender, 'mm.lender', LIMITS.lender) : '',
  };
}

function erBlock(v) {
  const b = obj(v, 'er');
  // 성공 true · 실패 false · 고르지 않음 null (안 고른 결과를 실패로 저장하지 않음)
  const cleared = boolOrNull(b.cleared, 'er.cleared');
  const remainingSec = int(b.remainingSec, 'er.remainingSec', 0, 18000, null);
  return {
    brand: text(b.brand, 'er.brand', LIMITS.brand),
    branch: text(b.branch, 'er.branch', LIMITS.branch),
    genre: text(b.genre, 'er.genre', LIMITS.genre),
    playerCount: int(b.playerCount, 'er.playerCount', 1, 10, null),
    timeLimitMin: int(b.timeLimitMin, 'er.timeLimitMin', 1, 300, null),
    cleared,
    // 남은 시간은 성공했을 때만 의미 있음
    remainingSec: cleared === true ? remainingSec : null,
    // 적지 않은 힌트 수는 null (0개로 저장하지 않음)
    hints: int(b.hints, 'er.hints', 0, 99, null),
    scores: scores(b.scores, 'er.scores', ER_SCORE_KEYS),
    difficulty: half(b.difficulty, 'er.difficulty'),
    fear: half(b.fear, 'er.fear'),
    activity: half(b.activity, 'er.activity'),
    replay: bool(b.replay, 'er.replay'),
  };
}

const BLOCK_BUILDERS = { bg: bgBlock, mm: mmBlock, er: erBlock };

// ── 공개 API ────────────────────────────────────────────────

/**
 * 기록 검증.
 * @returns {{ok:true, value:object} | {ok:false, field:string}}
 *   value에는 id(있을 때만)와 createdAt(유효한 ISO일 때만 — 가져오기용), 공통 필드(사진 id 목록 photos 는
 *   보냈을 때만), 해당 종류 블록만 담긴다.
 *   updatedAt은 서버가 정하므로 담지 않는다.
 */
export function validateRecord(input) {
  try {
    if (!isPlainObject(input)) fail('record');
    const out = {};
    if (!isBlank(input.id)) out.id = idField(input.id, 'id');
    const type = input.type;
    if (!TYPES.includes(type)) fail('type');
    out.type = type;
    if (!isValidDate(input.date)) fail('date');
    out.date = input.date;
    out.title = text(input.title, 'title', LIMITS.title, { min: 1 });
    out.members = [
      ...new Set(list(input.members, 'members', LIMITS.recordMembers).map((m) => idField(m, 'members'))),
    ];
    out.rating = half(input.rating, 'rating');
    out.oneLiner = text(input.oneLiner, 'oneLiner', LIMITS.oneLiner);
    out.review = text(input.review, 'review', LIMITS.review, { multiline: true });
    out.spoiler = bool(input.spoiler, 'spoiler');
    out.tags = [
      ...new Set(
        list(input.tags, 'tags', LIMITS.tags)
          .map((t) => text(t, 'tags', LIMITS.tag))
          .filter(Boolean),
      ),
    ];
    // 사진 id (순서 유지, 첫 장 = 대표). 실제로 있는 사진인지는 저장할 때 handler 가 확인.
    // 아예 없으면(사진을 모르는 예전 앱·예전 백업) 담지 않음 → handler 가 저장된 사진을 그대로 둠
    if (input.photos !== undefined) {
      out.photos = [...new Set(list(input.photos, 'photos', LIMITS.photos).map((p) => idField(p, 'photos')))];
    }
    // 연결한 게임 정보 id. 아예 없으면(게임 정보를 모르는 예전 앱) 담지 않음 → handler 가 저장된 연결을 그대로 둠.
    // null·'' 은 연결을 끊음
    if (input.gameId !== undefined) out.gameId = isBlank(input.gameId) ? null : idField(input.gameId, 'gameId');
    if (isIsoTimestamp(input.createdAt)) out.createdAt = input.createdAt;
    const key = BLOCK_KEY[type];
    out[key] = BLOCK_BUILDERS[key](input[key]);
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, field: err.field };
    throw err;
  }
}

/**
 * 멤버 검증. (이름 중복 검사는 저장소 조회가 필요하므로 handler에서)
 * @returns {{ok:true, value:object} | {ok:false, field:string}}
 */
export function validateMember(input) {
  try {
    if (!isPlainObject(input)) fail('member');
    const out = {};
    if (!isBlank(input.id)) out.id = idField(input.id, 'id');
    out.name = text(input.name, 'name', LIMITS.memberName, { min: 1 }).replace(/\s+/g, ' ');
    out.emoji = text(input.emoji, 'emoji', LIMITS.memberEmoji);
    out.color = oneOf(input.color, 'color', MEMBER_COLORS, 'c1');
    if (isIsoTimestamp(input.createdAt)) out.createdAt = input.createdAt;
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, field: err.field };
    throw err;
  }
}

/** 최소~최대 범위 (한쪽만 적으면 고정값: 2 → 2~2). 둘 다 비면 null, 최소 > 최대면 거부 */
function range(minV, maxV, field, lo, hi) {
  let a = int(minV, `${field}Min`, lo, hi, null);
  let b = int(maxV, `${field}Max`, lo, hi, null);
  if (a === null) a = b;
  if (b === null) b = a;
  if (a !== null && a > b) fail(`${field}Max`);
  return [a, b];
}

/**
 * 게임 정보(게임·작품·테마) 검증. 같은 종류·같은 이름 확인은 handler 에서.
 * 이름·종류·메모 말고는 보낸 항목만 담는다 (안 보낸 항목은 handler 가 저장된 값을 그대로 둠 —
 * 이름·메모만 아는 예전 앱이 고쳐도 대표 이미지·인원·장르가 지워지지 않게). 종류에 맞는 정리는 finalizeGame.
 * @returns {{ok:true, value:object} | {ok:false, field:string}}
 */
export function validateGame(input) {
  try {
    if (!isPlainObject(input)) fail('game');
    const out = {};
    if (!isBlank(input.id)) out.id = idField(input.id, 'id');
    if (!GAME_TYPES.includes(input.type)) fail('type');
    out.type = input.type;
    out.title = text(input.title, 'title', LIMITS.title, { min: 1 }).replace(/\s+/g, ' ');
    out.memo = text(input.memo, 'memo', LIMITS.gameMemo);
    if (input.owned !== undefined) out.owned = bool(input.owned, 'owned');
    if (input.cover !== undefined) out.cover = isBlank(input.cover) ? null : idField(input.cover, 'cover');
    if (input.playersMin !== undefined || input.playersMax !== undefined) {
      [out.playersMin, out.playersMax] = range(input.playersMin, input.playersMax, 'players', 1, LIMITS.gamePlayers);
    }
    if (input.timeMin !== undefined || input.timeMax !== undefined) {
      [out.timeMin, out.timeMax] = range(input.timeMin, input.timeMax, 'time', 1, LIMITS.gameTime);
    }
    if (input.genres !== undefined) {
      out.genres = [
        ...new Set(
          list(input.genres, 'genres', LIMITS.gameGenres)
            .map((g) => text(g, 'genres', LIMITS.gameGenre).replace(/\s+/g, ' '))
            .filter(Boolean),
        ),
      ];
    }
    if (input.brand !== undefined) out.brand = text(input.brand, 'brand', LIMITS.brand);
    if (input.branch !== undefined) out.branch = text(input.branch, 'branch', LIMITS.branch);
    if (isIsoTimestamp(input.createdAt)) out.createdAt = input.createdAt;
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, field: err.field };
    throw err;
  }
}

/**
 * 저장할 게임 정보 모양 (validateGame 결과를 저장된 값 위에 덮은 것 → 종류에 맞는 항목만).
 *   owned: 보드게임·머미만. 정한 적이 없으면 true (예전 '소장 게임 등록'으로 올린 게임은 모두 내 소장)
 *   cover: 대표 이미지 사진 id (없으면 빠짐)
 *   보드게임: playersMin·playersMax(명)·timeMin·timeMax(분, 예상 시간)·genres — 그날 실제 인원·시간과 별개
 *   방탈출: brand·branch (매장·지점)
 */
export function finalizeGame(g) {
  const out = { type: g.type, title: g.title, memo: typeof g.memo === 'string' ? g.memo : '' };
  out.owned = OWNABLE_TYPES.includes(g.type) ? (typeof g.owned === 'boolean' ? g.owned : true) : false;
  if (typeof g.cover === 'string' && isValidId(g.cover)) out.cover = g.cover;
  const n = (v) => (Number.isInteger(v) ? v : null);
  if (g.type === 'boardgame') {
    out.playersMin = n(g.playersMin);
    out.playersMax = n(g.playersMax);
    out.timeMin = n(g.timeMin);
    out.timeMax = n(g.timeMax);
    out.genres = Array.isArray(g.genres) ? g.genres.filter((x) => typeof x === 'string' && x) : [];
  } else if (g.type === 'escaperoom') {
    out.brand = typeof g.brand === 'string' ? g.brand : '';
    out.branch = typeof g.branch === 'string' ? g.branch : '';
  }
  return out;
}
