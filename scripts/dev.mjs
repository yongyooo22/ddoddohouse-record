// 로컬 개발 서버 — 정적 파일 + /api/* (인메모리 가짜 Redis) + vercel.json 헤더 흉내
// 실행: npm run dev   (PORT, APP_SECRET, HOST 환경변수로 변경 가능)
// 테스트에서: const { url, close } = await startDevServer({ port: 0 });
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandlers, UPSERT_SCRIPT, RECORD_DELETE_SCRIPT, MAX_BODY_BYTES } from '../lib/handler.js';
import { FAIL_SCRIPT, PUBLIC_DEV_SECRET } from '../lib/auth.js';
import {
  IMAGE_ADD_SCRIPT,
  IMAGE_COMMIT_SCRIPT,
  IMAGE_DELETE_SCRIPT,
  IMAGE_ROLLBACK_SCRIPT,
  MAX_IMAGE_BODY_BYTES,
  PENDING_MARK,
} from '../lib/images.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_DEV_SECRET = PUBLIC_DEV_SECRET;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

// ── 인메모리 가짜 Redis (lib/redis.js 인터페이스와 동일) ─────────────

/**
 * handler가 쓰는 명령만 구현한 가짜 Redis. 값은 실제 Upstash 클라이언트(automaticDeserialization: false)처럼 문자열.
 * EVAL은 lib/handler.js의 UPSERT_SCRIPT·RECORD_DELETE_SCRIPT, lib/auth.js의 FAIL_SCRIPT, lib/images.js의
 * IMAGE_ADD_SCRIPT·IMAGE_COMMIT_SCRIPT·IMAGE_ROLLBACK_SCRIPT·IMAGE_DELETE_SCRIPT만 지원하며
 * 같은 로직(문자열 패턴까지)을 JS로 수행한다.
 * @param {{ now?: () => number }} [opts]  만료 계산용 시계(ms)
 */
