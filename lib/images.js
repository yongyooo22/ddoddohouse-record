// 사진 — 형식 판별·메타데이터 제거·base64 해석·한도, 그리고 사진 목록(Redis)을 원자적으로 고치는 Lua 스크립트.
//
// 사진 파일(원본·썸네일)은 Vercel Blob 비공개 저장소에 두고(lib/blob.js), Redis 에는 파일 경로 문자열과 작은 정보만 둔다:
//   boardgame:photos  HASH  사진 id → JSON {id, full, thumb, mime, mimeT, bytesF, bytesT, createdAt[, touchedAt][, state]}
//     full · thumb  Blob 파일 경로 (boardgame/photos/<id>-<올릴 때마다 새 값>.jpg · …-thumb.jpg)
//     touchedAt     기록에서 빠졌거나(수정·삭제) 다시 쓰겠다고 한(가져오기·초안) 시각 — 이때부터 24시간은 정리하지 않음
//                   (저장 안 한 폼·삭제된 기록 되살리기가 아직 그 사진을 가리킬 수 있음)
//     state         'uploading'(파일을 아직 다 쓰지 않음·올리다 끊김) | 'deleting'(파일을 지우는 중) —
//                   state 가 있는 사진은 기록이 가리킬 수 없고 보여 주지도 않음
// 원칙: Blob 에 파일이 있으면 그 경로를 적은 메타도 있다. 올릴 때는 메타(uploading)를 먼저 적고 파일을 쓴 뒤 state 를 떼고,
//   지울 때는 메타를 deleting 으로 바꾼 뒤 파일을 지우고 마지막에 메타를 뺀다 → 중간에 끊겨도 파일이 새지 않고
//   (남은 메타를 다음 정리가 다시 지움), 사진 수·총 용량은 메타만 합산하면 된다.
//   파일 경로는 올릴 때마다 새로 만들므로, 같은 id 를 두 기기에서 동시에 올리거나 지우는 중에 다시 올려도 서로의 파일을 지우지 않는다.
//   (예외 하나: 올리다 끊긴 같은 id 를 가져오기가 이어받은 뒤 예전 파일 지우기까지 실패하면 그 파일은 남음 — 서버 로그에 남김)
// DOM 에 의존하지 않지만 Buffer 를 쓰므로 서버(node) 전용.
import { PHOTOS_KEY, PHOTO_PATH_PREFIX } from './keys.js';

export { PHOTOS_KEY };

/** /api/images 업로드 본문 한도 (다른 API 는 64KB 그대로) */
export const MAX_IMAGE_BODY_BYTES = 1.5 * 1024 * 1024;
/** 디코드된 바이트 기준. 원본(긴 변 1600px)·썸네일의 base64 가 함께 본문 한도(1.5MB) 안에 들어가는 크기 */
export const MAX_FULL_BYTES = 700 * 1024;
export const MAX_THUMB_BYTES = 100 * 1024;
export const MAX_IMAGES = 3000;
/** 사진 파일 총량(원본+썸네일). Vercel Blob 무료(Hobby) 저장 공간 1GB 의 절반 */
export const MAX_IMAGE_TOTAL_BYTES = 500 * 1024 * 1024;
/** 정리 유예: 올린 뒤(또는 기록에서 빠진 뒤) 이 시간이 지나도 어떤 기록도 참조하지 않으면 지움 (작성 중인 폼의 사진 보호) */
export const IMAGE_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** gc 요청의 keep(이 기기 초안이 쓰는 사진) 최대 개수 */
export const MAX_GC_KEEP = 40;
/** 정리 스크립트 한 번에 지울 차례로 바꾸는 최대 사진 수 (응답 크기 제한 — 더 있으면 서버가 다시 부름) */
export const IMAGE_SWEEP_BATCH = 200;
export const IMAGE_CACHE_CONTROL = 'private, max-age=604800, immutable';

/** 메타 JSON 에 이 글자가 있으면 아직 쓸 수 없는 사진 (올리는 중·지우는 중) */
export const STATE_MARK = '"state":"';

const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** 새 파일 경로 (nonce: 올릴 때마다 새 임의 값) */
export function photoPaths(id, nonce, mime, mimeT) {
  const base = `${PHOTO_PATH_PREFIX}${id}-${nonce}`;
  return { full: `${base}.${EXT[mime] || 'bin'}`, thumb: `${base}-thumb.${EXT[mimeT] || 'bin'}` };
}

