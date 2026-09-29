// 사진 불러오기 — 입장 코드 헤더로 받아 objectURL 로 보여 줌
// 메모리 캐시(최근 사용 순, 최대 150장) · 화면에 가까워지면 불러오기 · 불러오는 동안 스켈레톤, 실패하면 자리표시
import { h, icon } from './dom.js';
import { getKey, state, subscribe } from './store.js';
import * as api from './api.js';

const MAX_CACHED = 150;
const cache = new Map();    // `${id}:${size}` → objectURL (Map 순서 = 오래 안 쓴 순)
const inflight = new Map(); // key → Promise<objectURL>
const missing = new Set();  // 서버에 없는 사진(404) — 다시 요청하지 않음
let cacheOwner = null;      // 캐시를 채운 입장 코드 (코드가 바뀌면 통째로 비움)
let gen = 0;                // 캐시를 비울 때마다 +1 (그 전에 보낸 요청의 결과는 버림)

// 이번 코드로 서버 응답을 한 번이라도 받기 전에는 한 장씩만 요청
// (코드가 바뀐 기기에서 사진 여러 장이 동시에 틀린 코드로 가서 '시도 횟수'를 쌓지 않게)
let verified = false;
let active = 0;
const waiting = [];
const limit = () => (verified ? 4 : 1);

function pump() {
  while (active < limit() && waiting.length) {
    active++;
    waiting.shift()();
  }
}
function acquire() {
  if (active < limit()) { active++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  active = Math.max(0, active - 1);
  pump();
}
function markVerified() {
  if (verified) return;
  verified = true;
  pump();
}
subscribe((kind) => { if (kind === 'status' && state.status === 'ok') markVerified(); });

/** 메모리의 사진을 모두 버림 (잠금·코드 변경 때) */
export function clearImageCache() {
  gen++;
  for (const url of cache.values()) URL.revokeObjectURL(url);
  cache.clear();
  inflight.clear();
  missing.clear();
  waiting.length = 0;
  verified = false;
}

/**
 * 브라우저 HTTP 캐시에 남은 사진까지 지움 (잠금 해제 정보 지우기·코드가 바뀌어 잠길 때).
 * 사진 응답은 오프라인에서도 보이게 private 캐시로 받는데, 이 파일의 응답 머리 Clear-Site-Data: "cache" 가
 * 이 사이트의 HTTP 캐시를 비움 (서비스 워커의 앱 파일 캐시는 그대로). 지원하지 않는 브라우저에선 아무 일도 없음
 */
export function clearHttpImageCache() {
  try {
    fetch('/clear-cache.txt', { cache: 'no-store', credentials: 'same-origin' }).catch(() => {});
  } catch { /* 무시 */ }
}

function checkOwner() {
  const k = getKey();
  if (k !== cacheOwner) {
    clearImageCache();
    cacheOwner = k;
  }
  if (!verified && state.status === 'ok' && !state.fromCache) verified = true;
}

/** 캐시가 넘치면 오래 안 쓴 것부터 revoke (지금 화면의 <img> 가 쓰는 건 남김) */
function evict() {
  if (cache.size <= MAX_CACHED) return;
  const inUse = new Set();
  for (const im of document.images) if (im.src.startsWith('blob:')) inUse.add(im.src);
  for (const [k, url] of cache) {
    if (cache.size <= MAX_CACHED) break;
    if (inUse.has(url)) continue;
    cache.delete(k);
    URL.revokeObjectURL(url);
  }
}

function put(key, blob) {
  const old = cache.get(key);
  if (old) URL.revokeObjectURL(old);
  const url = URL.createObjectURL(blob);
  cache.delete(key);
  cache.set(key, url);
  missing.delete(key);
  evict();
  return url;
}

/** 이미 받아 둔 사진이면 바로 objectURL (없으면 null) */
export function peekImage(id, size = 't') {
  checkOwner();
  const key = `${id}:${size}`;
  const url = cache.get(key);
  if (!url) return null;
  cache.delete(key);
  cache.set(key, url);
  return url;
}

/** 방금 올린 사진은 받은 것처럼 캐시에 넣어 둠 (다시 내려받지 않게) */
export function seedImage(id, size, blob) {
  checkOwner();
  if (id && blob) put(`${id}:${size}`, blob);
}

/** 사진 → objectURL. 실패하면 ApiError (not_found 는 기억해 두고 다시 요청 안 함) */
export function loadImage(id, size = 't') {
  checkOwner();
  const key = `${id}:${size}`;
  const hit = peekImage(id, size);
  if (hit) return Promise.resolve(hit);
  if (missing.has(key)) return Promise.reject(new api.ApiError('not_found', 404));
  if (inflight.has(key)) return inflight.get(key);
  const myGen = gen;
  const p = (async () => {
    await acquire();
    try {
      if (myGen !== gen) throw new api.ApiError('aborted', 0);
      const blob = await api.fetchImageBlob(id, size);
      if (myGen !== gen) throw new api.ApiError('aborted', 0);
      markVerified();
      return put(key, blob);
    } catch (e) {
      if (e && e.code === 'not_found' && myGen === gen) missing.add(key);
      throw e;
    } finally {
      release();
      if (myGen === gen) inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** 서버에 있는 사진만 골라냄 (없는 것 = 404). 연결 문제로 확인 못 한 건 있다고 봄 */
export async function existingPhotos(ids) {
  const out = [];
  for (const id of ids) {
    try {
      await loadImage(id, 't');
      out.push(id);
    } catch (e) {
      if (!e || e.code !== 'not_found') out.push(id);
    }
  }
  return out;
}

export const isMissing = (id, size = 't') => missing.has(`${id}:${size}`);

// ── 화면에 가까워지면 불러오기 ──
let io = null;
const observed = new Map(); // 요소 → 시작 함수

function observe(el, start) {
  if (typeof IntersectionObserver !== 'function') { start(); return; }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const fn = observed.get(e.target);
        observed.delete(e.target);
        if (fn) fn();
      }
    }, { rootMargin: '320px 0px' });
  }
  // 화면에서 사라진 채 남은 요소는 정리 (목록을 다시 그릴 때마다 쌓이지 않게)
  if (observed.size > 200) {
    for (const node of observed.keys()) {
      if (!node.isConnected) { io.unobserve(node); observed.delete(node); }
    }
  }
  observed.set(el, start);
  io.observe(el);
}

// 연결 문제로 못 불러온 사진: 다시 온라인이 되면 한 번 더
const retryable = new Map(); // 요소 → 다시 시도 함수
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    for (const [el, fn] of [...retryable]) {
      retryable.delete(el);
      if (el.isConnected) fn();
    }
  });
}

