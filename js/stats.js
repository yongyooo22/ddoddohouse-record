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

/** 머미 기록에서 해당 멤버의 배역 (없으면 null) */
export function mmRoleOf(record, memberId) {
  return arr(obj(obj(record).mm).roles).find((x) => obj(x).memberId === memberId) || null;
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
    culprit: { caught, escaped, rate: caught + escaped ? caught / (caught + escaped) : null },
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
  const per = new Map();
  for (const r of list) {
    const ok = obj(r.er).cleared === true;
    for (const id of participants(r)) {
      const t = tally(per, id, { plays: 0, cleared: 0 });
      t.plays++;
      if (ok) t.cleared++;
    }
  }
  return {
    plays: list.length,
    cleared,
    clearRate: list.length ? cleared / list.length : null,
    avgHints: avg(ers.map((er) => num(er.hints)).filter((n) => n !== null)),
    avgRemainingSec: avg(
      ers.filter((er) => er.cleared === true).map((er) => num(er.remainingSec)).filter((n) => n !== null),
    ),
    byBrand: countByName(ers.map((er) => er.brand)),
    memberStats: [...per.values()]
      .map((t) => ({ ...t, rate: t.plays ? t.cleared / t.plays : 0 }))
      .sort((a, b) => b.plays - a.plays || b.rate - a.rate),
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
  const er = { plays: 0, cleared: 0 };
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
      if (obj(r.er).cleared === true) er.cleared++;
    }
  }
  return { byType, bg, mm, er, recent: [...mine].sort(byLatest).slice(0, 5) };
}
