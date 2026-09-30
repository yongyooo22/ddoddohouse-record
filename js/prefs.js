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

// ── 새 기록 초안 (앱을 닫았다 열어도 이어 쓰기) ──
export function getDraft() {
  const raw = lsGet(PREFS.draft);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return d && typeof d === 'object' && d.model && typeof d.model === 'object' ? d : null;
  } catch {
    return null;
  }
}
export function setDraft(d) {
  try { return lsSet(PREFS.draft, JSON.stringify(d)); } catch { return false; }
}
export const clearDraft = () => lsRemove(PREFS.draft);

/** 초안이 붙잡고 있는 사진 id (사진 정리 때 지우지 않도록) */
export function draftPhotoIds() {
  const d = getDraft();
  const photos = d && d.model && Array.isArray(d.model.photos) ? d.model.photos : [];
  return photos.filter((x) => typeof x === 'string');
}

/** 이 기기의 화면 설정·초안 모두 지우기 */
export function clearAllPrefs() {
  for (const k of Object.values(PREFS)) lsRemove(k);
}