export function createMemoryRedis({ now = Date.now } = {}) {
  const strings = new Map();
  const hashes = new Map();
  const expiresAt = new Map();

  function purge(key) {
    const t = expiresAt.get(key);
    if (t !== undefined && t <= now()) {
      strings.delete(key);
      hashes.delete(key);
      expiresAt.delete(key);
    }
  }
  function wrongType() {
    return new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  }
  function hash(key, create) {
    purge(key);
    if (strings.has(key)) throw wrongType();
    let h = hashes.get(key);
    if (!h && create) hashes.set(key, (h = new Map()));
    return h;
  }
  function str(key) {
    purge(key);
    if (hashes.has(key)) throw wrongType();
    return strings.has(key) ? strings.get(key) : null;
  }
  function dropIfEmpty(key) {
    const h = hashes.get(key);
    if (h && h.size === 0) {
      hashes.delete(key);
      expiresAt.delete(key);
    }
  }

  return {
    async hgetall(key) {
      return Object.fromEntries(hash(key, false) ?? []);
    },
    async hget(key, field) {
      const h = hash(key, false);
      return h && h.has(String(field)) ? h.get(String(field)) : null;
    },
    async hset(key, values) {
      const h = hash(key, true);
      let added = 0;
      for (const [f, v] of Object.entries(values)) {
        if (!h.has(f)) added++;
        h.set(f, String(v));
      }
      return added;
    },
    async hdel(key, ...fields) {
      const h = hash(key, false);
      if (!h) return 0;
      let n = 0;
      for (const f of fields) if (h.delete(String(f))) n++;
      dropIfEmpty(key);
      return n;
    },
    async hlen(key) {
      return hash(key, false)?.size ?? 0;
    },
    async hexists(key, field) {
      return hash(key, false)?.has(String(field)) ? 1 : 0;
    },
    async get(key) {
      return str(key);
    },
    async set(key, value) {
      // SET 은 종류와 만료를 가리지 않고 덮어씀
      purge(key);
      hashes.delete(key);
      expiresAt.delete(key);
      strings.set(key, String(value));
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys) {
        purge(key);
        if (strings.delete(key) || hashes.delete(key)) n++;
        expiresAt.delete(key);
      }
      return n;
    },
    async incr(key) {
      const cur = str(key);
      const n = cur === null ? 0 : Number(cur);
      if (!Number.isInteger(n)) throw new Error('ERR value is not an integer or out of range');
      strings.set(key, String(n + 1));
      return n + 1;
    },
    async expire(key, seconds) {
      purge(key);
      if (!strings.has(key) && !hashes.has(key)) return 0;
      expiresAt.set(key, now() + Number(seconds) * 1000);
      return 1;
    },
    async eval(script, keys, args) {
      if (script === FAIL_SCRIPT) {
        // INCR + EXPIRE (실제 Redis에서는 Lua 하나로 원자적)
        const key = keys[0];
        const cur = str(key);
        const n = cur === null ? 0 : Number(cur);
        if (!Number.isInteger(n)) throw new Error('ERR value is not an integer or out of range');
        strings.set(key, String(n + 1));
        expiresAt.set(key, now() + Number(args[0]) * 1000);
        return n + 1;
      }
      // 모든 기록이 가리키는 사진 id + 게임 정보의 대표 이미지 (Lua 의 refs 조각과 같은 패턴)
      const refsOf = (recordsKey, gamesKey) => {
        const refs = new Set();
        for (const rec of hash(recordsKey, false)?.values() ?? []) {
          const list = /"photos":\[([^\]]*)\]/.exec(rec);
          if (list) for (const m of list[1].matchAll(/"([^"]*)"/g)) refs.add(m[1]);
        }
        for (const g of (gamesKey ? hash(gamesKey, false)?.values() : null) ?? []) {
          const cover = /"cover":"([^"]*)"/.exec(g);
          if (cover) refs.add(cover[1]);
        }
        return refs;
      };
      const exists = (...ks) => ks.filter((k) => str(k) !== null).length;
      const hdelField = (key, field) => {
        hash(key, false)?.delete(field);
        dropIfEmpty(key);
      };
      if (script === IMAGE_ADD_SCRIPT) {
        const [id, meta, bytes, maxCount, maxBytes, at] = args.map(String);
        const h = hash(keys[0], false);
        if (h?.has(id)) {
          hash(keys[3], true).set(id, at);
          const cur = h.get(id);
          return [cur.includes(PENDING_MARK) || exists(keys[1], keys[2]) < 2 ? 'incomplete' : 'exists', cur];
        }
        const vals = [...(h?.values() ?? [])];
        if (vals.length >= Number(maxCount)) return ['limit', 'count'];
        let total = Number(bytes);
        for (const v of vals) total += Number(/"bytesF":(\d+)/.exec(v)?.[1] ?? 0) + Number(/"bytesT":(\d+)/.exec(v)?.[1] ?? 0);
        if (total > Number(maxBytes)) return ['limit', 'bytes'];
        hash(keys[0], true).set(id, meta);
        return ['ok', ''];
      }
      if (script === IMAGE_COMMIT_SCRIPT) {
        if (exists(keys[1], keys[2]) < 2) return 'incomplete';
        hash(keys[0], true).set(String(args[0]), String(args[1]));
        return 'ok';
      }
      if (script === IMAGE_ROLLBACK_SCRIPT) {
        const id = String(args[0]);
        const cur = hash(keys[1], false)?.get(id);
        if (cur !== undefined && !cur.includes(PENDING_MARK)) return 'kept';
        if (cur !== undefined && refsOf(keys[0], keys[4]).has(id)) return 'in_use';
        if (cur !== undefined) hdelField(keys[1], id);
        strings.delete(keys[2]);
        strings.delete(keys[3]);
        return 'deleted';
      }
      if (script === IMAGE_DELETE_SCRIPT) {
        const refs = refsOf(keys[0], keys[3]);
        const [cutoff, ...ids] = args.map(String);
        return ids.map((id, i) => {
          const touched = hash(keys[2], false)?.get(id);
          if (!hash(keys[1], false)?.has(id)) {
            if (touched !== undefined) hdelField(keys[2], id);
            return 'missing';
          }
          if (refs.has(id)) {
            if (touched !== undefined) hdelField(keys[2], id);
            return 'in_use';
          }
          if (cutoff !== '' && touched !== undefined && touched > cutoff) return 'young';
          strings.delete(keys[4 + 2 * i]);
          strings.delete(keys[5 + 2 * i]);
          hdelField(keys[1], id);
          if (touched !== undefined) hdelField(keys[2], id);
          return 'deleted';
        });
      }
      if (script === RECORD_DELETE_SCRIPT) {
        const h = hash(keys[0], false);
        const id = String(args[0]);
        if (!h?.has(id)) return null;
        const cur = h.get(id);
        hdelField(keys[0], id);
        return cur;
      }
      if (script !== UPSERT_SCRIPT) throw new Error('fake redis: unsupported script');
      const [hashKey, metaKey] = keys;
      const [field, expected, value, max, ...photos] = args.map(String);
      const h = hash(hashKey, false);
      const cur = h?.get(field) ?? '';
      if (cur !== expected) return ['conflict', cur];
      if (cur === '' && (h?.size ?? 0) >= Number(max)) return ['limit', ''];
      const missing = photos.filter((p) => {
        const m = hash(metaKey, false)?.get(p);
        return m === undefined || m.includes(PENDING_MARK);
      });
      if (missing.length) return ['missing', missing.join(',')];
      hash(hashKey, true).set(field, value);
      return ['ok', ''];
    },
    // ── 테스트 보조 (handler는 쓰지 않음) ──
    ttl(key) {
      purge(key);
      if (!strings.has(key) && !hashes.has(key)) return -2;
      const t = expiresAt.get(key);
      return t === undefined ? -1 : Math.ceil((t - now()) / 1000);
    },
    flushall() {
      strings.clear();
      hashes.clear();
      expiresAt.clear();
    },
  };
}

