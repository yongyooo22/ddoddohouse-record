// 정적 셸 점검 — 서비스 워커 사전 캐시 목록이 실제 파일과 맞는지, HTML 이 CSP 를 어기지 않는지
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpSource, nextVersion } from '../scripts/bump-sw.mjs';
import { sourceToRegExp } from '../scripts/dev.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

function precacheList() {
  const src = read('sw.js');
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'sw.js 에 PRECACHE 배열이 있어야 함');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(`/${rel}`);
  }
  return out;
}

test('PRECACHE 항목이 모두 실제 파일', () => {
  for (const url of precacheList()) {
    const file = url === '/' ? 'index.html' : url.slice(1);
    assert.ok(existsSync(path.join(ROOT, file)), `${url} → ${file} 없음`);
  }
});

test('js/·css/ 의 모든 파일과 아이콘이 PRECACHE 에 있음 (오프라인에서 빠지는 모듈 없음)', () => {
  const list = new Set(precacheList());
  const needed = [...walk('js'), ...walk('css'), '/', '/index.html', '/manifest.json'];
  const manifest = JSON.parse(read('manifest.json'));
  for (const ic of manifest.icons) needed.push(ic.src);
  const html = read('index.html');
  for (const [, ref] of html.matchAll(/(?:href|src)="(\/[^"#?]*)"/g)) needed.push(ref);
  for (const n of needed) assert.ok(list.has(n), `PRECACHE 에 ${n} 가 빠짐`);
  assert.equal(list.size, precacheList().length, 'PRECACHE 중복 없음');
});

test('모든 JS 모듈의 상대 import 가 실제 파일을 가리킴', () => {
  for (const file of walk('js')) {
    const src = read(file.slice(1));
    for (const [, spec] of src.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
      const target = path.join(path.dirname(path.join(ROOT, file.slice(1))), spec);
      assert.ok(existsSync(target), `${file}: ${spec} 없음`);
    }
  }
});

test('sw.js 는 /api/ 를 캐시하지 않음', () => {
  const src = read('sw.js');
  assert.match(src, /pathname\.startsWith\('\/api\/'\)\) return;/);
  assert.ok(!precacheList().some((u) => u.startsWith('/api')));
});

test('index.html: 인라인 스크립트·스타일·이벤트 속성 없음 (CSP self)', () => {
  const html = read('index.html');
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(attrs, /\ssrc="/, '인라인 <script> 금지');
    assert.equal(body.trim(), '');
  }
  assert.ok(!/<style[\s>]/i.test(html), '인라인 <style> 금지');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style="" 속성 금지');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'onclick= 같은 속성 금지');
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
});

test('CACHE_VERSION 과 bump-sw', () => {
  const src = read('sw.js');
  const r = bumpSource(src);
  assert.ok(r, 'CACHE_VERSION 을 찾을 수 있어야 함');
  assert.notEqual(r.from, r.to);
  assert.match(r.src, new RegExp(`CACHE_VERSION = '${r.to}'`));
  assert.equal(nextVersion('ddh-v9'), 'ddh-v10');
  assert.equal(nextVersion('v009'), 'v010');
  assert.equal(nextVersion('abc'), 'abc-2');
});

test('vercel.json: 전역 보안 헤더와 no-cache', () => {
  const cfg = JSON.parse(read('vercel.json'));
  const all = cfg.headers.find((h) => h.source === '/(.*)');
  const get = (k) => (all.headers.find((x) => x.key === k) || {}).value;
  assert.match(get('Content-Security-Policy'), /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.match(get('Content-Security-Policy'), /frame-ancestors 'none'/);
  // 사진은 fetch → Blob → URL.createObjectURL 로 보여 주므로 blob: 필요 (그 밖의 출처는 여전히 막음)
  assert.match(get('Content-Security-Policy'), /(^|; )img-src 'self' data: blob:;/);
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  // 전역 보안 헤더 규칙이 API(사진 바이너리 응답 포함)에도 적용됨
  assert.ok(sourceToRegExp(all.source).test('/api/images'));
  assert.equal(get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
  assert.equal(get('Referrer-Policy'), 'no-referrer');
  assert.equal(get('X-Frame-Options'), 'DENY');
  for (const p of ['/sw.js', '/index.html']) {
    const rule = cfg.headers.find((h) => h.source === p);
    assert.ok(rule && rule.headers.some((x) => x.key === 'Cache-Control' && /no-cache/.test(x.value)), p);
  }
  const api = readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
  assert.deepEqual(api.sort(), ['data.js', 'games.js', 'images.js', 'members.js', 'records.js']);
  assert.ok(api.length <= 12, 'Vercel Hobby 함수 수 제한');
});

test('clear-cache.txt: 잠글 때 받아 둔 사진 캐시를 비우는 신호 — Clear-Site-Data "cache", 저장·가로채기 없음', () => {
  assert.ok(existsSync(path.join(ROOT, 'clear-cache.txt')));
  const cfg = JSON.parse(read('vercel.json'));
  const rule = cfg.headers.find((h) => h.source === '/clear-cache.txt');
  assert.ok(rule, 'vercel.json 규칙');
  const get = (k) => (rule.headers.find((x) => x.key === k) || {}).value;
  assert.equal(get('Clear-Site-Data'), '"cache"'); // "storage" 는 안 됨 (서비스 워커·오프라인 사본까지 지움)
  assert.equal(get('Cache-Control'), 'no-store');
  // 서비스 워커가 가로채면 브라우저가 헤더를 못 볼 수 있으므로 그대로 네트워크로
  assert.match(read('sw.js'), /pathname === '\/clear-cache\.txt'\) return;/);
  assert.ok(!precacheList().includes('/clear-cache.txt'));
  assert.ok(!read('.vercelignore').split('\n').some((l) => l.trim() && 'clear-cache.txt'.startsWith(l.trim().replace(/\/$/, ''))), '배포에 포함');
});
