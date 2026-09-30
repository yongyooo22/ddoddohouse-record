// 로컬 개발 서버 — 정적 파일 + /api/* (인메모리 가짜 Redis·가짜 사진 저장소) + vercel.json 헤더 흉내
// 실행: npm run dev   (PORT, APP_SECRET, HOST 환경변수로 변경 가능)
// 테스트에서: const { url, close } = await startDevServer({ port: 0 });
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHandlers, UPSERT_SCRIPT, RECORD_DELETE_SCRIPT, MAX_BODY_BYTES } from '../lib/handler.js';
import { FAIL_SCRIPT, PUBLIC_DEV_SECRET } from '../lib/auth.js';
import { KEY_PREFIX, PHOTO_PATH_PREFIX, isOwnKey, isOwnPath } from '../lib/keys.js';
import {
  IMAGE_COMMIT_SCRIPT,
  IMAGE_DELETE_SCRIPT,
  IMAGE_FORGET_SCRIPT,
  IMAGE_GC_SCRIPT,
  IMAGE_RELEASE_SCRIPT,
  IMAGE_RESERVE_SCRIPT,
  IMAGE_ROLLBACK_SCRIPT,
  MAX_IMAGE_BODY_BYTES,
  STATE_MARK,
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
 * 실제 어댑터처럼 'boardgame:' 밖의 키는 거부한다 (테스트에서 이름공간을 벗어나는 코드를 잡아내게).
 * EVAL은 lib/handler.js의 UPSERT_SCRIPT·RECORD_DELETE_SCRIPT, lib/auth.js의 FAIL_SCRIPT, lib/images.js의
 * IMAGE_*_SCRIPT만 지원하며 같은 로직(문자열 패턴까지)을 JS로 수행한다.
 * hset·set·del 등은 테스트가 상태를 꾸미는 데 쓰는 보조 명령 (handler는 쓰지 않음).
 * @param {{ now?: () => number }} [opts]  만료 계산용 시계(ms)
 */
export function createMemoryRedis({ now = Date.now } = {}) {
  const strings = new Map();
  const hashes = new Map();
  const expiresAt = new Map();

  function own(key) {
    if (!isOwnKey(key)) throw new Error(`fake redis: '${KEY_PREFIX}' 밖의 키 (${key})`);
    return key;
  }
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
    own(key);
    purge(key);
    if (strings.has(key)) throw wrongType();
    let h = hashes.get(key);
    if (!h && create) hashes.set(key, (h = new Map()));
    return h;
  }
  function str(key) {
    own(key);
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

  // ── lib/images.js 의 Lua 조각과 같은 로직 ──
  const setField = (m, name, value) => {
    const s = m.split(new RegExp(`,"${name}":"[^"]*"`)).join('');
    return value === '' ? s : `${s.slice(0, -1)},"${name}":"${value}"}`;
  };
  const ready = (m) => !m.includes(STATE_MARK);
  const isoOf = (m, name) => new RegExp(`"${name}":"(\\d{4}-\\d{2}-\\d{2}T[^"]*)"`).exec(m)?.[1];

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
    async get(key) {
      return str(key);
    },
    async set(key, value) {
      // SET 은 종류와 만료를 가리지 않고 덮어씀
      own(key);
      purge(key);
      hashes.delete(key);
      expiresAt.delete(key);
      strings.set(key, String(value));
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const key of keys) {
        own(key);
        purge(key);
        if (strings.delete(key) || hashes.delete(key)) n++;
        expiresAt.delete(key);
      }
      return n;
    },
    async eval(script, keys, args) {
      keys.forEach(own);
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
      // 모든 기록이 가리키는 사진 id (Lua 의 REFS 조각과 같은 패턴)
      const refsOf = (recordsKey) => {
        const refs = new Set();
        for (const rec of hash(recordsKey, false)?.values() ?? []) {
          const list = /"photos":\[([^\]]*)\]/.exec(rec);
          if (list) for (const m of list[1].matchAll(/"([^"]*)"/g)) refs.add(m[1]);
        }
        return refs;
      };
      const hdelField = (key, field) => {
        hash(key, false)?.delete(field);
        dropIfEmpty(key);
      };
      // 정리 후보를 참조 확인 뒤 지울 차례로 (Lua 의 SWEEP 조각) → [id, 메타, …]
      const sweep = (cand, max) => {
        if (!cand.length) return [];
        const refs = refsOf(keys[0]);
        const out = [];
        for (const [id, m] of cand) {
          if (out.length >= 2 * max) break;
          if (refs.has(id)) {
            if (m.includes('"touchedAt":"')) hash(keys[1], true).set(id, setField(m, 'touchedAt', ''));
          } else {
            const d = setField(m, 'state', 'deleting');
            hash(keys[1], true).set(id, d);
            out.push(id, d);
          }
        }
        return out;
      };
      if (script === IMAGE_RESERVE_SCRIPT) {
        const [id, pending, bytes, maxCount, maxBytes, at, takeover] = args.map(String);
        const h = hash(keys[0], false);
        const cur = h?.get(id);
        if (cur === pending) return ['ok', ''];
        if (cur !== undefined && ready(cur)) {
          const t = setField(cur, 'touchedAt', at);
          h.set(id, t);
          return ['exists', t];
        }
        if (cur !== undefined) {
          if (takeover !== '1') return ['taken', ''];
          h.set(id, pending);
          return ['incomplete', cur];
        }
        const vals = [...(h?.values() ?? [])];
        if (vals.length >= Number(maxCount)) return ['limit', 'count'];
        let total = Number(bytes);
        for (const v of vals) total += Number(/"bytesF":(\d+)/.exec(v)?.[1] ?? 0) + Number(/"bytesT":(\d+)/.exec(v)?.[1] ?? 0);
        if (total > Number(maxBytes)) return ['limit', 'bytes'];
        hash(keys[0], true).set(id, pending);
        return ['ok', ''];
      }
      if (script === IMAGE_COMMIT_SCRIPT) {
        const [id, pending, meta] = args.map(String);
        const cur = hash(keys[0], false)?.get(id);
        if (cur === meta) return 'ok';
        if (cur !== pending) return 'lost';
        hash(keys[0], true).set(id, meta);
        return 'ok';
      }
      if (script === IMAGE_ROLLBACK_SCRIPT) {
        const [id, pending] = args.map(String);
        if (hash(keys[0], false)?.get(id) !== pending) return 0;
        hdelField(keys[0], id);
        return 1;
      }
      if (script === IMAGE_DELETE_SCRIPT) {
        const id = String(args[0]);
        const cur = hash(keys[1], false)?.get(id);
        if (cur === undefined) return ['missing', ''];
        if (refsOf(keys[0]).has(id)) return ['in_use', ''];
        const d = setField(cur, 'state', 'deleting');
        hash(keys[1], true).set(id, d);
        return ['deleting', d];
      }
      if (script === IMAGE_RELEASE_SCRIPT) {
        const [at, cutoff, max, ...released] = args.map(String);
        for (const id of released) {
          const m = hash(keys[1], false)?.get(id);
          if (m !== undefined && ready(m)) hash(keys[1], true).set(id, setField(m, 'touchedAt', at));
        }
        const cand = [...(hash(keys[1], false) ?? [])].filter(([, m]) => {
          const t = /"touchedAt":"([^"]*)"/.exec(m)?.[1];
          return t !== undefined && !(t > cutoff);
        });
        return sweep(cand, Number(max));
      }
      if (script === IMAGE_GC_SCRIPT) {
        const [at, cutoff, max, ...kept] = args.map(String);
        const keep = new Set(kept);
        const cand = [];
        for (const [id, m] of [...(hash(keys[1], false) ?? [])]) {
          if (keep.has(id)) {
            if (ready(m)) hash(keys[1], true).set(id, setField(m, 'touchedAt', at));
          } else {
            const c = isoOf(m, 'createdAt');
            const t = isoOf(m, 'touchedAt');
            if (!((c && c > cutoff) || (t && t > cutoff))) cand.push([id, m]);
          }
        }
        return sweep(cand, Number(max));
      }
      if (script === IMAGE_FORGET_SCRIPT) {
        let n = 0;
        for (let i = 0; i + 1 < args.length; i += 2) {
          const id = String(args[i]);
          if (hash(keys[0], false)?.get(id) === String(args[i + 1])) {
            hdelField(keys[0], id);
            n++;
          }
        }
        return n;
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
        return m === undefined || !ready(m);
      });
      if (missing.length) return ['missing', missing.join(',')];
      hash(hashKey, true).set(field, value);
      return ['ok', ''];
    },
    // ── 테스트 보조 (handler는 쓰지 않음) ──
    ttl(key) {
      own(key);
      purge(key);
      if (!strings.has(key) && !hashes.has(key)) return -2;
      const t = expiresAt.get(key);
      return t === undefined ? -1 : Math.ceil((t - now()) / 1000);
    },
    /** 들어 있는 키 이름 (테스트에서 이름공간 확인용) */
    keyNames() {
      return [...strings.keys(), ...hashes.keys()].sort();
    },
  };
}

