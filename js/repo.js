// 저장소 — 메모리 상태 + IndexedDB 저장 + 다른 탭에 변경 알림
// 화면은 이 모듈만 통해 기록을 읽고 쓴다. 나중에 로그인·동기화를 붙일 때는 여기(commit)에서
// 서버로 보내고, init()에서 받아 합치면 된다 (README "로그인·동기화를 붙이려면" 참고).
import * as db from './db.js';
import { DEFAULT_BOOK_NAME, LIMITS } from './constants.js';
import { normalizeWork, normalizePlay, newId, isId, cleanLine, charLength, DETAIL_KEYS, SPOILER_KEYS } from './model.js';
import { workStats, playOrdinals, cmpPlayDesc, companionNames } from './query.js';

export class ValidationFailed extends Error {
  constructor(errors) {
    super('invalid');
    this.errors = errors || {};
  }
}

export const state = {
  ready: false,
  error: null, // null | 'unavailable' | 'failed'
  works: new Map(),
  plays: new Map(),
  bookName: DEFAULT_BOOK_NAME,
  version: 0,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let memo = {};
function changed({ broadcast = true } = {}) {
  state.version += 1;
  memo = {};
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error(e); }
  }
  if (broadcast) post();
}

// ── 다른 탭과 맞추기 (같은 브라우저에서 두 탭을 열어 둔 경우) ──
const TAB_ID = newId('t');
let channel = null;
function post() {
  try { if (channel) channel.postMessage({ type: 'changed', from: TAB_ID }); } catch { /* 무시 */ }
}

let imageHooks = [];
/** 사진이 지워질 때 알림 (화면에 띄워 둔 사진 주소를 정리하려고). ids 가 null 이면 모두 */
export function onImagesDeleted(fn) { imageHooks.push(fn); }
function imagesDeleted(ids) {
  if (ids && !ids.length) return;
  for (const fn of imageHooks) {
    try { fn(ids); } catch { /* 무시 */ }
  }
}

async function loadAll() {
  const [works, plays, meta] = await Promise.all([db.getAll('works'), db.getAll('plays'), db.getAll('meta')]);
  state.works = new Map(works.filter((w) => w && isId(w.id)).map((w) => [w.id, w]));
  state.plays = new Map(plays.filter((p) => p && isId(p.id) && state.works.has(p.workId)).map((p) => [p.id, p]));
  const name = meta.find((m) => m && m.key === 'bookName');
  state.bookName = name && typeof name.value === 'string' && name.value.trim() ? name.value : DEFAULT_BOOK_NAME;
}

export async function init() {
  try {
    await loadAll();
    state.ready = true;
    state.error = null;
  } catch (e) {
    state.ready = false;
    state.error = (e && e.code) || 'failed';
    changed({ broadcast: false });
    return false;
  }
  if (typeof BroadcastChannel === 'function' && !channel) {
    channel = new BroadcastChannel('ddoddohouse-record');
    channel.onmessage = (e) => {
      if (e.data && e.data.type === 'changed' && e.data.from !== TAB_ID) reload();
    };
  }
  changed({ broadcast: false });
  return true;
}

let reloading = null;
let reloadAgain = false;
/** IndexedDB 에서 다시 읽기 (다른 탭에서 바뀜) */
export function reload() {
  if (reloading) { reloadAgain = true; return reloading; }
  reloading = loadAll()
    .then(() => changed({ broadcast: false }))
    .catch(() => {})
    .finally(() => {
      reloading = null;
      if (reloadAgain) { reloadAgain = false; reload(); }
    });
  return reloading;
}

// ── 읽기 (버전마다 한 번만 계산) ──
function cached(k, fn) {
  if (!(k in memo)) memo[k] = fn();
  return memo[k];
}

