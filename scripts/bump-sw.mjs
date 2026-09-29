// 서비스 워커 캐시 버전(CACHE_VERSION)을 올린다. 배포 전에 실행: npm run bump-sw
//   'v12' → 'v13', 'ddh-2026-09-29-3' → 'ddh-2026-09-29-4', 숫자로 안 끝나면 '-2'를 붙인다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SW_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sw.js');
const VERSION_RE = /(CACHE_VERSION\s*=\s*)(['"`])([^'"`\n]*)\2/;

export function nextVersion(v) {
  const m = /^(.*?)(\d+)$/.exec(v);
  if (!m) return `${v}-2`;
  const next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
  return m[1] + next;
}

/** sw.js 소스의 CACHE_VERSION을 올린 결과. 못 찾으면 null */
export function bumpSource(src) {
  const m = VERSION_RE.exec(src);
  if (!m) return null;
  const from = m[3];
  const to = nextVersion(from);
  return { from, to, src: src.replace(VERSION_RE, (_, lhs, q) => lhs + q + to + q) };
}

export function bumpFile(file = SW_FILE) {
  if (!existsSync(file)) {
    console.log('sw.js가 아직 없어요 — 건너뜀');
    return null;
  }
  const result = bumpSource(readFileSync(file, 'utf8'));
  if (!result) {
    console.error("sw.js에서 CACHE_VERSION = '...' 을 찾지 못했어요");
    process.exitCode = 1;
    return null;
  }
  writeFileSync(file, result.src);
  console.log(`캐시 버전: ${result.from} → ${result.to}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  bumpFile();
}
