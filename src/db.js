import fs from 'fs';
import path from 'path';

const dbPath = process.env.DATABASE_URL || './data/signals.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = await openDatabase(dbPath);

async function openDatabase(filename) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    return new DatabaseSync(filename);
  } catch {
    const { default: Database } = await import('better-sqlite3');
    return new Database(filename);
  }
}

function immediateTransaction(fn) {
  return (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw err;
    }
  };
}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_created ON signals(user_id, created_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  user_id TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`);

function maybeFail() {
  const rate = Number(process.env.DB_FAIL_RATE || 0);
  if (rate > 0 && Math.random() < rate) {
    const err = new Error('simulated_db_failure');
    err.code = 'SQLITE_BUSY';
    throw err;
  }
}

const insertSignalStmt = db.prepare(
  'INSERT INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
);
const insertSignalIdemStmt = db.prepare(
  'INSERT OR IGNORE INTO signals (user_id, type, payload, idempotency_key, created_at) VALUES (?,?,?,?,?)'
);
const getByIdemKeyStmt = db.prepare(
  'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE idempotency_key = ?'
);
const listSignalsStmt = db.prepare(
  'SELECT id, user_id as userId, type, payload, idempotency_key as idempotencyKey, created_at as createdAt FROM signals WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
);
const getRateLimitStmt = db.prepare(
  'SELECT window_start as windowStart, count FROM rate_limits WHERE user_id = ?'
);
const insertRateLimitStmt = db.prepare(
  'INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET window_start = excluded.window_start, count = excluded.count'
);
const incrementRateLimitStmt = db.prepare(
  'UPDATE rate_limits SET count = count + 1 WHERE user_id = ?'
);

const insertIdempotentTransaction = immediateTransaction((userId, type, payload, idemKey, nowMs) => {
  insertSignalIdemStmt.run(userId, type, String(payload), idemKey, nowMs);
  return getByIdemKeyStmt.get(idemKey);
});

function consumeRateLimitInTransaction(userId, nowMs, rate, windowMs) {
  const row = getRateLimitStmt.get(userId);
  if (!row || row.windowStart + windowMs <= nowMs) {
    insertRateLimitStmt.run(userId, nowMs);
    return { ok: true, remaining: Math.max(rate - 1, 0), resetMs: nowMs + windowMs };
  }

  if (row.count >= rate) {
    return { ok: false, remaining: 0, resetMs: row.windowStart + windowMs };
  }

  incrementRateLimitStmt.run(userId);
  return { ok: true, remaining: Math.max(rate - row.count - 1, 0), resetMs: row.windowStart + windowMs };
}

const consumeRateLimitTransaction = immediateTransaction((userId, nowMs, rate, windowMs) => {
  return consumeRateLimitInTransaction(userId, nowMs, rate, windowMs);
});

const insertIdempotentWithLimitTransaction = immediateTransaction((userId, type, payload, idemKey, nowMs, rate, windowMs) => {
  const info = insertSignalIdemStmt.run(userId, type, String(payload), idemKey, nowMs);
  if (info.changes === 0) {
    return { signal: getByIdemKeyStmt.get(idemKey), limit: null };
  }

  const limit = consumeRateLimitInTransaction(userId, nowMs, rate, windowMs);
  if (!limit.ok) {
    const err = new Error('rate_limited');
    err.code = 'RATE_LIMITED';
    err.limit = limit;
    throw err;
  }

  return { signal: getByIdemKeyStmt.get(idemKey), limit };
});

export function insertSignal(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  return insertSignalStmt.run(userId, type, String(payload), idemKey || null, nowMs);
}

export function insertSignalIdempotent(userId, type, payload, idemKey, nowMs) {
  maybeFail();
  return insertIdempotentTransaction(userId, type, payload, idemKey, nowMs);
}

export function insertSignalIdempotentWithLimit(userId, type, payload, idemKey, nowMs, rate, windowMs) {
  maybeFail();
  return insertIdempotentWithLimitTransaction(userId, type, payload, idemKey, nowMs, rate, windowMs);
}

export function getByIdemKey(idemKey) {
  maybeFail();
  return getByIdemKeyStmt.get(idemKey);
}

export function listSignals(userId, limit) {
  maybeFail();
  return listSignalsStmt.all(userId, limit);
}

export function consumeRateLimit(userId, nowMs, rate, windowMs) {
  return consumeRateLimitTransaction(userId, nowMs, rate, windowMs);
}

export function isTransientDbError(err) {
  return ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR'].includes(err?.code);
}