/**
 * 사진 자리 <span class="pimg">.
 * size: 't' | 'f'. progressive: 큰 사진이면 작은 사진을 먼저 보여 주고 바꿔 끼움. lazy: 화면에 가까워질 때 불러옴
 * alt 가 비어 있으면 꾸밈용(스크린리더가 건너뜀)
 */
export function photoImg(id, { size = 't', alt = '', cls = '', lazy = true, progressive = false } = {}) {
  const img = h('img', { alt, decoding: 'async', draggable: 'false', hidden: true });
  const box = h('span', { class: ['pimg', 'is-loading', cls], dataset: { photo: id } }, img);
  let shown = null;

  const show = async (url) => {
    if (shown === url) return;
    img.src = url;
    try { await img.decode(); } catch { /* 표시는 그대로 시도 */ }
    shown = url;
    img.hidden = false;
    box.classList.remove('is-loading', 'is-error', 'is-missing');
    box.classList.add('is-ready');
    const fb = box.querySelector('.pimg-fallback');
    if (fb) fb.remove();
  };
  const fail = (e) => {
    if (e && e.code === 'aborted') return;
    box.classList.remove('is-loading');
    if (shown) return; // 작은 사진이라도 보이면 그대로 둠
    box.classList.add('is-error');
    if (e && e.code === 'not_found') box.classList.add('is-missing');
    else retryable.set(box, start);
    if (!box.querySelector('.pimg-fallback')) {
      box.appendChild(h('span', { class: 'pimg-fallback' }, icon('imageOff'),
        alt ? h('span', { class: 'sr-only', text: e && e.code === 'not_found' ? '사진을 찾을 수 없어요' : '사진을 불러오지 못했어요' }) : null));
    }
  };
  async function start() {
    box.classList.add('is-loading');
    box.classList.remove('is-error');
    let big = false; // 큰 사진이 먼저 오면(둘 다 브라우저 캐시에 있을 때 등) 늦게 온 작은 사진으로 덮지 않음
    try {
      if (size === 'f' && progressive) {
        const small = peekImage(id, 't');
        if (small) show(small);
        else loadImage(id, 't').then((u) => { if (!shown && !big) show(u); }, () => {});
      }
      const url = await loadImage(id, size);
      big = true;
      await show(url);
    } catch (e) {
      fail(e);
    }
  }
  // 이미 받아 둔 사진은 기다리지 않고 바로
  const ready = peekImage(id, size);
  if (ready) {
    img.src = ready;
    img.hidden = false;
    shown = ready;
    box.classList.remove('is-loading');
    box.classList.add('is-ready');
  } else if (lazy) observe(box, start);
  else start();
  return box;
}
