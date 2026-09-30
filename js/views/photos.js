// 사진 — 폼의 사진 칸(여러 장 / 표지 한 장), 상세 화면 갤러리, 전체화면 뷰어
import { h, icon } from '../dom.js';
import { LIMITS } from '../constants.js';
import { photo, loadImage, savePhotoFile, photoErrorMessage, imageFiles } from '../images.js';
import { toast, choiceSheet, reducedMotion } from '../ui.js';

// ── 폼의 사진 칸 ─────────────────────────────────────────────

/**
 * 여러 장 사진 칸 (첫 장이 대표). 고르면 바로 줄여서 이 브라우저에 저장하고 id 를 돌려줌.
 * onChange(ids) · onAdded(id): 이번 작성 중에 새로 저장한 사진 (그만두면 지우려고)
 */
export function photoField({ ids = [], max = LIMITS.photos, onChange, onAdded, label = '사진' }) {
  let list = [...ids];
  let busy = 0;
  const input = h('input', { type: 'file', accept: 'image/*', multiple: max > 1, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  const addBtn = h('button', { type: 'button', class: 'pf-add' }, icon('camera'), h('span', { class: 'pf-add-text' }));
  const strip = h('div', { class: 'pf-strip', role: 'list', 'aria-label': label });
  const box = h('div', { class: 'pf' }, input, strip);

  function paint() {
    const tiles = list.map((id, i) => {
      const t = h('button', {
        type: 'button', class: 'pf-tile', role: 'listitem',
        'aria-label': `${label} ${i + 1}${i === 0 && max > 1 ? ' (대표)' : ''} — 눌러서 메뉴 열기`,
      }, photo(id, { size: 't', alt: '', lazy: false }), i === 0 && max > 1 ? h('span', { class: 'pf-badge', text: '대표' }) : null);
      t.addEventListener('click', () => tileMenu(i));
      return t;
    });
    const waiting = [];
    for (let i = 0; i < busy; i++) waiting.push(h('span', { class: 'pf-tile is-busy', role: 'listitem', 'aria-label': '사진 저장 중' }, h('span', { class: 'spinner', 'aria-hidden': 'true' })));
    addBtn.querySelector('.pf-add-text').textContent = max > 1 ? `${list.length + busy}/${max}` : (list.length ? '바꾸기' : '추가');
    addBtn.setAttribute('aria-label', max > 1 ? `${label} 추가 (${list.length}/${max})` : `${label} ${list.length ? '바꾸기' : '추가'}`);
    addBtn.disabled = max > 1 && list.length + busy >= max;
    strip.replaceChildren(...(max > 1 || !list.length ? [addBtn] : []), ...tiles, ...waiting);
  }

  async function tileMenu(i) {
    const items = [{ label: '크게 보기', value: 'view', icon: 'eye' }];
    if (max > 1 && i > 0) items.push({ label: '대표 사진으로', value: 'first', icon: 'flag' });
    if (max === 1) items.push({ label: '다른 사진으로 바꾸기', value: 'replace', icon: 'image' });
    items.push({ label: '빼기', value: 'remove', icon: 'trash', danger: true });
    const v = await choiceSheet(`${label} ${max > 1 ? i + 1 : ''}`.trim(), items);
    if (v === 'view') openViewer(list, i);
    else if (v === 'first') { list = [list[i], ...list.filter((_, j) => j !== i)]; paint(); onChange([...list]); }
    else if (v === 'replace') input.click();
    else if (v === 'remove') { list = list.filter((_, j) => j !== i); paint(); onChange([...list]); }
  }

  async function addFiles(files) {
    const imgs = imageFiles(files);
    if (!imgs.length) return;
    const room = max > 1 ? max - list.length - busy : 1;
    if (room <= 0) { toast(`${label}은 ${max}장까지 붙일 수 있어요`, 'error'); return; }
    const take = imgs.slice(0, room);
    if (imgs.length > room) toast(`${label}은 ${max}장까지라 ${take.length}장만 넣어요`, 'info');
    busy += take.length;
    paint();
    // 한 장씩 차례로 (큰 사진 여러 장을 한꺼번에 디코드하면 휴대폰 메모리가 모자람)
    for (const file of take) {
      try {
        const id = await savePhotoFile(file);
        if (onAdded) onAdded(id);
        if (max === 1) list = [id];
        else list.push(id);
        onChange([...list]);
      } catch (e) {
        toast(photoErrorMessage(e), 'error', 4500);
      } finally {
        busy -= 1;
        paint();
      }
    }
  }

  addBtn.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    addFiles(files);
  });
  // 컴퓨터: 끌어다 놓기
  box.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); box.classList.add('is-drop'); } });
  box.addEventListener('dragleave', () => box.classList.remove('is-drop'));
  box.addEventListener('drop', (e) => {
    box.classList.remove('is-drop');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles(e.dataTransfer.files);
  });
  paint();
  box.addFiles = addFiles;
  box.isBusy = () => busy > 0;
  box.setIds = (next) => { list = [...next]; paint(); };
  return box;
}

// ── 상세 갤러리 ─────────────────────────────────────────────

