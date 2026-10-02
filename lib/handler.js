// API 핸들러 팩토리. redis/env를 주입받아 테스트·로컬 개발 서버·Vercel 함수가 같은 코드를 쓴다.
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { clientIp, isLockedOut, keyMatches, readSecret, recordFailure } from './auth.js';
import { isPlainObject, isValidId, normalizeName, validateGame, validateMember, validateRecord } from './validate.js';
import {
  IMAGE_ADD_SCRIPT,
  IMAGE_CACHE_CONTROL,
  IMAGE_COMMIT_SCRIPT,
  IMAGE_DELETE_BATCH,
  IMAGE_DELETE_SCRIPT,
  IMAGE_GC_MIN_AGE_MS,
  IMAGE_META_KEY,
  IMAGE_ROLLBACK_SCRIPT,
  IMAGE_TOUCH_KEY,
  MAX_FULL_BYTES,
  MAX_GC_KEEP,
  MAX_IMAGE_BODY_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  MAX_IMAGES,
  MAX_THUMB_BYTES,
  PENDING_MARK,
  decodeImage,
  deleteScriptArgs,
  detectImageType,
  imageKey,
  photosOf,
} from './images.js';

export const RECORDS_KEY = 'ddh:records';
export const MEMBERS_KEY = 'ddh:members';
// 기록 없이 소장 목록에 바로 등록한 게임
export const GAMES_KEY = 'ddh:games';
export const MAX_RECORDS = 5000;
export const MAX_MEMBERS = 200;
export const MAX_GAMES = 1000;
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 해시 필드 하나를 원자적으로 비교 후 저장(CAS).
 *   KEYS[1] = 해시 키
 *   KEYS[2] = (기록만) 사진 메타 해시 — ARGV[5..] 의 사진이 모두 있어야 저장
 *   ARGV[1] = 필드(id)
 *   ARGV[2] = 기대하는 현재 원본 JSON ('' = 아직 없어야 함)
 *   ARGV[3] = 저장할 JSON
 *   ARGV[4] = 새로 추가할 때의 최대 필드 수
 *   ARGV[5..] = 참조하는 사진 id (확인과 저장이 한 번에 일어나 사진 정리와 엇갈려도 깨진 참조가 안 생김.
 *               아직 올리는 중인(pending) 사진도 없는 것으로 봄)
 * 반환: {'ok',''} | {'conflict', <현재 원본 또는 ''>} | {'limit',''} | {'missing', '<없는 사진 id,…>'}
 * (문자열 비교만 쓰므로 cjson 없이 동작)
 */