export const worksList = () => cached('works', () => [...state.works.values()]);
/** 모든 플레이 기록 (최근 날짜순) */
export const playsList = () => cached('plays', () => [...state.plays.values()].sort(cmpPlayDesc));
export const workMap = () => state.works;
export const stats = () => cached('stats', () => workStats(playsList()));
export const ordinals = () => cached('ord', () => playOrdinals(playsList()));
export const companions = () => cached('companions', () => companionNames(playsList()));
export const getWork = (id) => state.works.get(id) || null;
export const getPlay = (id) => state.plays.get(id) || null;
/** 작품 id → 그 작품의 플레이 기록 (최근순) */
const playsByWork = () => cached('byWork', () => {
  const m = new Map();
  for (const p of playsList()) {
    if (!m.has(p.workId)) m.set(p.workId, []);
    m.get(p.workId).push(p);
  }
  return m;
});
export const playsOfWork = (workId) => playsByWork().get(workId) || [];
export const sampleCount = () => cached('sampleCount', () => playsList().filter((p) => p.sample).length);
export const realCount = () => playsList().length - sampleCount();

/** 플레이 카드의 대표 사진: 그날 사진 첫 장 → 작품 표지 */
export function playCover(play) {
  if (play && Array.isArray(play.photos) && play.photos.length) return play.photos[0];
  const w = play ? getWork(play.workId) : null;
  return (w && w.cover) || null;
}

/** 작품의 대표 사진: 작품 표지 → 가장 최근 플레이의 사진 */
export function workCover(work) {
  if (!work) return null;
  if (work.cover) return work.cover;
  for (const p of playsOfWork(work.id)) if (p.photos && p.photos.length) return p.photos[0];
  return null;
}

// ── 쓰기 ──

/**
 * 변경을 한 트랜잭션으로 저장하고 메모리에 반영.
 * dropImages: 이번 변경으로 쓰이지 않게 될 수 있는 사진 — 다른 기록이 여전히 쓰면 남긴다.
 */
async function commit({ putWorks = [], putPlays = [], delWorks = [], delPlays = [], dropImages = [] }) {
  const nextWorks = new Map(state.works);
  const nextPlays = new Map(state.plays);
  for (const w of putWorks) nextWorks.set(w.id, w);
  for (const p of putPlays) nextPlays.set(p.id, p);
  for (const id of delWorks) nextWorks.delete(id);
  for (const id of delPlays) nextPlays.delete(id);
  const used = new Set();
  for (const p of nextPlays.values()) for (const i of p.photos || []) used.add(i);
  for (const w of nextWorks.values()) if (w.cover) used.add(w.cover);
  const orphans = [...new Set(dropImages)].filter((id) => id && !used.has(id));
  const now = new Date().toISOString();
  await db.run(['works', 'plays', 'images', 'deleted'], 'readwrite', (s) => {
    for (const w of putWorks) s.works.put(w);
    for (const p of putPlays) s.plays.put(p);
    for (const id of delWorks) {
      const w = state.works.get(id);
      s.works.delete(id);
      if (w && !w.sample) s.deleted.put({ id, kind: 'work', at: now });
    }
    for (const id of delPlays) {
      const p = state.plays.get(id);
      s.plays.delete(id);
      if (p && !p.sample) s.deleted.put({ id, kind: 'play', at: now });
    }
    for (const id of orphans) s.images.delete(id);
  });
  state.works = nextWorks;
  state.plays = nextPlays;
  imagesDeleted(orphans);
  changed();
}

/**
 * 플레이 기록 저장 (새로 쓰기·수정).
 * input.workId 로 기존 작품에 붙이거나, newWork({genre,title,store,branch})로 작품을 함께 만든다.
 * @returns {{play, work, removedWorkId}}  removedWorkId: 다른 작품으로 옮기면서 비어서 정리된 작품
 */
