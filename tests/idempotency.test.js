import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.API_KEY = 'k';
process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_PER_MIN = '100';
process.env.DATABASE_URL = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signals-idem-')), 'signals.db');

const { buildApp } = await import('../src/server.js');

test('idempotency returns same resource for same key', async () => {
  const app = buildApp();
  const idem = 'same-key';

  const a = await postJson(app, idem, 'x');
  const b = await postJson(app, idem, 'x');

  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(a.body.id, b.body.id);
  assert.equal(a.body.idempotencyKey, b.body.idempotencyKey);
  await app.close();
});

test('idempotency is safe for parallel requests', async () => {
  const app = buildApp();
  const idem = 'parallel-key';
  const responses = await Promise.all(
    Array.from({ length: 25 }, (_, i) => postJson(app, idem, `payload-${i}`))
  );

  assert.deepEqual(new Set(responses.map((res) => res.statusCode)), new Set([200]));
  assert.equal(new Set(responses.map((res) => res.body.id)).size, 1);

  const list = await app.inject({
    method: 'GET',
    url: '/v1/signals?userId=u1&limit=100',
    headers: { 'x-api-key': 'k' }
  });
  const items = JSON.parse(list.payload).items.filter((item) => item.idempotencyKey === idem);

  assert.equal(items.length, 1);
  await app.close();
});

async function postJson(app, idem, payload) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/signals',
    headers: { 'x-api-key': 'k', 'idempotency-key': idem },
    payload: { userId: 'u1', type: 'note', payload }
  });

  return { statusCode: res.statusCode, body: JSON.parse(res.payload || '{}') };
}
