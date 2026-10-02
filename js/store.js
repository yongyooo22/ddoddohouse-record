// 앱 상태 · 기기 로컬 캐시 · 파생 계산
import { STORAGE } from './constants.js';
import { escapeRoomOrdinals, participants, resolveGameIds, gameEntries, isOwnedGame } from './stats.js';

// ── localStorage 안전 래퍼 (사생활 보호 모드 등에서 throw 가능) ──
export function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}
export function lsRemove(k) {
  try { localStorage.removeItem(k); } catch { /* 무시 */ }
}
function lsGetJSON(k) {
  const raw = lsGet(k);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ── 키 ──
export const getKey = () => lsGet(STORAGE.key) || '';
export const setKey = (k) => lsSet(STORAGE.key, k);
export const clearKey = () => lsRemove(STORAGE.key);

// ── 테마 ──
export const getTheme = () => {
  const t = lsGet(STORAGE.theme);
  return t === 'light' || t === 'dark' ? t : 'system';
};
export const setTheme = (t) => {
  if (t === 'light' || t === 'dark') lsSet(STORAGE.theme, t);
  else lsRemove(STORAGE.theme);
};

// ── 마지막으로 기록한 종류 (새 기록 폼의 기본 종류) ──
export const getLastType = () => {
  const t = lsGet(STORAGE.lastType);
  return t === 'boardgame' || t === 'murdermystery' || t === 'escaperoom' ? t : null;
};
export const setLastType = (t) => lsSet(STORAGE.lastType, t);

// ── 초안 ──
export const getDraft = () => {
  const d = lsGetJSON(STORAGE.draft);
  return d && typeof d === 'object' && d.model && typeof d.model === 'object' ? d : null;
};
/** 초안 저장. 저장 공간이 모자라면 (다시 받을 수 있는) 기기 캐시를 비우고 한 번 더 시도. 성공 여부 반환 */
export function setDraft(d) {
  let raw;
  try { raw = JSON.stringify(d); } catch { return false; }
  if (lsSet(STORAGE.draft, raw)) return true;
  lsRemove(STORAGE.cache);
  return lsSet(STORAGE.draft, raw);
}
export const clearDraft = () => lsRemove(STORAGE.draft);
/** 지정한 초안일 때만 지움 (다른 기록의 초안을 실수로 날리지 않도록) */
export function clearDraftIf(match) {
  const d = getDraft();
  if (d && match(d)) clearDraft();
}

// ── 상태 ──
export const state = {
  records: [],
  members: [],
  games: [],           // 게임 정보 (게임·작품·테마). 기록은 gameId 로 연결
  serverTime: null,
  lastSync: null,      // 마지막으로 서버에서 받아온 시각(ISO)
  fromCache: false,    // 지금 보이는 데이터가 기기 캐시인지
  status: 'idle',      // idle | loading | ok | offline | error
  errorCode: null,
  version: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(kind = 'data') {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error(e); }
  }
}

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && typeof x.id === 'string') : []);

function bump() {
  state.version += 1;
  memo = {};
}

let memo = {};

export function loadCache() {
  const c = lsGetJSON(STORAGE.cache);
  if (!c) return false;
  state.records = asArray(c.records);
  state.members = asArray(c.members);
  state.games = asArray(c.games);
  state.lastSync = typeof c.savedAt === 'string' ? c.savedAt : null;
  state.fromCache = true;
  bump();
  return true;
}

/** 기기 캐시 저장. 용량 초과 등으로 실패하면 예전 사본이 계속 보이지 않도록 아예 지운다 */
function saveCache() {
  let raw;
  try {
    raw = JSON.stringify({
      records: state.records,
      members: state.members,
      games: state.games,
      savedAt: state.lastSync || new Date().toISOString(),
    });
  } catch { raw = null; }
  if (raw !== null && lsSet(STORAGE.cache, raw)) return true;
  lsRemove(STORAGE.cache);
  return false;
}

// ── 로컬 변경 기록 (새로고침 응답이 방금 저장/삭제한 내용을 되돌리지 않도록) ──
let mutationSeq = 0;
let localOps = []; // { seq, kind: 'record'|'member'|'game', id, value(null = 삭제) }

function noteOp(kind, id, value) {
  mutationSeq += 1;
  localOps.push({ seq: mutationSeq, kind, id, value });
  if (localOps.length > 300) localOps = localOps.slice(-300);
}

/** 서버 요청을 보내기 직전에 찍어 두는 표시 — setData(data, { since }) 에 넘김 */
export const mutationMark = () => mutationSeq;