export async function savePlay(input, { newWork = null } = {}) {
  const now = new Date().toISOString();
  const prev = input && isId(input.id) ? state.plays.get(input.id) || null : null;
  let work;
  const putWorks = [];
  if (newWork) {
    const r = normalizeWork({ ...newWork, id: undefined, cover: null, createdAt: now, updatedAt: now, sample: false }, { now });
    if (!r.ok) throw new ValidationFailed(r.errors);
    work = r.value;
    putWorks.push(work);
  } else {
    work = state.works.get(input && input.workId);
    if (!work) throw new ValidationFailed({ workId: '연결할 작품을 찾지 못했어요. 작품을 다시 골라 주세요' });
  }
  const r = normalizePlay({
    ...input,
    workId: work.id,
    createdAt: prev ? prev.createdAt : now,
    updatedAt: now,
    sample: prev ? prev.sample === true : false,
  }, work.genre, { now });
  if (!r.ok) throw new ValidationFailed(r.errors);
  const play = r.value;
  // 예시 작품에 내 기록을 더하면 그 작품은 더 이상 예시가 아님 (예시를 지워도 남도록)
  if (!newWork && work.sample && !play.sample) {
    const { sample, ...rest } = work;
    work = { ...rest, updatedAt: now };
    putWorks.push(work);
  }
  const dropImages = prev ? prev.photos.filter((id) => !play.photos.includes(id)) : [];
  const delWorks = [];
  if (prev && prev.workId !== play.workId) {
    const left = [...state.plays.values()].some((p) => p.workId === prev.workId && p.id !== play.id);
    if (!left) {
      delWorks.push(prev.workId);
      const old = state.works.get(prev.workId);
      if (old && old.cover) dropImages.push(old.cover);
    }
  }
  await commit({ putWorks, putPlays: [play], delWorks, dropImages });
  return { play, work, removedWorkId: delWorks[0] || null };
}

/** 플레이 기록 지우기. 작품의 마지막 기록이면 작품(표지 포함)도 함께 지운다 */
export async function deletePlay(id) {
  const play = state.plays.get(id);
  if (!play) return { workRemoved: false };
  const left = [...state.plays.values()].some((p) => p.workId === play.workId && p.id !== id);
  const work = state.works.get(play.workId);
  const dropImages = [...(play.photos || [])];
  if (!left && work && work.cover) dropImages.push(work.cover);
  await commit({ delPlays: [id], delWorks: left ? [] : [play.workId], dropImages });
  return { workRemoved: !left };
}

/** 장르를 바꾸면 사라지는 장르별 항목이 있는 플레이 기록 수 */
export function genreChangeLoss(workId, nextGenre) {
  const work = state.works.get(workId);
  if (!work || work.genre === nextGenre) return 0;
  const lostD = (DETAIL_KEYS[work.genre] || []).filter((k) => !(DETAIL_KEYS[nextGenre] || []).includes(k));
  const lostS = (SPOILER_KEYS[work.genre] || []).filter((k) => !(SPOILER_KEYS[nextGenre] || []).includes(k));
  const filled = (v) => v !== null && v !== undefined && v !== '';
  return playsOfWork(workId).filter((p) =>
    lostD.some((k) => filled((p.details || {})[k])) || lostS.some((k) => filled((p.spoiler || {})[k]))).length;
}

/** 작품 정보 수정 (제목·매장·지점·표지·장르) */
export async function saveWork(input) {
  const prev = state.works.get(input && input.id);
  if (!prev) throw new ValidationFailed({ id: '작품을 찾지 못했어요' });
  const now = new Date().toISOString();
  const r = normalizeWork({ ...input, createdAt: prev.createdAt, updatedAt: now, sample: prev.sample === true }, { now });
  if (!r.ok) throw new ValidationFailed(r.errors);
  const work = r.value;
  const putPlays = [];
  // 장르가 바뀌면 플레이 기록도 새 장르 기준으로 정리 (공통 항목·같은 이름의 항목은 유지)
  if (work.genre !== prev.genre) {
    for (const p of playsOfWork(work.id)) {
      const rp = normalizePlay({ ...p, updatedAt: now }, work.genre, { now });
      if (rp.ok) putPlays.push(rp.value);
    }
  }
  const dropImages = prev.cover && prev.cover !== work.cover ? [prev.cover] : [];
  await commit({ putWorks: [work], putPlays, dropImages });
  return work;
}

/** 작품과 그 플레이 기록 모두 지우기 */
export async function deleteWork(id) {
  const work = state.works.get(id);
  if (!work) return 0;
  const plays = playsOfWork(id);
  const dropImages = plays.flatMap((p) => p.photos || []);
  if (work.cover) dropImages.push(work.cover);
  await commit({ delWorks: [id], delPlays: plays.map((p) => p.id), dropImages });
  return plays.length;
}

