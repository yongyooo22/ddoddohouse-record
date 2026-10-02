// 사진 — 폼의 사진 칸(그날 찍은 플레이 사진) · 게임 정보의 대표 이미지 칸 · 목록 카드 썸네일 · 상세 갤러리 · 전체화면 뷰어
import { h, icon } from '../dom.js';
import { LIMITS } from '../constants.js';
import { photosOf, referencedPhotos } from '../store.js';
import { storageUsage } from '../stats.js';
import * as api from '../api.js';
import { compressPhoto, blobToBase64 } from '../compress.js';
import { photoImg, seedImage, loadImage } from '../images.js';
import { toast, openDialog } from '../ui.js';

const MAX = LIMITS.photos;
const UNDO_MS = 6000;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

const HEIC_HINT = '카메라 설정의 ‘고효율’ 사진을 끄거나 JPG로 저장해서 올려 주세요';
const SLOW_MSG = '연결이 느려서 사진을 다 올리지 못했어요. 실패한 사진을 눌러 다시 올려 주세요';

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
    case 'offline': return '오프라인이라 사진을 올리지 못했어요. 연결되면 실패한 사진을 눌러 다시 올려 주세요';
    default: return api.errorMessage(e, '업로드');
  }
}

/** 한 번에 고른 사진 여러 장이 같은 이유로 실패했을 때의 알림 하나 */
function batchMessage(code, n, e) {
  if (n <= 1) return photoErrorMessage(e);
  switch (code) {
    case 'decode': return `사진 ${n}장은 열 수 없는 형식(HEIC 등)이라 뺐어요. ${HEIC_HINT}`;
    case 'too_big': return `사진 ${n}장은 파일이 너무 커서 뺐어요 (60MB 이하)`;
    case 'encode': return `사진 ${n}장은 줄이지 못해서 뺐어요. 다른 사진으로 해 주세요`;
    default: return photoErrorMessage(e);
  }
}

/** 하나씩 차례로 실행하는 줄 — 여러 장을 한꺼번에 디코드·업로드하면 메모리가 넘치고, 느린 연결에서는 모두 시간 초과가 남 */
function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * 올렸지만 저장하지 않고 버린 사진을 서버에서 바로 지움 (안 지워도 '사용하지 않는 사진 정리'가 나중에 지움).
 * 저장된 기록이 쓰는 사진(수정 중인 기록의 원래 사진·가져다 쓴 이전 대표 사진)은 건드리지 않음 — 서버도 409 로 거절함
 */
export function discardPhotos(ids) {
  const used = new Set(referencedPhotos());
  for (const id of new Set(ids)) if (id && !used.has(id)) api.deleteImage(id).catch(() => {});
}

// ── 사진 저장 공간 ───────────────────────────────────────────
// 사진 칸을 열 때마다 서버에 한 번 묻고, 이 기기에서 올린 만큼은 직접 더해 둠.
// 80%를 넘으면 사진 칸에 남은 양을 알리고, 가득 차면 더 넣지 않게 막음 (서버도 한도를 넘는 사진은 받지 않음)
const FULL_MSG = '사진 저장 공간이 가득 찼어요. 설정 → 사진 저장 공간에서 안 쓰는 사진을 정리하면 다시 넣을 수 있어요';
let store = null; // { count, bytes, limitCount, limitBytes }
let storeReq = null;
let warned80 = false; // ‘80%를 넘었어요’ 알림은 앱을 열어 둔 동안 한 번만

function loadStore() {
  if (!storeReq) {
    storeReq = api.imageStats()
      .then((d) => {
        store = { count: Number(d.count) || 0, bytes: Number(d.bytes) || 0, limitCount: Number(d.limitCount) || 0, limitBytes: Number(d.limitBytes) || 0 };
        return store;
      })
      .catch(() => store) // 못 물어보면(오프라인 등) 막지 않음 — 서버가 한도를 지킴
      .finally(() => { storeReq = null; });
  }
  return storeReq;
}

/** 방금 올린 사진만큼 더함. 이번에 80%를 막 넘었으면 true */
function addToStore(img) {
  if (!store) return false;
  const before = storageUsage(store).warn;
  store = { ...store, count: store.count + 1, bytes: store.bytes + (Number(img.bytesF) || 0) + (Number(img.bytesT) || 0) };
  return !before && storageUsage(store).warn;
}

