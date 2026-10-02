// js/stats.js 테스트 — 실제 모임 기록과 비슷한 픽스처로 모든 통계 함수 검증
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  overview,
  boardgameStats,
  mmStats,
  erStats,
  escapeRoomOrdinals,
  memberProfile,
  participants,
  bgWinners,
  ratingText,
  percentText,
  durationText,
  ownershipOf,
  lenderOf,
  titleKey,
  collectionOf,
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

  test('collectionOf: 같은 종류·같은 제목을 한 게임으로, 횟수는 모든 판', () => {
    const { owned, borrowed } = collectionOf([c1, c2, c3, s1, s2, s3, w1, w2, box, store, sameTitleMm]);
    assert.deepEqual(owned.map((g) => g.key), ['boardgame:카탄', 'boardgame:윙스팬', 'murdermystery:마지막 야간열차']);
    const catan = owned[0];
    assert.equal(catan.title, '카탄');
    assert.equal(catan.plays, 3);
    assert.equal(catan.lastDate, '2026-09-20');
    assert.equal(catan.firstDate, '2026-09-01');
    assert.equal(catan.latestId, 'c3');
    assert.equal(catan.cover, 'p-new'); // 가장 최근 사진
    close(catan.avgRating, 3.5);
    assert.equal(owned[1].plays, 2);
    assert.equal(owned[2].avgRating, null);
    // 대여한 게임: 소장한 적 없는 것만, 빌려준 사람은 이름이 같으면 한 번
    assert.deepEqual(borrowed.map((g) => [g.title, g.plays, g.lenders]), [['스플렌더', 3, ['준호', '영식']]]);
  });

  test('collectionOf: 빈 입력·이상한 값에도 죽지 않음', () => {
    assert.deepEqual(collectionOf(null), { owned: [], borrowed: [] });
    assert.deepEqual(collectionOf([null, 3, { type: 'boardgame', title: '', bg: { ownership: 'mine' } }]), { owned: [], borrowed: [] });
  });
});
