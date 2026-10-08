// 사진 — 게임 정보의 대표 이미지 칸 · 목록 카드 썸네일 · 상세 갤러리 · 전체화면 뷰어
// (기록 폼에서는 더 이상 플레이 사진을 받지 않아요. 예전 기록에 있던 사진은 그대로 보여 줘요)
import { h, icon } from '../dom.js';
import { photosOf, referencedPhotos } from '../store.js';
import * as api from '../api.js';
import { compressPhoto, blobToBase64 } from '../compress.js';
import { photoImg, seedImage, loadImage } from '../images.js';
import { toast } from '../ui.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

const HEIC_HINT = '카메라 설정의 ‘고효율’ 사진을 끄거나 JPG로 저장해서 올려 주세요';
const SLOW_MSG = '연결이 느려서 사진을 올리지 못했어요. 잠시 뒤 다시 해 주세요';

/** 사진 줄이기·올리기 오류 → 안내 문구 */
export function photoErrorMessage(e) {
  switch (e && e.code) {
    case 'decode': return `이 사진 형식(HEIC 등)은 열 수 없어요. ${HEIC_HINT}`;
    case 'too_big': return '사진 파일이 너무 커요 (60MB 이하)';
    case 'encode': return '사진을 줄이지 못했어요. 다른 사진으로 해 주세요';
    case 'too_large': return '사진이 너무 커서 올리지 못했어요';
    case 'limit': return '사진 저장 공간이 가득 찼어요. 설정에서 안 쓰는 사진을 정리해 주세요';
    case 'invalid': return '올릴 수 없는 사진이에요. JPG/PNG로 올려주세요';
    // 느린 건 대개 서버가 아니라 이 기기의 연결 (지하 방탈출·보드게임 카페 등)
    case 'timeout': case 'network': return SLOW_MSG;
    case 'offline': return '오프라인이라 사진을 올리지 못했어요. 연결되면 다시 해 주세요';
    default: return api.errorMessage(e, '업로드');
  }
}

/**
 * 올렸지만 저장하지 않고 버린 사진을 서버에서 바로 지움 (안 지워도 '사용하지 않는 사진 정리'가 나중에 지움).
 * 저장된 기록이 쓰는 사진(수정 중인 기록의 원래 사진·가져다 쓴 이전 대표 사진)은 건드리지 않음 — 서버도 409 로 거절함
 */
export function discardPhotos(ids) {
  const used = new Set(referencedPhotos());
  for (const id of new Set(ids)) if (id && !used.has(id)) api.deleteImage(id).catch(() => {});
}

// ── 게임 정보: 대표 이미지 한 장 ─────────────────────────────
/**
 * 게임·작품·테마의 대표 이미지 칸 (그날 찍은 플레이 사진과 따로). 한 장만, 고르자마자 줄여서 올림.
 * value: 지금 대표 이미지 id(없으면 null). onChange(id|null)
 * 반환: { el, value(), busy(), whenIdle(), finish(savedId) — 저장(또는 취소)한 뒤 이 칸에서 올렸지만 안 쓰는 사진을 지움 }
 */
