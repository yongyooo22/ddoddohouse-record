// IndexedDB 얇은 래퍼 — 기록과 사진은 모두 이 브라우저의 IndexedDB 에만 저장된다 (서버 없음)
//   works   작품         (keyPath id)
//   plays   플레이 기록   (keyPath id, index workId)
//   images  사진 바이트   (keyPath id) — { full, thumb: ArrayBuffer, type, thumbType, width, height, size }
//   meta    기록장 설정   (keyPath key) — 기록장 이름 등
//   deleted 지운 항목 표시 (keyPath id) — 나중에 동기화를 붙일 때 "지웠다"를 전달하기 위한 기록
import { DB_NAME, DB_VERSION } from './constants.js';

export class StorageError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code; // unavailable(저장소를 못 씀) | quota(공간 부족) | failed
    if (cause) this.cause = cause;
  }
}

function classify(err) {
  if (err instanceof StorageError) return err;
  const name = err && err.name;
  if (name === 'QuotaExceededError' || (err && /quota/i.test(String(err.message)))) return new StorageError('quota', err);
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError') return new StorageError('unavailable', err);
  return new StorageError('failed', err);
}

let dbp = null;
let onChangeElsewhere = null;

/** 다른 탭이 새 버전 앱으로 DB 구조를 바꾸려 할 때 부를 함수 */
export function onVersionChange(fn) { onChangeElsewhere = fn; }

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    let req;
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new StorageError('unavailable');
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(classify(e));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('works')) db.createObjectStore('works', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('plays')) db.createObjectStore('plays', { keyPath: 'id' }).createIndex('workId', 'workId');
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('deleted')) db.createObjectStore('deleted', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
        if (onChangeElsewhere) onChangeElsewhere();
      };
      resolve(db);
    };
    req.onerror = () => reject(classify(req.error || new StorageError('unavailable')));
    req.onblocked = () => reject(new StorageError('unavailable'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}

/**
 * 트랜잭션 하나 실행. fn(stores) 안에서 요청을 걸고, 읽은 값이 필요하면 함수를 돌려주면
 * 트랜잭션이 끝난 뒤 그 함수의 결과로 resolve 된다. (요청 사이에 await 하지 않음 — 자동 커밋 방지)
 */
export async function run(names, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction(names, mode);
    } catch (e) {
      reject(classify(e));
      return;
    }
    const stores = Object.fromEntries(names.map((n) => [n, t.objectStore(n)]));
    let out;
    try {
      out = fn(stores, t);
    } catch (e) {
      try { t.abort(); } catch { /* 이미 끝남 */ }
      reject(classify(e));
      return;
    }
    t.oncomplete = () => {
      try { resolve(typeof out === 'function' ? out() : out); } catch (e) { reject(classify(e)); }
    };
    // 요청 하나라도 실패하면 트랜잭션 전체가 취소됨 → 반쯤만 저장되는 일 없음
    t.onabort = () => reject(classify(t.error || new StorageError('failed')));
  });
}

export function getAll(name) {
  return run([name], 'readonly', (s) => {
    const r = s[name].getAll();
    return () => r.result || [];
  });
}

export function getOne(name, key) {
  return run([name], 'readonly', (s) => {
    const r = s[name].get(key);
    return () => r.result || null;
  });
}

export function getAllKeys(name) {
  return run([name], 'readonly', (s) => {
    const r = s[name].getAllKeys();
    return () => r.result || [];
  });
}

/** 모든 저장소 비우기 */
export function clearAll() {
  const names = ['works', 'plays', 'images', 'meta', 'deleted'];
  return run(names, 'readwrite', (s) => { for (const n of names) s[n].clear(); });
}
