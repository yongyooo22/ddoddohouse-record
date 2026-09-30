// 데이터 모델 — 작품/플레이 검증, 장르별 항목만 남기기, 스포일러 분리
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWork, normalizePlay, hasExtra, hasSpoiler, hasDetails, placeLabel, workLabel, titleKey,
  isValidDate, cleanLine, cleanText, newId, DETAIL_KEYS, SPOILER_KEYS,
} from '../js/model.js';
import { buildSamples } from '../js/samples.js';

const NOW = '2026-09-30T01:02:03.000Z';

test('작품: 장르·제목 필수, 방탈출만 매장·지점', () => {
  const bad = normalizeWork({ title: '' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.genre && bad.errors.title);
  const bg = normalizeWork({ genre: 'boardgame', title: '  스플렌더 ', store: '어딘가', branch: '강남' }, { now: NOW });
  assert.equal(bg.ok, true);
  assert.equal(bg.value.title, '스플렌더');
  assert.equal(bg.value.store, '', '보드게임은 매장 정보를 버림');
  assert.equal(bg.value.createdAt, NOW);
  assert.match(bg.value.id, /^w_[0-9a-f]{24}$/);
  const er = normalizeWork({ genre: 'escaperoom', title: '시계탑의 비밀', store: '달빛방탈출', branch: '강남점' });
  assert.equal(er.value.store, '달빛방탈출');
  assert.equal(placeLabel(er.value), '달빛방탈출 강남점');
  assert.equal(workLabel(er.value), '시계탑의 비밀 · 달빛방탈출 강남점');
  assert.equal(workLabel(bg.value), '스플렌더');
});

test('작품: 길이 한도·제어문자 정리', () => {
  const long = normalizeWork({ genre: 'boardgame', title: '가'.repeat(81) });
  assert.equal(long.ok, false);
  assert.match(long.errors.title, /80자/);
  const w = normalizeWork({ genre: 'boardgame', title: `a\u0000b\u202Ec\nd` });
  assert.equal(w.value.title, 'a bc d');
});

test('플레이: 날짜 필수·형식, 평점은 0.5 단위·미평가 허용', () => {
  const base = { workId: 'w_1', date: '2026-09-30' };
  assert.equal(normalizePlay({ workId: 'w_1' }, 'boardgame').errors.date, '플레이 날짜를 골라 주세요');
  assert.ok(normalizePlay({ ...base, date: '2026-02-30' }, 'boardgame').errors.date);
  assert.equal(normalizePlay({ ...base, rating: null }, 'boardgame').value.rating, null);
  assert.equal(normalizePlay({ ...base, rating: 0 }, 'boardgame').value.rating, null, '0 은 미평가');
  assert.equal(normalizePlay({ ...base, rating: '4.5' }, 'boardgame').value.rating, 4.5);
  assert.ok(normalizePlay({ ...base, rating: 4.3 }, 'boardgame').errors.rating);
  assert.ok(normalizePlay({ ...base, rating: 5.5 }, 'boardgame').errors.rating);
  assert.ok(normalizePlay({ date: '2026-09-30' }, 'boardgame').errors.workId);
});

test('플레이: 고른 장르의 항목만 남김', () => {
  const input = {
    workId: 'w_1', date: '2026-09-30',
    details: { players: '4', expansions: '프렐류드', myScore: '86', myRank: 1, durationMin: '90', result: 'success', hints: 2, story: 4 },
    spoiler: { role: '집사', culprit: '에이미', puzzles: '0315', memo: '비밀' },
  };
  const bg = normalizePlay(input, 'boardgame').value;
  assert.deepEqual(Object.keys(bg.details).sort(), [...DETAIL_KEYS.boardgame].sort());
  assert.equal(bg.details.players, 4);
  assert.equal(bg.details.myScore, 86);
  assert.deepEqual(bg.spoiler, { memo: '비밀' }, '보드게임은 스포일러 메모만');
  const er = normalizePlay(input, 'escaperoom').value;
  assert.deepEqual(Object.keys(er.details).sort(), [...DETAIL_KEYS.escaperoom].sort());
  assert.equal(er.details.result, 'success');
  assert.equal(er.details.players, undefined);
  assert.deepEqual(Object.keys(er.spoiler).sort(), [...SPOILER_KEYS.escaperoom].sort());
  assert.equal(er.spoiler.puzzles, '0315');
  const mm = normalizePlay(input, 'murdermystery').value;
  assert.equal(mm.spoiler.role, '집사');
  assert.equal(mm.spoiler.culprit, '에이미');
  assert.equal(mm.details.story, 4);
  assert.equal(mm.details.result, undefined);
});

test('플레이: 장르별 값 검사', () => {
  const p = (details, genre) => normalizePlay({ workId: 'w_1', date: '2026-09-30', details }, genre);
  assert.ok(p({ myRank: 5, players: 3 }, 'boardgame').errors['details.myRank'], '순위 > 인원');
  assert.ok(p({ players: 0 }, 'boardgame').errors['details.players']);
  assert.ok(p({ format: 'cafe' }, 'murdermystery').errors['details.format']);
  assert.ok(p({ difficulty: 6 }, 'escaperoom').errors['details.difficulty']);
  assert.equal(p({ fear: 0 }, 'escaperoom').value.details.fear, 0, '공포도 0 = 없음');
  assert.equal(p({ result: 'fail', remainingSec: 300 }, 'escaperoom').value.details.remainingSec, null, '실패면 남은 시간 버림');
  assert.equal(p({ result: 'success', remainingSec: '760' }, 'escaperoom').value.details.remainingSec, 760);
});

test('플레이: 함께한 사람 중복 제거·한도, 사진 id 형식', () => {
  const r = normalizePlay({ workId: 'w_1', date: '2026-09-30', companions: [' 민지 ', '민지', 'MJ', 'mj', ''], photos: ['i_1', 'i_1', 'bad id!', 42] }, 'boardgame');
  assert.deepEqual(r.value.companions, ['민지', 'MJ']);
  assert.deepEqual(r.value.photos, ['i_1']);
  const many = normalizePlay({ workId: 'w_1', date: '2026-09-30', photos: Array.from({ length: 9 }, (_, i) => `i_${i}`) }, 'boardgame');
  assert.ok(many.errors.photos);
});

test('추가 기록·스포일러 여부', () => {
  const plain = normalizePlay({ workId: 'w_1', date: '2026-09-30', oneLiner: '좋았다' }, 'escaperoom').value;
  assert.equal(hasExtra(plain, 'escaperoom'), false, '한 줄 감상은 기본 항목');
  assert.equal(hasSpoiler(plain, 'escaperoom'), false);
  const withSp = normalizePlay({ workId: 'w_1', date: '2026-09-30', spoiler: { puzzles: '0315' } }, 'escaperoom').value;
  assert.equal(hasSpoiler(withSp, 'escaperoom'), true);
  assert.equal(hasExtra(withSp, 'escaperoom'), true);
  const withD = normalizePlay({ workId: 'w_1', date: '2026-09-30', details: { hints: 0 } }, 'escaperoom').value;
  assert.equal(hasDetails(withD, 'escaperoom'), true, '힌트 0개도 적은 것');
});

test('도우미', () => {
  assert.equal(titleKey(' 테라포밍  마스 '), titleKey('테라포밍마스'));
  assert.equal(titleKey('Catan'), titleKey('catan'));
  assert.equal(isValidDate('2024-02-29'), true);
  assert.equal(isValidDate('2023-02-29'), false);
  assert.equal(isValidDate('1969-12-31'), false);
  assert.equal(cleanLine(' a \n b '), 'a b');
  assert.equal(cleanText(' a \r\n b '), 'a \n b');
  assert.notEqual(newId('p'), newId('p'));
});

test('예시 기록은 모두 검증을 통과하고 sample 표시', () => {
  const { works, plays } = buildSamples({ now: NOW, art: { w_sample_splendor: 'i_x_1' } });
  assert.ok(works.length >= 4 && plays.length >= 6);
  assert.ok(works.every((w) => w.sample === true));
  assert.ok(plays.every((p) => p.sample === true));
  assert.equal(works.find((w) => w.id === 'w_sample_splendor').cover, 'i_x_1');
  const ids = new Set(works.map((w) => w.id));
  assert.ok(plays.every((p) => ids.has(p.workId)));
  // 이름이 같은 방탈출 테마가 매장별로 따로 있음 (자동으로 합치지 않는 예)
  const clocks = works.filter((w) => w.title === '시계탑의 비밀');
  assert.equal(clocks.length, 2);
  assert.notEqual(placeLabel(clocks[0]), placeLabel(clocks[1]));
});
