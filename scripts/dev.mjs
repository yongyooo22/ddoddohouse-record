// 로컬 개발 서버 — 정적 파일 + vercel.json 헤더 흉내 (서버 저장소 없음: 기록은 브라우저 IndexedDB 에만)
// 실행: npm run dev   (PORT, HOST 환경변수로 변경 가능)
// 테스트에서: const { url, close } = await startDevServer({ port: 0 });
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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

async function serveStatic(root, pathname, req, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    rel = null;
  }
  if (rel === '/') rel = '/index.html';
  const segments = rel ? rel.split('/').filter(Boolean) : [];
  // 숨김 파일(.git, .env 등)과 node_modules·개발용 폴더는 내보내지 않음
  const blocked = !rel || rel.includes('\0') ||
    segments.some((s) => s.startsWith('.') || s === 'node_modules') ||
    ['tests', 'scripts', 'test-results'].includes(segments[0]);
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
 * @param {{port?:number, host?:string, root?:string}} [opts]  port 0 = 임의 포트
 * @returns {Promise<{url:string, port:number, close:() => Promise<void>}>}
 */
export async function startDevServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  const root = path.resolve(opts.root ?? ROOT);
  const headerRules = loadHeaderRules(root);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      applyHeaderRules(headerRules, url.pathname, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD');
        res.end();
        return;
      }
      await serveStatic(root, url.pathname, req, res);
    } catch (err) {
      console.error('[dev] error', err);
      if (!res.headersSent) { res.statusCode = 500; res.end('server error'); } else res.end();
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
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

// 직접 실행 시
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { url, close } = await startDevServer();
  console.log(`또또하우스 기록장 개발 서버: ${url}`);
  console.log('기록은 브라우저(IndexedDB)에만 저장돼요. 종료: Ctrl+C');
  const stop = () => close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
