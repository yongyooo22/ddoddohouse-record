// 실제 @upstash/redis 클라이언트 경로 검증 (redis-server 가 있을 때만)
// Upstash REST API 를 흉내 내는 작은 HTTP 서버(단일 명령 + /pipeline, base64 응답 인코딩)를
// 로컬 redis-server 앞에 세우고, lib/redis.js 의 createRedisFromEnv() → lib/handler.js 까지
// 배포 환경과 같은 코드로 돌려 본다. (자동 파이프라이닝·base64 디코딩·역직렬화 끄기 확인)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createRedisFromEnv } from '../lib/redis.js';
import { createHandlers, UPSERT_SCRIPT, RECORDS_KEY } from '../lib/handler.js';

const hasRedisServer = spawnSync('redis-server', ['--version']).status === 0;
const SECRET = 'upstash-test-secret-0123456789';
const TOKEN = 'rest-token-for-tests';

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** 최소 RESP 클라이언트 (응답은 요청 순서대로 옴) */
function respClient(port) {
  const sock = net.createConnection({ port, host: '127.0.0.1' });
  let buf = Buffer.alloc(0);
  const pending = [];
  function parse(b, i) {
    const eol = b.indexOf('\r\n', i);
    if (eol < 0) return null;
    const type = String.fromCharCode(b[i]);
    const line = b.toString('utf8', i + 1, eol);
    const next = eol + 2;
    if (type === '+') return [line, next];
    if (type === '-') return [new Error(line), next];
    if (type === ':') return [Number(line), next];
    if (type === '$') {
      const len = Number(line);
      if (len < 0) return [null, next];
      if (b.length < next + len + 2) return null;
      return [b.toString('utf8', next, next + len), next + len + 2];
    }
    if (type === '*') {
      const n = Number(line);
      if (n < 0) return [null, next];
      const out = [];
      let pos = next;
      for (let k = 0; k < n; k++) {
        const r = parse(b, pos);
        if (!r) return null;
        out.push(r[0]);
        pos = r[1];
      }
      return [out, pos];
    }
    throw new Error(`RESP type ${type}`);
  }
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (pending.length) {
      const r = parse(buf, 0);
      if (!r) return;
      buf = buf.subarray(r[1]);
      const p = pending.shift();
      if (r[0] instanceof Error) p.reject(r[0]);
      else p.resolve(r[0]);
    }
  });
  const ready = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  function cmd(...args) {
    const parts = [`*${args.length}\r\n`];
    for (const a of args) {
      const s = String(a);
      parts.push(`$${Buffer.byteLength(s)}\r\n${s}\r\n`);
    }
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      sock.write(parts.join(''));
    });
  }
  return { cmd, ready, close: () => sock.end() };
}

/** Upstash REST 흉내: POST / (명령 하나), POST /pipeline (여러 개). Upstash-Encoding: base64 지원 */
function restShim(redis) {
  const log = [];
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
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const path = new URL(req.url, 'http://x').pathname;
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
  return { server, log };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    headersSent: false,
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return this.headers[k.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = JSON.parse(JSON.stringify(obj));
      this.headersSent = true;
      return this;
    },
  };
}

describe('실제 Upstash 클라이언트 + REST 흉내 서버 + redis-server', { skip: hasRedisServer ? false : 'redis-server 없음' }, () => {
  let proc;
  let resp;
  let shim;
  let url;
  let redis;
  let handlers;
  const errors = [];

  async function call(route, { method = 'GET', key = SECRET, ip = '10.0.0.9', body, query = {} } = {}) {
    const res = mockRes();
    await handlers[route]({ method, headers: { 'x-app-key': key, 'x-forwarded-for': ip }, query, body }, res);
    return res;
  }

  before(async () => {
    const port = await freePort();
    proc = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      try {
        resp = respClient(port);
        await resp.ready;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await resp.cmd('FLUSHALL');
    shim = restShim(resp);
    await new Promise((r) => shim.server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${shim.server.address().port}`;
    // Vercel 의 Upstash 연동이 넣어 주는 이름 그대로
    redis = createRedisFromEnv({ KV_REST_API_URL: url, KV_REST_API_TOKEN: TOKEN });
    handlers = createHandlers({ redis, env: { APP_SECRET: SECRET }, logger: { error: (...a) => errors.push(a.join(' ')) } });
  });

  after(async () => {
    shim?.server.closeAllConnections?.();
    await new Promise((r) => (shim ? shim.server.close(r) : r()));
    resp?.close();
    proc?.kill();
  });

  test('어댑터: 문자열(한글·이모지)·해시·카운터·EVAL 이 그대로 오감', async () => {
    const v = JSON.stringify({ title: '붉은 저택 🔪 "따옴표"', n: 1 });
    assert.equal(await redis.hset('t:h', { a: v, b: '{"x":2}' }), 2);
    assert.equal(await redis.hget('t:h', 'a'), v);
    assert.equal(await redis.hget('t:h', 'zz'), null);
    assert.deepEqual(await redis.hgetall('t:h'), { a: v, b: '{"x":2}' });
    assert.deepEqual(await redis.hgetall('t:none'), {});
    assert.equal(await redis.hlen('t:h'), 2);
    assert.equal(Number(await redis.hdel('t:h', 'b')), 1);
    assert.equal(await redis.get('t:cnt'), null);
    assert.equal(await redis.incr('t:cnt'), 1);
    assert.equal(await redis.incr('t:cnt'), 2);
    assert.equal(Number(await redis.get('t:cnt')), 2);
    assert.equal(Number(await redis.expire('t:cnt', 900)), 1);
    assert.equal(await resp.cmd('TTL', 't:cnt') > 890, true);
    const r1 = await redis.eval(UPSERT_SCRIPT, ['t:cas'], ['id1', '', v, '10']);
    assert.deepEqual(r1, ['ok', '']);
    const r2 = await redis.eval(UPSERT_SCRIPT, ['t:cas'], ['id1', '', '{}', '10']);
    assert.deepEqual(r2, ['conflict', v]);
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
    assert.equal(Number(await resp.cmd('GET', `ddh:fail:${ip}`)), 20);
    assert.ok((await resp.cmd('TTL', `ddh:fail:${ip}`)) > 0);
    const res = await call('data', { ip });
    assert.equal(res.statusCode, 429);
    assert.deepEqual(res.body, { error: 'too_many_attempts' });
    const other = await call('data', { ip: '10.9.9.10' });
    assert.equal(other.statusCode, 200);
  });

  test('자동 파이프라이닝 경로도 사용됨 (동시 명령이 /pipeline 으로 묶임)', () => {
    assert.ok(shim.log.some((l) => l.startsWith('pipeline:')), shim.log.join(' '));
    assert.deepEqual(errors, []);
  });
});
