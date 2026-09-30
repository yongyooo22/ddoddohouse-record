// 예시 기록 — 처음 써 볼 때 화면을 둘러보는 용도. 모두 sample: true 로 표시되고, 설정에서 한 번에 지울 수 있다.
// 매장·작품 이름은 지어낸 것 (실제 매장·작품과 관계없음). 보드게임은 널리 알려진 게임 이름을 썼다.
import { normalizeWork, normalizePlay } from './model.js';

// 사진이 붙는 예시 (views/sample-art.js 가 그림을 그려 넣음)
export const SAMPLE_ART = {
  gems: 'w_sample_splendor',   // 작품 표지
  clock: 'p_sample_clock_gn',  // 그날 사진
};

const WORKS = [
  { id: 'w_sample_splendor', genre: 'boardgame', title: '스플렌더' },
  { id: 'w_sample_terraforming', genre: 'boardgame', title: '테라포밍 마스' },
  { id: 'w_sample_redmansion', genre: 'murdermystery', title: '붉은 저택의 초대' },
  { id: 'w_sample_clock_gn', genre: 'escaperoom', title: '시계탑의 비밀', store: '달빛방탈출', branch: '강남점' },
  { id: 'w_sample_clock_hd', genre: 'escaperoom', title: '시계탑의 비밀', store: '열쇠공방', branch: '홍대점' },
];

const PLAYS = [
  {
    id: 'p_sample_clock_gn', workId: 'w_sample_clock_gn', date: '2026-09-20', rating: 4.5,
    oneLiner: '마지막 방 연출에서 다 같이 소리 질렀다',
    review: '입구부터 인테리어가 탄탄하고, 문제 흐름이 자연스러워서 막히는 구간이 거의 없었다. 두 번째 방에서 힌트를 한 번 썼지만 전체적으로 난이도가 딱 좋았다.',
    companions: ['민지', '준호'],
    details: { result: 'success', remainingSec: 760, hints: 1, difficulty: 4, fear: 1 },
    spoiler: { puzzles: '시계탑 바늘을 3시 15분에 맞추면 첫 금고(0315)가 열린다. 마지막 방은 종 치는 순서(도-미-솔-도)가 열쇠.' },
  },
  {
    id: 'p_sample_splendor_2', workId: 'w_sample_splendor', date: '2026-09-13', rating: 4,
    oneLiner: '귀족 타일 싸움이 치열했던 판',
    companions: ['민지', '서연', '준호'],
    details: { players: 4, myScore: 15, myRank: 2, durationMin: 40 },
  },
  {
    id: 'p_sample_redmansion', workId: 'w_sample_redmansion', date: '2026-09-06', rating: 5,
    oneLiner: '인물마다 사연이 촘촘해서 끝나고도 한참 이야기했다',
    review: 'GM 진행이 매끄러웠고 캐릭터 몰입이 잘 됐다. 초반 탐색 시간이 넉넉해서 단서를 놓치지 않았다.',
    companions: ['서연', '하준', '지우', '민지', '준호'],
    details: { format: 'store', durationMin: 240, story: 4.5, immersion: 5, impression: '저택의 분위기와 인물 관계도가 자연스럽게 이어져서 롤플레이가 쉬웠다.' },
    spoiler: { role: '집사 로웰', culprit: '막내딸 에이미', ending: '유언장 위조가 드러나면서 에이미가 범인으로 지목됐다. 집사는 공범이 아니었다.', memo: '2라운드 서재 단서(찢어진 편지)가 결정적.' },
  },
  {
    id: 'p_sample_splendor_1', workId: 'w_sample_splendor', date: '2026-08-02', rating: 3.5,
    oneLiner: '처음 해 봤는데 규칙이 간단해서 금방 익혔다',
    companions: ['민지'],
    details: { players: 2, myScore: 12, myRank: 2, durationMin: 30 },
  },
  {
    id: 'p_sample_terraforming', workId: 'w_sample_terraforming', date: '2026-07-19', rating: null,
    oneLiner: '',
    companions: ['준호', '서연'],
    details: { players: 3, expansions: '프렐류드', myScore: 86, myRank: 1, durationMin: 150 },
  },
  {
    id: 'p_sample_clock_hd', workId: 'w_sample_clock_hd', date: '2025-12-14', rating: 3,
    oneLiner: '이름은 같은데 강남점과 전혀 다른 테마였다',
    companions: ['준호'],
    details: { result: 'fail', hints: 3, difficulty: 5, fear: 3 },
    spoiler: { puzzles: '마지막 자물쇠는 벽 달력의 동그라미 친 날짜 네 개.' },
  },
];

/** 예시 작품·기록 (검증을 거친 값, 모두 sample: true). covers: {workId|playId → 사진 id} */
export function buildSamples({ now = new Date().toISOString(), art = {} } = {}) {
  const works = WORKS.map((w) => {
    const r = normalizeWork({ ...w, cover: art[w.id] || null, sample: true, createdAt: now, updatedAt: now });
    if (!r.ok) throw new Error(`sample work ${w.id}`);
    return r.value;
  });
  const genre = new Map(works.map((w) => [w.id, w.genre]));
  const plays = PLAYS.map((p, i) => {
    // 같은 날짜 안에서도 순서가 흔들리지 않게 만든 시각을 조금씩 다르게
    const t = new Date(Date.parse(now) - i * 1000).toISOString();
    const photos = art[p.id] ? [art[p.id]] : [];
    const r = normalizePlay({ ...p, photos, sample: true, createdAt: t, updatedAt: t }, genre.get(p.workId));
    if (!r.ok) throw new Error(`sample play ${p.id}: ${JSON.stringify(r.errors)}`);
    return r.value;
  });
  return { works, plays };
}