// ── 폼: 사진 칸 ─────────────────────────────────────────────
const BUSY = new Set(['wait', 'compress', 'upload']);
const isBusy = (it) => BUSY.has(it.status);

/**
 * model(): 지금 폼 모델 (초안을 불러오면 바뀌므로 함수로 받음). 올리기가 끝난 사진만 model().photos 에 들어감
 * onChange(): 사진 목록이 바뀜 (초안 저장용). onBusy(n): 올리는 중인 사진 수가 바뀜
 * onAdd(): 사진을 넣기 시작함 (붙여넣기 등 — 접혀 있던 사진 칸을 펼치게)
 * 여러 장을 고르면 줄이기·올리기를 한 장씩 차례로 (줄이는 동안 다음 사진은 '대기')
 */
export function photoField({ model, onChange, onBusy, onAdd }) {
  // 칸: { key, id?, status: 'wait'|'compress'|'upload'|'ok'|'error', session(이 폼에서 올림), file?, blobs?, preview?,
  //       uploadId(다시 올려도 같은 id → 응답만 못 받은 경우 두 장이 되지 않음), req?, sent?, started?, batch? }
  let items = [];
  let seq = 0;
  let idleWaiters = [];
  let alive = true;
  let closeSheet = null;
  const removed = new Map(); // 뺀 사진 → 서버에서 지우기 타이머 (그동안 '되돌리기' 가능)
  const compressQ = serialQueue();
  const uploadQ = serialQueue();

  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' });
  fileIn.addEventListener('change', () => {
    const files = [...(fileIn.files || [])];
    fileIn.value = '';
    addFiles(files);
  });
  const addBtn = h('button', { type: 'button', class: 'ph-add', onClick: () => fileIn.click() },
    icon('plus'), h('span', { class: 'ph-add-label', text: '사진 추가' }));
  const addCell = h('div', { class: 'ph-cell ph-cell-add', role: 'listitem' }, addBtn);
  const grid = h('div', { class: 'ph-grid', role: 'list', 'aria-label': '올린 사진' });
  const hint = h('p', { class: 'fhint ph-hint' });
  const storeNote = h('p', { class: 'ph-store', hidden: true });
  const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
  const el = h('div', { class: 'ph-field' }, grid, hint, storeNote, live, fileIn);

  const busyN = () => items.filter(isBusy).length;
  const failedN = () => items.filter((it) => it.status === 'error').length;
  const has = (it) => items.includes(it);

  function notify() {
    const n = busyN();
    if (onBusy) onBusy(n);
    if (!n) {
      const w = idleWaiters;
      idleWaiters = [];
      w.forEach((f) => f());
    }
  }

  /** 올리기가 끝난 사진만 순서대로 모델에 */
  function sync() {
    const ids = [];
    for (const it of items) if (it.status === 'ok' && it.id && !ids.includes(it.id)) ids.push(it.id);
    const m = model();
    if (JSON.stringify(m.photos || []) !== JSON.stringify(ids)) {
      m.photos = ids;
      onChange();
    }
  }

  function freePreview(it) {
    if (it.preview) { URL.revokeObjectURL(it.preview); it.preview = null; }
  }

  // ── 한 번에 고른 묶음: 모두 끝나면 실패를 이유별로 알림 하나씩 ──
  const newBatch = (n) => ({ left: n, fails: new Map() });
  function settle(it, err) {
    const b = it.batch;
    if (!b) return;
    it.batch = null;
    if (err && err.code !== 'unauthorized' && err.code !== 'aborted') {
      const code = err.code === 'network' ? 'timeout' : err.code; // 같은 안내
      const f = b.fails.get(code) || { n: 0, e: err };
      f.n++;
      b.fails.set(code, f);
    }
    if (--b.left > 0 || !alive) return;
    for (const [code, f] of b.fails) toast(batchMessage(code, f.n, f.e), 'error', 5500);
  }

  // ── 칸 그리기 (칸 요소는 사진마다 한 번 만들고 다시 씀 → 순서를 바꿔도 사진을 다시 안 불러옴) ──
  function build(it) {
    it.media = h('span', { class: 'ph-media' });
    it.openBtn = h('button', { type: 'button', class: 'ph-open', onClick: () => onOpen(it) }, it.media);
    it.stateEl = h('span', { class: 'ph-state', 'aria-hidden': 'true' });
    it.bar = h('span', { class: 'ph-bar-fill' });
    it.xBtn = h('button', { type: 'button', class: 'ph-x', onClick: () => remove(it) }, icon('x'));
    it.foot = h('div', { class: 'ph-foot' });
    it.tile = h('div', { class: 'ph-tile' }, it.openBtn, it.stateEl, h('span', { class: 'ph-bar', 'aria-hidden': 'true' }, it.bar), it.xBtn);
    it.el = h('div', { class: 'ph-cell', role: 'listitem' }, it.tile, it.foot);
    setMedia(it);
  }
  function setMedia(it) {
    if (it.id && it.status === 'ok') it.media.replaceChildren(photoImg(it.id, { size: 't', lazy: false }));
    else if (it.preview) it.media.replaceChildren(h('img', { src: it.preview, alt: '', class: 'ph-preview' }));
    else it.media.replaceChildren(h('span', { class: 'pimg is-loading' }));
  }
  const waiting = (it) => it.status === 'wait' || (it.status === 'upload' && !it.started);
  function paintState(it) {
    const busy = isBusy(it);
    const pct = Math.round((it.progress || 0) * 100);
    it.tile.classList.toggle('is-busy', busy);
    it.tile.classList.toggle('is-error', it.status === 'error');
    it.bar.style.width = it.status === 'upload' && it.started ? `${Math.max(4, pct)}%` : '0%';
    // 모양은 상태가 바뀔 때만 새로 (진행률마다 다시 만들면 도는 표시가 끊김), 글자만 갱신
    const shape = busy ? 'busy' : it.status;
    if (it.stateShape !== shape) {
      it.stateShape = shape;
      it.stateText = h('span');
      if (busy) it.stateEl.replaceChildren(h('span', { class: 'ph-spin' }), it.stateText);
      else if (it.status === 'error') it.stateEl.replaceChildren(icon('refresh'), it.stateText);
      else it.stateEl.replaceChildren();
    }
    it.stateText.textContent = waiting(it) ? '대기'
      : it.status === 'compress' ? '줄이는 중'
        : it.status === 'upload' ? (pct >= 99 ? '저장 중' : `${pct}%`)
          : it.status === 'error' ? '다시' : '';
  }
  function paintItem(it) {
    const i = items.indexOf(it);
    if (i < 0 || !it.el) return;
    const n = i + 1;
    const cover = i === 0;
    it.el.classList.toggle('is-cover', cover);
    paintState(it);
    const busy = isBusy(it);
    it.openBtn.disabled = busy;
    it.openBtn.setAttribute('aria-label', it.status === 'error'
      ? `사진 ${n} 올리지 못함 — 다시 올리기`
      : busy ? `사진 ${n} ${waiting(it) ? '올릴 차례를 기다리는 중' : it.status === 'compress' ? '줄이는 중' : '올리는 중'}`
        : `사진 ${n}${cover ? ' (첫 장)' : ''} — 크게 보기·순서 바꾸기`);
    it.xBtn.setAttribute('aria-label', `사진 ${n} 빼기`);
    // 첫 장은 목록 카드에 보이는 사진 (게임 정보의 대표 이미지와는 따로)
    it.foot.replaceChildren(cover && items.length > 1 ? h('span', { class: 'ph-badge', text: '첫 장' })
      : it.status === 'error' ? h('span', { class: 'ph-foot-note', text: '실패' }) : null);
  }
  function paint() {
    if (!alive) return;
    for (const it of items) if (!it.el) build(it);
    grid.classList.toggle('is-empty', items.length === 0);
    grid.replaceChildren(...items.map((it) => it.el), ...(items.length < MAX ? [addCell] : []));
    items.forEach(paintItem);
    hint.textContent = items.length > 1 ? `${items.length}/${MAX}장 · 사진을 누르면 크게 보거나 순서를 바꿔요` : `최대 ${MAX}장 · 위치 정보는 지우고 올려요`;
  }
  const announce = (msg) => { live.textContent = ''; setTimeout(() => { live.textContent = msg; }, 30); };

  /** 저장 공간이 80% 넘게 찼으면 남은 양을, 가득 찼으면 정리 방법을 보여 주고 사진 추가를 막음 */
  function paintStore() {
    if (!alive) return;
    const u = store ? storageUsage(store) : null;
    const full = !!(u && u.full);
    addBtn.disabled = full;
    if (full) addBtn.setAttribute('aria-describedby', storeNote.id);
    else addBtn.removeAttribute('aria-describedby');
    storeNote.hidden = !(u && u.warn);
    storeNote.classList.toggle('is-full', full);
    if (!u || !u.warn) return;
    const pct = Math.round(u.ratio * 100);
    storeNote.replaceChildren(icon('info'), h('span', {
      text: full ? FULL_MSG : `사진 저장 공간이 ${pct}% 찼어요${u.left !== null ? ` · 약 ${u.left.toLocaleString('ko-KR')}장 더 넣을 수 있어요` : ''}. 설정에서 안 쓰는 사진을 정리할 수 있어요`,
    }));
  }
  storeNote.id = `ph-store-${Math.random().toString(36).slice(2, 8)}`;

  // ── 추가 · 줄이기 · 올리기 (한 장씩 차례로) ──
  function addFiles(list) {
    if (!alive) return;
    // 형식은 줄이면서(디코드) 확인 — 이름만 이상한 사진(예: 종류가 비어 있는 HEIC)도 열 수 있으면 올림
    const files = list.filter(Boolean);
    if (!files.length) return;
    if (store && storageUsage(store).full) { toast(FULL_MSG, 'error', 5500); return; }
    const room = MAX - items.length;
    if (room <= 0) { toast(`사진은 ${MAX}장까지 넣을 수 있어요`, 'error'); return; }
    if (files.length > room) toast(`사진은 ${MAX}장까지라 앞의 ${room}장만 넣었어요`, 'info', 3500);
    if (onAdd) onAdd();
    const batch = newBatch(Math.min(files.length, room));
    for (const f of files.slice(0, room)) {
      const it = { key: ++seq, status: 'wait', file: f, session: true, progress: 0, batch };
      items.push(it);
      compressQ(() => compress(it));
    }
    paint();
    notify();
  }

  async function compress(it) {
    if (!alive || !has(it)) return; // 기다리는 동안 뺐거나 폼을 떠남
    it.status = 'compress';
    paintItem(it);
    let blobs;
    try {
      await nextFrame(); // 도는 표시가 한 번 그려진 뒤에 (줄이는 동안 화면이 멈춰 보이지 않게)
      blobs = await compressPhoto(it.file);
    } catch (e) {
      it.file = null;
      if (!has(it)) return;
      items.splice(items.indexOf(it), 1);
      paint();
      notify();
      settle(it, e);
      return;
    }
    it.file = null;
    if (!alive || !has(it)) return;
    it.blobs = blobs;
    it.preview = URL.createObjectURL(blobs.thumb);
    setMedia(it);
    queueUpload(it);
    await nextFrame();
  }

  function queueUpload(it) {
    it.status = 'upload';
    it.started = false;
    it.sent = false;
    it.progress = 0;
    it.uploadId = it.uploadId || api.newId();
    paintItem(it);
    notify();
    uploadQ(() => upload(it));
  }

  async function upload(it) {
    if (!alive || !has(it)) return;
    it.started = true;
    paintItem(it);
    try {
      const [full, thumb] = await Promise.all([blobToBase64(it.blobs.full), blobToBase64(it.blobs.thumb)]);
      if (!has(it)) return;
      it.req = api.uploadImage({ id: it.uploadId, full, thumb }, {
        onProgress: (p) => { it.progress = p; if (has(it)) paintState(it); },
        onSent: () => { it.sent = true; },
      });
      const res = await it.req.promise;
      it.req = null;
      const img = res && res.image;
      if (!img || typeof img.id !== 'string') throw new api.ApiError('server_error', 0);
      if (!has(it)) { discard([img.id]); return; } // 다 보낸 뒤에 뺀 사진 (서버엔 저장됨)
      it.id = img.id;
      it.status = 'ok';
      if (!res.existed && addToStore(img) && !warned80) {
        warned80 = true;
        toast('사진 저장 공간이 80%를 넘었어요. 설정 → 사진 저장 공간에서 확인해 주세요', 'info', 5500);
      }
      paintStore();
      seedImage(it.id, 't', it.blobs.thumb);
      seedImage(it.id, 'f', it.blobs.full);
      it.blobs = null;
      setMedia(it);
      freePreview(it);
      sync();
      settle(it, null);
    } catch (e) {
      it.req = null;
      if (!has(it) || (e && e.code === 'aborted')) return;
      it.status = 'error';
      if (e && e.code === 'limit') loadStore().then(paintStore); // 가득 참 → 사진 칸에도 안내
      settle(it, e);
    }
    paint();
    notify();
  }

  /** 올리는 중인 사진 그만두기: 아직 다 보내지 않았으면 끊음. 다 보냈으면 끝까지 받은 뒤 서버에서 지움(upload 가 처리) */
  function cancel(it) {
    if (it.req && !it.sent) it.req.abort();
    settle(it, null);
  }

  const discard = discardPhotos;

  function remove(it) {
    const i = items.indexOf(it);
    if (i < 0) return;
    items.splice(i, 1);
    if (isBusy(it)) cancel(it);
    freePreview(it);
    sync();
    paint();
    notify();
    announce(`${i + 1}번 사진을 뺐어요`);
    // 초점이 사라진 버튼과 함께 없어지지 않게 옆 칸으로
    const next = items[i] || items[i - 1];
    const target = next && next.openBtn && !next.openBtn.disabled ? next.openBtn : addBtn;
    if (target.isConnected) target.focus({ preventScroll: true });
    if (it.status !== 'ok' || !it.id) return;
    // 올린 사진은 잠깐 되돌릴 수 있게: 서버에서 지우는 건 그 뒤로 (폼을 떠나면 바로).
    // 저장된 기록이 쓰는 사진(수정 중인 기록의 원래 사진 등)은 여기서 지우지 않음 — 저장하면 서버가 하루 유예 뒤 정리
    // (저장 뒤에는 이 기기 목록에서도 빠지므로 뺄 때 미리 확인해 둠)
    const owned = !referencedPhotos().includes(it.id);
    removed.set(it, { owned, timer: setTimeout(() => flushRemoved(it), UNDO_MS + 1000) });
    toast(`${i + 1}번 사진을 뺐어요`, 'info', UNDO_MS, { action: { label: '되돌리기', onClick: () => undo(it, i) } });
  }

  function undo(it, at) {
    if (!alive || !removed.has(it)) return;
    const { owned } = removed.get(it);
    clearTimeout(removed.get(it).timer);
    removed.delete(it);
    if (items.length >= MAX || items.some((x) => x.id === it.id)) {
      toast(`사진은 ${MAX}장까지라 되돌리지 못했어요`, 'error');
      if (owned) discard([it.id]);
      return;
    }
    items.splice(Math.min(at, items.length), 0, it);
    sync();
    paint();
    notify();
    announce(`${Math.min(at, items.length - 1) + 1}번 사진을 되돌렸어요`);
    if (it.openBtn && it.openBtn.isConnected) it.openBtn.focus({ preventScroll: true });
  }

  /** 되돌릴 시간이 지남 → 이 폼·초안에서 올린 사진이면 서버에서도 지움 (저장된 기록이 쓰는 사진은 그대로) */
  function flushRemoved(it) {
    const r = removed.get(it);
    if (!r) return;
    clearTimeout(r.timer);
    removed.delete(it);
    if (r.owned) discard([it.id]);
  }
  const flushAllRemoved = () => [...removed.keys()].forEach(flushRemoved);

  function move(it, to) {
    const from = items.indexOf(it);
    if (from < 0 || to < 0 || to >= items.length || from === to) return;
    items.splice(from, 1);
    items.splice(to, 0, it);
    sync();
    paint();
    if (it.openBtn && !it.openBtn.disabled) it.openBtn.focus({ preventScroll: true });
  }

  function onOpen(it) {
    if (it.status === 'error') { it.batch = newBatch(1); queueUpload(it); return; }
    if (it.status !== 'ok') return;
    const i = items.indexOf(it);
    const n = i + 1;
    const last = items.length - 1;
    let close = () => {};
    const act = (label, fn, cls = 'btn-soft', ic = null, aria = null) => h('button', {
      type: 'button', class: `btn ${cls}`, 'aria-label': aria,
      onClick: () => { close(null); fn(); },
    }, ic ? icon(ic) : null, h('span', { text: label }));
    const ready = items.filter((x) => x.status === 'ok' && x.id);
    openDialog({
      title: `사진 ${n}${i === 0 ? ' · 첫 장' : ''}`,
      cls: 'dlg-photo',
      body: h('div', { class: 'ph-sheet' },
        h('div', { class: 'ph-sheet-prev' }, photoImg(it.id, { size: 'f', progressive: true, lazy: false, alt: `사진 ${n}` })),
        h('div', { class: 'ph-sheet-actions' },
          act('크게 보기', () => openViewer(ready.map((x) => x.id), ready.indexOf(it), { opener: it.openBtn }), 'btn-soft', 'eye'),
          last > 0 ? h('div', { class: 'ph-sheet-row', role: 'group', 'aria-label': '순서 바꾸기' },
            i > 0 ? act('첫 장으로', () => move(it, 0), 'btn-soft', 'check', `${n}번 사진을 첫 장으로`) : null,
            // 앱의 '뒤로'(이전 화면)와 헷갈리지 않게 '순서'를 붙임
            i > 0 ? act('앞 순서로', () => move(it, i - 1), 'btn-soft', 'back', `${n}번 사진을 앞 순서로`) : null,
            i < last ? act('뒤 순서로', () => move(it, i + 1), 'btn-soft', 'chevron', `${n}번 사진을 뒤 순서로`) : null) : null,
          act('사진 빼기', () => remove(it), 'btn-danger-soft', 'trash'))),
      actions: [{ label: '닫기', value: null, kind: 'ghost' }],
      bind: (c) => { close = c; closeSheet = c; },
    }).then(() => { closeSheet = null; });
  }

  // ── 붙여넣기 · 끌어다 놓기 ──
  function onPaste(e) {
    if (!alive || !el.isConnected || document.querySelector('dialog[open]')) return;
    const dt = e.clipboardData;
    const files = dt ? [...(dt.files || [])].filter((f) => f.type && f.type.startsWith('image/')) : [];
    if (!files.length) return;
    // 글 칸에 글자를 붙여넣는 중이면 방해하지 않음 (워드 등은 글과 그림을 같이 복사함)
    const t = e.target;
    const typing = t && t.nodeType === 1 && (t.isContentEditable || t.matches('input, textarea'));
    if (typing && [...(dt.types || [])].includes('text/plain')) return;
    e.preventDefault();
    addFiles(files);
    el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  document.addEventListener('paste', onPaste);
  el.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); el.classList.add('is-drop'); }
  });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop'); });
  el.addEventListener('drop', (e) => {
    el.classList.remove('is-drop');
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });

  /** 지금 칸을 모두 그만둠 (올리는 중인 건 끊거나 끝난 뒤 지우고, 되돌리기를 기다리던 사진도 지금 정리) */
  function dropAll() {
    flushAllRemoved();
    const old = items;
    items = [];
    for (const it of old) {
      it.batch = null; // 그만둔 묶음의 실패는 알리지 않음
      if (isBusy(it)) cancel(it);
      freePreview(it);
    }
    return old;
  }

  /** 모델의 사진 목록으로 다시 채움 (초안 불러오기 등) */
  function reset(ids) {
    const next = Array.isArray(ids) ? ids : [];
    const old = dropAll();
    // 불러온 초안에 없는, 방금 이 폼에서 올린 사진은 지움
    discard(old.filter((it) => it.session && it.id && !next.includes(it.id)).map((it) => it.id));
    items = next.map((id) => ({ key: ++seq, id, status: 'ok', session: false }));
    paint();
    notify();
  }

  reset(model().photos);
  paintStore(); // 앞서 물어본 값이 있으면 바로, 새 값은 받는 대로
  loadStore().then(paintStore);

  return {
    el,
    busy: busyN,
    failed: failedN,
    /** 올리는 중인 사진이 모두 끝날 때까지 */
    whenIdle: () => (busyN() ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve()),
    reset,
    count: () => items.length,
    /** 서버에 없는 사진 빼기 (오래된 초안의 사진이 정리된 경우) */
    drop(ids) {
      const gone = new Set(ids);
      items = items.filter((it) => !(it.status === 'ok' && gone.has(it.id)));
      sync();
      paint();
      notify();
    },
    /** 작성을 그만둠: 저장된 기록이 쓰지 않는 사진(이 폼·초안에서 올린 것, 되돌리기를 기다리던 것)은 지움 */
    discardUnsaved() {
      flushAllRemoved();
      discard(items.filter((it) => it.id).map((it) => it.id));
    },
    focus() {
      if (onAdd) onAdd();
      el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
      const bad = items.find((it) => it.status === 'error');
      const target = bad ? bad.openBtn : addBtn;
      target.focus({ preventScroll: true });
    },
    destroy() {
      // 화면을 떠남(또는 잠김): 사진 시트·뷰어도 닫음
      if (closeSheet) closeSheet(null);
      closeViewer();
      document.removeEventListener('paste', onPaste);
      alive = false;
      dropAll();
      const w = idleWaiters;
      idleWaiters = [];
      w.forEach((f) => f());
    },
  };
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
