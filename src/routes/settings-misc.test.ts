import { test, expect, beforeEach } from 'bun:test';
import { req, resetDb } from '../test-harness';

beforeEach(() => {
  resetDb();
});

test('PUT /api/settings/embeddings with an invalid body returns a readable C3 error', async () => {
  const res = await req('/api/settings/embeddings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'not-a-bool' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toContain('[object');
});

test('PUT /api/settings/freshness with an invalid body returns a readable C3 error', async () => {
  const res = await req('/api/settings/freshness', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, maxAgeDays: 0 }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).toContain('maxAgeDays');
});