export function coverField({ value = null, onChange, label = '대표 이미지' } = {}) {
  let cur = value;
  let pending = null; // 올리는 중: { preview, promise }
  const uploaded = new Set(); // 이 칸에서 올린 사진 (저장하지 않으면 지움)
  const fileIn = h('input', { type: 'file', accept: 'image/*', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const tile = h('button', { type: 'button', class: 'cv-tile' });
  const removeBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm cv-remove' }, icon('x'), h('span', { text: '빼기' }));
  const note = h('p', { class: 'fhint cv-note' });
  const el = h('div', { class: 'cv-field' }, tile, h('div', { class: 'cv-side' }, note, removeBtn), fileIn);

  function paint() {
    tile.classList.toggle('is-empty', !cur && !pending);
    tile.classList.toggle('is-busy', !!pending);
    if (pending) {
      tile.replaceChildren(h('img', { src: pending.preview, alt: '', class: 'ph-preview' }), h('span', { class: 'ph-state cv-state' }, h('span', { class: 'ph-spin' })));
      tile.setAttribute('aria-label', `${label} 올리는 중`);
    } else if (cur) {
      tile.replaceChildren(photoImg(cur, { size: 't', lazy: false }));
      tile.setAttribute('aria-label', `${label} 바꾸기`);
    } else {
      tile.replaceChildren(icon('image'), h('span', { class: 'cv-add', text: '이미지 추가' }));
      tile.setAttribute('aria-label', `${label} 추가`);
    }
    tile.disabled = !!pending;
    removeBtn.hidden = !cur || !!pending;
    removeBtn.setAttribute('aria-label', `${label} 빼기`);
    note.textContent = pending ? '올리는 중…' : cur ? '눌러서 바꿔요' : '선택 · 상자 사진이나 포스터';
  }

  async function pick(file) {
    if (!file || pending) return;
    let preview = null;
    const job = (async () => {
      const blobs = await compressPhoto(file);
      preview = URL.createObjectURL(blobs.thumb);
      pending.preview = preview;
      paint();
      const [full, thumb] = await Promise.all([blobToBase64(blobs.full), blobToBase64(blobs.thumb)]);
      const res = await api.uploadImage({ id: api.newId(), full, thumb }).promise;
      const img = res && res.image;
      if (!img || typeof img.id !== 'string') throw new api.ApiError('server_error', 0);
      seedImage(img.id, 't', blobs.thumb);
      seedImage(img.id, 'f', blobs.full);
      return img.id;
    })();
    pending = { preview: '', promise: job };
    paint();
    try {
      const id = await job;
      uploaded.add(id);
      cur = id;
      if (onChange) onChange(cur);
    } catch (e) {
      toast(photoErrorMessage(e), 'error', 4500);
    } finally {
      if (preview) URL.revokeObjectURL(preview);
      pending = null;
      paint();
    }
  }

  tile.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    pick(f);
  });
  removeBtn.addEventListener('click', () => {
    cur = null;
    if (onChange) onChange(null);
    paint();
    tile.focus({ preventScroll: true });
  });
  paint();
  return {
    el,
    value: () => cur,
    busy: () => !!pending,
    whenIdle: () => (pending ? pending.promise.then(() => {}, () => {}) : Promise.resolve()),
    finish(savedId) {
      discardPhotos([...uploaded].filter((id) => id !== savedId));
      uploaded.clear();
    },
    reset() {
      cur = null;
      paint();
    },
  };
}

// ── 목록 카드 썸네일 ────────────────────────────────────────
/** 대표 사진 (카드 링크가 제목을 읽어 주므로 꾸밈용) */
export function cardPhoto(r) {
  const ids = photosOf(r);
  if (!ids.length) return null;
  return h('div', { class: 'rcard-photo', 'aria-hidden': 'true' },
    photoImg(ids[0], { size: 't' }),
    ids.length > 1 ? h('span', { class: 'rcard-pn' }, icon('image'), h('span', { text: String(ids.length) })) : null);
}

/**
 * 가로로 넘기는 사진 줄(스크롤 스냅)의 '지금 몇 번째' 추적.
 * 버튼·키로 옮기는 동안(부드러운 스크롤 중)에는 중간 위치로 번호가 되돌아가지 않게 도착할 때까지 기다림
 */
function snapTrack(track, n, onIndex) {
  let cur = -1;
  let target = null;
  let timer = 0;
  let raf = 0;
  const at = () => Math.max(0, Math.min(n - 1, Math.round(track.scrollLeft / (track.clientWidth || 1))));
  const set = (i) => { if (i !== cur) { cur = i; onIndex(i); } };
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = at();
      if (target !== null) {
        if (i !== target) return;
        target = null;
      }
      set(i);
    });
  }, { passive: true });
  return {
    get index() { return cur; },
    go(i, smooth = true) {
      const j = Math.max(0, Math.min(n - 1, i));
      const anim = smooth && !reducedMotion();
      target = anim ? j : null;
      clearTimeout(timer);
      if (anim) timer = setTimeout(() => { target = null; set(at()); }, 900);
      track.scrollTo({ left: j * track.clientWidth, behavior: anim ? 'smooth' : 'auto' });
      set(j);
    },
    /** 창 크기가 바뀌면 보던 사진에 다시 맞춤 */
    refit() { if (cur >= 0) track.scrollLeft = cur * track.clientWidth; },
  };
}

// ── 상세 갤러리 ─────────────────────────────────────────────
const galleries = new Map(); // 기록 id → 지금 화면의 갤러리 (상세를 다시 그려도 뷰어가 닫힐 때 새 갤러리를 맞춤)

/**
 * 대표 사진 크게 + 여러 장이면 넘기기·썸네일 줄. 누르면 전체화면.
 * start: 처음 보여 줄 사진 (다시 그려도 보던 사진 그대로), onIndex(i): 보는 사진이 바뀜
 */