/** 같은 작품이 둘로 나뉘었을 때 합치기: from 의 기록을 모두 to 로 옮기고 from 은 지움 */
export async function mergeWork(fromId, toId) {
  const from = state.works.get(fromId);
  const to = state.works.get(toId);
  if (!from || !to || from.id === to.id || from.genre !== to.genre) throw new ValidationFailed({ merge: '같은 장르의 다른 작품만 합칠 수 있어요' });
  const now = new Date().toISOString();
  const putPlays = playsOfWork(fromId).map((p) => ({ ...p, workId: toId, updatedAt: now }));
  const putWorks = [];
  const dropImages = [];
  if (from.cover) {
    // 합칠 작품에 표지가 없으면 표지를 넘겨 줌
    if (!to.cover) putWorks.push({ ...to, cover: from.cover, updatedAt: now });
    else dropImages.push(from.cover);
  }
  await commit({ putWorks, putPlays, delWorks: [fromId], dropImages });
  return putPlays.length;
}

export async function setBookName(name) {
  let v = cleanLine(name);
  if (charLength(v) > LIMITS.bookName) v = [...v].slice(0, LIMITS.bookName).join('');
  if (!v) v = DEFAULT_BOOK_NAME;
  await db.run(['meta'], 'readwrite', (s) => { s.meta.put({ key: 'bookName', value: v }); });
  state.bookName = v;
  changed();
  return v;
}

// ── 사진 ──

/** 사진 id 에 만든 시각을 담아 둠 → 쓰이지 않는 사진을 정리할 때 "만든 지 하루 지났는지"를 바이트를 읽지 않고 판단 */
export function newImageId(t = Date.now()) {
  return `i_${t.toString(36)}_${newId('x').slice(2, 14)}`;
}
export function imageTime(id) {
  const m = /^i_([0-9a-z]+)_/.exec(String(id));
  return m ? parseInt(m[1], 36) : 0;
}

/** 줄인 사진 저장 → id */
export async function putImage({ full, thumb, width, height, sample = false }) {
  const [f, t] = await Promise.all([full.arrayBuffer(), thumb.arrayBuffer()]);
  const rec = {
    id: newImageId(),
    type: full.type || 'image/jpeg',
    thumbType: thumb.type || 'image/jpeg',
    full: f,
    thumb: t,
    width: Number(width) || 0,
    height: Number(height) || 0,
    size: f.byteLength + t.byteLength,
    createdAt: new Date().toISOString(),
  };
  if (sample) rec.sample = true;
  await db.run(['images'], 'readwrite', (s) => { s.images.put(rec); });
  return rec.id;
}

export function getImage(id) {
  return isId(id) ? db.getOne('images', id) : Promise.resolve(null);
}

/** 저장된 기록이 쓰는 사진 id */
export function referencedImages() {
  const used = new Set();
  for (const p of state.plays.values()) for (const i of p.photos || []) used.add(i);
  for (const w of state.works.values()) if (w.cover) used.add(w.cover);
  return used;
}

/** 폼에서 올렸다가 뺀 사진 지우기 (저장된 기록이 쓰는 사진은 절대 지우지 않음) */
export async function discardImages(ids) {
  const used = referencedImages();
  const del = [...new Set(ids)].filter((id) => isId(id) && !used.has(id));
  if (!del.length) return 0;
  await db.run(['images'], 'readwrite', (s) => { for (const id of del) s.images.delete(id); });
  imagesDeleted(del);
  return del.length;
}

/**
 * 어떤 기록에도 쓰이지 않는 사진 정리. keep: 작성 중인 초안의 사진.
 * 다른 탭에서 쓰는 중인 폼의 사진을 지우지 않도록, 올린 지 graceMs 가 지난 것만.
 */
export async function cleanupOrphanImages({ keep = [], graceMs = 24 * 3600 * 1000 } = {}) {
  const keys = await db.getAllKeys('images');
  const used = referencedImages();
  for (const k of keep) used.add(k);
  const now = Date.now();
  const del = keys.filter((id) => !used.has(id) && now - imageTime(id) > graceMs);
  if (!del.length) return 0;
  await db.run(['images'], 'readwrite', (s) => { for (const id of del) s.images.delete(id); });
  imagesDeleted(del);
  return del.length;
}

export async function imageCount() {
  return (await db.getAllKeys('images')).length;
}

// ── 예시 기록 ──

