// 실제 @upstash/redis 클라이언트 경로 검증 (redis-server 가 있을 때만)
// Upstash REST API 를 흉내 내는 작은 HTTP 서버(단일 명령 + /pipeline, base64 응답 인코딩)를
// 로컬 redis-server 앞에 세우고, lib/redis.js 의 createRedisFromEnv() → lib/handler.js 까지
// 배포 환경과 같은 코드로 돌려 본다. (자동 파이프라이닝·base64 디코딩·역직렬화 끄기 확인)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRedisFromEnv } from '../lib/redis.js';
import { createHandlers, UPSERT_SCRIPT, RECORDS_KEY, PHOTOS_KEY } from '../lib/handler.js';
import { FAIL_SCRIPT } from '../lib/auth.js';
import { MAX_FULL_BYTES, MAX_THUMB_BYTES } from '../lib/images.js';
import { createMemoryBlob } from '../scripts/dev.mjs';
import { fakeJpeg, fakeWebp, hasRedisServer, mockRes, startRedisServer } from './redis-helpers.mjs';

const SECRET = 'upstash-test-secret-0123456789';
const TOKEN = 'rest-token-for-tests';

/** Upstash REST 흉내: POST / (명령 하나), POST /pipeline (여러 개). Upstash-Encoding: base64 지원.
 *  requests 에 요청마다 {bytes: 본문 크기, cmds: 명령 이름들} 을 남김 (요청 크기 한도 확인용) */
function restShim(redis) {
  const log = [];
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const b64 = String(req.headers['upstash-encoding'] || '').toLowerCase() === 'base64';
      const enc = (v) => (typeof v === 'string' ? (b64 ? Buffer.from(v, 'utf8').toString('base64') : v) : Array.isArray(v) ? v.map(enc) : v);
      const run = async (c) => {
        try {
          return { result: enc(await redis.cmd(...c)) };
        } catch (e) {
          return { error: e.message };
        }
      };
      const rawBody = Buffer.concat(chunks);
      const body = JSON.parse(rawBody.toString('utf8'));
      const path = new URL(req.url, 'http://x').pathname;
      requests.push({ bytes: rawBody.length, cmds: (path === '/pipeline' ? body : [body]).map((c) => String(c[0]).toLowerCase()) });
      if (path === '/pipeline') {
        log.push(`pipeline:${body.map((c) => c[0]).join(',')}`);
        const out = [];
        for (const c of body) out.push(await run(c));
        res.end(JSON.stringify(out));
      } else {
        log.push(String(body[0]));
        const out = await run(body);
        if (out.error) res.statusCode = 400;
        res.end(JSON.stringify(out));
      }
    });
  });
  return { server, log, requests };
}

