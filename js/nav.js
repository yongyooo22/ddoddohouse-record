// 해시 라우팅 보조: 이동 / 뒤로가기 / 화면 사이에 넘기는 한 번짜리 표시
let depth = 0;
let router = () => {};

export function setRouter(fn) { router = fn; }
export function markRendered() { depth += 1; }

/** 해시로 이동. replace=true 면 현재 항목을 바꿔치기 */
export function navigate(hash, { replace = false } = {}) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (replace) {
    history.replaceState(null, '', target);
    router();
  } else if (location.hash === target) {
    router();
  } else {
    location.hash = target;
  }
}

/** 앱 안에서 온 경우 history.back(), 아니면 fallback 으로 */
export function goBack(fallback = '#/') {
  if (depth > 1 && history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}

// 바로 앞 화면의 주소 (저장 후 같은 화면이 history 에 두 번 쌓이지 않게 — 앞 화면이면 뒤로 가기)
let prevHash = null;
let curHash = null;
export function noteRoute(hash) {
  if (hash === curHash) return;
  prevHash = curHash;
  curHash = hash;
}

/** 저장 뒤 target 으로: 바로 앞 화면이 target 이면 뒤로 가기, 아니면 지금 항목을 target 으로 바꿈 */
export function returnTo(target) {
  if (prevHash === target && depth > 1 && history.length > 1) history.back();
  else navigate(target, { replace: true });
}

// 저장 직후 상세 화면에서 도장을 한 번만 보여 주기 위한 표시 (새로고침하면 사라짐)
let justSaved = null;
export function markJustSaved(id) { justSaved = id; }
export function takeJustSaved(id) {
  if (justSaved !== id) return false;
  justSaved = null;
  return true;
}
