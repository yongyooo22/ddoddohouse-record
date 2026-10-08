// js/stats.js 테스트 — 실제 모임 기록과 비슷한 픽스처로 모든 통계 함수 검증
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  overview,
  boardgameStats,
  bgRanking,
  scoreRanks,
  bgLowWins,
  mmStats,
  erStats,
  escapeRoomOrdinals,
  memberProfile,
  memberRoles,
  participants,
  bgWinners,
  ratingText,
  percentText,
  durationText,
  ownershipOf,
  lenderOf,
  titleKey,
  collectionOf,
  gameEntries,
  resolveGameIds,
  isOwnedGame,
  storageUsage,
} from '../js/stats.js';

const close = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ''} ${actual} ≠ ${expected}`);

const members = [
  { id: 'm1', name: '연경', color: 'c1' },
  { id: 'm2', name: '영식', color: 'c2' },
  { id: 'm3', name: '수진', color: 'c3' },
  { id: 'm4', name: '민호', color: 'c4' },
  { id: 'm6', name: '새멤버', color: 'c6' }, // 기록 없음
];

// ── 보드게임 ──
const b1 = {
  id: 'b1', type: 'boardgame', date: '2026-09-05', title: '카탄', members: ['m1', 'm2', 'm3'], rating: 4,
  createdAt: '2026-09-05T13:00:00.000Z',
  bg: { mode: 'competitive', results: [
    { memberId: 'm1', score: 10, rank: 1, winner: true },
    { memberId: 'm2', score: 8, rank: 2, winner: false },
    { memberId: 'm3', score: 5, rank: 3, winner: false },
  ] },
};
const b2 = {
  id: 'b2', type: 'boardgame', date: '2026-09-12', title: '카탄 ', members: ['m1', 'm2'],
  createdAt: '2026-09-12T13:00:00.000Z',
  bg: { mode: 'competitive', results: [{ memberId: 'm2', winner: true }, { memberId: 'm1', winner: false }] },
};
const b3 = {
  id: 'b3', type: 'boardgame', date: '2026-08-20', title: '팬데믹', members: ['m1', 'm2', 'm4'],
  createdAt: '2026-08-20T13:00:00.000Z',
  bg: { mode: 'coop', coopWin: true, results: [] },
};
const b4 = {
  id: 'b4', type: 'boardgame', date: '2026-07-01', title: '팬데믹', members: ['m1', 'm3'],
  createdAt: '2026-07-01T13:00:00.000Z',
  bg: { mode: 'coop', coopWin: false },
};
// 떠난 멤버 m5는 결과에만 남아 있음
const b5 = {
  id: 'b5', type: 'boardgame', date: '2025-09-15', title: '스플렌더', members: ['m2'],
  createdAt: '2025-09-15T13:00:00.000Z',
  bg: { mode: 'competitive', results: [{ memberId: 'm2', winner: true }, { memberId: 'm5', winner: false }] },
};
const b6 = {
  id: 'b6', type: 'boardgame', date: '2025-06-10', title: '아줄', members: ['m1'],
  createdAt: '2025-06-10T13:00:00.000Z',
  bg: { mode: 'competitive', results: [{ memberId: 'm1', winner: true }] },
};

// ── 머더미스터리 ──
const mm1 = {
  id: 'mm1', type: 'murdermystery', date: '2026-09-20', title: '붉은 저택', members: ['m1', 'm2', 'm3'], rating: 4.5,
  createdAt: '2026-09-20T13:00:00.000Z',
  mm: {
    publisher: '머더랩', format: 'store',
    roles: [
      { memberId: 'm1', character: '집사', culprit: true, outcome: 'win' },
      { memberId: 'm2', character: '탐정', culprit: false, outcome: 'lose' },
      { memberId: 'm3', character: '하녀', culprit: false, outcome: null },
    ],
    culpritResult: 'escaped',
    scores: { story: 5, deduction: 4, roleplay: 4.5, balance: 0, production: 3 },
  },
};
const mm2 = {
  id: 'mm2', type: 'murdermystery', date: '2026-08-08', title: '검은 숲', members: ['m1', 'm2'], rating: 0,
  createdAt: '2026-08-08T13:00:00.000Z',
  mm: {
    publisher: '머더랩',
    roles: [
      { memberId: 'm2', culprit: true, outcome: 'lose' },
      { memberId: 'm1', culprit: false, outcome: 'win' },
    ],
    culpritResult: 'caught',
    scores: { story: 3, deduction: 5, roleplay: 0, balance: 4, production: 0 },
  },
};
const mm3 = {
  id: 'mm3', type: 'murdermystery', date: '2026-06-06', title: '붉은 저택', members: ['m4'], rating: 3,
  createdAt: '2026-06-06T13:00:00.000Z',
  mm: { publisher: '크라임씬', roles: [], culpritResult: null }, // scores 없음
};
const mm4 = {
  id: 'mm4', type: 'murdermystery', date: '2026-09-01', title: '파란 방', members: ['m3'], rating: 4,
  createdAt: '2026-09-01T13:00:00.000Z',
  // mm 블록 자체가 없음 (방어적 처리 확인)
};

// ── 방탈출 ──
const e1 = {
  id: 'e1', type: 'escaperoom', date: '2026-09-26', title: '저주받은 병동', members: ['m1', 'm2'],
  createdAt: '2026-09-26T12:00:00.000Z',
  er: { brand: '키이스케이프', cleared: true, remainingSec: 305, hints: 2, difficulty: 4, fear: 5 },
};
const e2 = {
  id: 'e2', type: 'escaperoom', date: '2026-09-26', title: '타임머신', members: ['m1'],
  createdAt: '2026-09-26T15:00:00.000Z',
  er: { brand: '키이스케이프 ', cleared: false, remainingSec: null, hints: 5, difficulty: 4.5, fear: 1 },
};
const e3 = {
  id: 'e3', type: 'escaperoom', date: '2026-07-15', title: '비밀의 화원', members: ['m1', 'm3'],
  createdAt: '2026-07-15T20:00:00.000Z',
  er: { brand: '넥스트에디션', cleared: true, remainingSec: 60, hints: 0, difficulty: 2, fear: 0 },
};
const e4 = {
  id: 'e4', type: 'escaperoom', date: '2026-07-15', title: '미로', members: ['m2'],
  createdAt: '2026-07-15T10:00:00.000Z',
  er: { brand: '', cleared: true, remainingSec: null, difficulty: 0 }, // hints·fear 없음
};

const junk = [null, 'x', 42, { type: 'poker', date: '2026-09-10', members: ['m1'] }, { date: '2026-09-10' }];
// 서버 응답처럼 섞인 순서
const records = [e2, mm1, b2, junk[0], e1, b1, mm4, junk[3], b3, mm2, e3, e4, b4, mm3, junk[1], b5, b6, junk[4]];
const NOW = new Date(2026, 8, 29, 15, 30); // 2026-09-29 (로컬)

describe('overview', () => {
  const o = overview(records, members, NOW);

  test('총계·이번 달·종류별', () => {
    assert.equal(o.total, 14);
    assert.equal(o.thisMonth, 6);
    assert.deepEqual(o.byType, { boardgame: 6, murdermystery: 4, escaperoom: 4 });
  });

  test('월별: 최근 12개월, 오래된 달 먼저', () => {
    assert.equal(o.monthly.length, 12);
    assert.equal(o.monthly[0].ym, '2025-10');
    assert.equal(o.monthly[11].ym, '2026-09');
    const byYm = Object.fromEntries(o.monthly.map((m) => [m.ym, m]));
    assert.deepEqual(byYm['2026-09'], { ym: '2026-09', count: 6, byType: { boardgame: 2, murdermystery: 2, escaperoom: 2 } });
    assert.deepEqual(byYm['2026-08'].byType, { boardgame: 1, murdermystery: 1, escaperoom: 0 });
    assert.equal(byYm['2026-07'].count, 3);
    assert.equal(byYm['2026-06'].count, 1);
    // 12개월 밖(2025-09, 2025-06)은 제외
    assert.equal(o.monthly.reduce((s, m) => s + m.count, 0), 12);
  });

  test('연도 경계: 1월 기준이면 전년도 2월부터', () => {
    const jan = overview([], [], new Date(2026, 0, 15));
    assert.equal(jan.monthly[0].ym, '2025-02');
    assert.equal(jan.monthly[11].ym, '2026-01');
  });

  test('요일 분포 (0=일요일)', () => {
    assert.deepEqual(o.weekday, [1, 1, 2, 3, 1, 0, 6]);
  });

  test('멤버별 참여 횟수: 많은 순, 0회 멤버·떠난 멤버 포함', () => {
    assert.deepEqual(o.memberCounts, [
      { memberId: 'm1', count: 10 },
      { memberId: 'm2', count: 8 },
      { memberId: 'm3', count: 5 },
      { memberId: 'm4', count: 2 },
      { memberId: 'm5', count: 1 },
      { memberId: 'm6', count: 0 },
    ]);
  });

  test('빈 입력/잘못된 입력에도 안전', () => {
    const e = overview(undefined, null, NOW);
    assert.equal(e.total, 0);
    assert.equal(e.thisMonth, 0);
    assert.deepEqual(e.weekday, [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(e.memberCounts, []);
    const odd = overview([{ type: 'boardgame', date: 'bad' }], [], NOW);
    assert.equal(odd.total, 1);
    assert.deepEqual(odd.weekday, [0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('boardgameStats', () => {
  const s = boardgameStats(records);

  test('플레이 수와 게임별 TOP (제목 공백 차이는 같은 게임)', () => {
    assert.equal(s.plays, 6);
    assert.deepEqual(s.topGames, [
      { title: '카탄', count: 2 },
      { title: '팬데믹', count: 2 },
      { title: '스플렌더', count: 1 },
      { title: '아줄', count: 1 },
    ]);
  });

  test('멤버별 승률: 결과 winner + 협력 승리는 참여자 전원', () => {
    assert.deepEqual(s.memberWinRates, [
      { memberId: 'm4', plays: 1, decided: 1, wins: 1, rate: 1 },
      { memberId: 'm2', plays: 4, decided: 4, wins: 3, rate: 0.75 },
      { memberId: 'm1', plays: 5, decided: 5, wins: 3, rate: 0.6 },
      { memberId: 'm3', plays: 2, decided: 2, wins: 0, rate: 0 },
      { memberId: 'm5', plays: 1, decided: 1, wins: 0, rate: 0 },
    ]);
  });

  test('최다 우승자: 승수 같으면 승률 높은 쪽', () => {
    assert.deepEqual(s.topWinner, { memberId: 'm2', wins: 3 });
  });

  test('기록이 없거나 아무도 못 이기면 topWinner null', () => {
    assert.deepEqual(boardgameStats([]), { plays: 0, topGames: [], memberWinRates: [], topWinner: null });
    assert.equal(boardgameStats([b4]).topWinner, null);
  });

  test('bg 블록이 없어도 members로 참여 집계 (결과가 없으니 승률은 없음)', () => {
    const r = boardgameStats([{ id: 'x', type: 'boardgame', date: '2026-01-01', title: '루미큐브', members: ['m1'] }]);
    assert.deepEqual(r.memberWinRates, [{ memberId: 'm1', plays: 1, decided: 0, wins: 0, rate: null }]);
  });

  test('결과 미기록 판(협력 미기록·승자 표시 없음)은 승률 분모에서 빠짐', () => {
    const won = { id: 'w', type: 'boardgame', date: '2026-01-01', title: 'A', members: ['a', 'b'], bg: { mode: 'competitive', results: [{ memberId: 'a', winner: true }, { memberId: 'b', winner: false }] } };
    const coopUnknown = { id: 'c', type: 'boardgame', date: '2026-01-02', title: 'B', members: ['a', 'b'], bg: { mode: 'coop', coopWin: null } };
    const noWinner = { id: 'n', type: 'boardgame', date: '2026-01-03', title: 'C', members: ['a', 'b'], bg: { mode: 'competitive', results: [{ memberId: 'a', score: null, winner: false }] } };
    const r = boardgameStats([won, coopUnknown, noWinner]);
    const a = r.memberWinRates.find((x) => x.memberId === 'a');
    assert.deepEqual(a, { memberId: 'a', plays: 3, decided: 1, wins: 1, rate: 1 });
    const b = r.memberWinRates.find((x) => x.memberId === 'b');
    assert.deepEqual(b, { memberId: 'b', plays: 3, decided: 1, wins: 0, rate: 0 });
    // 결과가 전혀 없는 멤버는 맨 뒤 (rate null)
    const r2 = boardgameStats([coopUnknown, won]);
    assert.equal(r2.memberWinRates.at(-1).rate, 0);
    const r3 = boardgameStats([{ ...coopUnknown, members: ['z'] }, won]);
    assert.deepEqual(r3.memberWinRates.at(-1), { memberId: 'z', plays: 1, decided: 0, wins: 0, rate: null });
    // 협력 패배는 결과 있는 판
    assert.equal(boardgameStats([{ ...coopUnknown, bg: { mode: 'coop', coopWin: false } }]).memberWinRates[0].decided, 1);
  });
});

describe('보드게임 점수 → 등수 (scoreRanks)', () => {
  const ranks = (entries, opts) => Object.fromEntries(scoreRanks(entries, opts));

  test('높은 점수가 1등, 같은 점수는 같은 등수이고 다음 등수는 건너뜀 (1·2·2·4)', () => {
    assert.deepEqual(ranks([
      { memberId: 'a', score: 61 }, { memberId: 'b', score: 52 }, { memberId: 'c', score: 52 }, { memberId: 'd', score: 40 },
    ]), { a: 1, b: 2, c: 2, d: 4 });
  });

  test('낮은 점수가 이기는 게임', () => {
    assert.deepEqual(ranks([{ memberId: 'a', score: 3 }, { memberId: 'b', score: -2 }, { memberId: 'c', score: 3 }], { lowWins: true }), { b: 1, a: 2, c: 2 });
  });

  test('점수를 적지 않은 사람은 등수 없음 · 소수·문자열 숫자도 비교', () => {
    assert.deepEqual(ranks([
      { memberId: 'a', score: null }, { memberId: 'b', score: '' }, { memberId: 'c', score: '7.5' }, { memberId: 'd', score: 7 }, { score: 99 },
    ]), { c: 1, d: 2 });
    assert.deepEqual(ranks([]), {});
    assert.deepEqual(ranks(null), {});
  });

  test('저장된 결과가 낮은 점수 우선이었는지 (bgLowWins)', () => {
    assert.equal(bgLowWins([{ rank: 1, score: 3 }, { rank: 2, score: 9 }]), true);
    assert.equal(bgLowWins([{ rank: 1, score: 9 }, { rank: 2, score: 3 }]), false);
    assert.equal(bgLowWins([{ rank: 1, score: 5 }, { rank: 1, score: 5 }]), false); // 동점뿐이면 알 수 없음 → 높은 점수
    assert.equal(bgLowWins([{ rank: 1, winner: true }, { rank: 2 }]), false); // 점수 없이 매긴 등수
    assert.equal(bgLowWins(undefined), false);
  });
});

describe('보드게임 랭킹 (bgRanking)', () => {
  test('1등 횟수 → 1등 비율 → 평균 등수 순 · 협력 판과 결과 없는 판은 빠짐', () => {
    // b1: m1 1등(10점) · m2 2등 · m3 3등 / b2: m2 승 / b5: m2 승 · m5(떠난 멤버) / b6: m1 혼자 승 / b3·b4 협력은 제외
    const rows = bgRanking(records);
    assert.deepEqual(rows.map((x) => [x.memberId, x.place, x.games, x.wins]), [
      ['m1', 1, 3, 2], ['m2', 2, 3, 2], ['m3', 3, 1, 0], ['m5', 4, 1, 0],
    ]);
    close(rows[0].rate, 2 / 3);
    assert.equal(rows[0].avgRank, 1); // 등수를 적은 판(b1)만으로 평균
    assert.equal(rows[1].avgRank, 2);
    assert.equal(rows[3].avgRank, null);
  });

  test('keep 으로 떠난 멤버를 빼고 자리를 매김', () => {
    assert.deepEqual(bgRanking(records, { keep: (id) => id !== 'm5' }).map((x) => x.memberId), ['m1', 'm2', 'm3']);
  });

  test('승수·비율·평균 등수가 모두 같으면 같은 자리, 다음 자리는 건너뜀', () => {
    const g = (id, results) => ({ id, type: 'boardgame', date: '2026-01-01', title: 'X', members: results.map((x) => x.memberId), bg: { mode: 'competitive', results } });
    const rows = bgRanking([
      g('1', [{ memberId: 'a', score: 9, rank: 1, winner: true }, { memberId: 'b', score: 9, rank: 1, winner: true }, { memberId: 'c', score: 1, rank: 3, winner: false }]),
    ]);
    assert.deepEqual(rows.map((x) => [x.memberId, x.place]), [['a', 1], ['b', 1], ['c', 3]]);
  });

  test('함께했지만 점수가 없는 사람은 1등을 못 한 판으로 셈 · 기록이 없으면 빈 목록', () => {
    const r = { id: 'z', type: 'boardgame', date: '2026-01-01', title: 'Y', members: ['a', 'b'], bg: { mode: 'competitive', results: [{ memberId: 'a', score: 5, rank: 1, winner: true }] } };
    assert.deepEqual(bgRanking([r]).map((x) => [x.memberId, x.games, x.wins, x.avgRank]), [['a', 1, 1, 1], ['b', 1, 0, null]]);
    assert.deepEqual(bgRanking([]), []);
    assert.deepEqual(bgRanking([b3, b4]), []);
  });
});

describe('mmStats', () => {
  const s = mmStats(records);

  test('플레이·시나리오·평균 별점(미평가 제외)', () => {
    assert.equal(s.plays, 4);
    assert.equal(s.scenarios, 3);
    close(s.avgRating, (4.5 + 3 + 4) / 3, 'avgRating');
  });

  test('범인 검거율', () => {
    assert.deepEqual(s.culprit, { caught: 1, escaped: 1, rate: 0.5 });
  });

  test('제작사별 횟수 (빈 제작사 제외)', () => {
    assert.deepEqual(s.byPublisher, [
      { name: '머더랩', count: 2 },
      { name: '크라임씬', count: 1 },
    ]);
  });

  test('멤버별: 범인 횟수·범인일 때 생존·승률(결과 있는 판만)', () => {
    const base = { culpritDecided: 0, mvpCount: 0, culpritEscapeRate: null };
    assert.deepEqual(s.memberStats, [
      { ...base, memberId: 'm1', plays: 2, culpritCount: 1, culpritDecided: 1, culpritEscaped: 1, culpritEscapeRate: 1, wins: 2, decided: 2, winRate: 1 },
      { ...base, memberId: 'm2', plays: 2, culpritCount: 1, culpritDecided: 1, culpritEscaped: 0, culpritEscapeRate: 0, wins: 0, decided: 2, winRate: 0 },
      { ...base, memberId: 'm3', plays: 2, culpritCount: 0, culpritEscaped: 0, wins: 0, decided: 0, winRate: null },
      { ...base, memberId: 'm4', plays: 1, culpritCount: 0, culpritEscaped: 0, wins: 0, decided: 0, winRate: null },
    ]);
  });

  test('범인 생존률: 검거 결과 미기록 판은 분모에서 빠짐 (검거율과 같은 기준)', () => {
    const mk = (id, culpritResult) => ({ id, type: 'murdermystery', title: id, date: '2026-01-01', mm: { culpritResult, roles: [{ memberId: 'a', culprit: true }] } });
    const r = mmStats([mk('x', 'escaped'), mk('y', null)]);
    const a = r.memberStats[0];
    assert.equal(a.culpritCount, 2);
    assert.equal(a.culpritDecided, 1);
    assert.equal(a.culpritEscaped, 1);
    assert.equal(a.culpritEscapeRate, 1); // 1/1, 1/2 아님
    assert.deepEqual(r.culprit, { caught: 0, escaped: 1, rate: 0 });
    // 결과가 하나도 없으면 null (화면에는 '–')
    assert.equal(mmStats([mk('z', null)]).memberStats[0].culpritEscapeRate, null);
  });

  test('MVP 횟수 집계', () => {
    const r = mmStats([
      { type: 'murdermystery', title: 'a', date: '2026-01-01', mm: { roles: [{ memberId: 'a', mvp: true }, { memberId: 'b' }] } },
      { type: 'murdermystery', title: 'b', date: '2026-01-02', mm: { roles: [{ memberId: 'a', mvp: true }] } },
    ]);
    assert.equal(r.memberStats.find((x) => x.memberId === 'a').mvpCount, 2);
    assert.equal(r.memberStats.find((x) => x.memberId === 'b').mvpCount, 0);
  });

  test('세부 점수 평균 (0=미평가 제외, 없으면 null)', () => {
    assert.deepEqual(s.avgScores, { story: 4, deduction: 4.5, roleplay: 4.5, balance: 4, production: 3 });
  });

  test('빈 입력', () => {
    assert.deepEqual(mmStats([]), {
      plays: 0,
      scenarios: 0,
      avgRating: null,
      culprit: { caught: 0, escaped: 0, rate: null },
      byPublisher: [],
      memberStats: [],
      avgScores: { story: null, deduction: null, roleplay: null, balance: null, production: null },
    });
  });

  test('무승부도 결과 있는 판(decided)에 포함', () => {
    const r = mmStats([{ type: 'murdermystery', title: 'x', date: '2026-01-01', mm: { roles: [{ memberId: 'a', outcome: 'draw' }] } }]);
    assert.deepEqual(r.memberStats[0], {
      memberId: 'a', plays: 1, culpritCount: 0, culpritDecided: 0, culpritEscaped: 0, culpritEscapeRate: null, wins: 0, decided: 1, winRate: 0, mvpCount: 0,
    });
  });
});

describe('erStats', () => {
  const s = erStats(records);

  test('성공률·평균 힌트·평균 남은 시간', () => {
    assert.equal(s.plays, 4);
    assert.equal(s.cleared, 3);
    assert.equal(s.clearRate, 0.75);
    close(s.avgHints, 7 / 3, 'avgHints'); // 힌트 기록 없는 e4 제외
    assert.equal(s.avgRemainingSec, (305 + 60) / 2); // 성공 + 남은 시간 있는 것만
  });

  test('브랜드별 (공백 차이는 같은 브랜드)', () => {
    assert.deepEqual(s.byBrand, [
      { name: '키이스케이프', count: 2 },
      { name: '넥스트에디션', count: 1 },
    ]);
  });

  test('멤버별 성공률', () => {
    assert.equal(s.memberStats.length, 3);
    assert.deepEqual(s.memberStats[0], { memberId: 'm1', plays: 3, cleared: 2, rate: 2 / 3 });
    assert.deepEqual(s.memberStats[1], { memberId: 'm2', plays: 2, cleared: 2, rate: 1 });
    assert.deepEqual(s.memberStats[2], { memberId: 'm3', plays: 1, cleared: 1, rate: 1 });
  });

  test('난이도·공포도 분포 (반올림, 0=미평가 포함)', () => {
    assert.deepEqual(s.difficultyDist, [1, 0, 1, 0, 1, 1]);
    assert.deepEqual(s.fearDist, [2, 1, 0, 0, 0, 1]);
  });

  test('빈 입력', () => {
    const e = erStats([]);
    assert.equal(e.plays, 0);
    assert.equal(e.clearRate, null);
    assert.equal(e.avgHints, null);
    assert.equal(e.avgRemainingSec, null);
    assert.deepEqual(e.difficultyDist, [0, 0, 0, 0, 0, 0]);
  });
});

describe('escapeRoomOrdinals', () => {
  test('날짜 → createdAt 순으로 1부터', () => {
    const m = escapeRoomOrdinals(records);
    assert.ok(m instanceof Map);
    assert.deepEqual([...m.entries()], [
      ['e4', 1],
      ['e3', 2],
      ['e1', 3],
      ['e2', 4],
    ]);
  });

  test('다른 종류는 무시, 빈 입력은 빈 Map', () => {
    assert.equal(escapeRoomOrdinals([b1, mm1]).size, 0);
    assert.equal(escapeRoomOrdinals(null).size, 0);
  });
});

describe('memberProfile', () => {
  test('종류별 참여·보드게임 승·머미 범인·방탈출 성공·최근 5개', () => {
    const p = memberProfile(records, 'm1');
    assert.deepEqual(p.byType, { boardgame: 5, murdermystery: 2, escaperoom: 3 });
    assert.deepEqual(p.bg, { plays: 5, decided: 5, wins: 3 });
    assert.deepEqual(p.mm, { plays: 2, culpritCount: 1, mvpCount: 0 });
    assert.deepEqual(p.er, { plays: 3, cleared: 2 });
    assert.deepEqual(
      p.recent.map((r) => r.id),
      ['e2', 'e1', 'mm1', 'b2', 'b1'],
    );
  });

  test('떠난 멤버(결과에만 남음)와 모르는 멤버', () => {
    const gone = memberProfile(records, 'm5');
    assert.deepEqual(gone.bg, { plays: 1, decided: 1, wins: 0 });
    assert.deepEqual(gone.recent.map((r) => r.id), ['b5']);
    const none = memberProfile(records, 'nobody');
    assert.deepEqual(none.byType, { boardgame: 0, murdermystery: 0, escaperoom: 0 });
    assert.deepEqual(none.recent, []);
  });

  test('입력 배열을 바꾸지 않음', () => {
    const copy = [...records];
    memberProfile(records, 'm1');
    escapeRoomOrdinals(records);
    assert.deepEqual(records, copy);
  });
});

describe('도우미', () => {
  test('participants: members ∪ 결과 ∪ 배역', () => {
    assert.deepEqual([...participants(b5)], ['m2', 'm5']);
    assert.deepEqual([...participants(mm2)], ['m1', 'm2']);
    assert.deepEqual([...participants({ type: 'escaperoom', members: ['a', '', null, 'a'] })], ['a']);
    assert.equal(participants(null).size, 0);
  });

  test('bgWinners', () => {
    assert.deepEqual([...bgWinners(b1)], ['m1']);
    assert.deepEqual([...bgWinners(b3)], ['m1', 'm2', 'm4']);
    assert.equal(bgWinners(b4).size, 0);
  });

  test('표시용 텍스트', () => {
    assert.equal(ratingText(4.5), '4.5');
    assert.equal(ratingText(0), '미평가');
    assert.equal(ratingText(undefined), '미평가');
    assert.equal(percentText(2 / 3), '67%');
    assert.equal(percentText(null), '-');
    assert.equal(durationText(305), '5:05');
    assert.equal(durationText(null), '-');
  });
});

describe('소장', () => {
  const own = (id, type, date, title, block, extra = {}) => ({ id, type, date, title, members: [], createdAt: `${date}T12:00:00.000Z`, ...extra, [type === 'boardgame' ? 'bg' : 'mm']: block });
  const c1 = own('c1', 'boardgame', '2026-09-01', '카탄', { ownership: 'mine' }, { rating: 4, photos: ['p-old'] });
  const c2 = own('c2', 'boardgame', '2026-09-10', '  카탄 ', {}, { rating: 3 }); // 같은 게임, 소장 표시 없는 판
  const c3 = own('c3', 'boardgame', '2026-09-20', '카탄', { ownership: 'mine' }, { photos: ['p-new'] });
  const s1 = own('s1', 'boardgame', '2026-08-01', '스플렌더', { ownership: 'borrowed', lender: '영식' });
  const s2 = own('s2', 'boardgame', '2026-08-05', '스플렌더', { ownership: 'borrowed', lender: ' 영식 ' });
  const s3 = own('s3', 'boardgame', '2026-08-09', '스플렌더', { ownership: 'borrowed', lender: '준호' });
  const w1 = own('w1', 'boardgame', '2026-07-01', '윙스팬', { ownership: 'borrowed' });
  const w2 = own('w2', 'boardgame', '2026-07-09', '윙스팬', { ownership: 'mine' }); // 빌려 하다가 산 게임 → 소장
  const box = own('k1', 'murdermystery', '2026-06-01', '마지막 야간열차', { format: 'box', ownership: 'mine' });
  const store = own('k2', 'murdermystery', '2026-06-02', '붉은 저택', { format: 'store', ownership: 'mine' });
  const sameTitleMm = own('k3', 'murdermystery', '2026-06-03', '카탄', { format: 'box' }); // 제목이 같아도 종류가 다르면 다른 게임

  test('ownershipOf · lenderOf: 보드게임과 보드게임형 머미만', () => {
    assert.equal(ownershipOf(c1), 'mine');
    assert.equal(ownershipOf(c2), null);
    assert.equal(ownershipOf(s1), 'borrowed');
    assert.equal(lenderOf(s2), '영식');
    assert.equal(lenderOf(c1), '');
    assert.equal(ownershipOf(box), 'mine');
    assert.equal(ownershipOf(store), null);
    assert.equal(ownershipOf({ type: 'escaperoom', er: { ownership: 'mine' } }), null);
    assert.equal(ownershipOf({ type: 'boardgame', bg: { ownership: 'stolen' } }), null);
    assert.equal(ownershipOf(null), null);
    assert.equal(titleKey('  Catan  Big '), 'catan big');
  });

  test('collectionOf: 등록 전 예전 기록은 같은 종류·같은 제목을 한 게임으로, 내 소장으로 남긴 판이 있으면 소장', () => {
    const { owned } = collectionOf([c1, c2, c3, s1, s2, s3, w1, w2, box, store, sameTitleMm]);
    assert.deepEqual(owned.map((g) => g.key), ['boardgame:카탄', 'boardgame:윙스팬', 'murdermystery:마지막 야간열차']);
    const catan = owned[0];
    assert.equal(catan.title, '카탄');
    assert.equal(catan.plays, 3);
    assert.equal(catan.lastDate, '2026-09-20');
    assert.equal(catan.firstDate, '2026-09-01');
    assert.equal(catan.latestId, 'c3');
    assert.equal(catan.cover, 'p-new'); // 가장 최근 사진
    assert.equal(catan.gameId, null);
    close(catan.avgRating, 3.5);
    assert.equal(owned[1].plays, 2);
    assert.equal(owned[2].avgRating, null);
    // 대여로만 한 게임은 소장 목록에 없음 (게임별 요약에는 빌려준 사람이 남음)
    const splendor = gameEntries([s1, s2, s3]).find((g) => g.title === '스플렌더');
    assert.deepEqual([splendor.plays, splendor.lenders, splendor.owned], [3, ['준호', '영식'], false]);
  });

  test('collectionOf: 게임 정보 — 내 소장만, 기록은 gameId 로 연결, 예전 기록은 같은 이름이 하나뿐일 때만 묶음', () => {
    const reg = (id, type, title, createdAt, extra = {}) => ({ id, type, title, memo: '', createdAt, updatedAt: createdAt, ...extra });
    const linked = own('L1', 'boardgame', '2026-09-25', '옛 이름', {}, { gameId: 'g4', rating: 5 }); // 이름을 바꾼 게임에 연결된 기록
    const games = [
      reg('g1', 'boardgame', '아그리콜라', '2026-09-01T00:00:00.000Z', { memo: '확장 포함' }),
      reg('g2', 'boardgame', ' 스플렌더  ', '2026-09-02T00:00:00.000Z'), // owned 를 정한 적 없는 예전 소장 게임 → 내 소장
      reg('g4', 'boardgame', '카탄 (2판)', '2026-09-04T00:00:00.000Z', { owned: true, cover: 'cov-4' }),
      reg('g5', 'murdermystery', '카탄', '2026-09-05T00:00:00.000Z'), // 머미 '카탄'은 k3 와 묶임 (이름이 하나뿐)
      reg('g6', 'murdermystery', '열차 밖의 밤', '2026-09-06T00:00:00.000Z', { owned: false }), // 소장 해제
      reg('g7', 'escaperoom', '연구소', '2026-09-07T00:00:00.000Z', { owned: true }), // 방탈출은 소장 목록에 없음
      reg('g8', 'boardgame', '윙스팬', '2026-09-08T00:00:00.000Z', { owned: false }), // 예전 기록 '내 소장'이어도 게임 정보가 우선
      { id: 'g9', type: 'boardgame', title: '   ' }, null, 3,
    ];
    const { owned } = collectionOf([c1, c2, c3, s1, s2, s3, w1, w2, box, sameTitleMm, linked], games);
    assert.deepEqual(owned.map((g) => [g.key, g.plays, g.gameId]), [
      ['g:g4', 1, 'g4'], ['boardgame:카탄', 3, null], ['g:g2', 3, 'g2'], ['g:g5', 1, 'g5'],
      ['murdermystery:마지막 야간열차', 1, null], ['g:g1', 0, 'g1'],
    ]);
    const [catan2, , splendor] = owned;
    assert.deepEqual([catan2.title, catan2.cover, catan2.avgRating, catan2.latestId], ['카탄 (2판)', 'cov-4', 5, 'L1']);
    assert.equal(splendor.title, '스플렌더'); // 등록한 이름(공백 정리)
    assert.equal(splendor.lastDate, '2026-08-09');
    assert.equal(splendor.addedAt, '2026-09-02T00:00:00.000Z');
    const agricola = owned.at(-1);
    assert.deepEqual([agricola.plays, agricola.lastDate, agricola.cover, agricola.memo, agricola.avgRating], [0, '', null, '확장 포함', null]);
    // 같은 이름의 게임이 둘이면 예전 기록을 어느 쪽에도 붙이지 않음
    const twins = [reg('t1', 'boardgame', '카탄', '2026-09-01T00:00:00.000Z'), reg('t2', 'boardgame', '  카탄 ', '2026-09-02T00:00:00.000Z')];
    const ids = resolveGameIds([c1, { ...c2, gameId: 't2' }], twins);
    assert.deepEqual([ids.get('c1'), ids.get('c2')], [null, 't2']);
    const one = resolveGameIds([c1, { ...c3, gameId: 'gone' }], [twins[0]]);
    assert.deepEqual([one.get('c1'), one.get('c3')], ['t1', 't1']);
  });

  test('collectionOf: 빈 입력·이상한 값에도 죽지 않음', () => {
    assert.deepEqual(collectionOf(null), { owned: [] });
    assert.deepEqual(collectionOf([null, 3, { type: 'boardgame', title: '', bg: { ownership: 'mine' } }]), { owned: [] });
    assert.deepEqual(collectionOf(null, 'x'), { owned: [] });
    assert.deepEqual(collectionOf([], [{ type: 'boardgame', title: '카탄' }]).owned, []);
    assert.equal(isOwnedGame({ type: 'boardgame' }), true);
    assert.equal(isOwnedGame({ type: 'escaperoom', owned: true }), false);
    assert.equal(isOwnedGame(null), false);
  });
});

describe('사진 저장 공간', () => {
  const MB = 1024 * 1024;
  const lim = { limitCount: 3000, limitBytes: 150 * MB };

  test('storageUsage: 장수·용량 중 더 찬 쪽 · 대략 남은 장수', () => {
    const u = storageUsage({ count: 100, bytes: 20 * MB, ...lim });
    close(u.ratio, 20 / 150);
    assert.deepEqual([u.warn, u.full, u.left], [false, false, 650]); // 평균 0.2MB → 남은 130MB 에 650장
    close(storageUsage({ count: 2700, bytes: 10 * MB, ...lim }).ratio, 0.9); // 장수가 더 찬 쪽
  });

  test('80% 부터 알림, 한도에 닿거나 한 장도 더 못 넣으면 가득 참', () => {
    const warn = storageUsage({ count: 600, bytes: 121 * MB, ...lim });
    assert.deepEqual([warn.warn, warn.full, warn.left], [true, false, 143]);
    assert.equal(storageUsage({ count: 600, bytes: 120 * MB - 1, ...lim }).warn, false);
    assert.equal(storageUsage({ count: 600, bytes: 150 * MB, ...lim }).full, true);
    assert.equal(storageUsage({ count: 3000, bytes: 1 * MB, ...lim }).full, true);
    const almost = storageUsage({ count: 600, bytes: 150 * MB - 100 * 1024, ...lim }); // 평균 한 장(0.25MB)도 안 남음
    assert.deepEqual([almost.full, almost.left], [true, 0]);
  });

  test('응답이 없거나 이상해도 막지 않음', () => {
    assert.deepEqual(storageUsage(null), { ratio: 0, warn: false, full: false, left: null });
    assert.deepEqual(storageUsage({ count: 0, bytes: 0, ...lim }), { ratio: 0, warn: false, full: false, left: 3000 });
    assert.equal(storageUsage({ count: 'x', bytes: -5, limitBytes: 0, limitCount: 0 }).full, false);
  });
});

describe('멤버가 맡았던 역할', () => {
  const rec = (id, date, mm, extra = {}) => ({ id, type: 'murdermystery', date, title: `작품 ${id}`, rating: 4, createdAt: `${date}T00:00:00.000Z`, members: [], mm, ...extra });
  const records = [
    rec('a', '2026-01-01', { roles: [{ memberId: 'm1', character: '세바스찬' }, { memberId: 'm2', character: '집사' }] }),
    rec('b', '2026-03-01', { roles: [{ memberId: 'm1', character: '웬디' }] }, { spoiler: true }),
    rec('c', '2026-02-01', { roles: [{ memberId: 'm1', character: '탐정' }], roleSpoiler: true }),
    rec('d', '2026-04-01', { myRole: '해리엇 부인' }), // 배역 없이 내 역할만
    rec('e', '2026-05-01', { roles: [{ memberId: 'm1', character: '  ' }] }), // 역할 이름 없음
    { id: 'f', type: 'boardgame', date: '2026-06-01', title: '카탄', bg: {} },
  ];

  test('역할 이름이 적힌 기록만 최근 순으로, 스포일러·역할 가리기는 hidden', () => {
    const list = memberRoles(records, 'm1');
    assert.deepEqual(list.map((x) => [x.record.id, x.character, x.hidden]), [['b', '웬디', true], ['c', '탐정', true], ['a', '세바스찬', false]]);
    assert.deepEqual(memberRoles(records, 'm2').map((x) => x.character), ['집사']);
    assert.deepEqual(memberRoles(records, 'nobody'), []);
  });

  test('includeMyRole: 이 기기의 나만 배역 없는 내 역할(mm.myRole)도 봄', () => {
    assert.equal(memberRoles(records, 'm1').some((x) => x.record.id === 'd'), false);
    const mine = memberRoles(records, 'm1', { includeMyRole: true });
    assert.deepEqual(mine.map((x) => x.record.id), ['d', 'b', 'c', 'a']);
    assert.equal(mine[0].character, '해리엇 부인');
    // 내 배역 항목이 이미 있으면 그 이름이 우선 (배역은 있는데 이름이 비어 있는 e 는 myRole 로 채우지 않음)
    assert.equal(mine.some((x) => x.record.id === 'e'), false);
  });

  test('잘못된 입력은 비어 있음', () => {
    assert.deepEqual(memberRoles(null, 'm1'), []);
    assert.deepEqual(memberRoles([null, {}, { type: 'murdermystery' }], 'm1'), []);
  });
});