describe('실제 Upstash 클라이언트 + REST 흉내 서버 + redis-server', { skip: hasRedisServer ? false : 'redis-server 없음' }, () => {
  let server;
  let resp;
  let shim;
  let url;
  let redis;
  let handlers;
  let blob;
  const errors = [];

  async function call(route, { method = 'GET', key = SECRET, ip = '10.0.0.9', body, query = {} } = {}) {
    const res = mockRes();
    await handlers[route]({ method, headers: { 'x-app-key': key, 'x-forwarded-for': ip }, query, body }, res);
    return res;
  }

  before(async () => {
    server = await startRedisServer();
    resp = server.client;
    shim = restShim(resp);
    await new Promise((r) => shim.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${shim.server.address().port}`;
    // Vercel 의 Upstash 연동이 넣어 주는 이름 그대로
    redis = createRedisFromEnv({ KV_REST_API_URL: url, KV_REST_API_TOKEN: TOKEN });
    blob = createMemoryBlob();
    handlers = createHandlers({ redis, blob, env: { APP_SECRET: SECRET }, logger: { error: (...a) => errors.push(a.join(' ')) } });
  });

  after(async () => {
    shim?.server.closeAllConnections?.();
    await new Promise((r) => (shim ? shim.server.close(r) : r()));
    server?.stop();
  });

  test('어댑터: 문자열(한글·이모지)·해시·카운터·EVAL 이 그대로 오감 (boardgame: 키만)', async () => {
    const v = JSON.stringify({ title: '붉은 저택 🔪 "따옴표"', n: 1 });
    await resp.cmd('HSET', 'boardgame:test:h', 'a', v, 'b', '{"x":2}');
    assert.equal(await redis.hget('boardgame:test:h', 'a'), v);
    assert.equal(await redis.hget('boardgame:test:h', 'zz'), null);
    assert.deepEqual(await redis.hgetall('boardgame:test:h'), { a: v, b: '{"x":2}' });
    assert.deepEqual(await redis.hgetall('boardgame:test:none'), {});
    assert.equal(Number(await redis.hdel('boardgame:test:h', 'b')), 1);
    assert.equal(await redis.get('boardgame:test:cnt'), null);
    assert.equal(Number(await redis.eval(FAIL_SCRIPT, ['boardgame:test:cnt'], ['900'])), 1);
    assert.equal(Number(await redis.eval(FAIL_SCRIPT, ['boardgame:test:cnt'], ['900'])), 2);
    assert.equal(await redis.get('boardgame:test:cnt'), '2', '숫자도 문자열 그대로');
    assert.equal(await resp.cmd('TTL', 'boardgame:test:cnt') > 890, true);
    const r1 = await redis.eval(UPSERT_SCRIPT, ['boardgame:test:cas'], ['id1', '', v, '10']);
    assert.deepEqual(r1, ['ok', '']);
    const r2 = await redis.eval(UPSERT_SCRIPT, ['boardgame:test:cas'], ['id1', '', '{}', '10']);
    assert.deepEqual(r2, ['conflict', v]);
    // boardgame: 밖의 키는 요청을 보내지 않음
    const before = shim.requests.length;
    await assert.rejects(redis.hgetall('mahjong:games'), /밖의 키/);
    await assert.rejects(redis.eval(UPSERT_SCRIPT, ['mahjong:games'], ['id1', '', v, '10']), /밖의 키/);
    assert.equal(shim.requests.length, before);
    await resp.cmd('DEL', 'boardgame:test:h', 'boardgame:test:cnt', 'boardgame:test:cas');
  });

  test('핸들러 왕복: 저장 → 읽기 → 충돌(409, 최신본) → 삭제', async () => {
    await resp.cmd('DEL', RECORDS_KEY);
    const record = {
      type: 'murdermystery', date: '2026-09-02', title: '붉은 저택의 초대 🔪', members: ['m1', 'm2'], rating: 4.5,
      review: '집사가 범인!\n두 줄째', spoiler: true, tags: ['반전'],
      mm: { publisher: '머더랩', roles: [{ memberId: 'm1', character: '집사', culprit: true, outcome: 'win' }], culpritResult: 'escaped' },
    };
    let res = await call('records', { method: 'POST', body: { record } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const saved = res.body.record;
    assert.equal(saved.title, '붉은 저택의 초대 🔪');

    res = await call('data');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.body.records.length, 1);
    assert.deepEqual(res.body.records[0], saved);

    res = await call('records', { method: 'POST', body: { record: { ...saved, title: '다른 기기' }, baseUpdatedAt: saved.updatedAt } });
    assert.equal(res.statusCode, 200);
    const newer = res.body.record;
    res = await call('records', { method: 'POST', body: { record: { ...saved, title: '늦은 저장' }, baseUpdatedAt: saved.updatedAt } });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'conflict');
    assert.deepEqual(res.body.current, newer);

    res = await call('records', { method: 'DELETE', query: { id: saved.id } });
    assert.deepEqual(res.body, { ok: true });
    res = await call('records', { method: 'DELETE', query: { id: saved.id } });
    assert.equal(res.statusCode, 404);
  });

  test('멤버: 저장·중복 이름 거부', async () => {
    let res = await call('members', { method: 'POST', body: { member: { name: '연경', emoji: '🐰', color: 'c2' } } });
    assert.equal(res.statusCode, 200);
    res = await call('members', { method: 'POST', body: { member: { name: ' 연경 ' } } });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.reason, 'duplicate');
    res = await call('data');
    assert.equal(res.body.members.length, 1);
    assert.equal(res.body.members[0].emoji, '🐰');
  });

  test('무차별 대입: 실패 20번 뒤 429 (카운터는 Redis 에, 15분 만료)', async () => {
    const ip = '10.9.9.9';
    for (let i = 0; i < 20; i++) {
      const res = await call('data', { key: `wrong-${i}`, ip });
      assert.equal(res.statusCode, 401);
    }
    assert.equal(Number(await resp.cmd('GET', `boardgame:fail:${ip}`)), 20);
    assert.ok((await resp.cmd('TTL', `boardgame:fail:${ip}`)) > 0);
    const res = await call('data', { ip });
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, { error: 'too_many_attempts' });
    const other = await call('data', { ip: '10.9.9.10' });
    assert.equal(other.statusCode, 200);
  });

  test('사진: 최대 크기 업로드 → 바이너리 조회 (파일은 Blob, Redis 로 가는 요청은 모두 작음 — 사진 데이터 없음)', async () => {
    await resp.cmd('DEL', PHOTOS_KEY);
    const full = fakeJpeg(MAX_FULL_BYTES, 3);
    const thumb = fakeWebp(MAX_THUMB_BYTES, 4);
    shim.requests.length = 0;
    let res = await call('images', { method: 'POST', body: { full: full.toString('base64'), thumb: thumb.toString('base64') } });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { image } = res.body;
    assert.equal(image.mime, 'image/jpeg');
    assert.equal(image.mimeT, 'image/webp');
    assert.ok(shim.requests.length >= 2);
    const biggest = Math.max(...shim.requests.map((r) => r.bytes));
    assert.ok(biggest < 8 * 1024, `가장 큰 Redis 요청 ${biggest} bytes`);
    assert.deepEqual(shim.requests.flatMap((r) => r.cmds).filter((c) => c === 'set'), [], 'SET 없음 (사진 데이터를 Redis 에 쓰지 않음)');
    const stored = JSON.parse(await resp.cmd('HGET', PHOTOS_KEY, image.id));
    assert.deepEqual(stored, { ...image, full: stored.full, thumb: stored.thumb });
    assert.ok((await blob.get(stored.full)).equals(full));

    for (const [size, bytes, mime] of [['f', full, 'image/jpeg'], ['t', thumb, 'image/webp']]) {
      res = await call('images', { query: { id: image.id, size } });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], mime);
      assert.equal(res.headers['cache-control'], 'private, max-age=604800, immutable');
      assert.ok(res.raw.equals(bytes), size);
    }
    res = await call('images', { query: { stats: '1' } });
    assert.equal(res.body.count, 1);
    assert.equal(res.body.bytes, MAX_FULL_BYTES + MAX_THUMB_BYTES);
    res = await call('images', { query: { id: 'nope', size: 't' } });
    assert.equal(res.statusCode, 404);
  });

  test('사진: 가져오기 멱등(existed) · 기록 참조 확인 · 삭제 시 정리 · in_use · gc (Lua 결과가 클라이언트를 거쳐도 그대로)', async () => {
    await resp.cmd('DEL', PHOTOS_KEY, RECORDS_KEY);
    let clock = Date.parse('2026-09-01T00:00:00.000Z');
    const files = createMemoryBlob();
    const timed = createHandlers({ redis, blob: files, env: { APP_SECRET: SECRET }, now: () => new Date(clock), logger: { error: (...a) => errors.push(a.join(' ')) } });
    const tcall = async (route, { method = 'GET', body, query = {} } = {}) => {
      const res = mockRes();
      await timed[route]({ method, headers: { 'x-app-key': SECRET, 'x-forwarded-for': '10.0.0.9' }, query, body }, res);
      return res;
    };
    const up = (id, seed) =>
      tcall('images', { method: 'POST', body: { id, full: fakeJpeg(3000, seed).toString('base64'), thumb: fakeJpeg(300, seed).toString('base64') } });
    const filesOf = (id) => files.paths().filter((p) => p.startsWith(`boardgame/photos/${id}-`));

    let res = await up('imp-a', 1);
    assert.equal(res.statusCode, 200);
    const metaA = res.body.image;
    clock += 1000;
    res = await up('imp-a', 2);
    assert.deepEqual(res.body, { image: metaA, existed: true });
    assert.equal((await up('imp-b', 3)).statusCode, 200);
    assert.equal((await up('imp-c', 4)).statusCode, 200);

    const record = { type: 'escaperoom', date: '2026-09-03', title: '저주받은 병동 👻', members: [] };
    res = await tcall('records', { method: 'POST', body: { record: { ...record, photos: ['imp-a', 'ghost'] } } });
    assert.deepEqual(res.body, { error: 'invalid', field: 'photos', missing: ['ghost'] });
    res = await tcall('records', { method: 'POST', body: { record: { ...record, photos: ['imp-a', 'imp-b'] } } });
    assert.equal(res.statusCode, 200);
    const saved = res.body.record;
    assert.deepEqual(saved.photos, ['imp-a', 'imp-b']);

    res = await tcall('images', { method: 'DELETE', query: { id: 'imp-a' } });
    assert.deepEqual(res.body, { error: 'in_use' });
    res = await tcall('records', { method: 'POST', body: { record: { ...saved, photos: ['imp-b'] }, baseUpdatedAt: saved.updatedAt } });
    assert.equal(res.statusCode, 200);
    // 빠진 사진은 바로 지우지 않고 빠진 시각만 적음 (하루 유예)
    assert.equal(JSON.parse(await resp.cmd('HGET', PHOTOS_KEY, 'imp-a')).touchedAt, new Date(clock).toISOString());
    assert.equal(filesOf('imp-a').length, 2);
    // 사진을 모르는 예전 앱이 photos 없이 고쳐 저장해도 사진은 그대로
    const cur = res.body.record;
    const { photos, ...legacy } = cur;
    res = await tcall('records', { method: 'POST', body: { record: { ...legacy, title: '예전 앱에서 고침' }, baseUpdatedAt: cur.updatedAt } });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.record.photos, photos);

    clock += 24 * 60 * 60 * 1000;
    res = await tcall('records', { method: 'DELETE', query: { id: saved.id } });
    assert.deepEqual(res.body, { ok: true });
    // 기록을 지울 때 하루 지난 imp-a 는 파일까지 함께 정리, 방금 빠진 imp-b 는 유예
    assert.equal(await resp.cmd('HEXISTS', PHOTOS_KEY, 'imp-a'), 0);
    assert.deepEqual(filesOf('imp-a'), []);
    assert.equal(await resp.cmd('HEXISTS', PHOTOS_KEY, 'imp-b'), 1);

    res = await tcall('images', { method: 'POST', query: { action: 'gc' } });
    assert.deepEqual(res.body, { deleted: 1 }, '기록에 붙은 적 없는 imp-c 만');
    clock += 24 * 60 * 60 * 1000;
    res = await tcall('images', { method: 'POST', query: { action: 'gc' } });
    assert.deepEqual(res.body, { deleted: 1 });
    assert.deepEqual(files.paths(), []);
    assert.equal(await resp.cmd('EXISTS', PHOTOS_KEY), 0);
  });

  test('자동 파이프라이닝 경로도 사용됨 (동시 명령이 /pipeline 으로 묶임)', () => {
    assert.ok(shim.log.some((l) => l.startsWith('pipeline:')), shim.log.join(' '));
    assert.deepEqual(errors, []);
  });
});
