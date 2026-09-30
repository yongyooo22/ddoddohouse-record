// 검색·필터·정렬·작품별 묶기
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterEntries, groupByWork, yearsOf, playOrdinals, workStats, sameTitleWorks, suggestWorks,
  fuzzyIncludes, initialOf, matchesQuery, ratingMatches, avgRating, companionNames, cmpPlayDesc,
} from '../js/query.js';
import { buildSamples } from '../js/samples.js';

const { works, plays } = buildSamples({ now: '2026-09-30T00:00:00.000Z' });
const workMap = new Map(works.map((w) => [w.id, w]));

test('최근 플레이 날짜순 (같은 날이면 나중에 쓴 것 먼저)', () => {
  const dates = filterEntries(plays, workMap).map((e) => e.play.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  const a = { id: 'a', date: '2026-01-01', createdAt: '2026-01-01T01:00:00.000Z' };
  const b = { id: 'b', date: '2026-01-01', createdAt: '2026-01-01T02:00:00.000Z' };
  assert.deepEqual([a, b].sort(cmpPlayDesc).map((x) => x.id), ['b', 'a']);
});

test('분류·연도·평점 필터', () => {
  assert.ok(filterEntries(plays, workMap, { genre: 'escaperoom' }).every((e) => e.work.genre === 'escaperoom'));
  assert.ok(filterEntries(plays, workMap, { year: '2025' }).every((e) => e.play.date.startsWith('2025')));
  assert.ok(filterEntries(plays, workMap, { rating: '4.5' }).every((e) => e.play.rating >= 4.5));
  assert.ok(filterEntries(plays, workMap, { rating: 'none' }).every((e) => e.play.rating === null));
  assert.equal(ratingMatches(2.5, 'low'), true);
  assert.equal(ratingMatches(null, 'low'), false);
  assert.equal(ratingMatches(null, ''), true);
  assert.deepEqual(yearsOf(plays), ['2026', '2025']);
});

test('제목 검색: 띄어쓰기·대소문자 무시, 초성, 매장·지점', () => {
  assert.equal(initialOf('스'), 'ㅅ');
  assert.equal(initialOf('a'), null);
  assert.equal(fuzzyIncludes('스플렌더', 'ㅅㅍㄹㄷ'), true);
  assert.equal(fuzzyIncludes('스플렌더', '스ㅍ'), true);
  assert.equal(fuzzyIncludes('스플렌더', 'ㅍㅅ'), false);
  const tm = works.find((w) => w.title === '테라포밍 마스');
  assert.equal(matchesQuery(tm, '테라포밍마스'), true);
  assert.equal(matchesQuery(tm, 'ㅌㄹㅍㅁ'), true);
  const hd = filterEntries(plays, workMap, { q: '홍대' });
  assert.equal(hd.length, 1);
  assert.equal(hd[0].work.branch, '홍대점');
});

test('검색은 스포일러·후기 내용을 보지 않음', () => {
  // 예시의 방탈출 스포일러 '0315', 머더미스터리 범인 '에이미'
  assert.equal(filterEntries(plays, workMap, { q: '0315' }).length, 0);
  assert.equal(filterEntries(plays, workMap, { q: '에이미' }).length, 0);
  assert.equal(filterEntries(plays, workMap, { q: '인테리어' }).length, 0, '후기 내용도 검색하지 않음');
});

test('작품별 묶기: 이름이 같아도 작품이 다르면 따로', () => {
  const groups = groupByWork(filterEntries(plays, workMap));
  const clocks = groups.filter((g) => g.work.title === '시계탑의 비밀');
  assert.equal(clocks.length, 2);
  const splendor = groups.find((g) => g.work.id === 'w_sample_splendor');
  assert.equal(splendor.count, 2);
  assert.equal(splendor.latest.date, '2026-09-13');
  assert.equal(splendor.avg, 3.8);
  const latest = groups.map((g) => g.latest.date);
  assert.deepEqual(latest, [...latest].sort().reverse());
});

test('회차·작품 요약', () => {
  const ord = playOrdinals(plays);
  assert.equal(ord.get('p_sample_splendor_1'), 1);
  assert.equal(ord.get('p_sample_splendor_2'), 2);
  const s = workStats(plays).get('w_sample_splendor');
  assert.equal(s.count, 2);
  assert.equal(s.latest.id, 'p_sample_splendor_2');
  assert.equal(avgRating([{ rating: null }, { rating: 4 }, { rating: 3 }]), 3.5);
  assert.equal(avgRating([{ rating: null }]), null);
});

test('같은 이름 작품 후보 (자동으로 합치지 않고 물어볼 때)', () => {
  const c = sameTitleWorks(works, 'escaperoom', ' 시계탑의비밀 ');
  assert.equal(c.length, 2);
  assert.equal(sameTitleWorks(works, 'boardgame', '시계탑의 비밀').length, 0, '장르가 다르면 후보 아님');
  assert.equal(sameTitleWorks(works, 'escaperoom', '시계탑의 비밀', { excludeId: c[0].id }).length, 1);
  assert.equal(sameTitleWorks(works, 'escaperoom', '').length, 0);
});

test('제목 제안: 앞부분이 맞는 것 먼저', () => {
  const stats = workStats(plays);
  const s = suggestWorks(works, stats, { q: '스' });
  assert.equal(s[0].title, '스플렌더');
  assert.ok(suggestWorks(works, stats, { genre: 'escaperoom', q: '시계' }).every((w) => w.genre === 'escaperoom'));
  assert.deepEqual(suggestWorks(works, stats, { q: '' }), []);
});

test('함께한 사람 이름 제안: 많이 함께한 순, 대소문자 합침', () => {
  const names = companionNames([{ companions: ['민지', '준호'] }, { companions: ['민지'] }, { companions: ['MJ'] }, { companions: ['mj'] }]);
  assert.equal(names[0], '민지');
  assert.equal(names.filter((n) => n.toLowerCase() === 'mj').length, 1);
});
