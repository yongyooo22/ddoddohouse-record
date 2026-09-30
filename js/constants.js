// 공용 상수 — 장르, 라벨, 입력 한도, 저장소 이름 (DOM 없이 node 에서도 import 가능)

export const DEFAULT_BOOK_NAME = '또또하우스 기록장';
export const APP_VERSION = '2.0.0';

export const GENRE_KEYS = ['boardgame', 'murdermystery', 'escaperoom'];

export const GENRES = {
  boardgame: {
    key: 'boardgame', label: '보드게임', icon: 'dice', cls: 'g-bg',
    titleLabel: '게임 이름', titlePlaceholder: '예) 스플렌더',
    section: '보드게임 기록',
  },
  murdermystery: {
    key: 'murdermystery', label: '머더미스터리', icon: 'magnifier', cls: 'g-mm',
    titleLabel: '작품 이름', titlePlaceholder: '예) 붉은 저택의 초대',
    section: '머더미스터리 기록',
  },
  escaperoom: {
    key: 'escaperoom', label: '방탈출', icon: 'door', cls: 'g-er',
    titleLabel: '테마명', titlePlaceholder: '예) 시계탑의 비밀',
    section: '방탈출 기록',
  },
};

export const genreOf = (key) => GENRES[key] || null;

export const LIMITS = {
  title: 80,
  store: 40,
  branch: 40,
  oneLiner: 100,
  review: 5000,
  companion: 20,
  companions: 20,
  photos: 8,
  expansions: 100,
  impression: 1000,
  role: 40,
  culprit: 40,
  ending: 2000,
  puzzles: 5000,
  memo: 5000,
  bookName: 30,
};

export const MM_FORMATS = [
  { key: 'store', label: '매장' },
  { key: 'home', label: '집·박스' },
  { key: 'online', label: '온라인' },
];

export const ER_RESULTS = [
  { key: 'success', label: '성공' },
  { key: 'fail', label: '실패' },
];

export const DIFFICULTY_LABELS = ['', '쉬움', '무난', '보통', '어려움', '매우 어려움'];
export const FEAR_LABELS = ['없음', '약함', '조금', '보통', '무서움', '매우 무서움'];

// 평점 필터: 값 → 라벨
export const RATING_FILTERS = [
  { key: '', label: '전체 평점' },
  { key: '4.5', label: '4.5점 이상' },
  { key: '4', label: '4점 이상' },
  { key: '3', label: '3점 이상' },
  { key: 'low', label: '3점 미만' },
  { key: 'none', label: '미평가' },
];

export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

// IndexedDB — 기록·사진이 실제로 저장되는 곳
export const DB_NAME = 'ddoddohouse-record';
export const DB_VERSION = 1;

// localStorage — 이 기기에서만 쓰는 화면 설정과 작성 중인 초안
export const PREFS = {
  theme: 'ddh2:theme',
  view: 'ddh2:view',
  group: 'ddh2:group',
  drafts: 'ddh2:drafts',
  lastGenre: 'ddh2:lastGenre',
};

// 백업 파일 형식
export const BACKUP_APP = 'ddoddohouse-record';
export const BACKUP_VERSION = 2;