/** 큰 사진 + 여러 장이면 썸네일 줄. 누르면 전체화면 */
export function gallery(ids) {
  if (!ids || !ids.length) return null;
  const n = ids.length;
  let cur = 0;
  const main = h('button', { type: 'button', class: 'gal-main', 'aria-label': n > 1 ? `사진 1/${n} 크게 보기` : '사진 크게 보기' });
  const counter = n > 1 ? h('span', { class: 'gal-count', 'aria-hidden': 'true' }) : null;
  const thumbs = n > 1 ? ids.map((id, i) => {
    const b = h('button', { type: 'button', class: 'gal-thumb', 'aria-label': `사진 ${i + 1} 보기` }, photo(id, { size: 't', lazy: false }));
    b.addEventListener('click', () => show(i));
    return b;
  }) : [];
  function show(i) {
    cur = i;
    main.replaceChildren(photo(ids[i], { size: 'f', progressive: true, lazy: false, cls: 'gal-img' }));
    main.setAttribute('aria-label', n > 1 ? `사진 ${i + 1}/${n} 크게 보기` : '사진 크게 보기');
    if (counter) counter.textContent = `${i + 1} / ${n}`;
    thumbs.forEach((t, j) => { if (j === i) t.setAttribute('aria-current', 'true'); else t.removeAttribute('aria-current'); });
  }
  main.addEventListener('click', () => openViewer(ids, cur, { onClose: (j) => { show(j); return main; } }));
  show(0);
  return h('section', { class: 'gallery', 'aria-label': `사진 ${n}장` },
    h('div', { class: 'gal-frame' }, main, counter),
    n > 1 ? h('div', { class: 'gal-thumbs' }, thumbs) : null);
}

// ── 전체화면 뷰어 ───────────────────────────────────────────
let viewer = null;

export function closeViewer() {
  if (viewer) viewer.close(false);
}

/** 사진 전체화면: 좌우 넘기기(버튼·←→·쓸기), 닫기(버튼·Esc·뒤로가기) */
export function openViewer(ids, start = 0, { onClose = null } = {}) {
  closeViewer();
  const list = (ids || []).filter(Boolean);
  const n = list.length;
  if (!n) return;
  let i = Math.max(0, Math.min(n - 1, start));
  const back = document.activeElement;
  const counter = h('p', { class: 'vw-count', 'aria-live': 'polite' });
  const stage = h('div', { class: 'vw-stage' });
  const closeBtn = h('button', { type: 'button', class: 'vw-btn vw-close', 'aria-label': '닫기' }, icon('x'));
  const prev = h('button', { type: 'button', class: 'vw-btn vw-nav vw-prev', 'aria-label': '이전 사진' }, icon('back'));
  const next = h('button', { type: 'button', class: 'vw-btn vw-nav vw-next', 'aria-label': '다음 사진' }, icon('chevron'));
  const dlg = h('dialog', { class: 'viewer', 'aria-label': '사진 크게 보기' },
    h('div', { class: 'vw-bar' }, counter, closeBtn), stage, n > 1 ? [prev, next] : null);

  function go(j) {
    if (j < 0 || j >= n) return;
    i = j;
    stage.replaceChildren(photo(list[i], { size: 'f', progressive: true, lazy: false, alt: `사진 ${i + 1} / ${n}`, cls: 'vw-img' }));
    counter.textContent = n > 1 ? `${i + 1} / ${n}` : '';
    prev.disabled = i === 0;
    next.disabled = i === n - 1;
    for (const k of [i + 1, i - 1]) if (list[k]) loadImage(list[k], 'f').catch(() => {});
  }
  prev.addEventListener('click', () => go(i - 1));
  next.addEventListener('click', () => go(i + 1));
  closeBtn.addEventListener('click', () => close(true));
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(true); });
  dlg.addEventListener('close', () => close(false));
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { go(i - 1); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { go(i + 1); e.preventDefault(); }
  });
  // 좌우로 쓸어 넘기기
  let sx = null;
  let sy = 0;
  stage.addEventListener('pointerdown', (e) => { sx = e.clientX; sy = e.clientY; });
  stage.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.2) go(dx < 0 ? i + 1 : i - 1);
    else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 1.5) close(true);
  });

  // 안드로이드 뒤로가기 → 뷰어만 닫힘
  let pushed = false;
  try {
    history.pushState({ ...(history.state || {}), viewer: true }, '');
    pushed = true;
  } catch { /* 무시 */ }
  const onPop = () => { pushed = false; close(false); };
  window.addEventListener('popstate', onPop);

  let closed = false;
  function close(fromUser) {
    if (closed) return;
    closed = true;
    viewer = null;
    window.removeEventListener('popstate', onPop);
    try { dlg.close(); } catch { /* 무시 */ }
    dlg.remove();
    if (pushed && fromUser && history.state && history.state.viewer) history.back();
    const target = (onClose && onClose(i)) || back;
    if (fromUser && target && target.isConnected && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  viewer = { close };
  document.body.appendChild(dlg);
  dlg.showModal();
  if (!reducedMotion()) dlg.classList.add('is-anim');
  go(i);
  closeBtn.focus({ preventScroll: true });
}