// ── 인메모리 가짜 사진 저장소 (lib/blob.js 인터페이스와 동일) ──────────

/** Vercel Blob 대신 메모리에 파일을 두는 가짜. 실제 어댑터처럼 boardgame/photos/ 밖의 경로는 거부 */
export function createMemoryBlob() {
  const files = new Map(); // 경로 → { bytes, contentType }
  function own(pathname) {
    if (!isOwnPath(pathname)) throw new Error(`fake blob: '${PHOTO_PATH_PREFIX}' 밖의 경로 (${pathname})`);
    return pathname;
  }
  return {
    async put(pathname, bytes, contentType) {
      files.set(own(pathname), { bytes: Buffer.from(bytes), contentType });
    },
    async get(pathname) {
      const f = files.get(own(pathname));
      return f ? Buffer.from(f.bytes) : null;
    },
    async del(pathnames) {
      for (const p of pathnames) files.delete(own(p));
    },
    // ── 테스트 보조 ──
    paths() {
      return [...files.keys()].sort();
    },
    contentType(pathname) {
      return files.get(pathname)?.contentType ?? null;
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
 * @param {object} [opts.blob]     주입할 사진 저장소 (기본: 새 인메모리 가짜, null 이면 사진 저장소 없음)
 * @param {string} [opts.root]     정적 파일 루트 (기본: 저장소 루트)
 * @param {object} [opts.logger]   API 서버 로그 (기본 console)
 * @returns {Promise<{url:string, port:number, secret:string, redis:object, blob:object, close:() => Promise<void>}>}
 */
export async function startDevServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const secret = opts.secret ?? process.env.APP_SECRET ?? DEFAULT_DEV_SECRET;
  const root = path.resolve(opts.root ?? ROOT);
  const redis = opts.redis ?? createMemoryRedis();
  const blob = opts.blob === undefined ? createMemoryBlob() : opts.blob;
  const handlers = createHandlers({ redis, blob, env: { APP_SECRET: secret }, logger: opts.logger ?? console });
  const routes = {
    '/api/data': handlers.data,
    '/api/records': handlers.records,
    '/api/members': handlers.members,
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
    blob,
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
