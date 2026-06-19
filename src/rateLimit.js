import { consumeRateLimit, insertSignalIdempotentWithLimit } from './db.js';

export const RATE = Number(process.env.RATE_LIMIT_PER_MIN || 5);
export const WINDOW_MS = 60_000;

export function checkAndConsume(userId, nowMs = Date.now()) {
  return consumeRateLimit(userId, nowMs, RATE, WINDOW_MS);
}

export function insertIdempotentAndConsume(userId, type, payload, idemKey, nowMs = Date.now()) {
  return insertSignalIdempotentWithLimit(userId, type, payload, idemKey, nowMs, RATE, WINDOW_MS);
}