// ── vercel.json 헤더 흉내 ─────────────────────────────────────

/** Vercel source 패턴(path-to-regexp 부분집합: "(정규식)", ":name", ":name*")을 RegExp로 */
export function sourceToRegExp(source) {
  let re = '';
  for (const part of source.split(/(\([^)]*\)|:[A-Za-z_]\w*\*?)/)) {
    if (!part) continue;
    if (part.startsWith('(')) re += part;
    else if (part.startsWith(':')) re += part.endsWith('*') ? '.*' : '[^/]+';
    else re += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function loadHeaderRules(root) {
  try {
    const cfg = JSON.parse(readFileSync(path.join(root, 'vercel.json'), 'utf8'));
    return (cfg.headers || []).map((r) => ({ re: sourceToRegExp(r.source), headers: r.headers || [] }));
  } catch {
    return [];
  }
}

function applyHeaderRules(rules, pathname, res) {
  for (const rule of rules) {
    if (!rule.re.test(pathname)) continue;
    for (const { key, value } of rule.headers) res.setHeader(key, value);
  }
}

// ── 요청 처리 ────────────────────────────────────────────────

/** Vercel Node 런타임의 res 도우미(status/json/send) 흉내 */
export function enhanceResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (body) => {
    if (body === undefined || body === null) {
      res.end();
    } else if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    } else if (typeof body === 'string') {
      if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', String(Buffer.byteLength(body)));
      res.end(body);
    } else {
      res.json(body);
    }
    return res;
  };
  return res;
}

