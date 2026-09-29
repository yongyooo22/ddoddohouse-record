// 사진 저장 — 형식 판별·메타데이터 제거·base64 해석·한도, 그리고 원자적으로 처리해야 하는 부분의 Lua 스크립트.
//
// Redis 키:
//   ddh:img:<id>:f / ddh:img:<id>:t   원본(긴 변 1600px)·썸네일의 base64 문자열 (SET)
//   ddh:imgmeta  HASH  id → JSON {id, mime, mimeT, bytesF, bytesT, createdAt[, pending:true]}
//   ddh:imgtouch HASH  id → ISO 시각. 기록에서 빠졌거나(수정·삭제) 가져오기가 다시 쓰겠다고 한 시각 —
//                      이때부터 24시간은 정리하지 않음 (저장 안 한 폼·되살리기가 아직 가리킬 수 있음)
// 불변식: 데이터 키가 있으면 메타도 있다 (올릴 때는 메타 먼저, 지울 때는 Lua 한 번에 둘 다).
//   → 사진 수·총 용량은 메타만 합산하면 정확하고, gc 도 메타만 훑으면 된다.
//   메타의 pending 은 '예약만 하고 데이터를 다 쓰기 전' — 원본·썸네일을 모두 쓴 뒤에 뗀다.
//   그래서 올리다 끊긴 사진은 pending 으로 남고, 기록은 pending 사진을 가리킬 수 없으며(없는 사진으로 봄),
//   같은 id 로 다시 올리면(백업 가져오기) 데이터를 마저 쓴다.
// DOM 에 의존하지 않지만 Buffer 를 쓰므로 서버(node) 전용.

export const IMAGE_META_KEY = 'ddh:imgmeta';
export const IMAGE_TOUCH_KEY = 'ddh:imgtouch';
export const IMAGE_KEY_PREFIX = 'ddh:img:';

/** /api/images 업로드 본문 한도 (다른 API 는 64KB 그대로) */
export const MAX_IMAGE_BODY_BYTES = 1.5 * 1024 * 1024;
/** 디코드된 바이트 기준. 원본 base64(≈933KB)가 Upstash 요청 하나(1MB)에 들어가는 크기 */
export const MAX_FULL_BYTES = 700 * 1024;
export const MAX_THUMB_BYTES = 100 * 1024;
export const MAX_IMAGES = 3000;
/** 사진 데이터 총량(디코드 기준). base64 로 저장되면 약 200MB — Upstash 무료 256MB 안에서 기록 몫을 남김 */
export const MAX_IMAGE_TOTAL_BYTES = 150 * 1024 * 1024;
/** 정리 유예: 올린 뒤(또는 기록에서 빠진 뒤) 이 시간이 지나도 어떤 기록도 참조하지 않으면 지움 (작성 중인 폼의 사진 보호) */
export const IMAGE_GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** gc 요청의 keep(이 기기 초안이 쓰는 사진) 최대 개수 */
export const MAX_GC_KEEP = 40;
/** gc·정리 스크립트 한 번에 넘길 후보 수 (KEYS 가 2개씩 붙음) */
export const IMAGE_DELETE_BATCH = 200;
export const IMAGE_CACHE_CONTROL = 'private, max-age=604800, immutable';

export function imageKey(id, size) {
  return `${IMAGE_KEY_PREFIX}${id}:${size}`;
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
// cjson 없이 문자열 패턴만 쓴다. 메타·기록 JSON 은 서버가 JSON.stringify 로 만든 것이라
// 키 순서·공백이 고정이고, 문자열 값 안의 따옴표는 항상 \" 로 이스케이프되므로
// '"photos":[' · '"bytesF":' · '"pending":true' 같은 패턴이 값 안에서 잘못 걸리지 않는다. (사진 id 에는 따옴표·] 가 없음)

/** 메타 JSON 의 '아직 데이터를 다 쓰지 않음' 표시 */
export const PENDING_MARK = '"pending":true';

/** 모든 기록이 가리키는 사진 id 집합 refs 를 만드는 Lua 조각 (KEYS[1] = ddh:records) */
const REFS_LUA = `local refs = {}
local recs = redis.call('HVALS', KEYS[1])
for i = 1, #recs do
  local list = string.match(recs[i], '"photos":%[([^%]]*)%]')
  if list then
    for id in string.gmatch(list, '"([^"]*)"') do refs[id] = true end
  end
end`;

/**
 * 사진 메타 예약: 없을 때만, 개수·총 용량 한도 안에서 pending 메타를 HSET.
 *   KEYS[1] = ddh:imgmeta, KEYS[2]·KEYS[3] = 원본·썸네일 키, KEYS[4] = ddh:imgtouch
 *   ARGV[1] = id, ARGV[2] = pending 메타 JSON, ARGV[3] = 이 사진 바이트(원본+썸네일)
 *   ARGV[4] = 최대 개수, ARGV[5] = 최대 총 바이트, ARGV[6] = 지금(ISO)
 * 이미 있으면 곧 기록에 붙일 사진이므로 정리 유예를 지금부터 다시 셈(imgtouch).
 * 반환: {'ok',''} | {'exists', <메타>} | {'incomplete', <메타>}(pending 이거나 데이터 키가 빠짐 → 데이터를 마저 씀)
 *       | {'limit', 'count'|'bytes'}
 */
export const IMAGE_ADD_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[6])
  if string.find(cur, '${PENDING_MARK}', 1, true) or redis.call('EXISTS', KEYS[2], KEYS[3]) < 2 then
    return {'incomplete', cur}
  end
  return {'exists', cur}
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
 * 올리기 마무리: 원본·썸네일이 모두 있을 때만 pending 을 뗀 메타로 바꿈.
 *   KEYS[1] = ddh:imgmeta, KEYS[2]·KEYS[3] = 원본·썸네일 키, ARGV[1] = id, ARGV[2] = 최종 메타 JSON
 * 반환: 'ok' | 'incomplete' (그사이 같은 id 의 다른 올리기가 되돌리며 데이터를 지움)
 */