export function gallery(r, { start = 0, onIndex = null } = {}) {
  const ids = photosOf(r);
  if (!ids.length) return null;
  const n = ids.length;
  const first = Math.max(0, Math.min(n - 1, start));
  const slides = ids.map((id, i) => h('button', {
    type: 'button', class: 'dg-slide', tabindex: i === first ? '0' : '-1',
    'aria-label': n > 1 ? `사진 ${i + 1}/${n} 크게 보기` : '사진 크게 보기',
    onClick: () => openViewer(ids, i, { onClose: (j) => syncFromViewer(j) }),
    // 보이는 사진만 바로, 나머지 원본은 넘겨서 보일 때 (상세를 열 때마다 원본 네 장을 다 받지 않게 — 그동안은 작은 사진)
  }, photoImg(id, { size: 'f', progressive: true, lazy: i !== first, cls: 'dg-img' })));
  const track = h('div', { class: 'dg-track' }, slides);
  const counter = n > 1 ? h('span', { class: 'dg-count', 'aria-hidden': 'true' }) : null;
  const thumbs = n > 1
    ? ids.map((id, i) => h('button', {
      type: 'button', class: 'dg-thumb', 'aria-label': `사진 ${i + 1} 보기`,
      onClick: () => snap.go(i),
    }, photoImg(id, { size: 't', lazy: false })))
    : [];
  const snap = snapTrack(track, n, (i) => {
    if (counter) counter.textContent = `${i + 1} / ${n}`;
    thumbs.forEach((t, j) => { if (j === i) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); });
    // Tab 으로는 보이는 사진 하나만 (다른 사진은 아래 썸네일로 고름)
    slides.forEach((s, j) => { s.tabIndex = j === i ? 0 : -1; });
    if (onIndex) onIndex(i);
  });
  snap.go(first, false);
  // 화면에 붙은 뒤 그 위치로 스크롤 (그리기 전이라 보이는 깜빡임 없음)
  if (first > 0) requestAnimationFrame(() => { if (track.isConnected) snap.refit(); });
  const section = h('section', { class: `dgallery${n > 1 ? ' is-multi' : ''}`, 'aria-label': `사진 ${n}장` },
    h('div', { class: 'dg-frame' }, track, counter),
    n > 1 ? h('div', { class: 'dg-thumbs', role: 'group', 'aria-label': '사진 고르기' }, thumbs) : null);

  const api = {
    section,
    /** 뷰어에서 본 사진으로 맞추고 그 사진에 초점 */
    show(j) {
      snap.go(j, false);
      return slides[Math.max(0, Math.min(n - 1, j))];
    },
  };
  galleries.set(r.id, api);
  /** 뷰어가 닫힘: 지금 화면에 있는 이 기록의 갤러리(다시 그려졌으면 새 것)를 뷰어의 사진으로 */
  function syncFromViewer(j) {
    const g = galleries.get(r.id);
    return g && g.section.isConnected ? g.show(j) : null;
  }
  return section;
}

// ── 전체화면 뷰어 ───────────────────────────────────────────
let viewer = null;
const VIEWER_BAR = '#0B0A0D'; // 뷰어 바탕(--viewer-bg)과 같은 색 — 휴대폰 상태 표시줄도 어둡게

/** 열려 있는 뷰어 닫기 (화면을 옮길 때·잠글 때) */
export function closeViewer() {
  if (viewer) viewer.close(false);
}

/**
 * 사진 전체화면: 좌우로 넘기기(쓸기·버튼·←→), 닫기(버튼·Esc·아래로 쓸기·뒤로가기)
 * opener: 닫은 뒤 초점을 돌려줄 요소. onClose(i): 닫을 때 보던 사진 번호 → 초점을 줄 요소(없으면 opener)
 */
