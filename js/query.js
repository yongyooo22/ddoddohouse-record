// 검색·필터·정렬·작품별 묶기 (순수 함수 — node 테스트 가능)
// 검색은 작품의 제목과 방탈출 매장·지점만 본다. 후기·스포일러는 검색하지도, 미리보기로 보여 주지도 않는다.
import { titleKey } from './model.js';
import { yearOf } from './format.js';

// ── 한글 초성 검색 ───────────────────────────────────────────
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const CHO_SET = new Set(CHO);

/** 한글 음절의 초성 (음절이 아니면 null) */
export function initialOf(ch) {
  const code = ch.charCodeAt(0);
  if (code < 0xAC00 || code > 0xD7A3) return null;
  return CHO[Math.floor((code - 0xAC00) / 588)];
}

/** 검색용 정규화: NFC, 소문자, 띄어쓰기 제거 */
export function searchKey(s) {
  return String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, '');
}

// 검색어 글자 q 가 대상 글자 t 와 맞는지: 같거나, q 가 초성이고 t 의 초성과 같으면
const charMatch = (q, t) => q === t || (CHO_SET.has(q) && initialOf(t) === q);

/** 초성이 섞인 부분 문자열 검색 ('ㅅㅍㄹ', '스ㅍ' → '스플렌더') */
export function fuzzyIncludes(hay, needle) {
  const h = [...hay];
  const n = [...needle];
  if (!n.length) return true;
  outer: for (let i = 0; i + n.length <= h.length; i++) {
    for (let j = 0; j < n.length; j++) if (!charMatch(n[j], h[i + j])) continue outer;
    return true;
  }
  return false;
}

/** 작품이 검색어에 맞는지 (제목, 방탈출 매장·지점) */
export function matchesQuery(work, q) {
  const needle = searchKey(q);
  if (!needle) return true;
  const fields = [work.title, work.store, work.branch].filter(Boolean).map(searchKey);
  return fields.some((f) => fuzzyIncludes(f, needle));
}

// ── 필터 ─────────────────────────────────────────────────────

export function ratingMatches(rating, filter) {
  const r = typeof rating === 'number' && rating > 0 ? rating : null;
  switch (filter) {
    case '4.5': return r !== null && r >= 4.5;
    case '4': return r !== null && r >= 4;
    case '3': return r !== null && r >= 3;
    case 'low': return r !== null && r < 3;
    case 'none': return r === null;
    default: return true;
  }
}

/** 최근 플레이 날짜순 (같은 날이면 나중에 쓴 기록이 위) */
export function cmpPlayDesc(a, b) {
  return String(b.date || '').localeCompare(String(a.date || '')) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
    String(b.id).localeCompare(String(a.id));
}

/**
 * 플레이 기록을 조건으로 거르고 최근 날짜순으로.
 * @param {Array} plays
 * @param {Map<string, object>} workMap  work id → work
 * @param {{genre?:string, q?:string, year?:string, rating?:string}} f
 * @returns {Array<{play:object, work:object}>}
 */
export function filterEntries(plays, workMap, f = {}) {
  const out = [];
  for (const play of plays) {
    const work = workMap.get(play.workId);
    if (!work) continue;
    if (f.genre && work.genre !== f.genre) continue;
    if (f.year && yearOf(play.date) !== f.year) continue;
    if (!ratingMatches(play.rating, f.rating || '')) continue;
    if (f.q && !matchesQuery(work, f.q)) continue;
    out.push({ play, work });
  }
  return out.sort((x, y) => cmpPlayDesc(x.play, y.play));
}

/** 평균 평점 (미평가는 빼고). 없으면 null */
export function avgRating(plays) {
  const rated = plays.map((p) => p.rating).filter((r) => typeof r === 'number' && r > 0);
  if (!rated.length) return null;
  return Math.round((rated.reduce((a, b) => a + b, 0) / rated.length) * 10) / 10;
}

