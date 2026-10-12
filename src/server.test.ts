import { beforeEach, expect, test } from 'bun:test';
import { memDb, req, resetDb } from './test-harness';

beforeEach(() => {
  resetDb();
});

function insertJob(): number {
  const sourceId = memDb
    .query<{ id: number }, []>(
      `INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','acme','Acme',0,0) RETURNING id`
    )
    .get()!.id;
  return memDb
    .query<{ id: number }, [number]>(
      `INSERT INTO jobs (source_id, url, title, company, company_norm, content_hash, first_seen, last_seen)
       VALUES (?, 'https://x.test/j', 'Engineer', 'Acme', 'acme', 'h', 0, 0) RETURNING id`
    )
    .get(sourceId)!.id;
}

test('an evil Origin on a state-changing /api request is rejected with 403 and has no side effect', async () => {
  insertJob();
  const res = await req('/api/admin/clear-jobs', {
    method: 'POST',
    headers: { Origin: 'http://evil.example' },
  });
  expect(res.status).toBe(403);
  const jobs = memDb.query('SELECT COUNT(*) as n FROM jobs').get() as { n: number };
  expect(jobs.n).toBe(1); // clear-jobs did not run
});

test('a legitimate same-origin state-changing request is allowed through', async () => {
  insertJob();
  const res = await req('/api/admin/clear-jobs', {
    method: 'POST',
    headers: { Origin: 'http://localhost:3000' },
  });
  expect(res.status).toBe(200);
  const jobs = memDb.query('SELECT COUNT(*) as n FROM jobs').get() as { n: number };
  expect(jobs.n).toBe(0);
});

test('a state-changing request with no Origin header (curl-like) is allowed through', async () => {
  insertJob();
  const res = await req('/api/admin/clear-jobs', { method: 'POST' });
  expect(res.status).toBe(200);
});

test('Sec-Fetch-Site: cross-site is rejected with 403 even with no Origin header', async () => {
  insertJob();
  const res = await req('/api/admin/clear-jobs', {
    method: 'POST',
    headers: { 'Sec-Fetch-Site': 'cross-site' },
  });
  expect(res.status).toBe(403);
  const jobs = memDb.query('SELECT COUNT(*) as n FROM jobs').get() as { n: number };
  expect(jobs.n).toBe(1);
});

test('a spoofed Host header (DNS rebinding) is rejected with 403, even for a safe GET', async () => {
  const res = await req('/api/runs', { headers: { Host: 'evil.example:3000' } });
  expect(res.status).toBe(403);
});

test('a legitimate Host header on a GET request is allowed through', async () => {
  const res = await req('/api/runs', { headers: { Host: 'localhost:3000' } });
  expect(res.status).toBe(200);
});

test('an unknown /api path returns 404 JSON, not the SPA shell', async () => {
  const res = await req('/api/nope', { method: 'POST' });
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
});

test('a route that throws is caught by onError and returns 500 JSON, not a crash', async () => {
  // GET /api/runs/:id parses errors_json unguarded — a malformed value throws a
  // genuine, uncaught SyntaxError past the route, straight into onError. (A
  // malformed stored `criteria` row used to trigger this via POST /api/runs/scan,
  // but that path is now deliberately resilient — see NLFilterShape.safeParse in
  // routes/runs.ts, B-3 — so it no longer exercises the generic onError handler.)
  const runId = memDb
    .query<{ id: number }, []>(
      `INSERT INTO runs (started_at, sources_total, errors_json) VALUES (0, 0, '{not json') RETURNING id`
    )
    .get()!.id;
  const res = await req(`/api/runs/${runId}`);
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.error).toBe('internal error');
});

test('GET on a non-API path serves the SPA shell', async () => {
  const res = await req('/some/client/route');
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('SPA-INDEX');
});

test('POST on a non-API path is not answered by the SPA fallback', async () => {
  const res = await req('/some/client/route', { method: 'POST' });
  const text = await res.text();
  expect(text).not.toContain('SPA-INDEX');
});