/** 예시 작품·기록·사진 넣기 (모두 sample: true) */
export async function addSamples({ works, plays, images = [] }) {
  await db.run(['works', 'plays', 'images'], 'readwrite', (s) => {
    for (const im of images) s.images.put(im);
    for (const w of works) s.works.put(w);
    for (const p of plays) s.plays.put(p);
  });
  const next = new Map(state.works);
  for (const w of works) next.set(w.id, w);
  const nextP = new Map(state.plays);
  for (const p of plays) nextP.set(p.id, p);
  state.works = next;
  state.plays = nextP;
  changed();
}

/** 예시 기록 모두 지우기. 예시 작품에 내 기록을 더했다면 그 작품과 내 기록은 남긴다 */
export async function removeSamples() {
  const delPlays = playsList().filter((p) => p.sample);
  const delIds = new Set(delPlays.map((p) => p.id));
  const delWorks = [];
  const putWorks = [];
  const dropImages = delPlays.flatMap((p) => p.photos || []);
  for (const w of state.works.values()) {
    const left = [...state.plays.values()].some((p) => p.workId === w.id && !delIds.has(p.id));
    if (!left) {
      delWorks.push(w.id);
      if (w.cover) dropImages.push(w.cover);
    } else if (w.sample) {
      const { sample, ...rest } = w;
      putWorks.push(rest);
    }
  }
  await commit({ putWorks, delWorks, delPlays: [...delIds], dropImages });
  return delIds.size;
}

// ── 가져오기 · 모두 지우기 ──

/**
 * 백업에서 읽은(검증을 마친) 작품·기록·사진 저장.
 * mode 'merge': 이미 있는 id 는 건너뜀, 'replace': 모두 지우고 백업으로 바꿈
 */
export async function importData({ works, plays, images, bookName }, { mode = 'merge' } = {}) {
  const replace = mode === 'replace';
  const haveW = replace ? new Set() : new Set(state.works.keys());
  const haveP = replace ? new Set() : new Set(state.plays.keys());
  const haveI = replace ? new Set() : new Set(await db.getAllKeys('images'));
  let addW = works.filter((w) => !haveW.has(w.id));
  let addP = plays.filter((p) => !haveP.has(p.id) && (haveW.has(p.workId) || addW.some((w) => w.id === p.workId)));
  // 백업에도, 이 브라우저에도 없는 사진(사진 없이 내보낸 백업 등)은 기록에서 뺌
  const available = new Set([...haveI, ...images.map((im) => im.id)]);
  addW = addW.map((w) => (w.cover && !available.has(w.cover) ? { ...w, cover: null } : w));
  addP = addP.map((p) => (p.photos.some((i) => !available.has(i)) ? { ...p, photos: p.photos.filter((i) => available.has(i)) } : p));
  const neededImages = new Set();
  for (const p of addP) for (const i of p.photos || []) neededImages.add(i);
  for (const w of addW) if (w.cover) neededImages.add(w.cover);
  const addI = images.filter((im) => neededImages.has(im.id) && !haveI.has(im.id));
  if (replace) {
    await db.clearAll();
    imagesDeleted(null);
  }
  // 사진은 크기가 커서 여러 번에 나눠 저장
  for (let i = 0; i < addI.length; i += 10) {
    const chunk = addI.slice(i, i + 10);
    await db.run(['images'], 'readwrite', (s) => { for (const im of chunk) s.images.put(im); });
  }
  await db.run(['works', 'plays', 'meta'], 'readwrite', (s) => {
    for (const w of addW) s.works.put(w);
    for (const p of addP) s.plays.put(p);
    if (bookName && (replace || state.bookName === DEFAULT_BOOK_NAME)) s.meta.put({ key: 'bookName', value: bookName });
  });
  await loadAll();
  changed();
  return { works: addW.length, plays: addP.length, images: addI.length, skipped: plays.length - addP.length };
}

/** 이 브라우저에 저장된 기록·사진 모두 지우기 */
export async function wipeAll() {
  await db.clearAll();
  state.works = new Map();
  state.plays = new Map();
  state.bookName = DEFAULT_BOOK_NAME;
  imagesDeleted(null);
  changed();
}

/** 전체 사진 id 목록 (백업 내보내기용) */
export const allImageIds = () => db.getAllKeys('images');
