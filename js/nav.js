// 해시 라우팅 보조: 이동 / 뒤로가기
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