export const UPSERT_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then cur = '' end
if cur ~= ARGV[2] then return {'conflict', cur} end
if cur == '' and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then return {'limit', ''} end
local missing = {}
for i = 5, #ARGV do
  local m = redis.call('HGET', KEYS[2], ARGV[i])
  if not m or string.find(m, '${PENDING_MARK}', 1, true) then missing[#missing + 1] = ARGV[i] end
end
if #missing > 0 then return {'missing', table.concat(missing, ',')} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return {'ok', ''}`;

/**
 * 기록 하나를 지우고 지운 값을 돌려줌 (읽기와 지우기 사이에 다른 기기가 고쳐 저장해도, 실제로 지운 값의 사진을 정리).
 *   KEYS[1] = ddh:records, ARGV[1] = id
 * 반환: 지운 원본 JSON | nil(없음)
 */
export const RECORD_DELETE_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return false end
redis.call('HDEL', KEYS[1], ARGV[1])
return cur`;

class HttpError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

const invalid = (field) => new HttpError(400, { error: 'invalid', field });

function send(res, status, body) {
  res.status(status).json(body);
}

/** 바이너리 응답. Vercel Node 런타임·개발 서버 모두 res 가 http.ServerResponse 라 end(Buffer) 로 보냄 */
function sendBinary(res, status, buf, headers) {
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
  res.setHeader('Content-Length', String(buf.length));
  res.status(status);
  res.end(buf);
}

function parseStored(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    const v = JSON.parse(raw);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  } catch {
    return {};
  }
}

function queryParam(req, name) {
  const v = getQuery(req)[name];
  return Array.isArray(v) ? v[0] : v;
}

function queryId(req) {
  const id = queryParam(req, 'id');
  if (!isValidId(id)) throw invalid('id');
  return id;
}

/** 요청 본문(JSON 객체) 읽기 — 한도(기본 64KB) 초과 413, 형식 오류 400 */
function readBody(req, limit = MAX_BODY_BYTES) {
  const len = Number(req.headers?.['content-length']);
  if (Number.isFinite(len) && len > limit) throw new HttpError(413, { error: 'too_large' });
  let body;
  try {
    body = req.body; // Vercel은 잘못된 JSON이면 여기서 throw
  } catch {
    throw invalid('body');
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > limit) throw new HttpError(413, { error: 'too_large' });
    try {
      body = JSON.parse(body);
    } catch {
      throw invalid('body');
    }
  } else if (body && typeof body === 'object') {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > limit) {
      throw new HttpError(413, { error: 'too_large' });
    }
  }
  if (!isPlainObject(body)) throw invalid('body');
  return body;
}

/** updatedAt은 항상 이전 값보다 커지게 (같은 ms 저장으로 충돌 감지가 무력화되는 것 방지) */
function nextTimestamp(now, prevIso) {
  let t = now.getTime();
  const prev = prevIso ? Date.parse(prevIso) : NaN;
  if (Number.isFinite(prev) && t <= prev) t = prev + 1;
  return new Date(t).toISOString();
}

function normalizeEvalResult(r) {
  if (Array.isArray(r)) {
    const cur = r[1];
    // 클라이언트가 값을 역직렬화해 객체로 돌려줘도 저장된 JSON 문자열로 되돌려 비교
    return { status: String(r[0]), current: cur == null ? '' : typeof cur === 'string' ? cur : JSON.stringify(cur) };
  }
  return { status: String(r), current: '' };
}

function byDateDesc(a, b) {
  return (
    String(b.date).localeCompare(String(a.date)) ||
    String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function byCreatedAsc(a, b) {
  return (
    String(a.createdAt || '').localeCompare(String(b.createdAt || '')) ||
    String(a.id).localeCompare(String(b.id))
  );
}

function parseAll(hash) {
  const out = [];
  for (const [id, raw] of Object.entries(hash || {})) {
    const v = parseStored(raw);
    if (v) out.push({ ...v, id });
  }
  return out;
}

/**
 * @param {object} opts
 * @param {object|null} opts.redis   lib/redis.js 인터페이스를 따르는 객체 (없으면 not_configured)
 * @param {object} [opts.env]        APP_SECRET을 읽을 환경 객체 (요청마다 읽음)
 * @param {() => Date} [opts.now]
 * @param {() => string} [opts.randomUUID]
 * @param {{error: Function}} [opts.logger]  서버 로그 (응답에는 내부 정보를 넣지 않음)
 * @returns {{ data: Function, records: Function, members: Function, games: Function, images: Function }}  각각 Vercel 스타일 (req, res) 핸들러
 */
export function createHandlers({
  redis,
  env = process.env,
  now = () => new Date(),
  randomUUID = nodeRandomUUID,
  logger = console,
} = {}) {
  /** 공통 관문: no-store → 설정 확인 → 레이트리밋 → 인증 → 메서드 분기 → 오류 은닉 */
  function guarded(routes) {
    const allow = Object.keys(routes).join(', ');
    return async function handler(req, res) {
      try {
        res.setHeader('Cache-Control', 'no-store');
        const secret = readSecret(env);
        if (!secret || !redis) return send(res, 503, { error: 'not_configured' });

        let key = req.headers?.['x-app-key'];
        if (Array.isArray(key)) key = key[0];
        // 키를 아예 안 보낸 요청은 추측 시도가 아니므로 실패로 세지 않고 Redis도 건드리지 않는다.
        // (다른 사이트가 <img>·form·CORS preflight로 방문자 브라우저에 키 없는 요청을 보내게 해서
        //  그 IP를 잠그거나 Upstash 사용량을 태우는 것 방지. 브라우저는 교차 출처 요청에 x-app-key를 못 붙임)
        if (typeof key !== 'string' || !key.trim()) return send(res, 401, { error: 'unauthorized' });

        const ip = clientIp(req);
        let locked = false;
        try {
          locked = await isLockedOut(redis, ip);
        } catch (err) {
          // 확인 실패해도 인증은 그대로 요구한다 (fail closed)
          logger.error('[api] rate-limit check failed', err);
        }
        if (locked) return send(res, 429, { error: 'too_many_attempts' });

        if (!keyMatches(key, secret)) {
          try {
            await recordFailure(redis, ip);
          } catch (err) {
            logger.error('[api] rate-limit record failed', err);
          }
          return send(res, 401, { error: 'unauthorized' });
        }

        const route = routes[req.method];
        if (!route) {
          res.setHeader('Allow', allow);
          return send(res, 405, { error: 'method_not_allowed' });
        }
        const [status, body, headers] = await route(req);
        if (Buffer.isBuffer(body)) return sendBinary(res, status, body, headers);
        return send(res, status, body);
      } catch (err) {
        if (err instanceof HttpError) return send(res, err.status, err.body);
        logger.error('[api] server_error', err);
        if (!res.headersSent) {
          res.setHeader('Cache-Control', 'no-store');
          return send(res, 500, { error: 'server_error' });
        }
      }
    };
  }

  /** 해시 필드 CAS 저장. photos 가 있으면(기록) 그 사진이 모두 있을 때만. 반환: [status, body] 또는 null(성공) */
  async function casWrite(hashKey, id, expectedRaw, value, max, photos) {
    const keys = photos ? [hashKey, IMAGE_META_KEY] : [hashKey];
    const args = [id, expectedRaw || '', JSON.stringify(value), String(max), ...(photos || [])];
    const r = normalizeEvalResult(await redis.eval(UPSERT_SCRIPT, keys, args));
    if (r.status === 'ok') return null;
    // 네트워크 재시도로 같은 EVAL이 두 번 실행된 경우: 이미 우리 값이 저장돼 있으면 성공으로 본다
    if (r.status === 'conflict' && r.current === JSON.stringify(value)) return null;
    if (r.status === 'limit') return [409, { error: 'limit' }];
    if (r.status === 'conflict') return [409, { error: 'conflict', current: withId(parseStored(r.current), id) }];
    if (r.status === 'missing') {
      return [400, { error: 'invalid', field: 'photos', missing: r.current.split(',').filter(Boolean) }];
    }
    throw new Error(`unexpected eval result: ${r.status}`);
  }

  /**
   * 참조되지 않는 사진 지우기 (IMAGE_DELETE_SCRIPT, 후보를 나눠서).
   * cutoff: 이 시각(ISO) 뒤에 기록에서 빠진 사진은 남김 ('' = 유예 없이). 반환: id → 'deleted'|'in_use'|'missing'|'young'
   */
  async function deleteUnreferenced(ids, cutoff = '') {
    const out = new Map();
    const unique = [...new Set(ids)].filter(isValidId);
    for (let i = 0; i < unique.length; i += IMAGE_DELETE_BATCH) {
      const chunk = unique.slice(i, i + IMAGE_DELETE_BATCH);
      const [keys, args] = deleteScriptArgs(RECORDS_KEY, chunk, cutoff);
      const r = await redis.eval(IMAGE_DELETE_SCRIPT, keys, args);
      if (!Array.isArray(r) || r.length !== chunk.length) throw new Error('unexpected eval result');
      chunk.forEach((id, k) => out.set(id, String(r[k])));
    }
    return out;
  }

  /** 정리 유예 기준: 이 시각 뒤에 올렸거나 기록에서 빠진 사진은 아직 지우지 않음 */
  const graceCutoff = () => new Date(now().getTime() - IMAGE_GC_MIN_AGE_MS).toISOString();

  /**
   * 기록 삭제·수정 뒤 정리 — best-effort (실패해도 기록 작업은 성공, 남은 건 gc 가 정리).
   * 빠진 사진은 바로 지우지 않고 '빠진 시각'만 적어 둠: 다른 기기에서 아직 저장하지 않은 폼
   * (수정 중이던 기록을 되살리기, 가져다 쓴 이전 대표 사진, 초안)이 그 사진을 가리키고 있을 수 있어서.
   * 대신 빠진 지 24시간이 지난 사진은 여기서 함께 지움 (기록을 저장·삭제할 때마다 조금씩, 따로 gc 를 누르지 않아도)
   */
  async function cleanupPhotos(released) {
    try {
      const ids = [...new Set(released)].filter(isValidId);
      if (ids.length) {
        const at = now().toISOString();
        await redis.hset(IMAGE_TOUCH_KEY, Object.fromEntries(ids.map((id) => [id, at])));
      }
      const touched = await redis.hgetall(IMAGE_TOUCH_KEY);
      const cutoff = graceCutoff();
      // 적힌 시각이 깨진 것도 지난 것으로 (영원히 남지 않게). 참조 중인지·유예는 스크립트가 지울 때 다시 확인
      const due = Object.entries(touched || {}).filter(([, t]) => !(String(t) > cutoff)).map(([id]) => id);
      if (due.length) await deleteUnreferenced(due, cutoff);
    } catch (err) {
      logger.error('[api] photo cleanup failed', err);
    }
  }

  function withId(v, id) {
    return v ? { ...v, id } : null;
  }

  // ── GET /api/data ─────────────────────────────────────────
  async function getData() {
    const [recordsHash, membersHash, gamesHash] = await Promise.all([
      redis.hgetall(RECORDS_KEY), redis.hgetall(MEMBERS_KEY), redis.hgetall(GAMES_KEY),
    ]);
    return [
      200,
      {
        records: parseAll(recordsHash).sort(byDateDesc),
        members: parseAll(membersHash).sort(byCreatedAsc),
        games: parseAll(gamesHash).sort(byCreatedAsc),
        serverTime: now().toISOString(),
      },
    ];
  }

  // ── POST /api/records ─────────────────────────────────────
  async function upsertRecord(req) {
    const body = readBody(req);
    const v = validateRecord(body.record);
    if (!v.ok) throw invalid(v.field);
    const base = body.baseUpdatedAt;
    if (base !== undefined && base !== null && (typeof base !== 'string' || base.length > 64)) {
      throw invalid('baseUpdatedAt');
    }

    const { id: givenId, createdAt: givenCreatedAt, photos: givenPhotos, ...fields } = v.value;
    const id = givenId || randomUUID();
    const curRaw = await redis.hget(RECORDS_KEY, id);
    const cur = parseStored(curRaw);
    if (curRaw) {
      // 기존 기록 수정: 클라이언트가 본 버전이 최신이어야 함
      if ((base ?? null) !== (cur?.updatedAt ?? null)) {
        return [409, { error: 'conflict', current: withId(cur, id) }];
      }
    } else if (typeof base === 'string' && base !== '') {
      // 수정하려던 기록이 그사이 삭제됨 → 몰래 되살리지 않고 알림 (새로 만들려면 baseUpdatedAt 없이 다시 보냄)
      return [404, { error: 'not_found' }];
    }
    // 사진 목록을 아예 안 보낸 저장(사진 기능이 없는 예전 앱·예전 백업)은 지금 사진을 그대로 둠 —
    // 빈 목록으로 보고 사진을 모두 떼어 버리지 않게. 빈 배열 [] 을 보내야 사진을 모두 뺌
    const keepPhotos = givenPhotos === undefined;
    const ts = nextTimestamp(now(), cur?.updatedAt);
    const saved = {
      id,
      ...fields,
      photos: keepPhotos ? photosOf(cur) : givenPhotos,
      // 기존 createdAt 유지. 새 기록이면 (가져오기의) 유효한 createdAt 또는 지금
      createdAt: cur?.createdAt || givenCreatedAt || ts,
      updatedAt: ts,
    };
    let failed = await casWrite(RECORDS_KEY, id, curRaw, saved, MAX_RECORDS, saved.photos);
    if (failed && keepPhotos && failed[1].missing) {
      // 사진을 모르는 앱이 고친 기록: 이미 깨져 있던 사진 참조만 조용히 빼고 한 번 더
      saved.photos = saved.photos.filter((p) => !failed[1].missing.includes(p));
      failed = await casWrite(RECORDS_KEY, id, curRaw, saved, MAX_RECORDS, saved.photos);
    }
    if (failed) return failed;
    // 이번 수정으로 빠진 사진 (이 기록이 참조하던 사진만 대상, 다른 기록이 쓰면 정리할 때 남김)
    await cleanupPhotos(photosOf(cur).filter((p) => !saved.photos.includes(p)));
    return [200, { record: saved }];
  }

  // ── DELETE /api/records?id= ───────────────────────────────
  async function deleteRecord(req) {
    const id = queryId(req);
    const deletedRaw = await redis.eval(RECORD_DELETE_SCRIPT, [RECORDS_KEY], [id]);
    if (deletedRaw === null || deletedRaw === undefined || deletedRaw === false) return [404, { error: 'not_found' }];
    await cleanupPhotos(photosOf(parseStored(deletedRaw)));
    return [200, { ok: true }];
  }

  // ── POST /api/members ─────────────────────────────────────
  async function upsertMember(req) {
    const body = readBody(req);
    const v = validateMember(body.member);
    if (!v.ok) throw invalid(v.field);
    const { id: givenId, createdAt: givenCreatedAt, ...fields } = v.value;
    const id = givenId || randomUUID();

    const all = await redis.hgetall(MEMBERS_KEY);
    const name = normalizeName(fields.name);
    for (const [otherId, raw] of Object.entries(all || {})) {
      if (otherId === id) continue;
      const other = parseStored(raw);
      if (other && normalizeName(other.name) === name) {
        throw new HttpError(400, { error: 'invalid', field: 'name', reason: 'duplicate' });
      }
    }

    const curRaw = all && Object.hasOwn(all, id) ? all[id] : null;
    const cur = parseStored(curRaw);
    const ts = nextTimestamp(now(), cur?.updatedAt);
    const saved = { id, ...fields, createdAt: cur?.createdAt || givenCreatedAt || ts, updatedAt: ts };
    const failed = await casWrite(MEMBERS_KEY, id, curRaw, saved, MAX_MEMBERS);
    return failed || [200, { member: saved }];
  }

  // ── DELETE /api/members?id= ───────────────────────────────
  async function deleteMember(req) {
    const id = queryId(req);
    const n = Number(await redis.hdel(MEMBERS_KEY, id));
    return n > 0 ? [200, { ok: true }] : [404, { error: 'not_found' }];
  }

  // ── POST /api/games ───────────────────────────────────────
  async function upsertGame(req) {
    const body = readBody(req);
    const v = validateGame(body.game);
    if (!v.ok) throw invalid(v.field);
    const { id: givenId, createdAt: givenCreatedAt, ...fields } = v.value;
    const id = givenId || randomUUID();

    // 같은 종류에 같은 이름(공백·대소문자 무시)은 하나만
    const all = await redis.hgetall(GAMES_KEY);
    const title = normalizeName(fields.title);
    for (const [otherId, raw] of Object.entries(all || {})) {
      if (otherId === id) continue;
      const other = parseStored(raw);
      if (other && other.type === fields.type && normalizeName(other.title) === title) {
        throw new HttpError(400, { error: 'invalid', field: 'title', reason: 'duplicate', current: withId(other, otherId) });
      }
    }

    const curRaw = all && Object.hasOwn(all, id) ? all[id] : null;
    const cur = parseStored(curRaw);
    const ts = nextTimestamp(now(), cur?.updatedAt);
    const saved = { id, ...fields, createdAt: cur?.createdAt || givenCreatedAt || ts, updatedAt: ts };
    const failed = await casWrite(GAMES_KEY, id, curRaw, saved, MAX_GAMES);
    return failed || [200, { game: saved }];
  }

  // ── DELETE /api/games?id= ─────────────────────────────────
  async function deleteGame(req) {
    const id = queryId(req);
    const n = Number(await redis.hdel(GAMES_KEY, id));
    return n > 0 ? [200, { ok: true }] : [404, { error: 'not_found' }];
  }

  // ── GET /api/images?id=&size=t|f · ?stats=1 · ?list=1 ─────
  async function getImages(req) {
    if (queryParam(req, 'stats') !== undefined) return imageStats();
    if (queryParam(req, 'list') !== undefined) return imageList();
    const id = queryId(req);
    const size = queryParam(req, 'size') ?? 'f';
    if (size !== 'f' && size !== 't') throw invalid('size');
    const raw = await redis.get(imageKey(id, size));
    if (typeof raw !== 'string' || !raw) return [404, { error: 'not_found' }];
    const bytes = Buffer.from(raw, 'base64');
    // 저장할 때 판별한 형식과 같음 (같은 바이트를 같은 함수로 판별) — 메타 조회 명령 하나를 아낌.
    // JPEG·WebP 가 아닌 값(깨졌거나 앱 밖에서 쓴 키)은 어떤 형식으로도 보내지 않음
    const type = detectImageType(bytes);
    if (!type) throw new Error('stored image is not jpeg/webp');
    return [
      200,
      bytes,
      {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cross-Origin-Resource-Policy': 'same-origin',
        // 같은 id 의 내용은 바뀌지 않음. 키가 바뀌면 다른 캐시 항목이 되게 Vary
        'Cache-Control': IMAGE_CACHE_CONTROL,
        Vary: 'x-app-key',
      },
    ];
  }

  async function allImageMeta() {
    const hash = await redis.hgetall(IMAGE_META_KEY);
    return parseAll(hash).filter((m) => isValidId(m.id));
  }

  async function imageStats() {
    const all = await allImageMeta();
    const bytes = all.reduce((sum, m) => sum + (Number(m.bytesF) || 0) + (Number(m.bytesT) || 0), 0);
    return [200, { count: all.length, bytes, limitBytes: MAX_IMAGE_TOTAL_BYTES, limitCount: MAX_IMAGES }];
  }

  async function imageList() {
    return [200, { images: (await allImageMeta()).sort(byCreatedAsc) }];
  }

  // ── POST /api/images (업로드) · ?action=gc ─────────────────
  async function postImages(req) {
    const action = queryParam(req, 'action');
    if (action === 'gc') return gcRoute(req);
    if (action !== undefined && action !== '') throw invalid('action');
    return uploadImage(req);
  }

  function readImageField(value, field, max) {
    const r = decodeImage(value, max);
    if (r.ok) return r;
    if (r.error === 'too_large') throw new HttpError(413, { error: 'too_large', field });
    if (r.error === 'format') throw new HttpError(400, { error: 'invalid', field, reason: 'format' });
    throw invalid(field);
  }

  async function uploadImage(req) {
    const body = readBody(req, MAX_IMAGE_BODY_BYTES);
    const givenId = body.id === undefined || body.id === null || body.id === '' ? null : body.id;
    if (givenId !== null && !isValidId(givenId)) throw invalid('id');
    const full = readImageField(body.full, 'full', MAX_FULL_BYTES);
    const thumb = readImageField(body.thumb, 'thumb', MAX_THUMB_BYTES);

    const id = givenId || randomUUID();
    const meta = {
      id,
      mime: full.mime,
      mimeT: thumb.mime,
      bytesF: full.bytes.length,
      bytesT: thumb.bytes.length,
      createdAt: now().toISOString(),
    };
    const metaJson = JSON.stringify(meta);
    const pendingJson = JSON.stringify({ ...meta, pending: true });
    const dataKeys = [imageKey(id, 'f'), imageKey(id, 't')];
    // 메타를 먼저 (한도 확인과 함께 원자적으로, '올리는 중' 표시를 달아서) — 데이터 키가 메타 없이 남지 않게
    const reserve = async () => normalizeEvalResult(
      await redis.eval(
        IMAGE_ADD_SCRIPT,
        [IMAGE_META_KEY, ...dataKeys, IMAGE_TOUCH_KEY],
        [id, pendingJson, String(meta.bytesF + meta.bytesT), String(MAX_IMAGES), String(MAX_IMAGE_TOTAL_BYTES), meta.createdAt],
      ),
    );
    let r = await reserve();
    // 가득 찼으면 오래된 안 쓰는 사진을 한 번 정리해 보고 다시 (설정에서 '정리'를 누르지 않아도 계속 올릴 수 있게)
    if (r.status === 'limit' && (await collectGarbage()) > 0) r = await reserve();
    if (r.status === 'limit') return [409, { error: 'limit', reason: r.current }];
    if (r.status === 'exists') {
      // 같은 id 가 이미 다 올라가 있음 (가져오기·재시도) → 건너뜀 (멱등)
      if (givenId) return [200, { image: withId(parseStored(r.current) || {}, id), existed: true }];
      throw new Error('image id collision');
    }
    // 'incomplete': 올리다 끊긴 같은 id(가져오기) 또는 Redis 재시도로 두 번 실행된 우리 예약 → 데이터를 (마저) 씀
    if (r.status === 'incomplete' && !givenId && r.current !== pendingJson) throw new Error('image id collision');
    if (r.status !== 'ok' && r.status !== 'incomplete') throw new Error(`unexpected eval result: ${r.status}`);

    try {
      // 하나씩 차례로 — 동시에 보내면 자동 파이프라이닝이 한 HTTP 요청으로 묶어 Upstash 요청 크기 한도(1MB)를 넘을 수 있음
      await redis.set(dataKeys[0], full.base64);
      await redis.set(dataKeys[1], thumb.base64);
      const done = await redis.eval(IMAGE_COMMIT_SCRIPT, [IMAGE_META_KEY, ...dataKeys], [id, metaJson]);
      if (String(done) !== 'ok') throw new Error('image data vanished before commit');
    } catch (err) {
      // 되돌리기 (Lua 한 번에): 다른 요청이 같은 id 를 마무리했거나 기록이 가리키면 그대로 둠.
      // 되돌리기마저 실패하면 pending 메타가 남음 → 같은 id 로 다시 올리면 채워지고, 아니면 gc 가 정리
      try {
        await redis.eval(IMAGE_ROLLBACK_SCRIPT, [RECORDS_KEY, IMAGE_META_KEY, ...dataKeys], [id]);
      } catch (e) {
        logger.error('[api] image rollback failed', e);
      }
      throw err;
    }
    return [200, { image: meta }];
  }

  /**
   * 어떤 기록도 참조하지 않고, 올린 지(기록에서 빠진 지) 24시간 지난 사진 삭제. 반환: 지운 수
   * keep: 지우지 말 사진 (요청한 기기의 초안이 쓰는 사진) — 유예도 지금부터 다시 셈 (다른 기기의 정리에서도 보호)
   */
  async function collectGarbage(keep = []) {
    const cutoff = graceCutoff();
    const cutoffMs = Date.parse(cutoff);
    const hash = await redis.hgetall(IMAGE_META_KEY);
    const kept = new Set(keep);
    const candidates = [];
    const touch = {};
    for (const [id, raw] of Object.entries(hash || {})) {
      if (kept.has(id)) { touch[id] = now().toISOString(); continue; }
      const created = Date.parse(parseStored(raw)?.createdAt);
      // 만든 시각을 알 수 없는 메타는 오래된 것으로 (영원히 남지 않게). 참조 중인지·유예는 스크립트가 지울 때 확인
      if (!(created > cutoffMs)) candidates.push(id);
    }
    if (Object.keys(touch).length) await redis.hset(IMAGE_TOUCH_KEY, touch);
    const result = await deleteUnreferenced(candidates, cutoff);
    let deleted = 0;
    for (const code of result.values()) if (code === 'deleted') deleted++;
    return deleted;
  }

  /** POST /api/images?action=gc  본문(없어도 됨) {keep?: [사진 id]} */
  async function gcRoute(req) {
    let raw;
    try {
      raw = req.body;
    } catch {
      throw invalid('body');
    }
    const body = raw === undefined || raw === null || raw === '' ? {} : readBody(req);
    const keep = body.keep ?? [];
    if (!Array.isArray(keep) || keep.length > MAX_GC_KEEP || !keep.every(isValidId)) throw invalid('keep');
    return [200, { deleted: await collectGarbage(keep) }];
  }

  // ── DELETE /api/images?id= ────────────────────────────────
  async function deleteImage(req) {
    const id = queryId(req);
    const code = (await deleteUnreferenced([id])).get(id);
    if (code === 'deleted') return [200, { ok: true }];
    if (code === 'in_use') return [409, { error: 'in_use' }];
    return [404, { error: 'not_found' }];
  }

  return {
    data: guarded({ GET: getData }),
    records: guarded({ POST: upsertRecord, DELETE: deleteRecord }),
    members: guarded({ POST: upsertMember, DELETE: deleteMember }),
    games: guarded({ POST: upsertGame, DELETE: deleteGame }),
    images: guarded({ GET: getImages, POST: postImages, DELETE: deleteImage }),
  };
}
