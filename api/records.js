// Vercel 함수 — 실제 로직은 lib/handler.js (기록을 지우거나 고치면 안 쓰는 사진 파일도 정리하므로 Blob 도 연결)
import { createHandlers } from '../lib/handler.js';
import { createRedisFromEnv } from '../lib/redis.js';
import { createBlobFromEnv } from '../lib/blob.js';

let handlers;

export default function handler(req, res) {
  handlers ??= createHandlers({ redis: createRedisFromEnv(process.env), blob: createBlobFromEnv(process.env), env: process.env });
  return handlers.records(req, res);
}
