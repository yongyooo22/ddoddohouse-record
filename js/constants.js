// 또또하우스 기록장 — 공용 상수 (종류, 라벨, 태그 칩, 팔레트)

export const APP_NAME = '또또하우스 기록장';
export const APP_VERSION = '1.0.0';

export const TYPE_KEYS = ['boardgame', 'murdermystery', 'escaperoom'];

export const TYPES = {
  boardgame: {
    key: 'boardgame', label: '보드게임', short: '보드게임', icon: 'dice', cls: 't-boardgame',
    titleLabel: '게임 이름', titlePlaceholder: '예) 테라포밍 마스',
    desc: '승패, 점수, 순위를 남겨요',
  },
  murdermystery: {
    key: 'murdermystery', label: '머더미스터리', short: '머미', icon: 'magnifier', cls: 't-murdermystery',
    titleLabel: '시나리오 이름', titlePlaceholder: '예) 붉은 저택의 초대',
    desc: '역할, 범인, 평점을 남겨요',
  },
  escaperoom: {
    key: 'escaperoom', label: '방탈출', short: '방탈출', icon: 'door', cls: 't-escaperoom',
    titleLabel: '테마 이름', titlePlaceholder: '예) 잊혀진 연구소',
    desc: '성공 여부, 남은 시간, 힌트를 남겨요',
  },
};

export const typeOf = (key) => TYPES[key] || null;

// 종류별 추천 태그 (저장은 # 없이)
export const TAG_SUGGESTIONS = {
  boardgame: ['전략', '파티', '협력', '추리', '가족', '경매', '덱빌딩', '일꾼놓기', '타일', '카드', '2인추천', '입문추천'],
  murdermystery: ['추리중심', 'RP중심', '감성', '반전', '호러', '코믹', '피폐', '잔혹', '성인', '입문추천', '고인물용', '밸런스좋음'],
  escaperoom: ['스토리맛집', '인테리어맛집', '장치많음', '자물쇠많음', '공포', '감성', '코믹', '활동성높음', '문제퀄리티', '입문추천', '헬난이도'],
};

export const LIMITS = {
  title: 80, oneLiner: 100, review: 5000, tag: 15, tags: 10, members: 20,
  place: 40, expansion: 60, publisher: 40, store: 40, gm: 20, character: 30,
  brand: 40, branch: 40, genre: 20, memberName: 20,
};

export const BG_MODES = [
  { key: 'competitive', label: '경쟁' },
  { key: 'coop', label: '협력' },
  { key: 'team', label: '팀전' },
];

export const MM_FORMATS = [
  { key: 'store', label: '매장형' },
  { key: 'box', label: '보드게임형' },
  { key: 'online', label: '온라인' },
];

export const MM_OUTCOMES = [
  { key: 'win', label: '승' },
  { key: 'lose', label: '패' },
  { key: 'draw', label: '무' },
];

export const MM_SCORES = [
  { key: 'story', label: '스토리' },
  { key: 'deduction', label: '추리' },
  { key: 'roleplay', label: '롤플레이' },
  { key: 'balance', label: '밸런스' },
  { key: 'production', label: '연출·구성물' },
];

export const ER_SCORES = [
  { key: 'story', label: '스토리' },
  { key: 'interior', label: '인테리어' },
  { key: 'puzzle', label: '문제' },
  { key: 'device', label: '장치·연출' },
];

export const CULPRIT_RESULTS = [
  { key: 'caught', label: '검거 성공' },
  { key: 'escaped', label: '범인 도주' },
];

// 멤버 팔레트 (실제 색은 CSS 변수 --m-c1 … --m-c10, 라이트/다크 각각 정의)
export const PALETTE = [
  { key: 'c1', label: '장미' },
  { key: 'c2', label: '귤' },
  { key: 'c3', label: '겨자' },
  { key: 'c4', label: '풀잎' },
  { key: 'c5', label: '청록' },
  { key: 'c6', label: '하늘' },
  { key: 'c7', label: '남색' },
  { key: 'c8', label: '보라' },
  { key: 'c9', label: '분홍' },
  { key: 'c10', label: '모카' },
];
export const PALETTE_KEYS = PALETTE.map((p) => p.key);

export const EMOJI_SUGGESTIONS = ['🐻', '🐰', '🦊', '🐱', '🐶', '🐼', '🐯', '🐧', '🦉', '🐸', '🍀', '🌙', '⭐', '🔥', '🍓', '🎩'];

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// 서버 검증 오류 필드명 → 사람이 읽는 이름
export const FIELD_LABELS = {
  date: '날짜', title: '제목', members: '함께한 멤버', rating: '별점', oneLiner: '한줄평', review: '후기',
  tags: '태그', type: '종류', place: '장소', playTimeMin: '플레이 시간', mode: '방식', results: '결과',
  expansion: '확장판', publisher: '제작사', format: '형태', store: '매장', gm: 'GM', playerCount: '인원',
  roles: '역할', character: '캐릭터', culpritResult: '범인 검거 결과', scores: '세부 점수', difficulty: '난이도',
  brand: '브랜드', branch: '지점', genre: '장르', timeLimitMin: '제한 시간', remainingSec: '남은 시간',
  hints: '힌트', fear: '공포도', activity: '활동성', name: '이름', emoji: '이모지', color: '색',
};

export const STORAGE = {
  key: 'ddh:key',
  cache: 'ddh:cache',
  draft: 'ddh:draft',
  theme: 'ddh:theme',
};
