import { test, expect, beforeEach } from 'bun:test';
import { req, resetDb, memDb, insertSource, insertJob } from '../test-harness';

beforeEach(() => {
  resetDb();
});

const put = (body: unknown) =>
  req('/api/settings/l2-cap', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('GET /api/settings/l2-cap defaults to 300', async () => {
  expect(await (await req('/api/settings/l2-cap')).json()).toEqual({ settings: { maxJobs: 300 } });
});

test('PUT /api/settings/l2-cap saves and reads back, and rejects out-of-range values', async () => {
  expect((await put({ maxJobs: 120 })).status).toBe(200);
  expect(await (await req('/api/settings/l2-cap')).json()).toEqual({ settings: { maxJobs: 120 } });
  expect((await put({ maxJobs: 5 })).status).toBe(400);
  expect((await put({ maxJobs: 99999 })).status).toBe(400);
  expect((await put({ maxJobs: 'many' })).status).toBe(400);
});

test('run reads expose l2_pending: zero while running, survivors without a verdict once finished', async () => {
  const sourceId = insertSource({ type: 'lever', enabled: 0 });
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;
  insertJob(sourceId, { last_run_id: runId, l1_pass: 1 });
  insertJob(sourceId, { last_run_id: runId, l1_pass: 1 });
  insertJob(sourceId, { last_run_id: runId, l1_pass: 1, l2_verdict_json: '{}' });
  insertJob(sourceId, { last_run_id: runId, l1_pass: 0 });

  expect((await (await req(`/api/runs/${runId}`)).json()).l2_pending).toBe(0);

  memDb.run('UPDATE runs SET finished_at = 5 WHERE id = ?', [runId]);
  expect((await (await req(`/api/runs/${runId}`)).json()).l2_pending).toBe(2);
  const list = await (await req('/api/runs?limit=1')).json();
  expect(list.runs[0].l2_pending).toBe(2);
});
