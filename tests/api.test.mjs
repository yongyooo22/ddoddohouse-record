// API 테스트 (node:test) — 인증 / 레이트리밋 / 검증 / 충돌 / 한도 / 오류 은닉
// 저장소 관련 시나리오는 인메모리 가짜 Redis와 (설치돼 있으면) 실제 redis-server 양쪽에서 돌려
// Lua 스크립트와 가짜 구현이 똑같이 동작하는지 확인한다.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHandlers,
  UPSERT_SCRIPT,
  RECORDS_KEY,
  MEMBERS_KEY,
  PHOTOS_KEY,
  MAX_RECORDS,
  MAX_MEMBERS,
} from '../lib/handler.js';
import { validateRecord, validateMember } from '../lib/validate.js';
import { keyMatches, clientIp, readSecret, failKey, FAIL_SCRIPT } from '../lib/auth.js';
import { isOwnKey } from '../lib/keys.js';
import { pairsToObject, wrapUpstash, createRedisFromEnv } from '../lib/redis.js';
import { createMemoryRedis, createMemoryBlob, startDevServer, sourceToRegExp } from '../scripts/dev.mjs';
import { fakeJpeg, hasRedisServer, mockRes, startRedisServer, testRedis } from './redis-helpers.mjs';

const SECRET = 'test-secret-key-0123456789';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const silent = { error() {} };

/** 이 앱의 키만 비움 (테스트 사이 초기화 — 전체 초기화 명령은 쓰지 않음) */
const clearApp = (redis) => redis.del(RECORDS_KEY, MEMBERS_KEY, PHOTOS_KEY);

// ── 도우미 ───────────────────────────────────────────────────

function setup({ env = { APP_SECRET: SECRET }, redis = createMemoryRedis(), now, logger = silent } = {}) {
  const handlers = createHandlers({ redis, env, now, logger });
  async function call(route, { method = 'GET', key = SECRET, ip = '10.0.0.1', body, query = {}, headers = {} } = {}) {
    const req = {
      method,
      headers: { ...(key === null ? {} : { 'x-app-key': key }), 'x-forwarded-for': ip, ...headers },
      query,
      body,
    };
    const res = mockRes();
    await handlers[route](req, res);
    return res;
  }
  const post = (route, body, opts = {}) => call(route, { method: 'POST', body, ...opts });
  const del = (route, id, opts = {}) => call(route, { method: 'DELETE', query: { id }, ...opts });
  return { handlers, redis, call, post, del };
}

const bgRecord = (over = {}) => ({
  type: 'boardgame',
  date: '2026-09-01',
  title: '카탄',
  members: ['m1', 'm2'],
  rating: 4.5,
  oneLiner: '재밌었다',
  bg: {
    mode: 'competitive',
    place: '또또하우스',
    playTimeMin: 90,
    results: [
      { memberId: 'm1', score: 10, rank: 1, winner: true },
      { memberId: 'm2', score: 7, rank: 2, winner: false },
    ],
  },
  ...over,
});

const mmRecord = (over = {}) => ({
  type: 'murdermystery',
  date: '2026-09-02',
  title: '붉은 저택',
  members: ['m1', 'm2', 'm3'],
  rating: 5,
  tags: ['#반전', '#추리중심'],
  mm: {
    publisher: '머더랩',
    format: 'store',
    store: '강남점',
    playerCount: 5,
    roles: [
      { memberId: 'm1', character: '집사', culprit: true, outcome: 'win', mvp: true },
      { memberId: 'm2', character: '탐정', culprit: false, outcome: 'lose' },
    ],
    culpritResult: 'escaped',
    scores: { story: 5, deduction: 4.5, roleplay: 4, balance: 3.5, production: 0 },
    difficulty: 3,
    replay: true,
  },
  ...over,
});

const erRecord = (over = {}) => ({
  type: 'escaperoom',
  date: '2026-09-03',
  title: '저주받은 병동',
  members: ['m1'],
  er: {
    brand: '키이스케이프',
    branch: '홍대점',
    genre: '공포',
    playerCount: 3,
    timeLimitMin: 70,
    cleared: true,
    remainingSec: 305,
    hints: 2,
    scores: { story: 4, interior: 5, puzzle: 3.5, device: 4 },
    difficulty: 4,
    fear: 5,
    activity: 2,
  },
  ...over,
});

// ── 설정 / 인증 / 레이트리밋 ─────────────────────────────────

describe('설정 확인 (fail closed)', () => {
  for (const [label, env] of [
    ['APP_SECRET 없음', {}],
    ['APP_SECRET 15자', { APP_SECRET: '123456789012345' }],
    ['공백만', { APP_SECRET: '                    ' }],
  ]) {
    test(`${label} → 503 not_configured (모든 API, 키가 맞아도)`, async () => {
      const { call } = setup({ env });
      for (const route of ['data', 'records', 'members', 'images']) {
        const res = await call(route, { key: env.APP_SECRET ?? SECRET, method: 'POST', body: {} });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'not_configured' });
        assert.equal(res.headers['cache-control'], 'no-store');
      }
    });
  }

  test('Redis 설정이 없으면 503 not_configured', async () => {
    const { call } = setup({ redis: null });
    const res = await call('data');
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'not_configured' });
  });

  test('createRedisFromEnv: URL/토큰 없으면 null, 있으면 최소 인터페이스 (전체 초기화·키 훑기·통째 지우기 명령 없음)', () => {
    assert.equal(createRedisFromEnv({}), null);
    for (const env of [
      { UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' },
      { KV_REST_API_URL: 'https://example.upstash.io', KV_REST_API_TOKEN: 't' },
    ]) {
      const r = createRedisFromEnv(env);
      assert.deepEqual(Object.keys(r).sort(), ['eval', 'get', 'hdel', 'hget', 'hgetall']);
      for (const m of ['flushdb', 'flushall', 'keys', 'scan', 'del', 'set', 'hset']) assert.equal(r[m], undefined, m);
    }
  });

  test('readSecret은 앞뒤 공백을 무시하고 16자 이상만 인정', () => {
    assert.equal(readSecret({ APP_SECRET: ' abcdefghijklmnop \n' }), 'abcdefghijklmnop');
    assert.equal(readSecret({ APP_SECRET: 'abcdefghijklmno' }), null);
    assert.equal(readSecret(undefined), null);
  });

  test('readSecret: 링크로 보낼 수 없는 코드·공개된 개발용 코드(배포 환경)는 설정 안 된 것으로', () => {
    // README 방법으로 만든 값은 통과
    const uuidPair = `${'3f9c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6'}${'0a1b2c3d-4e5f-4a6b-8c7d-e8f9a0b1c2d3'}`;
    assert.equal(readSecret({ APP_SECRET: uuidPair }), uuidPair);
    assert.equal(readSecret({ APP_SECRET: 'a'.repeat(48) }), 'a'.repeat(48));
    assert.equal(readSecret({ APP_SECRET: 'Az09_.~-Az09_.~-' }), 'Az09_.~-Az09_.~-');
    // 공백·한글·%·&·+·base64 기호 → 앱이 링크로 보낼 수 없거나 깨짐
    for (const bad of ['our secret phrase 123', '우리모임비밀코드입니다아아아', 'abcdefghijklmnop%20', 'abcdefghij&klmnopq', 'abcd+efgh/ijklmn==']) {
      assert.equal(readSecret({ APP_SECRET: bad }), null, bad);
    }
    assert.equal(readSecret({ APP_SECRET: 'a'.repeat(513) }), null);
    // 개발용 기본 코드: 로컬에선 허용, Vercel 배포에선 거부
    assert.equal(readSecret({ APP_SECRET: 'dev-secret-key-1234' }), 'dev-secret-key-1234');
    assert.equal(readSecret({ APP_SECRET: 'dev-secret-key-1234', VERCEL: '1' }), null);
    assert.equal(readSecret({ APP_SECRET: 'dev-secret-key-1234', VERCEL_ENV: 'production' }), null);
  });

  test('설정이 잘못된 코드면 모든 API 503 (배포 환경의 개발용 코드 포함)', async () => {
    const { call } = setup({ env: { APP_SECRET: 'dev-secret-key-1234', VERCEL: '1' } });
    const res = await call('data', { key: 'dev-secret-key-1234' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, { error: 'not_configured' });
  });
});

