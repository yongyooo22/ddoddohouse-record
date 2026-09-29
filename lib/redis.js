// 실제 Upstash Redis 클라이언트 생성 + handler가 쓰는 최소 인터페이스로 감싸기.
//
// handler가 기대하는 인터페이스 (테스트용 가짜 redis도 똑같이 구현):
//   hgetall(key)            → { field: string } (없으면 {})
//   hget(key, field)        → string | null
//   hset(key, { field: v }) → number
//   hdel(key, field)        → number (지운 개수)
//   hlen(key)               → number
//   hexists(key, field)     → 0 | 1
//   get(key)                → string | null
//   set(key, value)         → 'OK'
//   del(...keys)            → number (지운 개수)
//   incr(key)               → number
//   expire(key, seconds)    → number
//   eval(script, keys, args)→ Lua 반환값 (배열 등)
import { Redis } from '@upstash/redis';

/** 값을 문자열 그대로 받도록(automaticDeserialization: false) Upstash 클라이언트를 감싼다 */
export function wrapUpstash(client) {
  return {
    async hgetall(key) {
      const raw = await client.hgetall(key);
      return pairsToObject(raw);
    },
    async hget(key, field) {
      return rawString(await client.hget(key, field));
    },
    hset: (key, values) => client.hset(key, values),
    hdel: (key, field) => client.hdel(key, field),
    hlen: (key) => client.hlen(key),
    hexists: (key, field) => client.hexists(key, field),
    // 사진 base64 도 문자열 그대로 (숫자처럼 보이는 값이 숫자로 바뀌지 않게)
    async get(key) {
      return rawString(await client.get(key));
    },
    set: (key, value) => client.set(key, value),
    del: (...keys) => client.del(...keys),
    incr: (key) => client.incr(key),
    expire: (key, seconds) => client.expire(key, seconds),
    eval: (script, keys, args) => client.eval(script, keys, args),
  };
}

/** 저장된 값을 원래 문자열로. 자동 역직렬화가 켜져 객체·숫자로 온 경우에도 JSON 문자열로 되돌린다
 *  (CAS 스크립트가 저장된 원본 문자열과 그대로 비교하므로 '[object Object]'가 되면 안 됨) */
export function rawString(v) {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** HGETALL 원시 응답([k, v, k, v, …] 또는 객체)을 { k: v } 로.
 *  '__proto__' 같은 필드 이름도 사라지지 않게 대입 대신 defineProperty(자기 속성)로 넣는다 */
export function pairsToObject(raw) {
  const out = {};
  const put = (k, v) => Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) put(String(raw[i]), String(raw[i + 1]));
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) put(k, rawString(v));
  }
  return out;
}

/**
 * 환경변수로 Redis 연결 생성. 설정이 없으면 null (→ API는 not_configured).
 * Vercel Marketplace(Upstash) 연결 시 주입되는 두 가지 이름 모두 지원.
 */
export function createRedisFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const client = new Redis({
      url: url.trim(),
      token: token.trim(),
      automaticDeserialization: false,
      enableTelemetry: false,
      // 함수 제한 시간(기본 10초) 안에 끝나도록 재시도는 짧게
      retry: { retries: 3, backoff: (n) => Math.min(800, 100 * 2 ** n) },
    });
    return wrapUpstash(client);
  } catch {
    return null;
  }
}
