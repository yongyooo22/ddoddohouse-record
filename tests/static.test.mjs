// 정적 셸 점검 — 서비스 워커 사전 캐시 목록이 실제 파일과 맞는지, HTML 이 CSP 를 어기지 않는지, 서버 코드가 없는지
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

test('서버 저장소 없음: 기록을 네트워크로 보내지 않음', () => {
  assert.ok(!existsSync(path.join(ROOT, 'api')), 'api/ 폴더 없음 (서버 함수 없음)');
  for (const file of walk('js')) {
    const src = read(file.slice(1));
    assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(src), `${file}: 네트워크 요청 코드`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length, '런타임 의존성 없음');
});

test('숨은 방향 조작 문자·줄 구분 문자가 소스에 없음', () => {
  const bad = /[\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
  for (const file of [...walk('js'), ...walk('css'), '/index.html', '/sw.js']) {
    assert.ok(!bad.test(read(file.slice(1))), `${file}: 보이지 않는 제어 문자`);
  }
});

test('사용자 글자는 innerHTML 로 넣지 않음 (아이콘 정적 템플릿만)', () => {
  for (const file of walk('js')) {
    const src = read(file.slice(1));
    const hits = [...src.matchAll(/\.innerHTML\s*=/g)];
    if (file === '/js/dom.js') assert.equal(hits.length, 1, 'dom.js 의 아이콘 템플릿만');
    else assert.equal(hits.length, 0, `${file}: innerHTML 사용`);
  }
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
  const r = bumpSource(read('sw.js'));
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
  const csp = get('Content-Security-Policy');
  assert.match(csp, /default-src 'self'; script-src 'self'; style-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  // 사진은 IndexedDB 의 바이트 → Blob → URL.createObjectURL 로 보여 주므로 blob: 필요
  assert.match(csp, /(^|; )img-src 'self' data: blob:;/);
  assert.match(csp, /connect-src 'self'/);
  assert.ok(sourceToRegExp(all.source).test('/index.html'));
  assert.equal(get('X-Content-Type-Options'), 'nosniff');
  assert.equal(get('X-Robots-Tag'), 'noindex, nofollow, noarchive');
  assert.equal(get('Referrer-Policy'), 'no-referrer');
  assert.equal(get('X-Frame-Options'), 'DENY');
  for (const p of ['/sw.js', '/index.html']) {
    const rule = cfg.headers.find((h) => h.source === p);
    assert.ok(rule && rule.headers.some((x) => x.key === 'Cache-Control' && /no-cache/.test(x.value)), p);
  }
});
