import { test, expect, beforeEach } from 'bun:test';
import { req, memDb, insertSource, insertJob, resetDb, seedEmbeddingsOff } from '../test-harness';

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

test('GET /api/jobs?fit=1 hides a job whose verdict outlived its L1 pass (rescued in an earlier run only)', async () => {
  const src = insertSource();
  const run = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (0) RETURNING id').get()!.id;
  const fit = (over: Record<string, unknown>) =>
    insertJob(src, { last_run_id: run, l2_fit: 1, l2_score: 0.9, l2_verdict_json: '{"fit":true}', ...over });
  const passing = fit({ l1_pass: 1 });
  fit({ l1_pass: 0, l1_rescued: 0 });

  const body = await (await req(`/api/jobs?fit=1&run=${run}`)).json();
  expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([passing]);
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

const vec3 = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer);

/** Three shortlisted jobs along x and three hidden ones along y, from distinct companies. */
function seedTaste(src: number) {
  for (const c of ['a', 'b', 'c']) insertJob(src, { company: c, company_norm: c, status: 'shortlist', embedding: vec3(1, 0, 0) });
  for (const c of ['x', 'y', 'z']) insertJob(src, { company: c, company_norm: c, status: 'hidden', embedding: vec3(0, 1, 0) });
}

const scoredJob = (src: number, title: string, score: number, embedding: Buffer, over: Record<string, unknown> = {}) =>
  insertJob(src, { title, l1_pass: 1, l2_fit: 1, l2_score: score, l2_verdict_json: '{"fit":true}', embedding, ...over });

const listIds = async (qs: string) =>
  ((await (await req(`/api/jobs?${qs}`)).json()).jobs as { id: number }[]).map((j) => j.id);

test('GET /api/jobs: learned taste reorders a near-tie and exposes pref_adjust', async () => {
  const src = insertSource();
  seedTaste(src);
  const dislikeish = scoredJob(src, 'Dislikeish', 0.8, vec3(0.3, 0.95, 0));
  const likeish = scoredJob(src, 'Likeish', 0.78, vec3(0.95, 0.3, 0));

  const body = await (await req('/api/jobs?fit=1')).json();
  expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([likeish, dislikeish]);
  const adj = Object.fromEntries(body.jobs.map((j: { id: number; pref_adjust: number }) => [j.id, j.pref_adjust]));
  expect(adj[likeish]).toBeGreaterThan(0);
  expect(adj[dislikeish]).toBeLessThan(0);
  expect(Math.abs(adj[likeish])).toBeLessThanOrEqual(0.1);
});

test('GET /api/jobs: taste cannot bury a clearly stronger match', async () => {
  const src = insertSource();
  seedTaste(src);
  const strong = scoredJob(src, 'Strong', 0.95, vec3(0.3, 0.95, 0));
  const weak = scoredJob(src, 'Weak', 0.6, vec3(0.95, 0.3, 0));
  expect(await listIds('fit=1')).toEqual([strong, weak]);
});

test('GET /api/jobs: a non-fit never outranks a fit, with or without taste', async () => {
  const src = insertSource();
  const nonFit = scoredJob(src, 'NonFit', 0.9, vec3(0.95, 0.3, 0), { l2_fit: 0 });
  const fit = scoredJob(src, 'Fit', 0.5, vec3(0.3, 0.95, 0));
  expect(await listIds('l2=1')).toEqual([fit, nonFit]);

  seedTaste(src);
  expect(await listIds('l2=1')).toEqual([fit, nonFit]);
});

test('GET /api/jobs: taste ordering paginates consistently', async () => {
  const src = insertSource();
  seedTaste(src);
  const ids = [0.9, 0.8, 0.7, 0.6].map((s, i) => scoredJob(src, `J${i}`, s, vec3(1, 0, 0)));
  const all = await listIds('fit=1');
  expect(all).toEqual(ids);
  expect(await listIds('fit=1&limit=2&offset=2')).toEqual(all.slice(2));
});

test('GET /api/jobs: without enough triage, or with embeddings off, order is plain and pref_adjust is null', async () => {
  const src = insertSource();
  const dislikeish = scoredJob(src, 'Dislikeish', 0.8, vec3(0.3, 0.95, 0));
  const likeish = scoredJob(src, 'Likeish', 0.78, vec3(0.95, 0.3, 0));

  let body = await (await req('/api/jobs?fit=1')).json();
  expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([dislikeish, likeish]);
  expect(body.jobs.every((j: { pref_adjust: unknown }) => j.pref_adjust === null)).toBe(true);

  seedTaste(src);
  seedEmbeddingsOff();
  body = await (await req('/api/jobs?fit=1')).json();
  expect(body.jobs.map((j: { id: number }) => j.id)).toEqual([dislikeish, likeish]);
  expect(body.jobs.every((j: { pref_adjust: unknown }) => j.pref_adjust === null)).toBe(true);
});

test('PATCH status hidden is the dismiss signal and does not count as applying', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const res = await req(`/api/jobs/${job}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'hidden' }),
  });
  expect(res.status).toBe(200);
  const row = memDb.query<{ status: string; applied_at: number | null }, [number]>('SELECT status, applied_at FROM jobs WHERE id = ?').get(job)!;
  expect(row).toEqual({ status: 'hidden', applied_at: null });
});

test('GET /api/jobs/calibration is routed (not read as a job id) and reports the split', async () => {
  const src = insertSource();
  insertJob(src, { status: 'shortlist', l2_score: 0.9, l2_fit: 1, l2_verdict_json: '{}' });
  insertJob(src, { status: 'hidden', l2_score: 0.7, l2_fit: 1, l2_verdict_json: '{}' });

  const res = await req('/api/jobs/calibration');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.liked.mean_score).toBeCloseTo(0.9, 5);
  expect(body.disliked.fit).toBe(1);
  expect(body.preference.active).toBe(false);
});

test('PATCH status stamps applied_at on interview/offer too, so a later employer rejection stays a like', async () => {
  const src = insertSource();
  const job = insertJob(src);
  const patch = (status: string) =>
    req(`/api/jobs/${job}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
  await patch('interview');
  const stamped = memDb.query<{ applied_at: number | null }, [number]>('SELECT applied_at FROM jobs WHERE id = ?').get(job)!.applied_at;
  expect(stamped).not.toBeNull();
  await patch('offer'); // an existing stamp is kept, not overwritten
  await patch('rejected');
  expect(memDb.query<{ applied_at: number | null }, [number]>('SELECT applied_at FROM jobs WHERE id = ?').get(job)!.applied_at).toBe(stamped);
});

test('GET /api/jobs: fully tied rows paginate by id, newest first', async () => {
  const src = insertSource();
  const ids = [1, 2, 3, 4].map(() => insertJob(src));
  const expected = [...ids].reverse();
  expect(await listIds('limit=4')).toEqual(expected);
  expect(await listIds('limit=2&offset=2')).toEqual(expected.slice(2));
});

test('GET /api/jobs/status-counts counts triage states only and is not read as a job id', async () => {
  const src = insertSource();
  insertJob(src, { status: 'shortlist' });
  insertJob(src, { status: 'shortlist' });
  insertJob(src, { status: 'hidden' });
  insertJob(src);
  const res = await req('/api/jobs/status-counts');
  expect(res.status).toBe(200);
  expect((await res.json()).counts).toEqual({ shortlist: 2, hidden: 1 });
});

test('GET /api/jobs filters by text, source type and run, and counts the matches', async () => {
  const gh = insertSource({ type: 'greenhouse' });
  const lv = insertSource({ type: 'lever' });
  memDb.run(`INSERT INTO runs (id, started_at, trigger) VALUES (7, 1, 'manual'), (8, 2, 'manual')`);
  const a = insertJob(gh, { title: 'Flutter Developer', last_run_id: 8 });
  const b = insertJob(lv, { company: 'Flutterwave', last_run_id: 7 });
  const c = insertJob(lv, { title: 'Backend Engineer', last_run_id: 8 });

  const ids = async (qs: string) => {
    const body = await (await req(`/api/jobs?${qs}`)).json();
    return { ids: body.jobs.map((j: { id: number }) => j.id).sort(), total: body.total, capped: body.total_capped };
  };
  expect(await ids('q=flutter')).toEqual({ ids: [a, b].sort(), total: 2, capped: false });
  expect((await ids('source_type=lever')).ids).toEqual([b, c].sort());
  expect(await ids('run=latest&q=flutter')).toEqual({ ids: [a], total: 1, capped: false });
  expect((await ids('run=7')).ids).toEqual([b]);
});
