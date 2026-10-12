import { test, expect, beforeEach } from 'bun:test';
import { req, memDb, insertSource, insertJob, resetDb } from '../test-harness';

beforeEach(() => {
  resetDb();
});

test('PATCH /:id/status with an invalid status returns a readable C3 error body', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const res = await req(`/api/jobs/${job}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'not-a-real-status' }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(body.error).not.toContain('[object');
  expect(body.issues).toBeInstanceOf(Array);
});

test('PATCH /:id/notes over the 4000-char cap returns a readable C3 error body', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const res = await req(`/api/jobs/${job}/notes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: 'x'.repeat(4001) }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error).toContain('notes');
});

test('GET /api/jobs clamps out-of-range and rejects malformed limit/offset instead of erroring', async () => {
  const src = insertSource();
  for (let i = 0; i < 5; i++) insertJob(src);

  // limit=-1 used to bypass the 500 cap (SQLite treats negative LIMIT as unlimited).
  const neg = await req('/api/jobs?limit=-1');
  expect(neg.status).toBe(200);
  const negBody = await neg.json();
  expect(negBody.limit).toBeGreaterThanOrEqual(1);

  // Non-numeric / non-integer values used to throw SQLITE_MISMATCH -> 500.
  for (const q of ['limit=abc', 'limit=2.5', 'offset=abc']) {
    const res = await req(`/api/jobs?${q}`);
    expect(res.status).toBe(200);
  }
});

test('GET /:id/similar returns the same ranking/content as scanning every embedded job', async () => {
  const src = insertSource();
  // A 12-dim toy embedding: cosine similarity along one axis for a deterministic ranking.
  const vec = (x: number) => {
    const f = new Float32Array(4);
    f[0] = x;
    return Buffer.from(f.buffer);
  };
  const target = insertJob(src, { title: 'Target', embedding: vec(1) });
  const near = insertJob(src, { title: 'Near', embedding: vec(0.9) });
  const far = insertJob(src, { title: 'Far', embedding: vec(0.1) });
  insertJob(src, { title: 'Hidden', status: 'hidden', embedding: vec(0.95) });
  insertJob(src, { title: 'NoEmbedding' });

  const res = await req(`/api/jobs/${target}/similar?limit=5`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.jobs.map((j: any) => j.id)).toEqual([near, far]);
  expect(body.jobs[0].similarity).toBeGreaterThan(body.jobs[1].similarity);
  // Full row fields (not just id/embedding) must still be present.
  expect(body.jobs[0].title).toBe('Near');
  expect(body.jobs[0].source_name).toBeDefined();
});

test('GET /:id/similar limit param is clamped (not passed through to SQL raw)', async () => {
  const src = insertSource();
  const vec = (x: number) => {
    const f = new Float32Array(4);
    f[0] = x;
    return Buffer.from(f.buffer);
  };
  const target = insertJob(src, { title: 'Target', embedding: vec(1) });
  for (let i = 0; i < 3; i++) insertJob(src, { title: `N${i}`, embedding: vec(0.5) });

  const res = await req(`/api/jobs/${target}/similar?limit=abc`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.jobs.length).toBeLessThanOrEqual(8);
});

test('memDb sanity: jobs table is reachable', () => {
  expect(memDb.query('SELECT 1 AS x').get()).toEqual({ x: 1 });
});