/**
 * 작품별로 묶기. entries 는 filterEntries 결과(최근순)라고 가정.
 * @returns {Array<{work, plays, latest, count, avg}>} 가장 최근에 플레이한 작품부터
 */
export function groupByWork(entries) {
  const map = new Map();
  for (const { play, work } of entries) {
    let g = map.get(work.id);
    if (!g) map.set(work.id, (g = { work, plays: [] }));
    g.plays.push(play);
  }
  return [...map.values()]
    .map((g) => ({ ...g, latest: g.plays[0], count: g.plays.length, avg: avgRating(g.plays) }))
    .sort((a, b) => cmpPlayDesc(a.latest, b.latest));
}

/** 기록이 있는 연도 (최근 연도부터) */
export function yearsOf(plays) {
  return [...new Set(plays.map((p) => yearOf(p.date)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse();
}

/** 작품마다 몇 번째 플레이인지 (오래된 날짜부터 1, 2, 3…) → Map(play id → n) */
export function playOrdinals(plays) {
  const byWork = new Map();
  for (const p of plays) {
    if (!byWork.has(p.workId)) byWork.set(p.workId, []);
    byWork.get(p.workId).push(p);
  }
  const out = new Map();
  for (const list of byWork.values()) {
    list.sort((a, b) => -cmpPlayDesc(a, b));
    list.forEach((p, i) => out.set(p.id, i + 1));
  }
  return out;
}

/** 작품별 요약 → Map(work id → {count, latest, avg}) */
export function workStats(plays) {
  const byWork = new Map();
  for (const p of plays) {
    if (!byWork.has(p.workId)) byWork.set(p.workId, []);
    byWork.get(p.workId).push(p);
  }
  const out = new Map();
  for (const [id, list] of byWork) {
    list.sort(cmpPlayDesc);
    out.set(id, { count: list.length, latest: list[0], avg: avgRating(list) });
  }
  return out;
}

/**
 * 같은 장르에서 제목이 같은(띄어쓰기·대소문자 무시) 작품들 — 저장할 때 "기존 작품에 추가할지" 물어볼 후보.
 * 자동으로 합치지 않기 위해 후보만 돌려준다.
 */
export function sameTitleWorks(works, genre, title, { excludeId = null } = {}) {
  const k = titleKey(title);
  if (!k) return [];
  return works.filter((w) => w.genre === genre && w.id !== excludeId && titleKey(w.title) === k);
}

/**
 * 제목 입력 중 보여 줄 기존 작품 제안: 앞부분이 맞는 것 먼저, 그다음 최근에 플레이한 순.
 * genre 가 비어 있으면 모든 장르에서 찾는다.
 */
export function suggestWorks(works, stats, { genre = '', q = '', limit = 6 } = {}) {
  const needle = searchKey(q);
  if (!needle) return [];
  const scored = [];
  for (const w of works) {
    if (genre && w.genre !== genre) continue;
    const t = searchKey(w.title);
    let score = -1;
    if (t.startsWith(needle)) score = 2;
    else if (fuzzyIncludes(t, needle)) score = 1;
    else if (matchesQuery(w, q)) score = 0;
    if (score < 0) continue;
    const s = stats.get(w.id);
    scored.push({ w, score, latest: s ? s.latest.date : '' });
  }
  scored.sort((a, b) => b.score - a.score || String(b.latest).localeCompare(String(a.latest)));
  return scored.slice(0, limit).map((x) => x.w);
}

/** 함께한 사람 이름 — 많이 함께한 순 (입력 제안용) */
export function companionNames(plays) {
  const counts = new Map();
  for (const p of plays) {
    for (const n of Array.isArray(p.companions) ? p.companions : []) {
      const k = n.toLowerCase();
      const c = counts.get(k);
      if (c) c.n += 1;
      else counts.set(k, { name: n, n: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ko')).map((c) => c.name);
}