/** 앱에 돌려줄 사진 정보 (파일 경로·내부 표시는 빼고, 쓸 수 없는 사진은 pending: true) */
export function publicMeta(meta) {
  if (!meta) return null;
  const { full, thumb, touchedAt, state, ...pub } = meta;
  return state ? { ...pub, pending: true } : pub;
}

/** 매직 바이트로 형식 판별: JPEG(FF D8 FF) · WebP(RIFF....WEBP) 만. 그 밖(PNG/GIF/SVG…)은 null */
export function detectImageType(buf) {
  if (!buf || buf.length < 3) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

// FileReader.readAsDataURL 결과를 그대로 보내도 되게 앞의 data: 머리는 떼어 냄 (형식은 어차피 바이트로 판별)
const DATA_URL_PREFIX_RE = /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** n 바이트를 base64 로 쓴 길이 */
export function base64Length(n) {
  return Math.ceil(n / 3) * 4;
}

// ── 메타데이터 제거 ──
// 앱은 기기에서 다시 그려(canvas) 올리므로 원래 메타데이터가 없지만, 손으로 만든 백업·직접 API 호출도
// 같은 보장을 받도록 서버에서도 구조를 읽어 위치 정보(EXIF GPS)·XMP·IPTC·주석 등을 떼어 낸다.
// 구조를 읽을 수 없으면(앞의 매직 바이트만 맞춘 파일 등) 거부.

/** JPEG 에서 남겨 둘 APPn: JFIF(APP0)·색 프로필(APP2 ICC_PROFILE)·Adobe(APP14, 색 변환 정보). 나머지 APPn·COM 은 뗌 */
function keepJpegSegment(marker, payload) {
  if (marker === 0xfe) return false; // COM (주석)
  if (marker < 0xe0 || marker > 0xef) return true; // 그림 데이터에 필요한 표식 (DQT·DHT·SOFn·DRI …)
  const tag = (n) => payload.toString('latin1', 0, n);
  if (marker === 0xe0) return tag(5) === 'JFIF\0' || tag(5) === 'JFXX\0';
  if (marker === 0xe2) return tag(12) === 'ICC_PROFILE\0';
  if (marker === 0xee) return tag(5) === 'Adobe';
  return false; // APP1(EXIF·XMP) · APP13(IPTC) · MPF 등
}

/** JPEG 표식을 차례로 읽으며 메타데이터를 떼고, EOI 뒤에 붙은 것(모션 포토 영상 등)도 버림. 읽을 수 없으면 null */
function cleanJpeg(buf) {
  const n = buf.length;
  if (n < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  let sawScan = false;
  while (i < n) {
    if (buf[i] !== 0xff) return null;
    while (i < n && buf[i] === 0xff) i++; // 채움 바이트
    if (i >= n) return null;
    const marker = buf[i];
    const at = i - 1;
    i++;
    if (marker === 0xd9) { // EOI
      if (!sawScan) return null;
      parts.push(buf.subarray(at, i));
      return Buffer.concat(parts);
    }
    if (marker === 0x00 || marker === 0xd8) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { // 길이 없는 표식
      parts.push(buf.subarray(at, i));
      continue;
    }
    if (i + 2 > n) return null;
    const len = buf.readUInt16BE(i);
    if (len < 2 || i + len > n) return null;
    const end = i + len;
    if (marker === 0xda) { // SOS: 머리 다음은 압축된 그림 데이터 — 다음 표식(FF 뒤가 00·RSTn 이 아닌 곳)까지 그대로
      let j = end;
      while (j < n && !(buf[j] === 0xff && j + 1 < n && buf[j + 1] !== 0x00 && (buf[j + 1] < 0xd0 || buf[j + 1] > 0xd7))) j++;
      parts.push(buf.subarray(at, j));
      sawScan = true;
      i = j;
      continue;
    }
    if (keepJpegSegment(marker, buf.subarray(i + 2, end))) parts.push(buf.subarray(at, end));
    i = end;
  }
  // EOI 없이 끝난 파일: 그림 데이터가 있으면 그대로 (브라우저도 보여 줌)
  return sawScan ? Buffer.concat(parts) : null;
}

/** WebP(RIFF) 청크를 읽으며 EXIF·XMP 청크를 떼고 VP8X 의 해당 표시도 끔. 읽을 수 없으면 null */
function cleanWebp(buf) {
  if (buf.length < 20) return null;
  const end = 8 + buf.readUInt32LE(4);
  if (end > buf.length || end < 20) return null;
  const parts = [];
  let i = 12;
  while (i < end) {
    if (i + 8 > end) return null;
    const fourcc = buf.toString('latin1', i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const dataEnd = i + 8 + size;
    if (dataEnd > end) return null;
    if (i === 12 && fourcc !== 'VP8 ' && fourcc !== 'VP8L' && fourcc !== 'VP8X') return null; // 첫 청크는 그림이어야 함
    const next = Math.min(end, dataEnd + (size & 1)); // 홀수 크기 뒤 채움 바이트 (마지막 청크는 빠져 있어도 봐줌)
    if (fourcc === 'VP8X') {
      if (size < 10) return null;
      const chunk = Buffer.from(buf.subarray(i, next));
      chunk[8] &= ~(0x08 | 0x04); // EXIF·XMP 있음 표시 끄기
      parts.push(chunk);
    } else if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      parts.push(buf.subarray(i, next));
    }
    i = next;
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

/** 형식에 맞게 메타데이터를 뗀 바이트 (구조를 읽을 수 없으면 null) */
export function stripImageMetadata(buf, mime) {
  if (mime === 'image/jpeg') return cleanJpeg(buf);
  if (mime === 'image/webp') return cleanWebp(buf);
  return null;
}

/**
 * base64 문자열 → 이미지 바이트 (메타데이터를 뗀 것). 공백·URL-safe 문자 등 표준이 아닌 base64 는 거부
 * (Buffer.from 은 이상한 글자를 조용히 건너뛰므로 먼저 엄격하게 검사).
 * @returns {{ok:true, bytes:Buffer, mime:string, base64:string} | {ok:false, error:'invalid'|'too_large'|'format'}}
 */
export function decodeImage(value, maxBytes) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid' };
  const s = value.replace(DATA_URL_PREFIX_RE, '');
  if (s.length > base64Length(maxBytes)) return { ok: false, error: 'too_large' };
  if (!s || s.length % 4 !== 0 || !BASE64_RE.test(s)) return { ok: false, error: 'invalid' };
  const raw = Buffer.from(s, 'base64');
  if (raw.length > maxBytes) return { ok: false, error: 'too_large' };
  const mime = detectImageType(raw);
  if (!mime) return { ok: false, error: 'format' };
  const bytes = stripImageMetadata(raw, mime);
  if (!bytes) return { ok: false, error: 'format' };
  // 끝자리 비트가 다른 비표준 표기도 같은 문자열로 저장되게 다시 인코딩
  return { ok: true, bytes, mime, base64: bytes.toString('base64') };
}

/** 저장된 기록 JSON 에서 사진 id 목록 (없거나 깨졌으면 []) */
export function photosOf(record) {
  return record && Array.isArray(record.photos) ? record.photos.filter((p) => typeof p === 'string') : [];
}

// ── Lua 스크립트 (scripts/dev.mjs 의 가짜 Redis 가 같은 로직을 JS 로 구현) ──────────
// cjson 없이 문자열 패턴만 쓴다. 메타·기록 JSON 은 서버가 JSON.stringify 로 만든 것이라 공백이 없고,
// 문자열 값 안의 따옴표는 항상 \" 로 이스케이프되므로 '"photos":[' · '"bytesF":' · '"state":"' 같은 패턴이
// 값 안에서 잘못 걸리지 않는다. (사진 id·파일 경로·시각에는 따옴표·] 가 없음)
// 모든 스크립트는 넘겨받은 KEYS(boardgame:games · boardgame:photos)만 건드린다.

/** 메타 JSON 다루기: 필드 바꾸기(맨 뒤로)·지우기, 쓸 수 있는지, ISO 시각 읽기 */
const HELPERS_LUA = `local function setField(m, name, value)
  local s = string.gsub(m, ',"' .. name .. '":"[^"]*"', '')
  if value == '' then return s end
  return string.sub(s, 1, -2) .. ',"' .. name .. '":"' .. value .. '"}'
end
local function ready(m) return not string.find(m, '${STATE_MARK}', 1, true) end
local function isoOf(m, name) return string.match(m, '"' .. name .. '":"(%d%d%d%d%-%d%d%-%d%dT[^"]*)"') end`;

/** 모든 기록이 가리키는 사진 id 집합 refs 를 만드는 Lua 조각 (KEYS[1] = boardgame:games) */
const REFS_LUA = `local refs = {}
local recs = redis.call('HVALS', KEYS[1])
for i = 1, #recs do
  local list = string.match(recs[i], '"photos":%[([^%]]*)%]')
  if list then
    for id in string.gmatch(list, '"([^"]*)"') do refs[id] = true end
  end
end`;

/**
 * 사진 자리 잡기: 없을 때만, 개수·총 용량 한도 안에서 uploading 메타를 HSET.
 *   KEYS[1] = boardgame:photos
 *   ARGV[1] = id, ARGV[2] = uploading 메타 JSON (이번 파일 경로 포함), ARGV[3] = 이 사진 바이트(원본+썸네일)
 *   ARGV[4] = 최대 개수, ARGV[5] = 최대 총 바이트, ARGV[6] = 지금(ISO), ARGV[7] = '1' 이면 끊긴 같은 id 를 이어받아도 됨(가져오기)
 * 반환: {'ok',''} (같은 요청의 재시도도) | {'exists', <메타>} (다 올라가 있음 — 곧 기록에 붙일 것이므로 정리 유예를 지금부터 다시 셈)
 *       | {'incomplete', <이전 메타>} (올리다 끊겼거나 지우는 중인 같은 id → 이번 올리기가 이어받음)
 *       | {'taken', ''} (이어받기 안 됨) | {'limit', 'count'|'bytes'}
 */
export const IMAGE_RESERVE_SCRIPT = `${HELPERS_LUA}
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur == ARGV[2] then return {'ok', ''} end
if cur and ready(cur) then
  local t = setField(cur, 'touchedAt', ARGV[6])
  redis.call('HSET', KEYS[1], ARGV[1], t)
  return {'exists', t}
end
if cur then
  if ARGV[7] ~= '1' then return {'taken', ''} end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  return {'incomplete', cur}
end
local vals = redis.call('HVALS', KEYS[1])
if #vals >= tonumber(ARGV[4]) then return {'limit', 'count'} end
local total = tonumber(ARGV[3])
for i = 1, #vals do
  total = total + (tonumber(string.match(vals[i], '"bytesF":(%d+)')) or 0) + (tonumber(string.match(vals[i], '"bytesT":(%d+)')) or 0)
end
if total > tonumber(ARGV[5]) then return {'limit', 'bytes'} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return {'ok', ''}`;

/**
 * 올리기 마무리: 자리가 아직 이 요청의 것일 때만 state 를 뗀 메타로 바꿈.
 *   KEYS[1] = boardgame:photos, ARGV[1] = id, ARGV[2] = 이 요청의 uploading 메타, ARGV[3] = 최종 메타
 * 반환: 'ok' (재시도로 이미 마무리됐어도) | 'lost' (그사이 다른 요청이 이어받았거나 지움)
 */
export const IMAGE_COMMIT_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur == ARGV[3] then return 'ok' end
if cur ~= ARGV[2] then return 'lost' end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 'ok'`;

/**
 * 올리기 실패 되돌리기: 자리가 아직 이 요청의 것(uploading 그대로)이면 뺌.
 * 서버는 먼저 이 요청의 파일을 지운 뒤에 부름 — 파일을 못 지우면 자리가 남아 다음 정리가 파일과 함께 지움 (새는 파일 없음).
 * 파일 경로는 요청마다 달라서 다른 요청의 파일은 건드리지 않음.
 *   KEYS[1] = boardgame:photos, ARGV[1] = id, ARGV[2] = 이 요청의 uploading 메타
 * 반환: 뺀 수 (0 | 1)
 */
export const IMAGE_ROLLBACK_SCRIPT = `if redis.call('HGET', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('HDEL', KEYS[1], ARGV[1])
  return 1
end
return 0`;

/**
 * 사진 하나 지우기 (유예 없이 — 올렸다가 저장하지 않고 버린 사진). 참조 확인과 지울 차례 표시가 한 번에 일어나므로
 * 그 사이에 다른 기록이 이 사진을 붙이는 일(→ 깨진 참조)이 없다.
 *   KEYS[1] = boardgame:games, KEYS[2] = boardgame:photos, ARGV[1] = id
 * 반환: {'deleting', <deleting 메타>} (서버가 파일을 지우고 메타를 뺌) | {'in_use', ''} | {'missing', ''}
 */
export const IMAGE_DELETE_SCRIPT = `${HELPERS_LUA}
local cur = redis.call('HGET', KEYS[2], ARGV[1])
if not cur then return {'missing', ''} end
${REFS_LUA}
if refs[ARGV[1]] then return {'in_use', ''} end
local d = setField(cur, 'state', 'deleting')
redis.call('HSET', KEYS[2], ARGV[1], d)
return {'deleting', d}`;

/** 정리 후보(cand: all 의 위치)를 참조 확인 뒤 지울 차례로 바꾸는 Lua 조각. 쓰는 사진은 빠진 시각만 지움 → out = {id, 메타, …} */
const SWEEP_LUA = `if #cand == 0 then return {} end
${REFS_LUA}
local out = {}
for _, i in ipairs(cand) do
  if #out >= 2 * tonumber(ARGV[3]) then break end
  local id, m = all[i], all[i + 1]
  if refs[id] then
    if string.find(m, '"touchedAt":"', 1, true) then redis.call('HSET', KEYS[2], id, setField(m, 'touchedAt', '')) end
  else
    local d = setField(m, 'state', 'deleting')
    redis.call('HSET', KEYS[2], id, d)
    out[#out + 1] = id
    out[#out + 1] = d
  end
end
return out`;

/**
 * 기록 저장·삭제 뒤 정리: 이번에 기록에서 빠진 사진은 빠진 시각을 적고(지금부터 하루 유예),
 * 빠진 지 하루가 지났는데 어떤 기록도 쓰지 않는 사진은 지울 차례로 바꿈.
 *   KEYS[1] = boardgame:games, KEYS[2] = boardgame:photos
 *   ARGV[1] = 지금(ISO), ARGV[2] = 유예 기준 시각(ISO), ARGV[3] = 한 번에 지울 최대 수, ARGV[4..] = 이번에 빠진 사진 id
 * 반환: 지울 차례가 된 사진 {id, deleting 메타, id, 메타, …} (서버가 파일을 지우고 메타를 뺌)
 */
export const IMAGE_RELEASE_SCRIPT = `${HELPERS_LUA}
for i = 4, #ARGV do
  local m = redis.call('HGET', KEYS[2], ARGV[i])
  if m and ready(m) then redis.call('HSET', KEYS[2], ARGV[i], setField(m, 'touchedAt', ARGV[1])) end
end
local all = redis.call('HGETALL', KEYS[2])
local cand = {}
for i = 1, #all, 2 do
  local t = string.match(all[i + 1], '"touchedAt":"([^"]*)"')
  if t and not (t > ARGV[2]) then cand[#cand + 1] = i end
end
${SWEEP_LUA}`;

/**
 * gc: 어떤 기록도 쓰지 않고, 올린 시각·빠진 시각이 모두 유예 기준보다 오래된 사진을 지울 차례로 바꿈
 * (시각을 알 수 없는 메타는 오래된 것으로 — 영원히 남지 않게). keep 은 지우지 않고 유예를 지금부터 다시 셈.
 *   KEYS[1] = boardgame:games, KEYS[2] = boardgame:photos
 *   ARGV[1] = 지금(ISO), ARGV[2] = 유예 기준 시각(ISO), ARGV[3] = 한 번에 지울 최대 수, ARGV[4..] = keep 사진 id
 * 반환: 지울 차례가 된 사진 {id, deleting 메타, …}
 */
export const IMAGE_GC_SCRIPT = `${HELPERS_LUA}
local keep = {}
for i = 4, #ARGV do keep[ARGV[i]] = true end
local all = redis.call('HGETALL', KEYS[2])
local cand = {}
for i = 1, #all, 2 do
  local id, m = all[i], all[i + 1]
  if keep[id] then
    if ready(m) then redis.call('HSET', KEYS[2], id, setField(m, 'touchedAt', ARGV[1])) end
  else
    local c, t = isoOf(m, 'createdAt'), isoOf(m, 'touchedAt')
    if not ((c and c > ARGV[2]) or (t and t > ARGV[2])) then cand[#cand + 1] = i end
  end
end
${SWEEP_LUA}`;

/**
 * 파일을 지운 사진의 메타 빼기 — 지울 차례로 바꾼 그대로일 때만 (그사이 같은 id 를 다시 올렸으면 새 메타는 남김).
 *   KEYS[1] = boardgame:photos, ARGV = id1, 메타1, id2, 메타2, …
 * 반환: 뺀 수
 */
export const IMAGE_FORGET_SCRIPT = `local n = 0
for i = 1, #ARGV, 2 do
  if redis.call('HGET', KEYS[1], ARGV[i]) == ARGV[i + 1] then
    redis.call('HDEL', KEYS[1], ARGV[i])
    n = n + 1
  end
end
return n`;
