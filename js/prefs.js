// 이 기기에서만 쓰는 화면 설정·작성 중인 초안 (localStorage — 사생활 보호 모드 등에서 throw 할 수 있어 감쌈)
import { PREFS } from './constants.js';

export function lsGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
export function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; } catch { return false; }
}
export function lsRemove(k) {
  try { localStorage.removeItem(k); } catch { /* 무시 */ }
}

export const getTheme = () => {
  const t = lsGet(PREFS.theme);
  return t === 'dark' || t === 'system' ? t : 'light';
};
export const setTheme = (t) => {
  if (t === 'dark' || t === 'system') lsSet(PREFS.theme, t);
  else lsRemove(PREFS.theme);
};

/** 카드형(card) / 목록형(list) */
export const getView = () => (lsGet(PREFS.view) === 'list' ? 'list' : 'card');
export const setView = (v) => lsSet(PREFS.view, v === 'list' ? 'list' : 'card');

/** 작품별로 묶어 보기 */
export const getGroup = () => lsGet(PREFS.group) === '1';
export const setGroup = (on) => (on ? lsSet(PREFS.group, '1') : lsRemove(PREFS.group));

export const getLastGenre = () => lsGet(PREFS.lastGenre) || '';
export const setLastGenre = (g) => lsSet(PREFS.lastGenre, g);

// ── 작성 중인 초안 (앱을 닫았다 열어도 이어 쓰기) ──
// 폼을 연 곳마다 따로 보관: 'new'(새 기록), 'new:work:<작품 id>'(작품 화면에서 연 새 기록), 'edit:<기록 id>'
const MAX_DRAFTS = 12;

function readDrafts() {
  const raw = lsGet(PREFS.drafts);
  if (!raw) return {};
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

function writeDrafts(all) {
  const keys = Object.keys(all);
  if (!keys.length) { lsRemove(PREFS.drafts); return true; }
  try { return lsSet(PREFS.drafts, JSON.stringify(all)); } catch { return false; }
}

export function getDraft(key) {
  const d = readDrafts()[key];
  return d && typeof d === 'object' && d.model && typeof d.model === 'object' ? d : null;
}

export function setDraft(key, d) {
  const all = readDrafts();
  all[key] = d;
  // 너무 많이 쌓이면 오래된 초안부터 정리
  const keys = Object.keys(all).sort((a, b) => String(all[b].savedAt || '').localeCompare(String(all[a].savedAt || '')));
  for (const k of keys.slice(MAX_DRAFTS)) delete all[k];
  return writeDrafts(all);
}

export function clearDraft(key) {
  const all = readDrafts();
  if (!(key in all)) return;
  delete all[key];
  writeDrafts(all);
}

export const clearAllDrafts = () => lsRemove(PREFS.drafts);

/** 모든 초안이 붙잡고 있는 사진 id (사진 정리 때 지우지 않도록) */
export function draftPhotoIds() {
  const ids = [];
  for (const d of Object.values(readDrafts())) {
    const photos = d && d.model && Array.isArray(d.model.photos) ? d.model.photos : [];
    for (const x of photos) if (typeof x === 'string') ids.push(x);
  }
  return ids;
}

/** 이 기기의 화면 설정·초안 모두 지우기 */
export function clearAllPrefs() {
  for (const k of Object.values(PREFS)) lsRemove(k);
}
