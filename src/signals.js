import { insertSignal, isTransientDbError, listSignals } from './db.js';
import { checkAndConsume, insertIdempotentAndConsume } from './rateLimit.js';

function nowMs() {
  return Date.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn) {
  const maxAttempts = Math.max(Number(process.env.DB_RETRIES || 5), 1);
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      const base = Math.min(25 * 2 ** attempt, 250);
      await sleep(base + Math.floor(Math.random() * base));
    }
  }

  throw lastErr;
}

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  if (idem) {
    try {
      const result = await withRetry(() => insertIdempotentAndConsume(userId, type, payload, idem, nowMs()));
      return result.signal;
    } catch (e) {
      if (e.code === 'RATE_LIMITED') {
        const { remaining, resetMs } = e.limit;
        return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });
      }
      req.log.error({ err: e, ctx: 'insertIdempotentAndConsume' });
      return reply.code(503).send({ error: 'db_unavailable' });
    }
  }

  let limit;
  try {
    limit = await withRetry(() => checkAndConsume(userId, nowMs()));
  } catch (e) {
    req.log.error({ err: e, ctx: 'checkAndConsume' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }

  const { ok, remaining, resetMs } = limit;
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  try {
    const t = nowMs();
    const info = await withRetry(() => insertSignal(userId, type, payload, null, t));
    return { id: info.lastInsertRowid, userId, type, payload: String(payload), idempotencyKey: idem, createdAt: t };
  } catch (e) {
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}
