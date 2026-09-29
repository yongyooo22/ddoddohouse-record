// Vercel 함수 — 실제 로직은 lib/handler.js (사진 올리기·보기·정리)
import { createHandlers } from '../lib/handler.js';
import { createRedisFromEnv } from '../lib/redis.js';

let handlers;

export default function handler(req, res) {
  handlers ??= createHandlers({ redis: createRedisFromEnv(process.env), env: process.env });
  return handlers.images(req, res);
}
