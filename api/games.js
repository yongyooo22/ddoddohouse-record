// Vercel 함수 — 실제 로직은 lib/handler.js (소장 게임 등록·삭제)
import { createHandlers } from '../lib/handler.js';
import { createRedisFromEnv } from '../lib/redis.js';

let handlers;

export default function handler(req, res) {
  handlers ??= createHandlers({ redis: createRedisFromEnv(process.env), env: process.env });
  return handlers.games(req, res);
}