/** 요청을 보낸 뒤에 이 기기에서 바꾼 항목은 (서버 사본이 더 새롭지 않으면) 로컬 것을 유지 */
function mergeLocal(list, kind, since) {
  let out = list;
  for (const op of localOps) {
    if (op.seq <= since || op.kind !== kind) continue;
    const i = out.findIndex((x) => x.id === op.id);
    if (op.value === null) {
      if (i >= 0) out = out.filter((x) => x.id !== op.id);
    } else if (i < 0) {
      out = [...out, op.value];
    } else if (String(out[i].updatedAt || '') < String(op.value.updatedAt || '')) {
      out = out.map((x, j) => (j === i ? op.value : x));
    }
  }
  return out;
}

/**
 * 서버에서 받은 전체 데이터 반영.
 * since: 요청을 보내기 직전의 mutationMark(). 주면 그 뒤의 로컬 저장·삭제를 덮어쓰지 않는다.
 */
export function setData({ records, members, games, serverTime }, { since } = {}) {
  let recs = asArray(records);
  let mems = asArray(members);
  let gams = asArray(games);
  if (typeof since === 'number') {
    recs = mergeLocal(recs, 'record', since);
    mems = mergeLocal(mems, 'member', since);
    gams = mergeLocal(gams, 'game', since);
    localOps = localOps.filter((op) => op.seq > since);
  }
  state.records = recs;
  state.members = mems;
  state.games = gams;
  state.serverTime = serverTime || null;
  state.lastSync = new Date().toISOString();
  state.fromCache = false;
  bump();
  saveCache();
  emit('data');
}

export function setStatus(status, errorCode = null) {
  if (state.status === status && state.errorCode === errorCode) return;
  state.status = status;
  state.errorCode = errorCode;
  emit('status');
}

export function upsertRecord(rec) {
  if (!rec || typeof rec.id !== 'string') return;
  noteOp('record', rec.id, rec);
  const i = state.records.findIndex((r) => r.id === rec.id);
  if (i >= 0) state.records = state.records.map((r, j) => (j === i ? rec : r));
  else state.records = [...state.records, rec];
  bump();
  saveCache();
  emit('data');
}

export function removeRecord(id) {
  noteOp('record', id, null);
  state.records = state.records.filter((r) => r.id !== id);
  bump();
  saveCache();
  emit('data');
}

export function upsertMember(m) {
  if (!m || typeof m.id !== 'string') return;
  noteOp('member', m.id, m);
  const i = state.members.findIndex((x) => x.id === m.id);
  if (i >= 0) state.members = state.members.map((x, j) => (j === i ? m : x));
  else state.members = [...state.members, m];
  bump();
  saveCache();
  emit('data');
}

export function removeMember(id) {
  noteOp('member', id, null);
  state.members = state.members.filter((m) => m.id !== id);
  bump();
  saveCache();
  emit('data');
}

export function upsertGame(g) {
  if (!g || typeof g.id !== 'string') return;
  noteOp('game', g.id, g);
  const i = state.games.findIndex((x) => x.id === g.id);
  if (i >= 0) state.games = state.games.map((x, j) => (j === i ? g : x));
  else state.games = [...state.games, g];
  bump();
  saveCache();
  emit('data');
}

export function removeGame(id) {
  noteOp('game', id, null);
  state.games = state.games.filter((g) => g.id !== id);
  bump();
  saveCache();
  emit('data');
}

/** 키 + 캐시 삭제 (401 등, 초안은 남김) */
export function forgetAccess() {
  localOps = [];
  clearKey();
  lsRemove(STORAGE.cache);
  state.records = [];
  state.members = [];
  state.games = [];
  state.lastSync = null;
  state.fromCache = false;
  state.status = 'idle';
  bump();
}

/** 아직 한 번도 데이터를 받지 못한 첫 로딩 중인지 */
export function isFirstLoad() {
  return !state.lastSync && (state.status === 'loading' || state.status === 'idle');
}

/** 한 번도 데이터를 받지 못했고(기기 사본도 없음) 불러오기에 실패했는지 — "기록 없음"과 구분하려고 */
export function loadFailed() {
  return !state.lastSync && (state.status === 'error' || state.status === 'offline');
}

/** 키 + 캐시 + 초안 삭제 */
export function wipeLocal() {
  localOps = [];
  clearKey();
  lsRemove(STORAGE.cache);
  clearDraft();
  state.records = [];
  state.members = [];
  state.games = [];
  state.lastSync = null;
  state.fromCache = false;
  state.status = 'idle';
  bump();
}

// ── 파생 계산 (version 기준 메모) ──
function cached(name, fn) {
  if (!(name in memo)) memo[name] = fn();
  return memo[name];
}

export function memberMap() {
  return cached('memberMap', () => new Map(state.members.map((m) => [m.id, m])));
}

