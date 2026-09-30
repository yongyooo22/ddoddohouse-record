// 사진 — 고른 파일을 기기 안에서 줄여(EXIF 위치 정보 제거) IndexedDB 에 저장하고, 화면에는 blob: 주소로 보여 줌
import { h, icon } from './dom.js';
import * as repo from './repo.js';
import { compressPhoto } from './compress.js';

const MAX_CACHED = 240;
const cache = new Map();    // `${id}:${size}` → objectURL (Map 순서 = 오래 안 쓴 순)
const inflight = new Map(); // key → Promise<objectURL>
const missing = new Set();  // 저장소에 없는 사진 — 다시 읽지 않음

function drop(key) {
  const u = cache.get(key);
  if (u) URL.revokeObjectURL(u);
  cache.delete(key);
}

repo.onImagesDeleted((ids) => {
  if (!ids) {
    for (const k of [...cache.keys()]) drop(k);
    return;
  }
  for (const id of ids) {
    drop(`${id}:t`);
    drop(`${id}:f`);
  }
});
// 기록이 바뀌면(가져오기 등으로 같은 id 의 사진이 다시 생길 수 있음) '없는 사진' 기억을 비움
repo.subscribe(() => missing.clear());

function put(key, url) {
  cache.set(key, url);
  while (cache.size > MAX_CACHED) drop(cache.keys().next().value);
}

/** 사진 주소 (size 't' 작은 사진 | 'f' 원본) */
export function loadImage(id, size = 't') {
  const key = `${id}:${size}`;
  if (cache.has(key)) {
    const u = cache.get(key);
    cache.delete(key);
    cache.set(key, u);
    return Promise.resolve(u);
  }
  if (missing.has(id)) return Promise.reject(new Error('missing'));
  if (inflight.has(key)) return inflight.get(key);
  const p = repo.getImage(id).then((rec) => {
    const bytes = rec && (size === 'f' ? rec.full : rec.thumb);
    if (!bytes) {
      missing.add(id);
      throw new Error('missing');
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: size === 'f' ? rec.type : rec.thumbType }));
    put(key, url);
    return url;
  }).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** 새로 저장한 사진은 다시 읽지 않도록 missing 표시 해제 */
function known(id) { missing.delete(id); }

// 화면 가까이 오면 불러오기
let io = null;
const pending = new Map(); // 요소 → { start, t }
function whenNear(el, start) {
  if (typeof IntersectionObserver !== 'function') { start(); return; }
  if (!io) {
    io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const job = pending.get(e.target);
        pending.delete(e.target);
        io.unobserve(e.target);
        if (job) job.start();
      }
    }, { rootMargin: '400px 0px' });
  }
  // 보이기 전에 화면에서 사라진 요소는 가끔 정리 (다시 그리기가 잦아도 쌓이지 않게).
  // 방금 만들어 아직 붙이기 전인 요소는 건드리지 않음
  const now = Date.now();
  if (pending.size > 300) {
    for (const [old, job] of [...pending]) {
      if (!old.isConnected && now - job.t > 10000) { pending.delete(old); io.unobserve(old); }
    }
  }
  pending.set(el, { start, t: now });
  io.observe(el);
}

/**
 * 사진 요소. 불러오는 동안은 빈 자리, 못 읽으면 '사진 없음' 아이콘.
 * size: 't' 작은 사진 | 'f' 원본 (progressive: 작은 사진을 먼저 보여 주고 원본으로 바꿈)
 */
export function photo(id, { size = 't', alt = '', cls = '', lazy = true, progressive = false } = {}) {
  const img = h('img', { alt, decoding: 'async', draggable: 'false' });
  const box = h('span', { class: ['ph', 'is-loading', cls] }, img);
  const fail = () => {
    box.classList.remove('is-loading');
    box.classList.add('is-broken');
    img.remove();
    box.appendChild(icon('imageOff', 'ph-broken'));
  };
  const show = (url) => {
    img.src = url;
    const done = () => box.classList.remove('is-loading');
    if (img.complete) done();
    else img.addEventListener('load', done, { once: true });
  };
  const start = () => {
    if (progressive && size === 'f') {
      loadImage(id, 't').then((u) => { if (!img.getAttribute('src')) show(u); }, () => {});
    }
    loadImage(id, size).then(show, () => {
      if (size === 'f') loadImage(id, 't').then(show, fail);
      else fail();
    });
  };
  if (lazy) whenNear(box, start);
  else start();
  return box;
}

// ── 파일 → 저장 ──

const HEIC_HINT = '카메라 설정의 ‘고효율’ 사진을 끄거나 JPG로 저장해서 올려 주세요';

export function photoErrorMessage(e) {
  const code = e && e.code;
  if (code === 'decode') return `이 사진 형식(HEIC 등)은 열 수 없어요. ${HEIC_HINT}`;
  if (code === 'too_big') return '사진 파일이 너무 커요 (60MB까지)';
  if (code === 'quota') return '이 브라우저의 저장 공간이 부족해요. 설정에서 사용량을 확인해 주세요';
  if (code === 'unavailable') return '이 브라우저에서는 사진을 저장할 수 없어요 (사생활 보호 모드 등)';
  return '사진을 저장하지 못했어요. 다시 시도해 주세요';
}

/** 사진 파일 하나를 줄여 저장 → 사진 id */
export async function savePhotoFile(file) {
  const out = await compressPhoto(file);
  const id = await repo.putImage(out);
  known(id);
  return id;
}

/** 사진 파일 목록 중 이미지만 */
export function imageFiles(list) {
  return [...(list || [])].filter((f) => f && (!f.type || f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name || '')));
}
