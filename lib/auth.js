// 인증 + 무차별 대입 방지
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_SECRET_LENGTH = 16;
export const MAX_SECRET_LENGTH = 512;
export const MAX_FAILURES = 20;
export const FAIL_WINDOW_SEC = 900;
export const FAIL_KEY_PREFIX = 'ddh:fail:';
const MAX_KEY_LENGTH = 1024;
// 공유 링크(#k=…, ?key=…)와 HTTP 헤더로 그대로 오갈 수 있는 문자만 (%, &, +, 공백, 한글 등은 링크에서 깨짐)
const SECRET_RE = /^[A-Za-z0-9_.~-]+$/;
// README·개발 서버에 공개된 개발용 코드 — 배포 환경에서는 절대 받아들이지 않음
export const PUBLIC_DEV_SECRET = 'dev-secret-key-1234';

/**
 * APP_SECRET 정리. 다음이면 null (= not_configured, fail closed):
 *  - 없음 / 16자 미만 / 512자 초과
 *  - 링크로 전달할 수 없는 문자가 섞임 (앱이 보낼 수 없는 코드라 영원히 401이 나는 것 방지)
 *  - Vercel 배포 환경인데 공개된 개발용 코드를 그대로 씀
 */
export function readSecret(env) {
  const raw = env && typeof env.APP_SECRET === 'string' ? env.APP_SECRET.trim() : '';
  if (raw.length < MIN_SECRET_LENGTH || raw.length > MAX_SECRET_LENGTH) return null;
  if (!SECRET_RE.test(raw)) return null;
  if (raw === PUBLIC_DEV_SECRET && (env.VERCEL || env.VERCEL_ENV)) return null;
  return raw;
}

function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** 길이와 무관하게 일정 시간 비교: 양쪽 SHA-256 digest를 timingSafeEqual로 */
export function keyMatches(provided, secret) {
  if (typeof provided !== 'string' || typeof secret !== 'string' || !secret) return false;
  const key = provided.trim();
  if (!key || key.length > MAX_KEY_LENGTH) return false;
  return timingSafeEqual(sha256(key), sha256(secret));
}

function firstHeader(v) {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : '';
}

/** IP: x-forwarded-for 첫 값 → x-real-ip → 'unknown'. Redis 키에 쓰이므로 문자 집합 제한 */
export function clientIp(req) {
  const h = (req && req.headers) || {};
  const candidates = [firstHeader(h['x-forwarded-for']).split(',')[0], firstHeader(h['x-real-ip'])];
  for (const c of candidates) {
    const ip = c.trim();
    if (ip && ip.length <= 64 && /^[0-9A-Fa-f:.]+$/.test(ip)) return ip;
  }
  return 'unknown';
}

export function failKey(ip) {
  return FAIL_KEY_PREFIX + ip;
}

/** 실패 횟수가 한도 이상이면 true. Redis 오류는 그대로 throw (호출 측에서 처리) */
export async function isLockedOut(redis, ip) {
  const v = await redis.get(failKey(ip));
  const n = Number(v);
  return Number.isFinite(n) && n >= MAX_FAILURES;
}

/**
 * 인증 실패 카운터: INCR + EXPIRE를 Lua 하나로 원자적으로.
 * (따로 보내면 EXPIRE만 실패했을 때 만료 없는 카운터가 남아 그 IP가 영원히 잠길 수 있음)
 *   KEYS[1] = ddh:fail:<ip>, ARGV[1] = 만료(초) → 반환: 증가한 값
 */
export const FAIL_SCRIPT = `local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return n`;

/** 인증 실패 기록: INCR + EXPIRE(900초, 마지막 실패 기준으로 연장) */
export async function recordFailure(redis, ip) {
  const n = await redis.eval(FAIL_SCRIPT, [failKey(ip)], [String(FAIL_WINDOW_SEC)]);
  return Number(Array.isArray(n) ? n[0] : n);
}