export function openViewer(ids, start = 0, { opener = null, onClose = null } = {}) {
  closeViewer();
  const list = (ids || []).filter(Boolean);
  const n = list.length;
  if (!n) return;
  const first = Math.max(0, Math.min(n - 1, start));
  const back = opener || document.activeElement;

  const counter = h('p', { class: 'vw-count', 'aria-live': 'polite' });
  // 보는 사진만 바로 받고, 나머지는 넘겨서 보일 때 (그리고 보는 사진이 다 오면 양옆을 미리)
  const slides = list.map((id, i) => h('div', { class: 'vw-slide' },
    photoImg(id, { size: 'f', progressive: true, lazy: i !== first, alt: `사진 ${i + 1} / ${n}`, cls: 'vw-img' })));
  const track = h('div', { class: 'vw-track' }, slides);
  const closeBtn = h('button', { type: 'button', class: 'vw-btn vw-close', 'aria-label': '닫기' }, icon('x'));
  const prev = h('button', { type: 'button', class: 'vw-btn vw-nav vw-prev', 'aria-label': '이전 사진' }, icon('back'));
  const next = h('button', { type: 'button', class: 'vw-btn vw-nav vw-next', 'aria-label': '다음 사진' }, icon('chevron'));
  const dlg = h('dialog', { class: 'viewer', 'aria-label': '사진 크게 보기' },
    h('div', { class: 'vw-bar' }, counter, closeBtn),
    track,
    n > 1 ? [prev, next] : null);

  const preload = (i) => {
    loadImage(list[i], 'f').then(() => {
      for (const j of [i + 1, i - 1]) if (list[j]) loadImage(list[j], 'f').catch(() => {});
    }, () => {});
  };
  const snap = snapTrack(track, n, (i) => {
    counter.textContent = `${i + 1} / ${n}`;
    prev.disabled = i === 0;
    next.disabled = i === n - 1;
    slides.forEach((s, j) => { s.inert = j !== i; }); // 안 보이는 사진은 스크린리더가 건너뜀
    preload(i);
  });
  const go = (i) => snap.go(i);
  prev.addEventListener('click', () => go(snap.index - 1));
  next.addEventListener('click', () => go(snap.index + 1));
  closeBtn.addEventListener('click', () => close(true));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(true); });
  dlg.addEventListener('close', () => close(false)); // 밖에서 닫힘 (잠금 등)
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { go(snap.index - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { go(snap.index + 1); e.preventDefault(); }
  });
  // 창 크기가 바뀌면(회전) 보던 사진에 다시 맞춤
  const onResize = () => snap.refit();
  window.addEventListener('resize', onResize);

  // 아래로 쓸어내려 닫기 (좌우 넘기기는 스크롤 스냅이 맡음)
  let pid = null, sx = 0, sy = 0, dy = 0, vertical = false;
  const resetDrag = () => {
    track.style.transform = '';
    dlg.style.removeProperty('--vw-dim');
    track.classList.remove('is-dragging');
  };
  track.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; dy = 0; vertical = false;
  });
  track.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - sx;
    const d = e.clientY - sy;
    if (!vertical && d > 12 && d > Math.abs(dx) * 1.3) {
      vertical = true;
      track.classList.add('is-dragging');
      try { track.setPointerCapture(pid); } catch { /* 무시 */ }
    }
    if (vertical) {
      dy = Math.max(0, d);
      track.style.transform = `translateY(${dy}px)`;
      dlg.style.setProperty('--vw-dim', String(Math.max(0.3, 1 - dy / 420)));
    }
  });
  const endDrag = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (vertical && dy > 90) close(true);
    else resetDrag();
    vertical = false;
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);

  // 안드로이드 뒤로가기 → 뷰어만 닫힘 (같은 주소로 기록 하나를 더 쌓음; 해시가 같아 라우터는 반응 안 함)
  let pushed = false;
  try {
    history.pushState({ ...(history.state || {}), viewer: true }, '');
    pushed = true;
  } catch { /* 무시 */ }
  const onPop = () => { pushed = false; close(false); };
  window.addEventListener('popstate', onPop);

  // 휴대폰 상태 표시줄(theme-color)도 뷰어처럼 어둡게, 닫으면 되돌림
  const bars = [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => [m, m.getAttribute('content')]);
  for (const [m] of bars) m.setAttribute('content', VIEWER_BAR);

  let closed = false;
  function close(fromUser) {
    if (closed) return;
    closed = true;
    viewer = null;
    window.removeEventListener('popstate', onPop);
    window.removeEventListener('resize', onResize);
    for (const [m, c] of bars) if (c !== null) m.setAttribute('content', c);
    try { dlg.close(); } catch { /* 무시 */ }
    dlg.remove();
    document.documentElement.classList.remove('vw-open');
    if (pushed && fromUser && history.state && history.state.viewer) history.back();
    const target = (onClose && onClose(snap.index)) || back;
    if (fromUser && target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  viewer = { close };
  document.body.appendChild(dlg);
  document.documentElement.classList.add('vw-open');
  dlg.showModal();
  snap.go(first, false);
  closeBtn.focus({ preventScroll: true });
}
