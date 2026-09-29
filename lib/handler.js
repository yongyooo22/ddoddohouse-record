// API 핸들러 팩토리. redis/env를 주입받아 테스트·로컬 개발 서버·Vercel 함수가 같은 코드를 쓴다.
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { clientIp, isLockedOut, keyMatches, readSecret, recordFailure } from './auth.js';
import { isPlainObject, isValidId, normalizeName, validateMember, validateRecord } from './validate.js';

export const RECORDS_KEY = 'ddh:records';
export const MEMBERS_KEY = 'ddh:members';
export const MAX_RECORDS = 5000;
export const MAX_MEMBERS = 200;
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * 해시 필드 하나를 원자적으로 비교 후 저장(CAS).
 *   KEYS[1] = 해시 키
 *   ARGV[1] = 필드(id)
 *   ARGV[2] = 기대하는 현재 원본 JSON ('' = 아직 없어야 함)
 *   ARGV[3] = 저장할 JSON
 *   ARGV[4] = 새로 추가할 때의 최대 필드 수
 * 반환: {'ok',''} | {'conflict', <현재 원본 또는 ''>} | {'limit',''}
 * (문자열 비교만 쓰므로 cjson 없이 동작)
 */
export const UPSERT_SCRIPT = `local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then cur = '' end
if cur ~= ARGV[2] then return {'conflict', cur} end
if cur == '' and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[4]) then return {'limit', ''} end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return {'ok', ''}`;

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

function queryId(req) {
  let id = getQuery(req).id;
  if (Array.isArray(id)) id = id[0];
  if (!isValidId(id)) throw invalid('id');
  return id;
}

/** 요청 본문(JSON 객체) 읽기 — 64KB 초과 413, 형식 오류 400 */
function readBody(req) {
  const len = Number(req.headers?.['content-length']);
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) throw new HttpError(413, { error: 'too_large' });
  let body;
  try {
    body = req.body; // Vercel은 잘못된 JSON이면 여기서 throw
  } catch {
    throw invalid('body');
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, { error: 'too_large' });
    try {
      body = JSON.parse(body);
    } catch {
      throw invalid('body');
    }
  } else if (body && typeof body === 'object') {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
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
 * @returns {{ data: Function, records: Function, members: Function }}  각각 Vercel 스타일 (req, res) 핸들러
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
        const [status, body] = await route(req);
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

  /** 해시 필드 CAS 저장. 반환: [status, body] 또는 null(성공) */
  async function casWrite(hashKey, id, expectedRaw, value, max) {
    const r = normalizeEvalResult(
      await redis.eval(UPSERT_SCRIPT, [hashKey], [id, expectedRaw || '', JSON.stringify(value), String(max)]),
    );
    if (r.status === 'ok') return null;
    // 네트워크 재시도로 같은 EVAL이 두 번 실행된 경우: 이미 우리 값이 저장돼 있으면 성공으로 본다
    if (r.status === 'conflict' && r.current === JSON.stringify(value)) return null;
    if (r.status === 'limit') return [409, { error: 'limit' }];
    if (r.status === 'conflict') return [409, { error: 'conflict', current: withId(parseStored(r.current), id) }];
    throw new Error(`unexpected eval result: ${r.status}`);
  }

  function withId(v, id) {
    return v ? { ...v, id } : null;
  }

  // ── GET /api/data ─────────────────────────────────────────
  async function getData() {
    const [recordsHash, membersHash] = await Promise.all([redis.hgetall(RECORDS_KEY), redis.hgetall(MEMBERS_KEY)]);
    return [
      200,
      {
        records: parseAll(recordsHash).sort(byDateDesc),
        members: parseAll(membersHash).sort(byCreatedAsc),
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

    const { id: givenId, createdAt: givenCreatedAt, ...fields } = v.value;
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
    const ts = nextTimestamp(now(), cur?.updatedAt);
    const saved = {
      id,
      ...fields,
      // 기존 createdAt 유지. 새 기록이면 (가져오기의) 유효한 createdAt 또는 지금
      createdAt: cur?.createdAt || givenCreatedAt || ts,
      updatedAt: ts,
    };
    const failed = await casWrite(RECORDS_KEY, id, curRaw, saved, MAX_RECORDS);
    return failed || [200, { record: saved }];
  }

  // ── DELETE /api/records?id= ───────────────────────────────
  async function deleteRecord(req) {
    const id = queryId(req);
    const n = Number(await redis.hdel(RECORDS_KEY, id));
    return n > 0 ? [200, { ok: true }] : [404, { error: 'not_found' }];
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

  return {
    data: guarded({ GET: getData }),
    records: guarded({ POST: upsertRecord, DELETE: deleteRecord }),
    members: guarded({ POST: upsertMember, DELETE: deleteMember }),
  };
}
