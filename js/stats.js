// 통계 계산 — 순수 함수 (DOM 없음, node에서 import 가능)
// 입력 기록은 서버 검증을 거친 형태를 기대하지만, 빠진 필드가 있어도 죽지 않도록 방어적으로 읽는다.

const TYPES = ['boardgame', 'murdermystery', 'escaperoom'];
const MM_SCORE_KEYS = ['story', 'deduction', 'roleplay', 'balance', 'production'];

// ── 내부 도우미 ──────────────────────────────────────────────

const arr = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const isRecord = (r) => !!r && typeof r === 'object' && TYPES.includes(r.type);
const ofType = (records, type) => arr(records).filter((r) => isRecord(r) && r.type === type);
const emptyByType = () => ({ boardgame: 0, murdermystery: 0, escaperoom: 0 });
const pad2 = (n) => String(n).padStart(2, '0');
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 유한한 숫자면 그 값, 아니면 null ('' / null / NaN → null) */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** 이름 묶기용 키 (공백 정리 + 대소문자 무시) */
function groupKey(s) {
  return str(s).normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 이름별 개수 → [{name, count}] (많은 순, 같으면 이름순). 빈 이름은 제외 */
function countByName(values) {
  const map = new Map();
  for (const v of values) {
    const key = groupKey(v);
    if (!key) continue;
    const cur = map.get(key);
    if (cur) cur.count++;
    else map.set(key, { name: str(v).trim().replace(/\s+/g, ' '), count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ko'));
}

function ymOf(date) {
  const s = str(date);
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
}

function weekdayOf(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(date));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

function cmpStr(a, b) {
  const x = str(a);
  const y = str(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** 최신순: 날짜 내림차순 → createdAt 내림차순 */
function byLatest(a, b) {
  return cmpStr(b.date, a.date) || cmpStr(b.createdAt, a.createdAt);
}

/** 멤버별 누적용 Map 도우미 */
function tally(map, id, init) {
  let t = map.get(id);
  if (!t) map.set(id, (t = { memberId: id, ...init }));
  return t;
}

// ── 공개 도우미 ──────────────────────────────────────────────

/** 기록에 참여한 멤버 id 집합 (members ∪ 보드게임 결과 ∪ 머미 배역) */
export function participants(record) {
  const r = obj(record);
  const ids = new Set();
  const add = (id) => {
    if (typeof id === 'string' && id) ids.add(id);
  };
  arr(r.members).forEach(add);
  if (r.type === 'boardgame') arr(obj(r.bg).results).forEach((x) => add(obj(x).memberId));
  if (r.type === 'murdermystery') arr(obj(r.mm).roles).forEach((x) => add(obj(x).memberId));
  return ids;
}

/** 보드게임 승자 id 집합. 협력 모드는 coopWin이면 참여자 전원 */
export function bgWinners(record) {
  const r = obj(record);
  const bg = obj(r.bg);
  if (bg.mode === 'coop') return bg.coopWin === true ? participants(r) : new Set();
  const winners = new Set();
  for (const x of arr(bg.results)) {
    const res = obj(x);
    if (res.winner === true && typeof res.memberId === 'string' && res.memberId) winners.add(res.memberId);
  }
  return winners;
}

/**
 * 보드게임 결과가 기록된 판인지 (승률의 분모).
 * 협력: 승리/패배를 골랐을 때. 경쟁·팀전: 승자가 한 명이라도 표시됐을 때. '미기록'은 패배로 세지 않는다.
 */
export function bgDecided(record) {
  const bg = obj(obj(record).bg);
  if (bg.mode === 'coop') return typeof bg.coopWin === 'boolean';
  return arr(bg.results).some((x) => obj(x).winner === true);
}

/**
 * 보드게임 점수 → 등수. 같은 점수는 같은 등수이고 다음 등수는 건너뜀 (1·2·2·4).
 * 점수를 적지 않은 사람은 등수가 없음. lowWins: 낮은 점수가 이기는 게임
 * @returns {Map<string, number>} memberId → 등수
 */
export function scoreRanks(entries, { lowWins = false } = {}) {
  const scored = arr(entries).map(obj).filter((e) => typeof e.memberId === 'string' && e.memberId && num(e.score) !== null);
  const out = new Map();
  for (const e of scored) {
    const s = num(e.score);
    const better = scored.filter((o) => (lowWins ? num(o.score) < s : num(o.score) > s)).length;
    out.set(e.memberId, better + 1);
  }
  return out;
}

/** 저장된 결과가 '낮은 점수가 이김'으로 매겨졌는지 (등수가 앞선 사람의 점수가 더 낮은 경우만 있으면 true) */
export function bgLowWins(results) {
  const xs = arr(results).map(obj).filter((x) => num(x.score) !== null && num(x.rank) !== null);
  let low = false;
  for (const a of xs) {
    for (const b of xs) {
      if (num(a.rank) >= num(b.rank)) continue;
      if (num(a.score) > num(b.score)) return false;
      if (num(a.score) < num(b.score)) low = true;
    }
  }
  return low;
}

/** 제목 묶기용 키 — 같은 게임인지 비교할 때 (공백 정리 + 대소문자 무시) */
export function titleKey(title) {
  return groupKey(title);
}

/**
 * 이번 판에 쓴 게임이 내 소장인지: 'mine' | 'borrowed' | null(미기록·해당 없음).
 * 보드게임, 또는 집에서 하는 보드게임형 머미만 (매장형·온라인 머미와 방탈출은 항상 null)
 */
export function ownershipOf(record) {
  const r = obj(record);
  let b;
  if (r.type === 'boardgame') b = obj(r.bg);
  else if (r.type === 'murdermystery' && obj(r.mm).format === 'box') b = obj(r.mm);
  else return null;
  return b.ownership === 'mine' || b.ownership === 'borrowed' ? b.ownership : null;
}

/** 대여한 게임이면 빌려준 사람 (적지 않았으면 '') */
export function lenderOf(record) {
  if (ownershipOf(record) !== 'borrowed') return '';
  const r = obj(record);
  return str(obj(r.type === 'boardgame' ? r.bg : r.mm).lender).trim();
}

/** 머미 기록에서 해당 멤버의 배역 (없으면 null) */
export function mmRoleOf(record, memberId) {
  return arr(obj(obj(record).mm).roles).find((x) => obj(x).memberId === memberId) || null;
}

/**
 * 멤버가 머미에서 맡았던 역할 목록 (최근 순). {record, character, hidden}
 *  - 배역에 역할 이름이 적힌 기록
 *  - includeMyRole: 이 기기의 '나'라면, 내 역할(mm.myRole)만 적히고 배역이 없는 기록도 내 역할로 봄
 *  hidden: 스포일러 기록이거나 '역할 가리기'라 열기 전에는 보이면 안 되는 역할
 */
export function memberRoles(records, memberId, { includeMyRole = false } = {}) {
  const out = [];
  for (const r of arr(records)) {
    if (!isRecord(r) || r.type !== 'murdermystery') continue;
    const mm = obj(r.mm);
    let character = str(obj(mmRoleOf(r, memberId)).character).trim();
    if (!character && includeMyRole && !mmRoleOf(r, memberId)) character = str(mm.myRole).trim();
    if (!character) continue;
    out.push({ record: r, character, hidden: r.spoiler === true || mm.roleSpoiler === true });
  }
  return out.sort((a, b) => byLatest(a.record, b.record));
}

/** 별점 표시: 4.5 → '4.5', 0/없음 → '미평가' */
export function ratingText(n) {
  const v = num(n);
  return v && v > 0 ? v.toFixed(1) : '미평가';
}

/** 비율 표시: 0.667 → '67%', null → '-' */
export function percentText(rate) {
  const v = num(rate);
  return v === null ? '-' : `${Math.round(v * 100)}%`;
}

/** 초 → 'm:ss' (null → '-') */
export function durationText(sec) {
  const v = num(sec);
  if (v === null || v < 0) return '-';
  const s = Math.round(v);
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// ── 전체 요약 ────────────────────────────────────────────────

/**
 * @param {object[]} records
 * @param {object[]} members
 * @param {Date} now
 */
export function overview(records, members, now = new Date()) {
  const list = arr(records).filter(isRecord);
  const nowYm = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;

  // 최근 12개월 (오래된 달 먼저)
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthly.push({ ym: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`, count: 0, byType: emptyByType() });
  }
  const monthIndex = new Map(monthly.map((m, i) => [m.ym, i]));

  const byType = emptyByType();
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  // 현재 멤버는 0회라도 포함 (목록 순서 유지), 떠난 멤버 id는 기록에 나오면 추가
  const counts = new Map();
  for (const m of arr(members)) if (m && typeof m.id === 'string') counts.set(m.id, 0);

  let thisMonth = 0;
  for (const r of list) {
    byType[r.type]++;
    const ym = ymOf(r.date);
    if (ym === nowYm) thisMonth++;
    const idx = monthIndex.get(ym);
    if (idx !== undefined) {
      monthly[idx].count++;
      monthly[idx].byType[r.type]++;
    }
    const wd = weekdayOf(r.date);
    if (wd !== null) weekday[wd]++;
    for (const id of participants(r)) counts.set(id, (counts.get(id) || 0) + 1);
  }

  const memberCounts = [...counts]
    .map(([memberId, count]) => ({ memberId, count }))
    .sort((a, b) => b.count - a.count);

  return { total: list.length, thisMonth, byType, monthly, weekday, memberCounts };
}

/** 달별 기록 수 (yms ['2026-01', …] 순서 그대로): [{ym, count, byType}] */
export function monthlyOf(records, yms) {
  const out = arr(yms).map((ym) => ({ ym, count: 0, byType: emptyByType() }));
  const idx = new Map(out.map((m, i) => [m.ym, i]));
  for (const r of arr(records)) {
    if (!isRecord(r)) continue;
    const i = idx.get(ymOf(r.date));
    if (i === undefined) continue;
    out[i].count++;
    out[i].byType[r.type]++;
  }
  return out;
}

// ── 보드게임 ─────────────────────────────────────────────────

export function boardgameStats(records) {
  const list = ofType(records, 'boardgame');
  const per = new Map();
  for (const r of list) {
    const winners = bgWinners(r);
    const decided = bgDecided(r);
    for (const id of participants(r)) {
      const t = tally(per, id, { plays: 0, decided: 0, wins: 0 });
      t.plays++;
      if (!decided) continue;
      t.decided++;
      if (winners.has(id)) t.wins++;
    }
  }
  // 승률 = 승리 / 결과가 기록된 판 (결과 없는 판만 있으면 null)
  const memberWinRates = [...per.values()]
    .map((t) => ({ ...t, rate: t.decided ? t.wins / t.decided : null }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.wins - a.wins || b.plays - a.plays);

  // 최다 우승자: 승수 → (같으면) 승률 높은 쪽
  const best = [...memberWinRates].sort((a, b) => b.wins - a.wins || (b.rate ?? -1) - (a.rate ?? -1))[0];
  const topWinner = best && best.wins > 0 ? { memberId: best.memberId, wins: best.wins } : null;

  return {
    plays: list.length,
    topGames: countByName(list.map((r) => r.title)).map(({ name, count }) => ({ title: name, count })),
    memberWinRates,
    topWinner,
  };
}

/**
 * 보드게임 랭킹 — 순위(승자)가 기록된 경쟁·팀전 판만 (협력은 모두 함께 이기거나 지므로 빠짐).
 * 1등 횟수 → 1등 비율 → 평균 등수(낮을수록 위) → 판 수 순. 셋이 모두 같으면 같은 자리.
 * 그 판에 함께했지만 점수·등수가 없는 사람은 1등을 못 한 판으로 셈. keep(memberId) 가 false 인 사람(떠난 멤버 등)은 빼고 자리를 매김
 * @returns {{memberId, place, games, wins, rate, avgRank}[]}
 */
export function bgRanking(records, { keep = () => true } = {}) {
  const per = new Map();
  for (const r of ofType(records, 'boardgame')) {
    const bg = obj(r.bg);
    if (bg.mode === 'coop' || !bgDecided(r)) continue;
    const res = new Map();
    for (const x of arr(bg.results).map(obj)) if (typeof x.memberId === 'string' && x.memberId) res.set(x.memberId, x);
    for (const id of participants(r)) {
      const t = tally(per, id, { games: 0, wins: 0, rankSum: 0, ranked: 0 });
      t.games++;
      const x = res.get(id);
      if (x && x.winner === true) t.wins++;
      const rank = x ? num(x.rank) : null;
      if (rank !== null && rank >= 1) {
        t.rankSum += rank;
        t.ranked++;
      }
    }
  }
  const rows = [...per.values()].filter((t) => keep(t.memberId)).map((t) => ({
    memberId: t.memberId, place: 0, games: t.games, wins: t.wins, rate: t.wins / t.games,
    avgRank: t.ranked ? t.rankSum / t.ranked : null,
  }));
  rows.sort((a, b) => b.wins - a.wins || b.rate - a.rate || (a.avgRank ?? Infinity) - (b.avgRank ?? Infinity) ||
    b.games - a.games || cmpStr(a.memberId, b.memberId));
  rows.forEach((x, i) => {
    const p = rows[i - 1];
    x.place = p && p.wins === x.wins && p.rate === x.rate && p.avgRank === x.avgRank ? p.place : i + 1;
  });
  return rows;
}

/**
 * 기록 상세의 플레이 결과 줄: 그 판에 함께한 사람 모두 (결과가 없는 사람도).
 * 등수 순 → 등수 없이 승리만 표시된 사람 → 결과 없는 사람. 같은 등수는 tied
 * @returns {{memberId, rank, score, winner, hasResult, tied}[]}
 */
export function bgResultRows(record) {
  const r = obj(record);
  const bg = obj(r.bg);
  const byId = new Map();
  if (bg.mode !== 'coop') {
    for (const x of arr(bg.results).map(obj)) if (typeof x.memberId === 'string' && x.memberId) byId.set(x.memberId, x);
  }
  const order = [...participants(r)];
  const rows = order.map((id, i) => {
    const x = byId.get(id);
    const rank = x ? num(x.rank) : null;
    const score = x ? num(x.score) : null;
    const winner = !!x && x.winner === true;
    return { memberId: id, rank: rank !== null && rank >= 1 ? rank : null, score, winner, hasResult: rank !== null || score !== null || winner, tied: false, i };
  });
  const rankCount = new Map();
  for (const x of rows) if (x.rank !== null) rankCount.set(x.rank, (rankCount.get(x.rank) || 0) + 1);
  for (const x of rows) x.tied = x.rank !== null && rankCount.get(x.rank) > 1;
  const group = (x) => (x.rank !== null ? 0 : x.winner ? 1 : x.hasResult ? 2 : 3);
  rows.sort((a, b) => group(a) - group(b) || (a.rank ?? 0) - (b.rank ?? 0) || (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.i - b.i);
  return rows.map(({ i, ...x }) => x);
}

/**
 * 이 기기의 '나'의 보드게임 결과 (나를 모르거나, 함께하지 않았거나, 내 결과가 없으면 null — 짐작해서 만들지 않음)
 * @returns {null | {kind:'rank', rank, of, tied, winner} | {kind:'win', of, shared} | {kind:'coop', win, of}}
 *   of: 그 판에 함께한 사람 수
 */
export function myBgResult(record, meId) {
  if (typeof meId !== 'string' || !meId) return null;
  const r = obj(record);
  if (r.type !== 'boardgame') return null;
  const people = participants(r);
  if (!people.has(meId)) return null;
  const bg = obj(r.bg);
  const of = people.size;
  if (bg.mode === 'coop') return typeof bg.coopWin === 'boolean' ? { kind: 'coop', win: bg.coopWin, of } : null;
  const mine = bgResultRows(r).find((x) => x.memberId === meId);
  if (!mine) return null;
  if (mine.rank !== null) return { kind: 'rank', rank: mine.rank, of, tied: mine.tied, winner: mine.winner };
  if (mine.winner) return { kind: 'win', of, shared: bgWinners(r).size > 1 };
  return null;
}

/**
 * 보드게임 멤버별 순위와 승률 (한 표로). 승리 = 1등(공동 포함) · 팀 승리 · 협력 승리,
 * 승률 = 승리 / 결과를 기록한 판 (결과 미입력 판은 패배로 세지 않음 — boardgameStats 와 같은 기준).
 * 승리 수 → 승률 → 결과 기록 판 수 순, 같으면 같은 자리. 결과 기록 판이 없는 사람은 맨 아래(place null).
 * avgRank: 점수·등수를 적은 경쟁·팀전 판의 평균 등수 (보조 정보, 없으면 null)
 * @returns {{memberId, place, plays, decided, wins, rate, avgRank}[]}
 */
export function bgMemberTable(records, { keep = () => true } = {}) {
  const avgRanks = new Map(bgRanking(records).map((x) => [x.memberId, x.avgRank]));
  const rows = boardgameStats(records).memberWinRates.filter((x) => keep(x.memberId)).map((x) => ({
    memberId: x.memberId, place: null, plays: x.plays, decided: x.decided, wins: x.wins, rate: x.rate,
    avgRank: avgRanks.get(x.memberId) ?? null,
  }));
  rows.sort((a, b) => (b.decided ? 1 : 0) - (a.decided ? 1 : 0) || b.wins - a.wins || (b.rate ?? -1) - (a.rate ?? -1) ||
    b.decided - a.decided || b.plays - a.plays || cmpStr(a.memberId, b.memberId));
  rows.forEach((x, i) => {
    if (!x.decided) return;
    const p = rows[i - 1];
    x.place = p && p.decided && p.wins === x.wins && p.rate === x.rate ? p.place : i + 1;
  });
  return rows;
}

// ── 기간 · 함께한 멤버 ───────────────────────────────────────

export const PERIODS = ['all', 'year', 'month'];

/** 플레이 날짜가 기간 안인지: 'all' 전체 · 'year' 올해 · 'month' 이번 달 (now 의 이 기기 시간대 기준) */
export function inPeriod(record, period, now = new Date()) {
  if (period !== 'year' && period !== 'month') return true;
  const d = str(obj(record).date);
  const y = String(now.getFullYear());
  if (period === 'year') return d.slice(0, 4) === y;
  return d.slice(0, 7) === `${y}-${pad2(now.getMonth() + 1)}`;
}

export function filterPeriod(records, period, now = new Date()) {
  return arr(records).filter((r) => isRecord(r) && inPeriod(r, period, now));
}

/**
 * 멤버별 함께한 플레이 (기록 한 개 = 한 번. 같은 기록에 두 번 나와도 한 번만 셈)
 * @returns {Map<string, {n, last, byType}>}  last: 가장 최근 플레이 날짜
 */
export function memberActivity(records) {
  const out = new Map();
  for (const r of arr(records)) {
    if (!isRecord(r)) continue;
    for (const id of participants(r)) {
      let a = out.get(id);
      if (!a) out.set(id, (a = { n: 0, last: '', byType: emptyByType() }));
      a.n++;
      a.byType[r.type]++;
      if (str(r.date) > a.last) a.last = str(r.date);
    }
  }
  return out;
}

/**
 * 가장 많이 함께한 멤버 (많은 순, 같으면 최근에 함께한 순). exclude(나)·keep(false 면 뺌 — 떠난 멤버 등)
 * @returns {{memberId, count, last}[]}
 */
export function mateRanking(records, { exclude = null, keep = () => true } = {}) {
  return [...memberActivity(records)]
    .filter(([id]) => id !== exclude && keep(id))
    .map(([memberId, a]) => ({ memberId, count: a.n, last: a.last }))
    .sort((a, b) => b.count - a.count || cmpStr(b.last, a.last) || cmpStr(a.memberId, b.memberId));
}

/** 맨 앞과 같은 횟수인 사람 모두 (공동 1위). 비었으면 [] */
export function topTies(list) {
  const xs = arr(list);
  return xs.length ? xs.filter((x) => x.count === xs[0].count) : [];
}

// ── 머더미스터리 ─────────────────────────────────────────────

export function mmStats(records) {
  const list = ofType(records, 'murdermystery');
  const scenarios = new Set(list.map((r) => groupKey(r.title)).filter(Boolean)).size;
  const ratings = list.map((r) => num(r.rating)).filter((n) => n !== null && n > 0);

  let caught = 0;
  let escaped = 0;
  const per = new Map();
  for (const r of list) {
    const mm = obj(r.mm);
    if (mm.culpritResult === 'caught') caught++;
    else if (mm.culpritResult === 'escaped') escaped++;

    const culpritDecided = mm.culpritResult === 'caught' || mm.culpritResult === 'escaped';
    for (const id of participants(r)) {
      const t = tally(per, id, { plays: 0, culpritCount: 0, culpritDecided: 0, culpritEscaped: 0, wins: 0, decided: 0, mvpCount: 0 });
      t.plays++;
      const role = obj(mmRoleOf(r, id));
      if (role.culprit === true) {
        t.culpritCount++;
        // 생존률의 분모는 검거/도주 결과가 기록된 판만 ('미기록'을 검거로 세지 않음)
        if (culpritDecided) t.culpritDecided++;
        if (mm.culpritResult === 'escaped') t.culpritEscaped++;
      }
      if (role.mvp === true) t.mvpCount++;
      if (['win', 'lose', 'draw'].includes(role.outcome)) {
        t.decided++;
        if (role.outcome === 'win') t.wins++;
      }
    }
  }

  const avgScores = {};
  for (const k of MM_SCORE_KEYS) {
    avgScores[k] = avg(
      list.map((r) => num(obj(obj(r.mm).scores)[k])).filter((n) => n !== null && n > 0),
    );
  }

  return {
    plays: list.length,
    scenarios,
    avgRating: avg(ratings),
    // 검거율의 분모는 검거·도주를 기록한 판만 (decided 0 = '결과 기록 없음', 0% 와 다름)
    culprit: { caught, escaped, decided: caught + escaped, rate: caught + escaped ? caught / (caught + escaped) : null },
    byPublisher: countByName(list.map((r) => obj(r.mm).publisher)),
    memberStats: [...per.values()]
      .map((t) => ({
        ...t,
        winRate: t.decided ? t.wins / t.decided : null,
        culpritEscapeRate: t.culpritDecided ? t.culpritEscaped / t.culpritDecided : null,
      }))
      .sort((a, b) => b.plays - a.plays),
    avgScores,
  };
}

// ── 방탈출 ───────────────────────────────────────────────────

function dist6(values) {
  const out = [0, 0, 0, 0, 0, 0];
  for (const v of values) {
    const n = num(v) ?? 0;
    out[Math.min(5, Math.max(0, Math.round(n)))]++;
  }
  return out;
}

export function erStats(records) {
  const list = ofType(records, 'escaperoom');
  const ers = list.map((r) => obj(r.er));
  const cleared = ers.filter((er) => er.cleared === true).length;
  // 성공률의 분모는 성공·실패를 기록한 테마만 ('미기록'을 실패로 세지 않음)
  const decided = ers.filter((er) => typeof er.cleared === 'boolean').length;
  const per = new Map();
  for (const r of list) {
    const res = obj(r.er).cleared;
    for (const id of participants(r)) {
      const t = tally(per, id, { plays: 0, decided: 0, cleared: 0 });
      t.plays++;
      if (typeof res === 'boolean') t.decided++;
      if (res === true) t.cleared++;
    }
  }
  return {
    plays: list.length,
    cleared,
    decided,
    clearRate: decided ? cleared / decided : null,
    avgHints: avg(ers.map((er) => num(er.hints)).filter((n) => n !== null)),
    avgRemainingSec: avg(
      ers.filter((er) => er.cleared === true).map((er) => num(er.remainingSec)).filter((n) => n !== null),
    ),
    byBrand: countByName(ers.map((er) => er.brand)),
    memberStats: [...per.values()]
      .map((t) => ({ ...t, rate: t.decided ? t.cleared / t.decided : null }))
      .sort((a, b) => b.plays - a.plays || (b.rate ?? -1) - (a.rate ?? -1)),
    difficultyDist: dist6(ers.map((er) => er.difficulty)),
    fearDist: dist6(ers.map((er) => er.fear)),
  };
}

/** 방탈출 누적 번호: 날짜 오름차순 → createdAt 오름차순, 1부터. Map(recordId → n) */
export function escapeRoomOrdinals(records) {
  const list = ofType(records, 'escaperoom').sort(
    (a, b) => cmpStr(a.date, b.date) || cmpStr(a.createdAt, b.createdAt) || cmpStr(a.id, b.id),
  );
  const map = new Map();
  list.forEach((r, i) => {
    if (r.id != null) map.set(r.id, i + 1);
  });
  return map;
}

// ── 멤버 프로필 ──────────────────────────────────────────────

export function memberProfile(records, memberId) {
  const mine = arr(records).filter((r) => isRecord(r) && participants(r).has(memberId));
  const byType = emptyByType();
  const bg = { plays: 0, decided: 0, wins: 0 };
  const mm = { plays: 0, culpritCount: 0, mvpCount: 0 };
  const er = { plays: 0, decided: 0, cleared: 0 };
  for (const r of mine) {
    byType[r.type]++;
    if (r.type === 'boardgame') {
      bg.plays++;
      if (bgDecided(r)) {
        bg.decided++;
        if (bgWinners(r).has(memberId)) bg.wins++;
      }
    } else if (r.type === 'murdermystery') {
      mm.plays++;
      const role = obj(mmRoleOf(r, memberId));
      if (role.culprit === true) mm.culpritCount++;
      if (role.mvp === true) mm.mvpCount++;
    } else {
      er.plays++;
      if (typeof obj(r.er).cleared === 'boolean') er.decided++;
      if (obj(r.er).cleared === true) er.cleared++;
    }
  }
  return { byType, bg, mm, er, recent: [...mine].sort(byLatest).slice(0, 5) };
}

// ── 게임 정보 ↔ 기록 · 소장 목록 ─────────────────────────

const OWNABLE = ['boardgame', 'murdermystery'];

/** 게임 정보가 '내 소장'인지 (보드게임·머미만. 소장 여부를 정한 적 없는 예전 등록 게임은 내 소장) */
export function isOwnedGame(game) {
  const g = obj(game);
  return OWNABLE.includes(g.type) && g.owned !== false;
}

const isGame = (g) => !!g && typeof g === 'object' && TYPES.includes(g.type) && typeof g.id === 'string' && !!g.id && !!groupKey(g.title);

/**
 * 기록마다 어느 게임 정보에 속하는지: Map(기록 id → 게임 id | null)
 * - gameId 가 있고 그 게임이 있으면 그 게임
 * - 그 밖(게임 정보 전의 예전 기록, 지워진 게임): 같은 종류·같은 이름의 게임이 딱 하나 등록돼 있을 때만 그 게임으로 봄.
 *   보여 줄 때만 묶을 뿐 기록은 바꾸지 않으며, 같은 이름이 둘 이상이면(다른 판본) 어느 쪽에도 붙이지 않음
 */
export function resolveGameIds(records, games) {
  const byId = new Map();
  const byTitle = new Map();
  for (const g of arr(games)) {
    if (!isGame(g)) continue;
    byId.set(g.id, g);
    const k = `${g.type}:${groupKey(g.title)}`;
    byTitle.set(k, [...(byTitle.get(k) || []), g.id]);
  }
  const out = new Map();
  for (const r of arr(records)) {
    if (!isRecord(r) || typeof r.id !== 'string') continue;
    const linked = typeof r.gameId === 'string' ? byId.get(r.gameId) : null;
    if (linked && linked.type === r.type) { out.set(r.id, linked.id); continue; }
    const same = byTitle.get(`${r.type}:${groupKey(r.title)}`) || [];
    out.set(r.id, same.length === 1 ? same[0] : null);
  }
  return out;
}

/**
 * 게임별 요약 (등록한 게임 정보 + 아직 등록하지 않고 기록에만 있는 이름).
 * @returns {Entry[]}  최근에 한 게임부터, 그 뒤에 아직 안 해 본 등록 게임이 최근에 등록한 것부터
 *   Entry = { key ('g:<게임 id>' | '<종류>:<제목 키>'), type, title, gameId(없으면 null), game(게임 정보 또는 null),
 *             owned(내 소장), plays, lastDate, firstDate(안 해 봤으면 ''), avgRating(없으면 null — 별점 없는 판은 빼고), rated(별점 있는 판 수), latestId,
 *             cover(대표 이미지, 없으면 가장 최근 기록 사진, 없으면 null), memo, addedAt(등록 시각 또는 null),
 *             mine·borrowed(예전 기록의 소장 여부 판 수), lenders(예전 기록의 빌려준 사람, 최근 순) }
 */
export function gameEntries(records, games = []) {
  const link = resolveGameIds(records, games);
  const regs = new Map(arr(games).filter(isGame).map((g) => [g.id, g]));
  const list = arr(records).filter(isRecord).sort(byLatest);
  const map = new Map();
  const blank = (key, type, title) => ({
    key, type, title, gameId: null, game: null, owned: false, plays: 0, lastDate: '', firstDate: '', latestId: null,
    cover: null, photo: null, memo: '', addedAt: null, ratings: [], mine: 0, borrowed: 0, lenders: [],
  });
  for (const r of list) {
    const gid = link.get(r.id) || null;
    const tk = groupKey(r.title);
    if (!gid && !tk) continue;
    const key = gid ? `g:${gid}` : `${r.type}:${tk}`;
    let e = map.get(key);
    if (!e) {
      e = blank(key, r.type, cleanTitle(r.title));
      map.set(key, e);
    }
    e.plays++;
    if (!e.lastDate) { e.lastDate = str(r.date); e.latestId = r.id; }
    e.firstDate = str(r.date); // 최신순으로 도니까 마지막 값이 가장 오래된 판
    const rating = num(r.rating);
    if (rating !== null && rating > 0) e.ratings.push(rating);
    if (!e.photo) e.photo = arr(r.photos).find((id) => typeof id === 'string' && id) || null;
    const own = ownershipOf(r);
    if (own === 'mine') e.mine++;
    else if (own === 'borrowed') {
      e.borrowed++;
      const who = lenderOf(r);
      if (who && !e.lenders.some((x) => groupKey(x) === groupKey(who))) e.lenders.push(who);
    }
  }
  // 아직 기록이 없는 등록 게임 — 최근에 등록한 것부터
  const unplayed = [...regs.values()].filter((g) => !map.has(`g:${g.id}`))
    .sort((a, b) => cmpStr(b.createdAt, a.createdAt) || cmpStr(a.id, b.id));
  for (const g of unplayed) map.set(`g:${g.id}`, blank(`g:${g.id}`, g.type, ''));
  const out = [];
  for (const { ratings, photo, ...e } of map.values()) {
    const g = e.key.startsWith('g:') ? regs.get(e.key.slice(2)) : null;
    const entry = { ...e, avgRating: avg(ratings), rated: ratings.length, cover: photo };
    if (g) {
      Object.assign(entry, {
        type: g.type, title: cleanTitle(g.title), gameId: g.id, game: g, owned: isOwnedGame(g),
        cover: (typeof g.cover === 'string' && g.cover) || photo, memo: str(g.memo).trim(), addedAt: str(g.createdAt) || null,
      });
    } else {
      // 등록 전의 예전 기록: '내 소장'으로 남긴 판이 있으면 소장 (보드게임·보드게임형 머미)
      entry.owned = OWNABLE.includes(entry.type) && entry.mine > 0;
    }
    out.push(entry);
  }
  return out;
}

/**
 * 소장 목록: '내 소장'인 게임 정보 + 등록 전 예전 기록 중 '내 소장'으로 남긴 게임 (보드게임·머미만, 방탈출 없음).
 * 횟수·날짜·평균 별점은 그 게임의 모든 판으로 센다.
 * @returns {{ owned: Entry[] }}
 */
export function collectionOf(records, games = []) {
  return { owned: gameEntries(records, games).filter((e) => e.owned && OWNABLE.includes(e.type)) };
}

function cleanTitle(s) {
  return str(s).trim().replace(/\s+/g, ' ');
}

// ── 사진 저장 공간 ──────────────────────────────────────────

/** 이만큼 차면 미리 알림 */
export const STORAGE_WARN_RATIO = 0.8;

/**
 * 사진 저장 공간 사용량 (서버 /api/images?stats=1 응답: count·bytes·limitCount·limitBytes).
 * @returns {{ ratio: number, warn: boolean, full: boolean, left: number|null }}
 *   ratio: 장수·용량 중 더 찬 쪽(0~1), warn: 80% 이상, full: 더 넣을 자리가 없음,
 *   left: 지금까지 사진의 평균 크기로 셈한 대략 더 넣을 수 있는 장수 (셀 수 없으면 null)
 */
export function storageUsage(stats) {
  const d = obj(stats);
  const count = Math.max(0, num(d.count) ?? 0);
  const bytes = Math.max(0, num(d.bytes) ?? 0);
  const limitCount = Math.max(0, num(d.limitCount) ?? 0);
  const limitBytes = Math.max(0, num(d.limitBytes) ?? 0);
  const ratio = Math.min(1, Math.max(limitBytes ? bytes / limitBytes : 0, limitCount ? count / limitCount : 0));
  const avg = count ? bytes / count : 0;
  const lefts = [];
  if (limitBytes && avg) lefts.push(Math.floor(Math.max(0, limitBytes - bytes) / avg));
  if (limitCount) lefts.push(Math.max(0, limitCount - count));
  const left = lefts.length ? Math.min(...lefts) : null;
  return { ratio, warn: ratio >= STORAGE_WARN_RATIO, full: ratio >= 1 || left === 0, left };
}