/** 멤버 목록 (이름순) */
export function membersSorted() {
  return cached('membersSorted', () => [...state.members].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')));
}

/** memberId → 표시 정보. 없는 멤버는 "(떠난 멤버)" */
export function memberInfo(id) {
  const m = memberMap().get(id);
  if (m) return { id, name: m.name || '이름 없음', emoji: m.emoji || '', color: m.color || 'c10', missing: false };
  return { id, name: '(떠난 멤버)', emoji: '', color: 'gone', missing: true };
}

export function recordById(id) {
  return state.records.find((r) => r.id === id) || null;
}

const cmpDesc = (a, b) =>
  String(b.date || '').localeCompare(String(a.date || '')) ||
  String(b.createdAt || '').localeCompare(String(a.createdAt || ''));

/** 최신순 정렬된 기록 */
export function recordsSorted() {
  return cached('recordsSorted', () => [...state.records].sort(cmpDesc));
}

export function erOrdinals() {
  return cached('erOrdinals', () => {
    try { return escapeRoomOrdinals(state.records); } catch { return new Map(); }
  });
}

// ── 게임 정보 ──

export function gameMap() {
  return cached('gameMap', () => new Map(state.games.map((g) => [g.id, g])));
}

export function gameById(id) {
  return (typeof id === 'string' && gameMap().get(id)) || null;
}

/** 기록 id → 게임 id (gameId, 또는 예전 기록이면 같은 이름의 게임이 하나뿐일 때 그 게임 — 보여 줄 때만) */
function recordGameIds() {
  return cached('recordGameIds', () => resolveGameIds(state.records, state.games));
}

/** 기록이 속한 게임 정보 (없으면 null) */
export function gameOfRecord(r) {
  return r ? gameById(recordGameIds().get(r.id)) : null;
}

/** 기록의 제목: 연결한 게임 정보가 있으면 지금 게임 이름 (이름을 고치면 지난 기록에도 바로), 없으면 기록에 남은 제목 */
export function titleOf(r) {
  if (!r) return '';
  const g = typeof r.gameId === 'string' ? gameById(r.gameId) : null;
  return (g && g.type === r.type && g.title) || r.title || '';
}

/** 게임 정보에 속한 기록 (최신순) */
export function recordsOfGame(gameId) {
  if (!gameId) return [];
  const ids = recordGameIds();
  return recordsSorted().filter((r) => ids.get(r.id) === gameId);
}

/** 게임별 요약 (등록한 게임 + 기록에만 있는 이름) — stats.gameEntries */
export function gameSummaries() {
  return cached('gameSummaries', () => gameEntries(state.records, state.games));
}

export function gameSummary(gameId) {
  return gameSummaries().find((e) => e.gameId === gameId) || null;
}

/** 종류의 게임 정보 (최근에 한 것·최근에 등록한 것 먼저) */
export function gamesOfType(type) {
  return cached(`games:${type}`, () => gameSummaries().filter((e) => e.gameId && e.type === type));
}

/** 아직 게임 정보로 등록하지 않고 예전 기록에만 있는 이름 (종류별, 최근 순) */
export function legacyTitles(type) {
  return cached(`legacy:${type}`, () => gameSummaries().filter((e) => !e.gameId && e.type === type));
}

export { isOwnedGame };

/** 통계용 기록: 제목을 연결한 게임 이름으로 (이름을 고친 게임도 한 게임으로 셈) */
export function recordsForStats() {
  return cached('recordsForStats', () => state.records.map((r) => {
    const t = titleOf(r);
    return t === r.title ? r : { ...r, title: t };
  }));
}

const PHOTO_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 기록의 사진 id 목록 (첫 장 = 대표). 예전 기록(photos 없음)은 [] */
export function photosOf(r) {
  return r && Array.isArray(r.photos) ? r.photos.filter((id) => typeof id === 'string' && PHOTO_ID_RE.test(id)) : [];
}

/** 게임 정보의 대표 이미지 id (없으면 null) */
export function coverOf(g) {
  return g && typeof g.cover === 'string' && PHOTO_ID_RE.test(g.cover) ? g.cover : null;
}

/** 기록 사진 + 게임 대표 이미지 (중복 없이, 최신 기록 순 → 게임) — 저장된 데이터가 쓰는 사진 */
export function referencedPhotos() {
  const seen = new Set();
  for (const r of recordsSorted()) for (const id of photosOf(r)) seen.add(id);
  for (const g of state.games) { const c = coverOf(g); if (c) seen.add(c); }
  return [...seen];
}

/** 같은 게임을 이미 해 본 멤버 id (머미·방탈출은 다시 하기 어려워서 알려 줌) */
export function playedBy(gameId, excludeId) {
  const ids = new Set();
  for (const r of recordsOfGame(gameId)) {
    if (r.id === excludeId) continue;
    for (const id of participants(r)) ids.add(id);
  }
  return [...ids];
}

/** 자주 쓴 태그 (종류별) */
export function usedTags(type) {
  return cached(`tags:${type}`, () => {
    const counts = new Map();
    for (const r of state.records) {
      if (type && r.type !== type) continue;
      for (const t of Array.isArray(r.tags) ? r.tags : []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  });
}

/** 모든 태그 (필터용) */
export function allTags() {
  return usedTags('');
}
