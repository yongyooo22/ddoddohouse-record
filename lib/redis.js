// 실제 Upstash Redis 클라이언트 생성 + handler가 쓰는 최소 인터페이스로 감싸기.
//
// handler가 기대하는 인터페이스 (테스트용 가짜 redis도 똑같이 구현) — 이 앱이 Redis 에 보내는 명령은 이것뿐:
//   hgetall(key)             → { field: string } (없으면 {})
//   hget(key, field)         → string | null
//   hdel(key, field)         → number (지운 개수)
//   get(key)                 → string | null
//   eval(script, keys, args) → Lua 반환값 (배열 등). 스크립트는 넘긴 keys 만 건드림
// 모든 키는 'boardgame:' 로 시작해야 하며(lib/keys.js), 아니면 명령을 보내지 않고 오류를 낸다 —
// 같은 Redis 를 쓰는 다른 앱(mahjong:* 등)의 데이터를 읽거나 고치거나 지우는 일이 없게.
// 전체 초기화(FLUSHDB·FLUSHALL)·키 훑기(KEYS·SCAN)·키 통째 지우기(DEL) 같은 명령은 아예 없다.
import { Redis } from '@upstash/redis';
import { KEY_PREFIX, isOwnKey } from './keys.js';

/** 이 앱의 키('boardgame:…')가 아니면 오류 (명령을 보내기 전에 막음) */
export function ownKey(key) {
  if (!isOwnKey(key)) throw new Error(`redis: '${KEY_PREFIX}' 밖의 키는 쓰지 않아요 (${String(key).slice(0, 40)})`);
  return key;
}

/** 값을 문자열 그대로 받도록(automaticDeserialization: false) Upstash 클라이언트를 감싼다 */
export function wrapUpstash(client) {
  return {
    async hgetall(key) {
      return pairsToObject(await client.hgetall(ownKey(key)));
    },
    async hget(key, field) {
      return rawString(await client.hget(ownKey(key), field));
    },
    async hdel(key, field) {
      return client.hdel(ownKey(key), field);
    },
    // 숫자처럼 보이는 값도 문자열 그대로 (숫자로 바뀌지 않게)
    async get(key) {
      return rawString(await client.get(ownKey(key)));
    },
    async eval(script, keys, args) {
      return client.eval(script, keys.map(ownKey), args);
    },
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
 * 연결 정보는 코드에 넣지 않고 Vercel 환경변수에서만 읽는다 — Vercel Marketplace(Upstash) 연결 시
 * 주입되는 KV_REST_API_URL/KV_REST_API_TOKEN, 또는 직접 넣은 UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN.
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
