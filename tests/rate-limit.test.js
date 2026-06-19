import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.API_KEY = 'k';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_PER_MIN = '5';
process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signals-rate-')), 'signals.db');

const { buildApp } = await import('../src/server.js');

test('rate limit allows 5 per minute and rejects the 6th', async () => {
  const app = buildApp();
  const statuses = [];

  for (let i = 0; i < 6; i += 1) {
    statuses.push(await postStatus(app, 'u1', String(i)));
  }

  assert.equal(statuses.filter((status) => status === 200).length, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 1);
  await app.close();
});

test('rate limit is safe for parallel requests', async () => {
  const app = buildApp();
  const statuses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => postStatus(app, 'parallel-user', String(i)))
  );

  assert.equal(statuses.filter((status) => status === 200).length, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 15);
  await app.close();
});

async function postStatus(app, userId, payload) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signals',
    headers: { 'x-api-key': 'k' },
    payload: { userId, type: 'note', payload }
  });

  return res.statusCode;
}
