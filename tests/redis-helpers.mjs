// 테스트 공용 도우미 — 최소 RESP 클라이언트, 로컬 redis-server 띄우기, Vercel 스타일 가짜 res, 가짜 사진 바이트
// (*.test.mjs 가 아니라서 node --test 가 따로 실행하지 않음)
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

export const hasRedisServer = spawnSync('redis-server', ['--version']).status === 0;

export async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** 최소 RESP 클라이언트 — 응답은 요청 순서대로 오고, 값은 Upstash 클라이언트처럼 raw 문자열 */
export function createRespClient(port) {
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

  const ready = new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });

  // Upstash 클라이언트(automaticDeserialization: false)와 같은 모양
  const raw = {
    hgetall: (k) => cmd('HGETALL', k),
    hget: (k, f) => cmd('HGET', k, f),
    hset: (k, obj) => cmd('HSET', k, ...Object.entries(obj).flat()),
    hdel: (k, ...f) => cmd('HDEL', k, ...f),
    hlen: (k) => cmd('HLEN', k),
    hexists: (k, f) => cmd('HEXISTS', k, f),
    get: (k) => cmd('GET', k),
    set: (k, v) => cmd('SET', k, v),
    del: (...k) => cmd('DEL', ...k),
    incr: (k) => cmd('INCR', k),
    expire: (k, s) => cmd('EXPIRE', k, s),
    eval: (script, keys, args) => cmd('EVAL', script, keys.length, ...keys, ...args),
  };
  return { raw, cmd, ready, close: () => sock.end() };
}

/** 임의 포트에 저장 안 하는 redis-server 를 띄우고 연결. 반환: { client, stop } */
export async function startRedisServer() {
  const port = await freePort();
  const proc = spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  let client;
  for (let i = 0; i < 50; i++) {
    try {
      client = createRespClient(port);
      await client.ready;
      break;
    } catch {
      client = null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!client) {
    proc.kill();
    throw new Error('redis-server 에 연결하지 못함');
  }
  await client.cmd('FLUSHALL');
  return {
    client,
    stop() {
      client.close();
      proc.kill();
    },
  };
}

/**
 * 가짜 JPEG — 서버가 읽는 구조만 갖춤: SOI · APP0(JFIF) · SOS 머리 · seed 로 채운 '압축 데이터' · EOI.
 * 메타데이터가 없어서 서버가 떼어 낼 것이 없으므로 저장된 바이트가 그대로 같아야 함. 최소 32바이트
 */
export function fakeJpeg(size = 2000, seed = 1) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ]);
  if (size < head.length + 2) throw new Error(`fakeJpeg: ${size} < ${head.length + 2}`);
  const b = Buffer.alloc(size);
  head.copy(b);
  // 압축 데이터 안에는 FF 가 (00 없이) 나오지 않게
  for (let i = head.length; i < size - 2; i++) {
    const v = (i * 31 + seed * 17) & 0xff;
    b[i] = v === 0xff ? 0xfe : v;
  }
  b[size - 2] = 0xff;
  b[size - 1] = 0xd9;
  return b;
}

/** 가짜 WebP (RIFF <크기> WEBP 'VP8 ' <청크 크기> …) — 청크 하나. 크기가 홀수면 마지막 채움 바이트가 빠진 모양 */
export function fakeWebp(size = 1500, seed = 1) {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 7 + seed * 13) & 0xff;
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(size - 8, 4);
  b.write('WEBPVP8 ', 8, 'latin1');
  b.writeUInt32LE(size - 20, 16);
  return b;
}

/** JPEG 의 SOI 바로 뒤에 표식 구간(APPn·COM 등)을 끼움 */
export function jpegWithSegments(jpeg, segments) {
  const parts = [jpeg.subarray(0, 2)];
  for (const [marker, payload] of segments) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(body.length + 2);
    parts.push(Buffer.from([0xff, marker]), len, body);
  }
  parts.push(jpeg.subarray(2));
  return Buffer.concat(parts);
}

/** WebP 에 청크를 덧붙이고 RIFF 크기를 맞춤. vp8x: 맨 앞에 VP8X(플래그) 청크 */
export function webpWithChunks(webp, chunks, vp8xFlags = null) {
  const body = [];
  if (vp8xFlags !== null) {
    const x = Buffer.alloc(18);
    x.write('VP8X', 0, 'latin1');
    x.writeUInt32LE(10, 4);
    x[8] = vp8xFlags;
    body.push(x);
  }
  body.push(webp.subarray(12));
  for (const [fourcc, payload] of chunks) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'latin1');
    const head = Buffer.alloc(8);
    head.write(fourcc, 0, 'latin1');
    head.writeUInt32LE(data.length, 4);
    body.push(head, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0));
  }
  const all = Buffer.concat(body);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + all.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, all]);
}

/** Vercel Node 런타임 res 흉내 — json() 과 바이너리 end(Buffer) 를 모두 받음 */
export function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    raw: undefined,
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
    end(chunk) {
      this.raw = chunk === undefined ? Buffer.alloc(0) : Buffer.from(chunk);
      this.headersSent = true;
      return this;
    },
  };
}