describe('인증', () => {
  test('키가 틀리면 401, 실패 카운터 INCR + EXPIRE 900', async () => {
    const { call, redis } = setup();
    let res = await call('data', { key: 'wrong-key-wrong-key', ip: '1.2.3.4' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
    assert.equal(res.headers['cache-control'], 'no-store');
    res = await call('records', { method: 'POST', key: 'another-wrong-key', ip: '1.2.3.4', body: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(await redis.get('boardgame:fail:1.2.3.4'), '2');
    const ttl = redis.ttl('boardgame:fail:1.2.3.4');
    assert.ok(ttl > 890 && ttl <= 900, `ttl=${ttl}`);
  });

  test('키 없는 요청은 401이지만 실패로 세지 않고 Redis 도 건드리지 않음 (교차 사이트 잠금 공격 방지)', async () => {
    const base = createMemoryRedis();
    const touched = [];
    const redis = Object.fromEntries(Object.entries(base).map(([k, fn]) => [k, (...a) => { touched.push(k); return fn(...a); }]));
    const { call } = setup({ redis });
    // <img src> / 폼 / CORS preflight(OPTIONS) 흉내: 키 헤더가 없거나 비어 있음
    for (const [method, key] of [['GET', null], ['POST', null], ['OPTIONS', null], ['DELETE', ''], ['GET', '   ']]) {
      const res = await call(method === 'GET' ? 'data' : 'records', { method, key, ip: '7.7.7.7' });
      assert.equal(res.statusCode, 401, `${method} ${JSON.stringify(key)}`);
      assert.deepEqual(res.body, { error: 'unauthorized' });
      assert.equal(res.headers['cache-control'], 'no-store');
    }
    assert.deepEqual(touched, []);
    assert.equal(await base.get('boardgame:fail:7.7.7.7'), null);
    // 그 뒤에도 같은 IP의 진짜 사용자는 정상
    assert.equal((await call('data', { ip: '7.7.7.7' })).statusCode, 200);
  });

  test('키 없는 요청 25번(다른 사이트의 <img> 폭탄) 뒤에도 맞는 키는 200', async () => {
    const { call, redis } = setup();
    for (let i = 0; i < 25; i++) await call('data', { key: null, ip: '8.8.4.4' });
    assert.equal(await redis.get('boardgame:fail:8.8.4.4'), null);
    assert.equal((await call('data', { ip: '8.8.4.4' })).statusCode, 200);
  });

  test('맞는 키 → 200, 성공은 카운터를 건드리지 않음', async () => {
    const { call, redis } = setup();
    await call('data', { key: 'nope', ip: '1.2.3.4' });
    const res = await call('data', { ip: '1.2.3.4' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.records, []);
    assert.deepEqual(res.body.members, []);
    assert.ok(!Number.isNaN(Date.parse(res.body.serverTime)));
    assert.equal(await redis.get('boardgame:fail:1.2.3.4'), '1');
  });

  test('키 앞뒤 공백은 무시, 다른 길이·비문자열은 거부', () => {
    assert.equal(keyMatches(` ${SECRET} `, SECRET), true);
    assert.equal(keyMatches(SECRET + 'x', SECRET), false);
    assert.equal(keyMatches(SECRET.slice(0, -1), SECRET), false);
    assert.equal(keyMatches(undefined, SECRET), false);
    assert.equal(keyMatches(['a'], SECRET), false);
    assert.equal(keyMatches('x'.repeat(5000), SECRET), false);
  });

  test('IP 추출: x-forwarded-for 첫 값 → x-real-ip → unknown', () => {
    assert.equal(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' } }), '9.9.9.9');
    assert.equal(clientIp({ headers: { 'x-real-ip': '2001:db8::1' } }), '2001:db8::1');
    assert.equal(clientIp({ headers: { 'x-forwarded-for': 'evil}{key' } }), 'unknown');
    assert.equal(clientIp({ headers: {} }), 'unknown');
  });
});

describe('무차별 대입 방지', () => {
  test('같은 IP에서 20번 실패하면 맞는 키도 429, 다른 IP는 정상', async () => {
    let clock = Date.parse('2026-09-29T00:00:00Z');
    const redis = createMemoryRedis({ now: () => clock });
    const { call } = setup({ redis });
    for (let i = 0; i < 19; i++) {
      assert.equal((await call('data', { key: 'bad', ip: '1.2.3.4' })).statusCode, 401);
    }
    // 19번 실패까지는 맞는 키로 들어갈 수 있음
    assert.equal((await call('data', { ip: '1.2.3.4' })).statusCode, 200);
    assert.equal((await call('data', { key: 'bad', ip: '1.2.3.4' })).statusCode, 401); // 20번째
    const locked = await call('data', { ip: '1.2.3.4' });
    assert.equal(locked.statusCode, 429);
    assert.deepEqual(locked.body, { error: 'too_many_attempts' });
    assert.equal(locked.headers['cache-control'], 'no-store');
    // 잠긴 동안은 인증 확인 전에 거절 → 카운터도 더 늘지 않음
    assert.equal((await call('records', { key: 'bad', ip: '1.2.3.4', method: 'POST' })).statusCode, 429);
    assert.equal(await redis.get('boardgame:fail:1.2.3.4'), '20');
    // 다른 IP는 영향 없음
    assert.equal((await call('data', { ip: '5.6.7.8' })).statusCode, 200);
    // 15분 지나면 풀림
    clock += 901 * 1000;
    assert.equal((await call('data', { ip: '1.2.3.4' })).statusCode, 200);
  });

  test('잠긴 IP: 키 없는 요청은 401(카운터 그대로), 틀린 키·맞는 키는 429', async () => {
    const { call, redis } = setup();
    for (let i = 0; i < 20; i++) await call('data', { key: `bad-${i}`, ip: '1.1.1.1' });
    assert.equal((await call('data', { key: null, ip: '1.1.1.1' })).statusCode, 401);
    assert.equal((await call('data', { key: 'bad', ip: '1.1.1.1' })).statusCode, 429);
    assert.equal((await call('data', { ip: '1.1.1.1' })).statusCode, 429);
    assert.equal(await redis.get('boardgame:fail:1.1.1.1'), '20');
  });

  test('실패 카운터는 INCR+EXPIRE 를 스크립트 하나로 (만료 없는 카운터가 남지 않음)', async () => {
    const base = createMemoryRedis();
    const calls = [];
    const redis = {
      ...base,
      incr: async () => { throw new Error('따로 INCR 하면 안 됨'); },
      expire: async () => { throw new Error('따로 EXPIRE 하면 안 됨'); },
      eval: async (script, keys, args) => { calls.push([script === FAIL_SCRIPT ? 'FAIL' : 'OTHER', keys, args]); return base.eval(script, keys, args); },
    };
    const { call } = setup({ redis });
    assert.equal((await call('data', { key: 'bad', ip: '2.2.2.2' })).statusCode, 401);
    assert.deepEqual(calls, [['FAIL', ['boardgame:fail:2.2.2.2'], ['900']]]);
    assert.equal(await base.get('boardgame:fail:2.2.2.2'), '1');
    const ttl = base.ttl('boardgame:fail:2.2.2.2');
    assert.ok(ttl > 890 && ttl <= 900, `ttl=${ttl}`);
  });

  test('레이트리밋 확인이 Redis 오류로 실패해도 인증은 계속 요구', async () => {
    const base = createMemoryRedis();
    const redis = {
      ...base,
      get: async () => {
        throw new Error('redis down');
      },
    };
    const { call } = setup({ redis });
    assert.equal((await call('data', { key: 'bad' })).statusCode, 401);
    assert.equal((await call('data', { key: null })).statusCode, 401);
    assert.equal((await call('data')).statusCode, 200);
  });

  test('실패 기록이 Redis 오류로 실패해도 401', async () => {
    const base = createMemoryRedis();
    const redis = {
      ...base,
      eval: async () => {
        throw new Error('redis down');
      },
    };
    const { call } = setup({ redis });
    const res = await call('data', { key: 'bad' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  });
});

// ── 공통 응답 규칙 ───────────────────────────────────────────

describe('공통 응답', () => {
  test('허용되지 않은 메서드 → 405 + Allow', async () => {
    const { call } = setup();
    let res = await call('data', { method: 'POST', body: {} });
    assert.equal(res.statusCode, 405);
    assert.deepEqual(res.body, { error: 'method_not_allowed' });
    assert.equal(res.headers.allow, 'GET');
    res = await call('records', { method: 'PUT' });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'POST, DELETE');
    res = await call('members', { method: 'GET' });
    assert.equal(res.statusCode, 405);
  });

  test('500은 내부 정보를 숨기고 {error:"server_error"}만', async () => {
    const logged = [];
    const base = createMemoryRedis();
    const redis = {
      ...base,
      hgetall: async () => {
        throw new Error(`boom at KV_REST_API_TOKEN=${SECRET} /var/task/lib/handler.js:12`);
      },
    };
    const { call } = setup({ redis, logger: { error: (...a) => logged.push(a) } });
    const res = await call('data');
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'server_error' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!JSON.stringify(res.body).includes(SECRET));
    assert.equal(logged.length, 1, '서버 로그에는 남김');
  });

  test('모든 응답에 Cache-Control: no-store', async () => {
    const { call, post, del } = setup();
    const responses = [
      await call('data'),
      await post('records', { record: bgRecord() }),
      await post('records', { record: { type: 'x' } }),
      await del('records', 'nope'),
      await post('members', { member: { name: '연경' } }),
      await call('members', { method: 'PATCH' }),
      await call('data', { key: 'bad' }),
    ];
    for (const r of responses) assert.equal(r.headers['cache-control'], 'no-store', JSON.stringify(r.body));
  });

  test('본문 64KB 초과 → 413 too_large', async () => {
    const { post, call } = setup();
    let res = await post('records', { record: bgRecord(), pad: 'x'.repeat(70 * 1024) });
    assert.equal(res.statusCode, 413);
    assert.deepEqual(res.body, { error: 'too_large' });
    res = await post('records', { record: bgRecord() }, { headers: { 'content-length': String(65 * 1024) } });
    assert.equal(res.statusCode, 413);
    res = await call('records', { method: 'POST', body: JSON.stringify({ pad: 'y'.repeat(66 * 1024) }) });
    assert.equal(res.statusCode, 413);
  });

  test('본문 형식 오류 → 400 invalid body, 문자열 JSON 본문은 허용', async () => {
    const { handlers, call } = setup();
    // Vercel은 잘못된 JSON이면 req.body 접근 시 throw
    const req = {
      method: 'POST',
      headers: { 'x-app-key': SECRET, 'x-forwarded-for': '1.1.1.1' },
      query: {},
      get body() {
        throw new Error('Invalid JSON');
      },
    };
    const res = mockRes();
    await handlers.records(req, res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: 'invalid', field: 'body' });

    assert.deepEqual((await call('records', { method: 'POST', body: '[1,2]' })).body, { error: 'invalid', field: 'body' });
    assert.deepEqual((await call('records', { method: 'POST', body: undefined })).body, { error: 'invalid', field: 'body' });
    const ok = await call('records', { method: 'POST', body: JSON.stringify({ record: bgRecord() }) });
    assert.equal(ok.statusCode, 200);
  });
});

// ── 검증 ─────────────────────────────────────────────────────

describe('기록 검증', () => {
  const bad = [
    ['type', { type: 'poker' }],
    ['type', { type: undefined }],
    ['date', { date: '2026-02-30' }],
    ['date', { date: '2026-9-1' }],
    ['date', { date: '26-09-01' }],
    ['title', { title: '' }],
    ['title', { title: '   ' }],
    ['title', { title: '가'.repeat(81) }],
    ['title', { title: 123 }],
    ['rating', { rating: 4.3 }],
    ['rating', { rating: 5.5 }],
    ['rating', { rating: -0.5 }],
    ['rating', { rating: 'abc' }],
    ['oneLiner', { oneLiner: 'a'.repeat(101) }],
    ['review', { review: 'a'.repeat(5001) }],
    ['spoiler', { spoiler: 'yes' }],
    ['members', { members: 'm1' }],
    ['members', { members: ['m1', 'bad id!'] }],
    ['members', { members: Array.from({ length: 21 }, (_, i) => `m${i}`) }],
    ['tags', { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['tags', { tags: ['가'.repeat(16)] }],
    ['tags', { tags: [1] }],
    ['id', { id: '../etc/passwd' }],
    ['id', { id: 'x'.repeat(65) }],
    ['bg', { bg: 'nope' }],
    ['bg.mode', { bg: { mode: 'solo' } }],
    ['bg.place', { bg: { place: 'a'.repeat(41) } }],
    ['bg.playTimeMin', { bg: { playTimeMin: 1441 } }],
    ['bg.playTimeMin', { bg: { playTimeMin: 1.5 } }],
    ['bg.results', { bg: { results: [1] } }],
    ['bg.results.memberId', { bg: { results: [{ memberId: '' }] } }],
    ['bg.results.rank', { bg: { results: [{ memberId: 'm1', rank: 21 }] } }],
    ['bg.results.score', { bg: { results: [{ memberId: 'm1', score: 'many' }] } }],
    ['bg.results.winner', { bg: { results: [{ memberId: 'm1', winner: 1 }] } }],
    ['bg.coopWin', { bg: { mode: 'coop', coopWin: 'yes' } }],
    ['bg.expansion', { bg: { expansion: 'a'.repeat(61) } }],
  ];
  for (const [field, patch] of bad) {
    test(`거부: ${field} ${JSON.stringify(patch).slice(0, 60)}`, () => {
      const r = validateRecord(bgRecord(patch));
      assert.equal(r.ok, false);
      assert.equal(r.field, field);
    });
  }

  const badMm = [
    ['mm.format', { format: 'vr' }],
    ['mm.playerCount', { playerCount: 0 }],
    ['mm.playerCount', { playerCount: 21 }],
    ['mm.roles.character', { roles: [{ memberId: 'm1', character: 'a'.repeat(31) }] }],
    ['mm.roles.outcome', { roles: [{ memberId: 'm1', outcome: 'lost' }] }],
    ['mm.roles', { roles: Array.from({ length: 21 }, (_, i) => ({ memberId: `m${i}` })) }],
    ['mm.culpritResult', { culpritResult: 'fled' }],
    ['mm.scores.story', { scores: { story: 4.2 } }],
    ['mm.scores', { scores: [] }],
    ['mm.difficulty', { difficulty: 6 }],
    ['mm.publisher', { publisher: 'a'.repeat(41) }],
    ['mm.gm', { gm: 'a'.repeat(21) }],
  ];
  for (const [field, patch] of badMm) {
    test(`거부: ${field}`, () => {
      const base = mmRecord();
      const r = validateRecord({ ...base, mm: { ...base.mm, ...patch } });
      assert.equal(r.ok, false);
      assert.equal(r.field, field);
    });
  }

  const badEr = [
    ['er.playerCount', { playerCount: 11 }],
    ['er.timeLimitMin', { timeLimitMin: 0 }],
    ['er.timeLimitMin', { timeLimitMin: 301 }],
    ['er.remainingSec', { remainingSec: 18001 }],
    ['er.hints', { hints: 100 }],
    ['er.hints', { hints: -1 }],
    ['er.cleared', { cleared: 'true' }],
    ['er.scores.device', { scores: { device: 3.3 } }],
    ['er.fear', { fear: 0.25 }],
    ['er.activity', { activity: 7 }],
    ['er.genre', { genre: 'a'.repeat(21) }],
  ];
  for (const [field, patch] of badEr) {
    test(`거부: ${field}`, () => {
      const base = erRecord();
      const r = validateRecord({ ...base, er: { ...base.er, ...patch } });
      assert.equal(r.ok, false);
      assert.equal(r.field, field);
    });
  }

  test('알 수 없는 필드는 버리고, 해당 종류 블록만 남김', () => {
    const r = validateRecord(
      bgRecord({
        isAdmin: true,
        __proto__polluted: 1,
        updatedAt: '2000-01-01T00:00:00.000Z',
        mm: mmRecord().mm,
        er: erRecord().er,
        bg: { ...bgRecord().bg, secret: 'x', results: [{ memberId: 'm1', score: 3, winner: true, hack: 1 }] },
      }),
    );
    assert.equal(r.ok, true);
    const v = r.value;
    assert.equal(v.isAdmin, undefined);
    assert.equal(v.__proto__polluted, undefined);
    assert.equal(v.updatedAt, undefined);
    assert.equal(v.mm, undefined);
    assert.equal(v.er, undefined);
    assert.equal(v.bg.secret, undefined);
    assert.deepEqual(v.bg.results, [{ memberId: 'm1', score: 3, rank: null, winner: true }]);
    // photos 를 안 보냈으면 담지 않음 (저장할 때 handler 가 지금 사진을 그대로 둠)
    assert.deepEqual(Object.keys(v).sort(), ['bg', 'date', 'members', 'oneLiner', 'rating', 'review', 'spoiler', 'tags', 'title', 'type']);
    assert.equal(v.photos, undefined);
  });

  test('기본값 채우기 + 문자열 정리', () => {
    const r = validateRecord({
      type: 'murdermystery',
      date: '2026-01-31',
      title: '  제목\u0000에\n개행\u202E  ',
      review: ' 첫 줄\r\n둘째 줄\u0007 ',
      tags: ['  #반전 ', '#반전', '', '#호러'],
      members: ['m1', 'm1', 'm2'],
      rating: '3.5',
    });
    assert.equal(r.ok, true);
    const v = r.value;
    assert.equal(v.title, '제목 에 개행');
    assert.equal(v.review, '첫 줄\n둘째 줄');
    assert.deepEqual(v.tags, ['#반전', '#호러']);
    assert.deepEqual(v.members, ['m1', 'm2']);
    assert.equal(v.rating, 3.5);
    assert.equal(v.spoiler, false);
    assert.deepEqual(v.mm, {
      publisher: '',
      format: 'store',
      store: '',
      gm: '',
      playerCount: null,
      playTimeMin: 0,
      roles: [],
      culpritResult: null,
      scores: { story: 0, deduction: 0, roleplay: 0, balance: 0, production: 0 },
      difficulty: 0,
      replay: false,
    });
  });

  test('0.5 단위 별점·경계값 허용', () => {
    for (const rating of [0, 0.5, 1, 2.5, 5, '4.5', null, '']) {
      assert.equal(validateRecord(bgRecord({ rating })).ok, true, String(rating));
    }
    assert.equal(validateRecord(bgRecord({ title: '가'.repeat(80) })).ok, true);
    assert.equal(validateRecord(bgRecord({ review: '가'.repeat(5000) })).ok, true);
    assert.equal(validateRecord(bgRecord({ date: '2024-02-29' })).ok, true);
  });

  test('방탈출: 실패면 남은 시간 null, 보드게임: 협력 모드 아니면 coopWin null', () => {
    const er = validateRecord(erRecord({ er: { ...erRecord().er, cleared: false, remainingSec: 100 } }));
    assert.equal(er.value.er.remainingSec, null);
    const bg = validateRecord(bgRecord({ bg: { mode: 'competitive', coopWin: true } }));
    assert.equal(bg.value.bg.coopWin, null);
    const coop = validateRecord(bgRecord({ bg: { mode: 'coop', coopWin: false } }));
    assert.equal(coop.value.bg.coopWin, false);
  });

  test('중복 memberId 결과/배역은 첫 항목만', () => {
    const r = validateRecord(
      bgRecord({ bg: { results: [{ memberId: 'm1', winner: true }, { memberId: 'm1', winner: false }] } }),
    );
    assert.equal(r.value.bg.results.length, 1);
    assert.equal(r.value.bg.results[0].winner, true);
  });

  test('record가 객체가 아니면 field=record', () => {
    for (const v of [null, 'x', [], 3]) assert.deepEqual(validateRecord(v), { ok: false, field: 'record' });
  });
});

describe('멤버 검증', () => {
  test('이름·이모지·색상', () => {
    assert.deepEqual(validateMember({ name: '  연경  ', emoji: '🐰', color: 'c3', extra: 1 }), {
      ok: true,
      value: { name: '연경', emoji: '🐰', color: 'c3' },
    });
    assert.equal(validateMember({ name: '' }).field, 'name');
    assert.equal(validateMember({ name: '가'.repeat(21) }).field, 'name');
    assert.equal(validateMember({ name: '가'.repeat(20) }).ok, true);
    assert.equal(validateMember({ name: 'a', emoji: '🐰🐰🐰🐰🐰' }).field, 'emoji');
    assert.equal(validateMember({ name: 'a', emoji: '👍🏻👍🏻' }).ok, true); // 4 code points
    assert.equal(validateMember({ name: 'a', color: 'c11' }).field, 'color');
    assert.equal(validateMember({ name: 'a', color: '#fff' }).field, 'color');
    assert.equal(validateMember({ name: 'a' }).value.color, 'c1');
    assert.equal(validateMember({ name: 'a', id: 'bad id' }).field, 'id');
    assert.equal(validateMember(null).field, 'member');
  });
});

// ── 저장소 시나리오 (가짜 / 실제 Redis 공통) ──────────────────

function storageSuite(label, makeRedis) {
  describe(`저장 (${label})`, () => {
    let redis;
    before(async () => {
      redis = await makeRedis();
    });

    function fresh(opts = {}) {
      return setup({ redis, ...opts });
    }

    test('새 기록: id 생성, createdAt=updatedAt, 종류 블록만 저장', async () => {
      await clearApp(redis);
      const { post, call } = fresh();
      const res = await post('records', { record: bgRecord({ mm: { publisher: 'x' } }) });
      assert.equal(res.statusCode, 200);
      const rec = res.body.record;
      assert.match(rec.id, UUID_RE);
      assert.equal(rec.createdAt, rec.updatedAt);
      assert.equal(rec.mm, undefined);
      assert.equal(rec.bg.place, '또또하우스');
      const data = await call('data');
      assert.deepEqual(data.body.records, [rec]);
    });

    test('클라이언트가 준 id로 새 기록 생성 (가져오기) — 유효한 createdAt은 유지', async () => {
      const { post } = fresh();
      const res = await post('records', {
        record: erRecord({ id: 'import-1', createdAt: '2024-05-05T01:02:03.000Z', updatedAt: 'x' }),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.record.id, 'import-1');
      assert.equal(res.body.record.createdAt, '2024-05-05T01:02:03.000Z');
      assert.notEqual(res.body.record.updatedAt, 'x');
    });

    test('수정: createdAt 유지, updatedAt 갱신(항상 증가), 종류 변경 시 이전 블록 제거', async () => {
      let clock = Date.parse('2026-09-29T10:00:00.000Z');
      const { post } = fresh({ now: () => new Date(clock) });
      const created = (await post('records', { record: bgRecord() })).body.record;
      // 같은 ms에 수정해도 updatedAt은 달라야 함
      const upd1 = await post('records', {
        record: { ...created, title: '카탄 확장', createdAt: '1999-01-01T00:00:00.000Z' },
        baseUpdatedAt: created.updatedAt,
      });
      assert.equal(upd1.statusCode, 200);
      const r1 = upd1.body.record;
      assert.equal(r1.id, created.id);
      assert.equal(r1.title, '카탄 확장');
      assert.equal(r1.createdAt, created.createdAt);
      assert.ok(Date.parse(r1.updatedAt) > Date.parse(created.updatedAt));

      clock += 60_000;
      const upd2 = await post('records', {
        record: { ...mmRecord(), id: created.id, bg: r1.bg },
        baseUpdatedAt: r1.updatedAt,
      });
      assert.equal(upd2.statusCode, 200);
      assert.equal(upd2.body.record.type, 'murdermystery');
      assert.equal(upd2.body.record.bg, undefined);
      assert.equal(upd2.body.record.updatedAt, new Date(clock).toISOString());
      assert.equal(upd2.body.record.createdAt, created.createdAt);
    });

    test('충돌: 낡은 baseUpdatedAt / baseUpdatedAt 없음 → 409 + current', async () => {
      const { post } = fresh();
      const created = (await post('records', { record: bgRecord() })).body.record;
      const winner = (await post('records', { record: { ...created, oneLiner: 'A가 먼저' }, baseUpdatedAt: created.updatedAt }))
        .body.record;

      const stale = await post('records', { record: { ...created, oneLiner: 'B' }, baseUpdatedAt: created.updatedAt });
      assert.equal(stale.statusCode, 409);
      assert.equal(stale.body.error, 'conflict');
      assert.deepEqual(stale.body.current, winner);

      const noBase = await post('records', { record: { ...created, oneLiner: 'C' } });
      assert.equal(noBase.statusCode, 409);
      assert.deepEqual(noBase.body.current, winner);

      const nullBase = await post('records', { record: { ...created, oneLiner: 'C' }, baseUpdatedAt: null });
      assert.equal(nullBase.statusCode, 409);

      const badBase = await post('records', { record: created, baseUpdatedAt: 123 });
      assert.deepEqual(badBase.body, { error: 'invalid', field: 'baseUpdatedAt' });
    });

    test('원자성: 읽은 뒤 저장 사이에 다른 저장이 끼면 Lua CAS가 409', async () => {
      const { post } = fresh();
      const created = (await post('records', { record: bgRecord() })).body.record;
      const sneaky = { ...created, oneLiner: '끼어든 저장', updatedAt: '2099-01-01T00:00:00.000Z' };
      const racing = {
        ...redis,
        async eval(script, keys, args) {
          // HGET 이후, EVAL 직전에 다른 요청이 저장했다고 가정
          await redis.hset(RECORDS_KEY, { [created.id]: JSON.stringify(sneaky) });
          return redis.eval(script, keys, args);
        },
      };
      const { post: racePost } = setup({ redis: racing });
      const res = await racePost('records', { record: { ...created, oneLiner: '내 저장' }, baseUpdatedAt: created.updatedAt });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.error, 'conflict');
      assert.deepEqual(res.body.current, sneaky);
      assert.equal(JSON.parse(await redis.hget(RECORDS_KEY, created.id)).oneLiner, '끼어든 저장');
    });

    test('삭제된 기록을 옛 baseUpdatedAt 으로 수정하면 404 (몰래 되살리지 않음), base 없이 보내면 새로 저장', async () => {
      const { post, del, call } = fresh();
      const rec = (await post('records', { record: mmRecord({ id: 'gone-1' }) })).body.record;
      assert.equal((await del('records', rec.id)).statusCode, 200);
      const stale = await post('records', { record: { ...rec, oneLiner: '지워진 줄 모르고 수정' }, baseUpdatedAt: rec.updatedAt });
      assert.equal(stale.statusCode, 404);
      assert.deepEqual(stale.body, { error: 'not_found' });
      assert.ok(!(await call('data')).body.records.some((r) => r.id === rec.id), '되살아나면 안 됨');
      // 사용자가 "새 기록으로 다시 저장"을 고른 경우: base 없이 + 원래 createdAt
      const again = await post('records', { record: { ...rec, oneLiner: '다시 저장' }, baseUpdatedAt: null });
      assert.equal(again.statusCode, 200);
      assert.equal(again.body.record.createdAt, rec.createdAt);
      await del('records', rec.id);
    });

    test('Redis 재시도로 같은 EVAL 이 두 번 실행돼도 가짜 409 가 나지 않음', async () => {
      const retrying = {
        ...redis,
        async eval(script, keys, args) {
          // 첫 실행은 서버에서 성공했지만 응답이 끊겨 클라이언트가 같은 명령을 다시 보낸 상황
          if (script === UPSERT_SCRIPT) await redis.eval(script, keys, args);
          return redis.eval(script, keys, args);
        },
      };
      const { post } = setup({ redis: retrying });
      const created = await post('records', { record: bgRecord({ id: 'retry-1' }) });
      assert.equal(created.statusCode, 200, JSON.stringify(created.body));
      const edited = await post('records', { record: { ...created.body.record, title: '재시도 수정' }, baseUpdatedAt: created.body.record.updatedAt });
      assert.equal(edited.statusCode, 200, JSON.stringify(edited.body));
      assert.equal(JSON.parse(await redis.hget(RECORDS_KEY, 'retry-1')).title, '재시도 수정');
      const mem = await post('members', { member: { id: 'retry-m', name: '재시도 멤버' } });
      assert.equal(mem.statusCode, 200, JSON.stringify(mem.body));
      await redis.hdel(RECORDS_KEY, 'retry-1');
      await redis.hdel(MEMBERS_KEY, 'retry-m');
    });

    test('객체 기본 속성 이름(__proto__·constructor·toString) id 는 400', async () => {
      const { post, del, call } = fresh();
      for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype', 'valueOf']) {
        assert.deepEqual((await post('records', { record: bgRecord({ id }) })).body, { error: 'invalid', field: 'id' }, id);
        assert.deepEqual((await post('members', { member: { id, name: `이름-${id}` } })).body, { error: 'invalid', field: 'id' }, id);
        assert.deepEqual((await del('records', id)).body, { error: 'invalid', field: 'id' }, id);
        assert.deepEqual((await post('records', { record: bgRecord({ members: [id] }) })).body, { error: 'invalid', field: 'members' }, id);
      }
      // 예전에 이런 이름으로 들어간 값이 있어도 목록에서 조용히 사라지지 않음 (어댑터가 자기 속성으로 보존)
      await redis.hset(RECORDS_KEY, { ['__proto__']: JSON.stringify({ type: 'boardgame', title: '숨은 기록', date: '2026-01-01' }) });
      const listed = (await call('data')).body.records.find((r) => r.title === '숨은 기록');
      assert.equal(listed && listed.id, '__proto__');
      assert.equal(Number(await redis.hdel(RECORDS_KEY, '__proto__')), 1);
    });

    test('삭제: 있으면 200, 없으면 404, 잘못된 id 400', async () => {
      const { post, del, call } = fresh();
      const rec = (await post('records', { record: erRecord() })).body.record;
      const ok = await del('records', rec.id);
      assert.equal(ok.statusCode, 200);
      assert.deepEqual(ok.body, { ok: true });
      const again = await del('records', rec.id);
      assert.equal(again.statusCode, 404);
      assert.deepEqual(again.body, { error: 'not_found' });
      assert.deepEqual((await del('records', 'bad id')).body, { error: 'invalid', field: 'id' });
      assert.deepEqual((await call('records', { method: 'DELETE', query: {} })).body, { error: 'invalid', field: 'id' });
      const data = await call('data');
      assert.ok(!data.body.records.some((r) => r.id === rec.id));
    });

    test('GET /api/data: 기록은 날짜 내림차순, 멤버는 생성순', async () => {
      await clearApp(redis);
      let clock = Date.parse('2026-09-29T10:00:00.000Z');
      const { post, call } = fresh({ now: () => new Date((clock += 1000)) });
      await post('records', { record: bgRecord({ date: '2026-01-01', title: 'A' }) });
      await post('records', { record: bgRecord({ date: '2026-03-01', title: 'B' }) });
      await post('records', { record: bgRecord({ date: '2026-03-01', title: 'C' }) });
      await post('members', { member: { name: '가' } });
      await post('members', { member: { name: '나' } });
      const data = await call('data');
      assert.deepEqual(
        data.body.records.map((r) => r.title),
        ['C', 'B', 'A'],
      );
      assert.deepEqual(
        data.body.members.map((m) => m.name),
        ['가', '나'],
      );
    });

    test('기록 한도 5000: 새 기록은 409 limit, 기존 기록 수정은 가능', async () => {
      await clearApp(redis);
      const { post } = fresh();
      const keep = (await post('records', { record: bgRecord() })).body.record;
      const filler = {};
      for (let i = 1; i < MAX_RECORDS; i++) filler[`fill-${i}`] = JSON.stringify({ id: `fill-${i}`, type: 'boardgame' });
      await redis.hset(RECORDS_KEY, filler);
      assert.equal(await redis.hlen(RECORDS_KEY), MAX_RECORDS);

      const over = await post('records', { record: bgRecord() });
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit' });
      const upd = await post('records', { record: { ...keep, title: '수정' }, baseUpdatedAt: keep.updatedAt });
      assert.equal(upd.statusCode, 200);
      await redis.hdel(RECORDS_KEY, ...Object.keys(filler));
    });

    test('멤버: 생성/수정/이름 중복/삭제', async () => {
      const { post, del } = fresh();
      const a = await post('members', { member: { name: 'Alice', emoji: '🐰', color: 'c2' } });
      assert.equal(a.statusCode, 200);
      const alice = a.body.member;
      assert.match(alice.id, UUID_RE);
      assert.equal(alice.createdAt, alice.updatedAt);

      // 대소문자·공백만 다른 이름도 중복
      const dup = await post('members', { member: { name: '  alice ' } });
      assert.equal(dup.statusCode, 400);
      assert.deepEqual(dup.body, { error: 'invalid', field: 'name', reason: 'duplicate' });

      // 자기 자신은 같은 이름으로 수정 가능, createdAt 유지
      const same = await post('members', { member: { ...alice, name: 'ALICE', color: 'c5' } });
      assert.equal(same.statusCode, 200);
      assert.equal(same.body.member.name, 'ALICE');
      assert.equal(same.body.member.createdAt, alice.createdAt);

      const bad = await post('members', { member: { name: 'Bob', color: 'red' } });
      assert.deepEqual(bad.body, { error: 'invalid', field: 'color' });
      assert.deepEqual((await post('members', {})).body, { error: 'invalid', field: 'member' });

      assert.deepEqual((await del('members', alice.id)).body, { ok: true });
      assert.equal((await del('members', alice.id)).statusCode, 404);
      // 삭제 후엔 같은 이름 다시 사용 가능
      assert.equal((await post('members', { member: { name: 'alice' } })).statusCode, 200);
    });

    test('멤버 한도 200', async () => {
      await clearApp(redis);
      const filler = {};
      for (let i = 0; i < MAX_MEMBERS; i++) filler[`mem-${i}`] = JSON.stringify({ id: `mem-${i}`, name: `멤버${i}` });
      await redis.hset(MEMBERS_KEY, filler);
      const { post } = fresh();
      const over = await post('members', { member: { name: '새 멤버' } });
      assert.equal(over.statusCode, 409);
      assert.deepEqual(over.body, { error: 'limit' });
      const edit = await post('members', { member: { id: 'mem-3', name: '이름변경' } });
      assert.equal(edit.statusCode, 200);
      await redis.hdel(MEMBERS_KEY, ...Object.keys(filler));
    });

    test('레이트리밋 카운터 (INCR/EXPIRE/GET)', async () => {
      const { call } = fresh();
      const ip = '203.0.113.9';
      for (let i = 0; i < 20; i++) await call('data', { key: 'bad', ip });
      assert.equal((await call('data', { ip })).statusCode, 429);
      assert.equal(Number(await redis.get(`boardgame:fail:${ip}`)), 20);
    });
  });
}

storageSuite('인메모리 가짜 Redis', () => createMemoryRedis());

// ── 실제 redis-server로 Lua 스크립트 검증 (설치돼 있을 때만) ────────

describe('실제 redis-server', { skip: hasRedisServer ? false : 'redis-server 없음' }, () => {
  let server;
  let client;
  let wrapped;

  before(async () => {
    server = await startRedisServer();
    client = server.client;
    // wrapUpstash 경유 → lib/redis.js 어댑터도 함께 검증 (+ 상태를 꾸미는 보조 명령)
    wrapped = testRedis(client.raw);
  });

  after(() => server?.stop());

  test('UPSERT_SCRIPT 동작: 새로 추가 / 기대값 불일치 / 한도', async () => {
    const ev = (...args) => wrapped.eval(UPSERT_SCRIPT, ['boardgame:test:h'], args);
    assert.deepEqual(await ev('a', '', '{"v":1}', '2'), ['ok', '']);
    assert.deepEqual(await ev('a', '', '{"v":2}', '2'), ['conflict', '{"v":1}']);
    assert.deepEqual(await ev('a', '{"v":1}', '{"v":2}', '2'), ['ok', '']);
    assert.deepEqual(await ev('b', '{"v":1}', '{"v":3}', '2'), ['conflict', '']);
    assert.deepEqual(await ev('b', '', '{"b":1}', '2'), ['ok', '']);
    assert.deepEqual(await ev('c', '', '{"c":1}', '2'), ['limit', '']);
    assert.deepEqual(await ev('a', '{"v":2}', '{"v":4}', '2'), ['ok', '']);
    assert.deepEqual(await wrapped.hgetall('boardgame:test:h'), { a: '{"v":4}', b: '{"b":1}' });
  });

  test('FAIL_SCRIPT: INCR+EXPIRE 가 한 번에 (가짜 Redis 와 같은 값)', async () => {
    await wrapped.del('boardgame:test:fail');
    const fake = createMemoryRedis();
    for (let i = 1; i <= 3; i++) {
      assert.equal(Number(await wrapped.eval(FAIL_SCRIPT, ['boardgame:test:fail'], ['900'])), i);
      assert.equal(Number(await fake.eval(FAIL_SCRIPT, ['boardgame:test:fail'], ['900'])), i);
    }
    const ttl = await client.cmd('TTL', 'boardgame:test:fail');
    assert.ok(ttl > 890 && ttl <= 900, `ttl=${ttl}`);
    assert.ok(fake.ttl('boardgame:test:fail') > 890);
  });

  test('가짜 Redis와 같은 결과', async () => {
    const fake = createMemoryRedis();
    const steps = [
      ['a', '', 'x', '2'],
      ['a', '', 'y', '2'],
      ['a', 'x', 'y', '2'],
      ['b', '', 'z', '2'],
      ['c', '', 'w', '2'],
      ['c', 'nope', 'w', '2'],
    ];
    await wrapped.del('boardgame:test:cmp');
    for (const s of steps) {
      assert.deepEqual(await wrapped.eval(UPSERT_SCRIPT, ['boardgame:test:cmp'], s), await fake.eval(UPSERT_SCRIPT, ['boardgame:test:cmp'], s), s.join(','));
    }
    assert.deepEqual(await wrapped.hgetall('boardgame:test:cmp'), await fake.hgetall('boardgame:test:cmp'));
  });

  test('같은 Redis 의 마작 데이터(mahjong:*)는 읽지도 고치지도 지우지도 않음 — 기록·멤버·사진·gc·잘못된 코드까지', async () => {
    // 마작 앱이 쓰던 키를 그대로 흉내 (앱 어댑터는 이 키를 거부하므로 원시 명령으로)
    const mahjong = {
      'mahjong:games': ['HSET', 'g1', '{"winner":"연경","score":32000}', 'g2', '{"winner":"영식"}'],
      'mahjong:members': ['HSET', 'm1', '{"name":"연경"}'],
      'mahjong:settings': ['SET', '{"uma":[20,10,-10,-20]}'],
    };
    for (const [key, [cmd, ...rest]] of Object.entries(mahjong)) await client.cmd(cmd, key, ...rest);
    const snapshot = async () => ({
      games: await client.cmd('HGETALL', 'mahjong:games'),
      members: await client.cmd('HGETALL', 'mahjong:members'),
      settings: await client.cmd('GET', 'mahjong:settings'),
      ttl: await client.cmd('TTL', 'mahjong:games'),
    });
    const before = await snapshot();

    // 이 앱의 명령이 어떤 키로 갔는지 모두 기록
    const seen = new Set();
    const spy = new Proxy(client.raw, {
      get(target, name) {
        const fn = target[name];
        return (...a) => {
          if (name === 'eval') a[1].forEach((k) => seen.add(k));
          else seen.add(a[0]);
          return fn(...a);
        };
      },
    });
    let clock = Date.parse('2026-09-01T00:00:00.000Z');
    const handlers = createHandlers({ redis: wrapUpstash(spy), blob: createMemoryBlob(), env: { APP_SECRET: SECRET }, now: () => new Date(clock), logger: silent });
    const call = async (route, { method = 'GET', key = SECRET, body, query = {} } = {}) => {
      const res = mockRes();
      await handlers[route]({ method, headers: { 'x-app-key': key, 'x-forwarded-for': '198.51.100.7' }, query, body }, res);
      return res;
    };
    const photo = { full: fakeJpeg(3000).toString('base64'), thumb: fakeJpeg(300).toString('base64') };
    const img = (await call('images', { method: 'POST', body: photo })).body.image.id;
    const spare = (await call('images', { method: 'POST', body: photo })).body.image.id;
    const mem = (await call('members', { method: 'POST', body: { member: { name: '연경' } } })).body.member;
    const rec = (await call('records', { method: 'POST', body: { record: bgRecord({ members: [mem.id], photos: [img] }) } })).body.record;
    assert.equal((await call('images', { query: { id: img, size: 't' } })).statusCode, 200);
    assert.equal((await call('data')).body.records.length, 1);
    await call('records', { method: 'POST', body: { record: { ...rec, photos: [] }, baseUpdatedAt: rec.updatedAt } });
    assert.deepEqual((await call('images', { method: 'DELETE', query: { id: spare } })).body, { ok: true });
    clock += 25 * 60 * 60 * 1000;
    assert.deepEqual((await call('images', { method: 'POST', query: { action: 'gc' } })).body, { deleted: 1 });
    await call('records', { method: 'DELETE', query: { id: rec.id } });
    await call('members', { method: 'DELETE', query: { id: mem.id } });
    await call('images', { query: { stats: '1' } });
    await call('images', { query: { list: '1' } });
    assert.equal((await call('data', { key: 'wrong-code-wrong-code' })).statusCode, 401);

    assert.ok(seen.size > 0);
    for (const k of seen) assert.ok(k.startsWith('boardgame:'), `이 앱 밖의 키로 명령이 감: ${k}`);
    assert.deepEqual(await snapshot(), before, '마작 데이터 그대로');
    assert.equal(await client.cmd('EXISTS', 'mahjong:games', 'mahjong:members', 'mahjong:settings'), 3);
    await clearApp(wrapped);
  });

  storageSuite('실제 redis-server + wrapUpstash', async () => wrapped);
});

// ── 어댑터 / 개발 서버 ────────────────────────────────────────

describe('Redis 키 이름공간 (boardgame:)', () => {
  test('키 이름: boardgame:games · boardgame:members · boardgame:photos · boardgame:fail:<IP>', () => {
    assert.equal(RECORDS_KEY, 'boardgame:games');
    assert.equal(MEMBERS_KEY, 'boardgame:members');
    assert.equal(PHOTOS_KEY, 'boardgame:photos');
    assert.equal(failKey('203.0.113.5'), 'boardgame:fail:203.0.113.5');
    for (const k of ['boardgame:games', 'boardgame:fail:::1']) assert.equal(isOwnKey(k), true, k);
    for (const k of ['mahjong:games', 'mahjong:members', 'boardgame:', 'boardgame', 'boardgames:games', 'Boardgame:games', 'ddh:records', '', null, 42]) {
      assert.equal(isOwnKey(k), false, String(k));
    }
  });

  test('어댑터는 boardgame: 밖의 키로 가는 명령을 보내지 않고 오류 (EVAL 의 KEYS 도)', async () => {
    const sent = [];
    const client = new Proxy({}, { get: (_, name) => async (...a) => { sent.push([name, ...a]); return null; } });
    const r = wrapUpstash(client);
    for (const [label, fn] of [
      ['hgetall', () => r.hgetall('mahjong:games')],
      ['hget', () => r.hget('mahjong:members', 'm1')],
      ['hdel', () => r.hdel('mahjong:games', 'g1')],
      ['get', () => r.get('mahjong:settings')],
      ['eval', () => r.eval('return 1', ['boardgame:games', 'mahjong:games'], [])],
      ['접두어만', () => r.get('boardgame:')],
    ]) {
      await assert.rejects(fn(), /boardgame:' 밖의 키/, label);
    }
    assert.deepEqual(sent, [], 'Redis 로는 아무것도 가지 않음');
    await r.hget('boardgame:games', 'x');
    assert.deepEqual(sent, [['hget', 'boardgame:games', 'x']]);
  });

  test('가짜 Redis 도 boardgame: 밖의 키를 거부 — API 전체를 돌려도 만들어지는 키는 boardgame:* 뿐', async () => {
    const redis = createMemoryRedis();
    await assert.rejects(redis.hget('mahjong:games', 'g1'), /밖의 키/);
    await assert.rejects(redis.eval(UPSERT_SCRIPT, ['mahjong:games'], ['a', '', '{}', '10']), /밖의 키/);
    const handlers = createHandlers({ redis, blob: createMemoryBlob(), env: { APP_SECRET: SECRET }, logger: silent });
    const call = async (route, { method = 'GET', key = SECRET, body, query = {} } = {}) => {
      const res = mockRes();
      await handlers[route]({ method, headers: { 'x-app-key': key, 'x-forwarded-for': '192.0.2.1' }, query, body }, res);
      return res;
    };
    const img = (await call('images', { method: 'POST', body: { full: fakeJpeg(2000).toString('base64'), thumb: fakeJpeg(200).toString('base64') } })).body.image.id;
    const mem = (await call('members', { method: 'POST', body: { member: { name: '영식' } } })).body.member;
    assert.equal((await call('records', { method: 'POST', body: { record: bgRecord({ members: [mem.id], photos: [img] }) } })).statusCode, 200);
    assert.equal((await call('data', { key: 'wrong-code-wrong-code' })).statusCode, 401);
    assert.deepEqual(redis.keyNames(), ['boardgame:fail:192.0.2.1', 'boardgame:games', 'boardgame:members', 'boardgame:photos']);
  });
});

describe('lib/redis.js 어댑터', () => {
  test('pairsToObject: 배열·객체·null', () => {
    assert.deepEqual(pairsToObject(['a', '1', 'b', '{"x":1}']), { a: '1', b: '{"x":1}' });
    // '__proto__' 필드도 조용히 사라지지 않고 자기 속성으로 남음
    const odd = pairsToObject(['__proto__', '{"t":1}', 'abc', '{}']);
    assert.deepEqual(Object.keys(odd).sort(), ['__proto__', 'abc']);
    assert.equal(Object.getPrototypeOf(odd), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(odd, '__proto__').value, '{"t":1}');
    assert.deepEqual(pairsToObject({ a: { x: 1 }, b: 's' }), { a: '{"x":1}', b: 's' });
    assert.deepEqual(pairsToObject(null), {});
    assert.deepEqual(pairsToObject([]), {});
  });

  test('클라이언트가 값을 역직렬화해 객체로 줘도 (automaticDeserialization 켜짐) 저장·수정·충돌이 그대로 동작', async () => {
    // @upstash/redis 의 기본 역직렬화(parseResponse)처럼 JSON 으로 읽히는 값은 객체로 바꿔 돌려주는 클라이언트
    const mem = createMemoryRedis();
    const parse = (v) => {
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return v; }
    };
    const deserializing = {
      ...mem,
      hget: async (k, f) => parse(await mem.hget(k, f)),
      hgetall: async (k) => {
        const o = await mem.hgetall(k);
        const out = {};
        for (const [f, v] of Object.entries(o || {})) out[f] = parse(v);
        return Object.keys(out).length ? out : null;
      },
      eval: async (...a) => {
        const r = await mem.eval(...a);
        return Array.isArray(r) ? r.map(parse) : r;
      },
    };
    const { post, call } = setup({ redis: wrapUpstash(deserializing) });
    const created = await post('records', { record: bgRecord() });
    assert.equal(created.statusCode, 200);
    const rec = created.body.record;
    const edited = await post('records', { record: { ...rec, title: '카탄 확장' }, baseUpdatedAt: rec.updatedAt });
    assert.equal(edited.statusCode, 200);
    const stale = await post('records', { record: { ...rec, title: '옛 버전' }, baseUpdatedAt: rec.updatedAt });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.current.title, '카탄 확장');
    const data = await call('data');
    assert.equal(data.statusCode, 200);
    assert.deepEqual(data.body.records.map((r) => r.title), ['카탄 확장']);
  });

  test('가짜 Redis EVAL은 알 수 없는 스크립트를 거부', async () => {
    await assert.rejects(createMemoryRedis().eval('return 1', [], []), /unsupported script/);
  });
});

describe('개발 서버 (scripts/dev.mjs)', () => {
  let server;
  before(async () => {
    server = await startDevServer({ port: 0, secret: SECRET, logger: silent });
  });
  after(() => server?.close());

  test('vercel.json source 패턴 변환', () => {
    assert.ok(sourceToRegExp('/(.*)').test('/a/b.js'));
    assert.ok(sourceToRegExp('/sw.js').test('/sw.js'));
    assert.ok(!sourceToRegExp('/sw.js').test('/swxjs'));
    assert.ok(sourceToRegExp('/').test('/'));
    assert.ok(!sourceToRegExp('/').test('/x'));
    assert.ok(sourceToRegExp('/api/:name').test('/api/data'));
  });

  test('정적 파일: 보안 헤더 + MIME', async () => {
    const res = await fetch(`${server.url}/robots.txt`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.equal(await res.text(), 'User-agent: *\nDisallow: /\n');
    const js = await fetch(`${server.url}/js/stats.js`);
    assert.match(js.headers.get('content-type'), /^text\/javascript/);
    await js.arrayBuffer();
  });

  test('index.html·sw.js는 no-cache', async () => {
    for (const p of ['/', '/index.html', '/sw.js']) {
      const res = await fetch(server.url + p);
      await res.arrayBuffer();
      assert.equal(res.headers.get('cache-control'), 'no-cache', p);
    }
  });

  test('숨김 파일·상위 경로 차단', async () => {
    for (const p of ['/.git/config', '/%2e%2e/%2e%2e/etc/passwd', '/.env', '/node_modules/@upstash/redis/package.json']) {
      const res = await fetch(server.url + p);
      await res.arrayBuffer();
      assert.equal(res.status, 404, p);
    }
  });

  test('API: 인증·저장·삭제 왕복 + no-store + 보안 헤더', async () => {
    const api = (p, init = {}) =>
      fetch(server.url + p, {
        ...init,
        headers: { 'content-type': 'application/json', 'x-app-key': SECRET, ...(init.headers || {}) },
      });
    let res = await fetch(`${server.url}/api/data`);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    await res.arrayBuffer();

    res = await api('/api/records', { method: 'POST', body: JSON.stringify({ record: mmRecord() }) });
    assert.equal(res.status, 200);
    const { record } = await res.json();
    assert.match(record.id, UUID_RE);

    res = await api('/api/data');
    const data = await res.json();
    assert.equal(data.records.length, 1);
    assert.equal(data.records[0].mm.culpritResult, 'escaped');

    res = await api(`/api/records?id=${record.id}`, { method: 'DELETE' });
    assert.deepEqual(await res.json(), { ok: true });
    res = await api(`/api/records?id=${record.id}`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    await res.arrayBuffer();
  });

  test('API: 잘못된 JSON 400, 64KB 초과 413, 없는 API 404', async () => {
    const headers = { 'content-type': 'application/json', 'x-app-key': SECRET };
    let res = await fetch(`${server.url}/api/records`, { method: 'POST', headers, body: '{"record":' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid', field: 'body' });
    res = await fetch(`${server.url}/api/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pad: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'too_large' });
    res = await fetch(`${server.url}/api/nope`, { headers });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    await res.arrayBuffer();
  });
});
