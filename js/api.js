// fetch 래퍼 — x-app-key 헤더, 타임아웃, 에러 코드 정규화
import { getKey } from './store.js';

const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(code, status = 0, data = null) {
    super(code);
    this.code = code;       // not_configured | too_many_attempts | unauthorized | invalid | too_large | not_found | conflict | limit | in_use | method_not_allowed | server_error | offline | network | timeout | bad_key | aborted
    this.status = status;
    this.data = data;
  }
}

/** 새 id (기록·사진). 서버 id 형식 [A-Za-z0-9_-] 에 맞음 */
export function newId() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

let errorHook = null;
/** 401/429/503 등 전역 처리용 훅 등록 */
export function onApiError(fn) { errorHook = fn; }

/** HTTP 헤더에 넣을 수 있는 키인지 (눈에 보이는 ASCII만) */
export function isValidKeyFormat(key) {
  return typeof key === 'string' && key.length >= 1 && key.length <= 512 && /^[\x21-\x7E]+$/.test(key);
}

async function request(method, path, body, { key: overrideKey } = {}) {
  const key = overrideKey ?? getKey();
  if (!key) throw new ApiError('unauthorized', 401);
  if (!isValidKeyFormat(key)) throw new ApiError('bad_key', 0);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ApiError('offline', 0);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { 'x-app-key': key, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
  } catch (e) {
    // 기기가 정말 오프라인인지, 온라인인데 서버 응답만 못 받은 것인지 구분
    // (후자는 요청이 서버에 닿아 저장됐을 수도 있음)
    const code = e && e.name === 'AbortError' ? 'timeout'
      : (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'network');
    throw new ApiError(code, 0);
  } finally {
    clearTimeout(timer);
  }

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok) throw httpError(res.status, data, !overrideKey);
  return data || {};
}

/** HTTP 오류 응답 → ApiError (전역 훅에도 알림) */
function httpError(status, data, notify = true) {
  const fallback = {
    400: 'invalid', 401: 'unauthorized', 404: 'not_found', 405: 'method_not_allowed',
    409: 'conflict', 413: 'too_large', 429: 'too_many_attempts', 503: 'not_configured',
  }[status] || 'server_error';
  const err = new ApiError((data && typeof data.error === 'string' && data.error) || fallback, status, data);
  if (errorHook && notify) {
    try { errorHook(err); } catch { /* 무시 */ }
  }
  return err;
}

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export const fetchData = (opts) => request('GET', '/api/data', undefined, opts);

export const saveRecord = (record, baseUpdatedAt = null) =>
  request('POST', '/api/records', { record, baseUpdatedAt });

export const deleteRecord = (id) => request('DELETE', `/api/records?id=${encodeURIComponent(id)}`);

export const saveMember = (member) => request('POST', '/api/members', { member });

export const deleteMember = (id) => request('DELETE', `/api/members?id=${encodeURIComponent(id)}`);

/**
 * 게임 정보 {id?, type, title, memo, owned?, cover?, playersMin?…} → {game}.
 * 같은 종류에 같은 이름이 있으면 400 duplicate — 사용자가 확인했으면 allowDuplicate 로 따로 등록
 */
export const saveGame = (game, { allowDuplicate = false } = {}) =>
  request('POST', '/api/games', allowDuplicate ? { game, allowDuplicate: true } : { game });

export const deleteGame = (id) => request('DELETE', `/api/games?id=${encodeURIComponent(id)}`);

// ── 사진 ──
const IMAGE_TIMEOUT_MS = 30000;
/** 올리기: 전체 시간이 아니라 '진행이 멈춘 시간'으로 판단 (느린 연결에서도 조금씩 올라가면 기다림) */
const UPLOAD_STALL_MS = 30000;
const UPLOAD_MAX_MS = 10 * 60 * 1000;

export const imageStats = () => request('GET', '/api/images?stats=1');

/** 서버의 모든 사진 정보 → {images:[{id, mime, bytesF, bytesT, createdAt}]} (백업용) */
export const imageList = () => request('GET', '/api/images?list=1');

/**
 * 어떤 기록에도 안 쓰이고 올린 지(기록에서 빠진 지) 하루가 지난 사진 정리 → {deleted}
 * keep: 이 기기의 초안이 쓰는 사진 (지우지 않음)
 */
export const gcImages = (keep = []) => request('POST', '/api/images?action=gc', { keep });

export const deleteImage = (id) => request('DELETE', `/api/images?id=${encodeURIComponent(id)}`);

