// 이 앱이 쓰는 Redis 키 이름과 Vercel Blob 파일 경로 — 모두 여기 한 곳에만.
//
// 같은 Upstash Redis 를 마작 기록 앱(mahjong:games · mahjong:members …)과 함께 쓰므로
// 이 앱의 키는 모두 'boardgame:' 로 시작하고, lib/redis.js 는 그 밖의 키로 가는 명령을 보내지 않고 막는다.
// 전체 초기화(FLUSHDB·FLUSHALL)나 키 훑기(KEYS·SCAN) 명령은 코드에 아예 없다.
//
//   boardgame:games      HASH    기록 id → 기록 JSON (보드게임·머더미스터리·방탈출)
//   boardgame:members    HASH    멤버 id → 멤버 JSON
//   boardgame:photos     HASH    사진 id → {Blob 파일 경로·형식·크기·시각} JSON (사진 파일 자체는 Vercel Blob 에)
//   boardgame:fail:<IP>  STRING  입장 코드를 틀린 횟수 (무차별 대입 방지 — 마지막 실패 15분 뒤 저절로 사라짐)

export const KEY_PREFIX = 'boardgame:';
export const RECORDS_KEY = `${KEY_PREFIX}games`;
export const MEMBERS_KEY = `${KEY_PREFIX}members`;
export const PHOTOS_KEY = `${KEY_PREFIX}photos`;
export const FAIL_KEY_PREFIX = `${KEY_PREFIX}fail:`;

// Vercel Blob(비공개 저장소) 안의 사진 파일: boardgame/photos/<사진 id>-<올릴 때마다 새 값>.jpg (썸네일은 -thumb)
export const BLOB_PREFIX = 'boardgame/';
export const PHOTO_PATH_PREFIX = `${BLOB_PREFIX}photos/`;

/** 이 앱의 Redis 키인지 ('boardgame:' 로 시작하고 뒤에 이름이 있음) */
export function isOwnKey(key) {
  return typeof key === 'string' && key.length > KEY_PREFIX.length && key.startsWith(KEY_PREFIX);
}

/** 이 앱의 사진 파일 경로인지 (boardgame/photos/ 아래, 경로를 벗어나는 글자 없음) */
export function isOwnPath(pathname) {
  return typeof pathname === 'string' && pathname.length > PHOTO_PATH_PREFIX.length && pathname.length <= 200 &&
    pathname.startsWith(PHOTO_PATH_PREFIX) && /^[A-Za-z0-9/_.-]+$/.test(pathname) && !pathname.includes('..');
}