export const IMAGE_COMMIT_SCRIPT = `if redis.call('EXISTS', KEYS[2], KEYS[3]) < 2 then return 'incomplete' end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
return 'ok'`;

/**
 * 올리기 실패 되돌리기. 같은 id 를 다른 요청이 이미 마무리했거나(가져오기를 두 기기에서) 어떤 기록이
 * 가리키면 건드리지 않음 — 남은 pending 메타는 같은 id 로 다시 올릴 때 채워짐.
 *   KEYS[1] = ddh:records, KEYS[2] = ddh:imgmeta, KEYS[3]·KEYS[4] = 원본·썸네일 키, ARGV[1] = id
 * 반환: 'deleted' | 'kept'(다른 요청이 마무리함) | 'in_use'
 */
export const IMAGE_ROLLBACK_SCRIPT = `local cur = redis.call('HGET', KEYS[2], ARGV[1])
if cur and not string.find(cur, '${PENDING_MARK}', 1, true) then return 'kept' end
${REFS_LUA}
if cur and refs[ARGV[1]] then return 'in_use' end
if cur then redis.call('HDEL', KEYS[2], ARGV[1]) end
redis.call('DEL', KEYS[3], KEYS[4])
return 'deleted'`;

/**
 * 참조되지 않는 사진 지우기. 참조 확인과 삭제가 한 번에 일어나므로
 * 그 사이에 다른 기록이 이 사진을 붙여 저장하는 일(→ 깨진 참조)이 없다.
 *   KEYS[1] = ddh:records, KEYS[2] = ddh:imgmeta, KEYS[3] = ddh:imgtouch
 *   KEYS[2+2i], KEYS[3+2i] = i번째 후보의 원본·썸네일 키
 *   ARGV[1] = 유예 기준 시각(ISO) — imgtouch 가 이보다 나중이면 아직 지우지 않음 ('' = 유예 없이, 직접 지울 때)
 *   ARGV[1+i] = i번째 후보 id
 * 반환: 후보마다 'deleted' | 'in_use' | 'missing'(메타 없음) | 'young'(유예 중)
 * 기록이 쓰거나 이미 없는 사진의 imgtouch 는 지움 (다시 빠질 때 새로 적힘)
 */
export const IMAGE_DELETE_SCRIPT = `${REFS_LUA}
local out = {}
for i = 2, #ARGV do
  local id = ARGV[i]
  local touched = redis.call('HGET', KEYS[3], id)
  if redis.call('HEXISTS', KEYS[2], id) == 0 then
    if touched then redis.call('HDEL', KEYS[3], id) end
    out[i - 1] = 'missing'
  elseif refs[id] then
    if touched then redis.call('HDEL', KEYS[3], id) end
    out[i - 1] = 'in_use'
  elseif ARGV[1] ~= '' and touched and touched > ARGV[1] then
    out[i - 1] = 'young'
  else
    redis.call('DEL', KEYS[2 * i], KEYS[2 * i + 1])
    redis.call('HDEL', KEYS[2], id)
    if touched then redis.call('HDEL', KEYS[3], id) end
    out[i - 1] = 'deleted'
  end
end
return out`;

/** IMAGE_DELETE_SCRIPT 의 KEYS·ARGV 만들기 (cutoff: 유예 기준 ISO, '' = 유예 없음) */
export function deleteScriptArgs(recordsKey, ids, cutoff = '') {
  const keys = [recordsKey, IMAGE_META_KEY, IMAGE_TOUCH_KEY];
  for (const id of ids) keys.push(imageKey(id, 'f'), imageKey(id, 't'));
  return [keys, [cutoff, ...ids]];
}
