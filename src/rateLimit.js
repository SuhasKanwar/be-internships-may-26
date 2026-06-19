import { consumeRateLimit } from './db.js';

const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
const WINDOW_MS = 60_000;

export function checkAndConsume(userId, nowMs = Date.now()) {
  return consumeRateLimit(userId, nowMs, RATE, WINDOW_MS);
}
