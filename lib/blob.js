// 사진 파일 저장소 — Vercel Blob 의 비공개(private) 저장소. Redis 에는 파일 경로 문자열만 둔다 (lib/images.js).
// 비공개 저장소의 파일은 공개 주소로 열 수 없고, 서버 함수(/api/images)가 입장 코드를 확인한 뒤에만 읽어서 보내 준다.
//
// 연결 정보는 코드에 넣지 않고 Vercel 환경변수에서만 읽음:
//   BLOB_READ_WRITE_TOKEN  Vercel 프로젝트에 Blob 저장소를 연결하면 자동으로 들어감
//   (또는 BLOB_STORE_ID — 배포 환경의 Vercel OIDC 로 인증)
//
// handler 가 쓰는 최소 인터페이스 (테스트·개발 서버의 인메모리 가짜도 똑같이 구현):
//   put(pathname, bytes, contentType) → void   (같은 경로면 덮어씀)
//   get(pathname)                     → Buffer | null (없으면 null)
//   del(pathnames)                    → void   (없는 경로는 무시)
// 경로는 모두 'boardgame/photos/' 아래여야 하며(lib/keys.js), 아니면 요청을 보내지 않고 오류를 낸다.
import { put as sdkPut, get as sdkGet, del as sdkDel } from '@vercel/blob';
import { PHOTO_PATH_PREFIX, isOwnPath } from './keys.js';

/** 읽을 때 한도 — 원본 사진 최대(700KB)보다 넉넉히. 이보다 크면 이 앱이 올린 파일이 아님 */
export const MAX_BLOB_READ_BYTES = 1024 * 1024;
/** 한 번에 지우는 파일 수 */
export const BLOB_DEL_BATCH = 100;

/** 이 앱의 사진 파일 경로가 아니면 오류 (요청을 보내기 전에 막음) */
export function ownPath(pathname) {
  if (!isOwnPath(pathname)) throw new Error(`blob: '${PHOTO_PATH_PREFIX}' 밖의 경로는 쓰지 않아요 (${String(pathname).slice(0, 60)})`);
  return pathname;
}

/**
 * @vercel/blob 함수들(put·get·del)을 위 인터페이스로 감싼다.
 * @param {{put: Function, get: Function, del: Function}} sdk
 * @param {{token?: string, storeId?: string}} auth
 */
export function wrapBlob(sdk, auth = {}) {
  return {
    async put(pathname, bytes, contentType) {
      await sdk.put(ownPath(pathname), bytes, {
        ...auth,
        access: 'private',
        contentType,
        addRandomSuffix: false, // 경로는 서버가 올릴 때마다 새로 만듦 (그 경로를 Redis 에 적어 둠)
        allowOverwrite: true, // 같은 요청의 재시도가 '이미 있음'으로 실패하지 않게
      });
    },
    async get(pathname) {
      const res = await sdk.get(ownPath(pathname), { ...auth, access: 'private' });
      if (!res || res.statusCode !== 200 || !res.stream) return null;
      const chunks = [];
      let size = 0;
      for await (const chunk of res.stream) {
        size += chunk.length;
        if (size > MAX_BLOB_READ_BYTES) throw new Error('blob: file too large');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
    async del(pathnames) {
      const list = [...new Set(pathnames)].map(ownPath);
      for (let i = 0; i < list.length; i += BLOB_DEL_BATCH) await sdk.del(list.slice(i, i + BLOB_DEL_BATCH), auth);
    },
  };
}

/**
 * 환경변수로 Blob 연결 생성. 설정이 없으면 null (→ 사진 API 는 not_configured, 기록·멤버는 그대로 동작)
 * @param {object} [env]
 * @param {{put: Function, get: Function, del: Function}} [sdk]  테스트에서 바꿔 끼움
 */
export function createBlobFromEnv(env = process.env, sdk = { put: sdkPut, get: sdkGet, del: sdkDel }) {
  const token = typeof env.BLOB_READ_WRITE_TOKEN === 'string' ? env.BLOB_READ_WRITE_TOKEN.trim() : '';
  const storeId = typeof env.BLOB_STORE_ID === 'string' ? env.BLOB_STORE_ID.trim() : '';
  if (token) return wrapBlob(sdk, { token });
  if (storeId) return wrapBlob(sdk, { storeId });
  return null;
}