/**
 * 사진 한 장(바이너리) → Blob. size: 't'(작은 사진) | 'f'(원본 크기)
 * 서버가 private·immutable 로 보내므로 브라우저 HTTP 캐시를 그대로 씀 (오프라인에서도 본 사진은 보일 수 있게)
 * — 그래서 오프라인이라도 미리 막지 않고 한 번 시도해 봄
 */
export async function fetchImageBlob(id, size = 't', { signal } = {}) {
  const key = getKey();
  if (!key) throw new ApiError('unauthorized', 401);
  if (!isValidKeyFormat(key)) throw new ApiError('bad_key', 0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    let res;
    try {
      res = await fetch(`/api/images?id=${encodeURIComponent(id)}&size=${size === 'f' ? 'f' : 't'}`, {
        headers: { 'x-app-key': key },
        signal: ctrl.signal,
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      if (signal && signal.aborted) throw new ApiError('aborted', 0);
      throw new ApiError(e && e.name === 'AbortError' ? 'timeout' : (isOffline() ? 'offline' : 'network'), 0);
    }
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      throw httpError(res.status, data);
    }
    try {
      return await res.blob();
    } catch {
      throw new ApiError(isOffline() ? 'offline' : 'network', 0);
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 사진 올리기 {full, thumb, id?} (base64) → {image}. 올라가는 정도를 알려고 fetch 대신 XHR 사용.
 * 30초 동안 하나도 더 올라가지 않으면(또는 다 보낸 뒤 응답이 없으면) 'timeout'.
 * onSent: 본문을 다 보냄 (이 뒤로는 끊어도 서버에 저장될 수 있음)
 * 반환: { promise, abort }
 */
export function uploadImage(body, { onProgress, onSent } = {}) {
  let xhr = null;
  let stall = 0;
  const promise = new Promise((resolve, reject) => {
    const key = getKey();
    if (!key) { reject(new ApiError('unauthorized', 401)); return; }
    if (!isValidKeyFormat(key)) { reject(new ApiError('bad_key', 0)); return; }
    if (isOffline()) { reject(new ApiError('offline', 0)); return; }
    xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/images');
    xhr.timeout = UPLOAD_MAX_MS;
    xhr.setRequestHeader('x-app-key', key);
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('accept', 'application/json');
    let stalled = false;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => { stalled = true; xhr.abort(); }, UPLOAD_STALL_MS);
    };
    if (xhr.upload) {
      xhr.upload.addEventListener('progress', (e) => {
        arm();
        if (onProgress && e.lengthComputable && e.total) onProgress(e.loaded / e.total);
      });
      xhr.upload.addEventListener('load', () => { arm(); if (onSent) onSent(); });
    }
    xhr.addEventListener('loadend', () => clearTimeout(stall));
    xhr.addEventListener('load', () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
      else reject(xhr.status >= 200 && xhr.status < 300 ? new ApiError('server_error', xhr.status) : httpError(xhr.status, data));
    });
    xhr.addEventListener('error', () => reject(new ApiError(isOffline() ? 'offline' : 'network', 0)));
    xhr.addEventListener('timeout', () => reject(new ApiError('timeout', 0)));
    xhr.addEventListener('abort', () => reject(new ApiError(stalled ? 'timeout' : 'aborted', 0)));
    arm();
    xhr.send(JSON.stringify(body));
  });
  return { promise, abort: () => { clearTimeout(stall); if (xhr) xhr.abort(); } };
}

/** 사용자에게 보여줄 오류 문구 */
export function errorMessage(err, action = '저장') {
  const code = err && err.code;
  switch (code) {
    case 'offline': return `오프라인이라 ${action}할 수 없어요`;
    case 'network': return `서버와 연결이 끊겨 ${action} 결과를 확인하지 못했어요. 잠시 후 다시 시도해 주세요`;
    case 'timeout': return '서버 응답이 늦어요. 잠시 후 다시 시도해 주세요';
    case 'too_many_attempts': return '시도가 너무 많아요. 15분쯤 뒤에 다시 해 주세요';
    case 'unauthorized': return '코드가 맞지 않아요. 공유받은 링크로 다시 들어와 주세요';
    case 'bad_key': return '코드 형식이 올바르지 않아요';
    case 'not_configured': return '서버 설정이 아직 끝나지 않았어요 (APP_SECRET·Redis 연결 확인)';
    case 'too_large': return '내용이 너무 길어요. 후기를 조금 줄여 주세요';
    case 'not_found': return '이미 삭제된 항목이에요';
    case 'limit': return '저장 가능한 개수를 넘었어요';
    case 'conflict': return '다른 사람이 먼저 수정했어요';
    case 'invalid': return '입력값을 확인해 주세요';
    default: return `${action}하지 못했어요. 잠시 후 다시 시도해 주세요`;
  }
}