/** 본문 읽기 (한도 초과면 null) */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Vercel처럼 content-type에 따라 req.body 설정. 잘못된 JSON이면 접근 시 throw */
function attachBody(req, buf) {
  let value;
  let error = null;
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (!buf || buf.length === 0) value = undefined;
  else if (type.includes('json')) {
    try {
      value = JSON.parse(buf.toString('utf8'));
    } catch {
      error = new Error('Invalid JSON');
    }
  } else if (type.startsWith('text/')) value = buf.toString('utf8');
  else value = buf;
  Object.defineProperty(req, 'body', {
    configurable: true,
    get() {
      if (error) throw error;
      return value;
    },
  });
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

async function serveStatic(root, pathname, req, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = null;
  }
  if (rel === '/') rel = '/index.html';
  const segments = rel ? rel.split('/').filter(Boolean) : [];
  // 숨김 파일(.git, .env 등)과 node_modules는 내보내지 않음
  const blocked =
    !rel || rel.includes('\0') || segments.some((s) => s.startsWith('.') || s === 'node_modules');
  const file = blocked ? null : path.resolve(root, '.' + rel);
  if (file && (file === root || file.startsWith(root + path.sep))) {
    try {
      const st = await stat(file);
      if (st.isFile()) {
        const data = await readFile(file);
        res.statusCode = 200;
        if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
        res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', data.length);
        res.end(req.method === 'HEAD' ? undefined : data);
        return;
      }
    } catch {
      // 아래 404로
    }
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(req.method === 'HEAD' ? undefined : '404 Not Found');
}

/**
 * 개발 서버 시작.
 * @param {object} [opts]
 * @param {number} [opts.port]     기본 env PORT 또는 3000 (0 = 임의 포트)
 * @param {string} [opts.host]     기본 env HOST 또는 127.0.0.1
 * @param {string} [opts.secret]   기본 env APP_SECRET 또는 'dev-secret-key-1234'
 * @param {object} [opts.redis]    주입할 redis (기본: 새 인메모리 가짜)
 * @param {string} [opts.root]     정적 파일 루트 (기본: 저장소 루트)
 * @param {object} [opts.logger]   API 서버 로그 (기본 console)
 * @returns {Promise<{url:string, port:number, secret:string, redis:object, close:() => Promise<void>}>}
 */
export async function startDevServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const secret = opts.secret ?? process.env.APP_SECRET ?? DEFAULT_DEV_SECRET;
  const root = path.resolve(opts.root ?? ROOT);
  const redis = opts.redis ?? createMemoryRedis();
  const handlers = createHandlers({ redis, env: { APP_SECRET: secret }, logger: opts.logger ?? console });
  const routes = {
    '/api/data': handlers.data,
    '/api/records': handlers.records,
    '/api/members': handlers.members,
    '/api/games': handlers.games,
    '/api/images': handlers.images,
  };
  // 사진 업로드만 1.5MB, 나머지는 64KB (배포에서는 Vercel 이 본문을 받고 handler 가 같은 한도로 다시 확인)
  const bodyLimits = { '/api/images': MAX_IMAGE_BODY_BYTES };
  const headerRules = loadHeaderRules(root);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      applyHeaderRules(headerRules, pathname, res);

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        const routePath = pathname.replace(/\/+$/, '');
        const route = Object.hasOwn(routes, routePath) ? routes[routePath] : null;
        if (!route) return sendJson(res, 404, { error: 'not_found' });
        // Vercel은 x-forwarded-for를 실제 접속 IP로 덮어쓴다
        req.headers['x-forwarded-for'] = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        req.query = Object.fromEntries(url.searchParams);
        if (!['GET', 'HEAD'].includes(req.method)) {
          const buf = await readRawBody(req, bodyLimits[routePath] ?? MAX_BODY_BYTES);
          if (buf === null) return sendJson(res, 413, { error: 'too_large' });
          attachBody(req, buf);
        } else {
          attachBody(req, null);
        }
        await route(req, enhanceResponse(res));
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        return res.end();
      }
      await serveStatic(root, pathname, req, res);
    } catch (err) {
      console.error('[dev] error', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  return {
    url: `http://${shownHost}:${actualPort}`,
    port: actualPort,
    secret,
    redis,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// 직접 실행 시
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { url, secret, close } = await startDevServer();
  console.log(`또또하우스 기록장 개발 서버: ${url}`);
  console.log(`공유 링크(키 포함): ${url}/#k=${encodeURIComponent(secret)}`);
  console.log('데이터는 메모리에만 저장돼요 (서버를 끄면 사라짐). 종료: Ctrl+C');
  const stop = () => close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
