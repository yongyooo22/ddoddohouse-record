// fetch 래퍼 — x-app-key 헤더, 타임아웃, 에러 코드 정규화
import { getKey } from './store.js';

const TIMEOUT_MS = 15000;

export class ApiError extends Error {
  constructor(code, status = 0, data = null) {
    super(code);
    this.code = code;       // not_configured | too_many_attempts | unauthorized | invalid | too_large | not_found | conflict | limit | method_not_allowed | server_error | offline | network | timeout | bad_key
    this.status = status;
    this.data = data;
  }
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

  if (!res.ok) {
    const fallback = {
      400: 'invalid', 401: 'unauthorized', 404: 'not_found', 405: 'method_not_allowed',
      409: 'conflict', 413: 'too_large', 429: 'too_many_attempts', 503: 'not_configured',
    }[res.status] || 'server_error';
    const err = new ApiError((data && typeof data.error === 'string' && data.error) || fallback, res.status, data);
    if (errorHook && !overrideKey) {
      try { errorHook(err); } catch { /* 무시 */ }
    }
    throw err;
  }
  return data || {};
}

export const fetchData = (opts) => request('GET', '/api/data', undefined, opts);

export const saveRecord = (record, baseUpdatedAt = null) =>
  request('POST', '/api/records', { record, baseUpdatedAt });

export const deleteRecord = (id) => request('DELETE', `/api/records?id=${encodeURIComponent(id)}`);

export const saveMember = (member) => request('POST', '/api/members', { member });

export const deleteMember = (id) => request('DELETE', `/api/members?id=${encodeURIComponent(id)}`);

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
