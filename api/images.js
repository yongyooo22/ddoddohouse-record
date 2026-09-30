// Vercel 함수 — 실제 로직은 lib/handler.js (사진 올리기·보기·정리 — 파일은 Vercel Blob, 경로는 Redis)
import { createHandlers } from '../lib/handler.js';
import { createRedisFromEnv } from '../lib/redis.js';
import { createBlobFromEnv } from '../lib/blob.js';

let handlers;

export default function handler(req, res) {
  handlers ??= createHandlers({ redis: createRedisFromEnv(process.env), blob: createBlobFromEnv(process.env), env: process.env });
  return handlers.images(req, res);
}
