import { beforeEach, expect, test } from 'bun:test';
import yaml from 'js-yaml';
import {
  memDb,
  runs,
  scan,
  llmCalls,
  setLlm,
  seedEmbeddingsOff,
  resetDb,
  NL_OK,
} from '../test-harness';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const J = (o: unknown) => JSON.stringify(o);

beforeEach(() => {
  resetDb();
  seedEmbeddingsOff();
});

async function waitUntilIdle(timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (scan.getScanningState() && Date.now() < deadline) await sleep(10);
}

test('two overlapping POST /scan: the second is rejected with 409, the first proceeds untouched', async () => {
  setLlm(async req => {
    if (req.task === 'nl-filter') {
      await sleep(150);
      return req.prompt.includes('backend') ? NL_OK : { ...NL_OK, title: { positive: ['frontend'], negative: [] } };
    }
    return { verdicts: [] };
  });

  const postA = runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'backend engineer' }),
  });
  await sleep(10); // A's lock acquisition (synchronous, before its own nl-filter await) has already run
  const postB = runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'frontend engineer' }),
  });

  const [a, b] = await Promise.all([postA, postB]);
  expect(a.status).toBe(202);
  expect(b.status).toBe(409);

  const aBody = await a.json();
  expect(aBody.runId).toBeGreaterThan(0);

  await waitUntilIdle();
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(1);
  const criteria = memDb.query('SELECT source_text FROM criteria WHERE id = 1').get() as { source_text: string };
  expect(criteria.source_text).toBe('backend engineer');
}, 10000);

test('an identical query reuses stored criteria: nl-filter is not called again and verdicts survive', async () => {
  setLlm(async req => {
    if (req.task === 'nl-filter') return NL_OK;
    return { verdicts: [] };
  });

  const first = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'same query' }),
  });
  expect(first.status).toBe(202);
  await waitUntilIdle();
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(1);

  // Simulate a job already scored by a prior (possibly usage-limit-truncated) L2 pass.
  const sourceId = memDb
    .query<{ id: number }, []>(
      `INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','acme','Acme',0,0) RETURNING id`
    )
    .get()!.id;
  memDb.run(
    `INSERT INTO jobs (source_id, url, title, company, company_norm, content_hash, first_seen, last_seen, l1_pass, l2_verdict_json, l2_score, l2_fit)
     VALUES (?, 'https://x.test/1', 'Engineer', 'Acme', 'acme', 'h1', 0, 0, 1, '{"fit":true}', 0.9, 1)`,
    [sourceId]
  );

  const second = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'same query' }),
  });
  expect(second.status).toBe(202);

  // No second nl-filter call, and the verdict inserted above must not be wiped —
  // both assertable immediately: the reuse path skips nl-filter synchronously and
  // never issues the invalidation UPDATE for this request.
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(1);
  const job = memDb.query('SELECT l2_verdict_json FROM jobs WHERE url = ?').get('https://x.test/1') as {
    l2_verdict_json: string | null;
  };
  expect(job.l2_verdict_json).not.toBeNull();

  await waitUntilIdle();
}, 10000);

test('POST /scan with a malformed JSON body returns 400 and releases the lock', async () => {
  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  expect(res.status).toBe(400);
  expect(scan.getScanningState()).toBe(false);
});

test('POST /scan with a query over 500 chars returns 400 and releases the lock', async () => {
  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'x'.repeat(501) }),
  });
  expect(res.status).toBe(400);
  expect(scan.getScanningState()).toBe(false);
});

test('POST /scan returns 502 when nl-filter fails, and releases the lock', async () => {
  setLlm(async () => {
    throw new Error('provider unavailable');
  });
  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'a query nl-filter has not seen before' }),
  });
  expect(res.status).toBe(502);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
  expect(scan.getScanningState()).toBe(false);
});

test('POST /scan with a blank body is a plain re-scan, not a 400 (B-6)', async () => {
  const res = await runs.request('/scan', { method: 'POST' });
  expect(res.status).toBe(202);
  await waitUntilIdle();
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(0);
});

test('POST /scan with an explicit empty-string body is also a plain re-scan (B-6)', async () => {
  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '',
  });
  expect(res.status).toBe(202);
  await waitUntilIdle();
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(0);
});

test('a rephrased query that nl-filter maps to identical YAML still invalidates verdicts (B-2)', async () => {
  setLlm(async req => (req.task === 'nl-filter' ? NL_OK : { verdicts: [] }));

  const first = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'first phrasing' }),
  });
  expect(first.status).toBe(202);
  await waitUntilIdle();

  const sourceId = memDb
    .query<{ id: number }, []>(
      `INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('lever','acme','Acme',0,0) RETURNING id`
    )
    .get()!.id;
  memDb.run(
    `INSERT INTO jobs (source_id, url, title, company, company_norm, content_hash, first_seen, last_seen, l1_pass, l2_verdict_json, l2_score, l2_fit)
     VALUES (?, 'https://x.test/1', 'Engineer', 'Acme', 'acme', 'h1', 0, 0, 1, '{"fit":true}', 0.9, 1)`,
    [sourceId]
  );

  // Different query text, but nl-filter (mocked) maps it to the SAME structured
  // criteria — L2 now grades on the query text too, so this must still invalidate.
  const second = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'second phrasing, same meaning' }),
  });
  expect(second.status).toBe(202);

  const job = memDb.query('SELECT l2_verdict_json FROM jobs WHERE url = ?').get('https://x.test/1') as {
    l2_verdict_json: string | null;
  };
  expect(job.l2_verdict_json).toBeNull();

  await waitUntilIdle();
}, 10000);

test('a stored criteria row that no longer matches NLFilterShape regenerates via nl-filter instead of reusing or 500ing (B-3)', async () => {
  // Pre-upgrade shape: valid YAML, but missing the now-required-nullable
  // experience_years field NLFilterShape expects.
  const { experience_years: _drop, ...legacy } = NL_OK;
  memDb.run(
    `INSERT INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, 'legacy query', 0)`,
    [yaml.dump(legacy)]
  );
  setLlm(async req => (req.task === 'nl-filter' ? NL_OK : { verdicts: [] }));

  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'legacy query' }),
  });
  expect(res.status).toBe(202);
  // Regenerated via nl-filter rather than reused as-is (or thrown as a 500).
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(1);

  await waitUntilIdle();
}, 10000);

test('a stored row from before the intent fields (employment/visa/skills/...) regenerates for the same query', async () => {
  const { employment_types: _a, visa_sponsorship_required: _b, skills: _c, industries: _d, company_stage: _e, ...preIntent } = NL_OK;
  memDb.run(
    `INSERT INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, 'same query', 0)`,
    [yaml.dump(preIntent)]
  );
  setLlm(async req => (req.task === 'nl-filter' ? NL_OK : { verdicts: [] }));

  const res = await runs.request('/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: J({ query: 'same query' }),
  });
  expect(res.status).toBe(202);
  expect(llmCalls.filter(c => c.task === 'nl-filter').length).toBe(1);
  const stored = memDb.query<{ yaml: string }, []>('SELECT yaml FROM criteria WHERE id = 1').get()!;
  expect(yaml.load(stored.yaml)).toMatchObject({ employment_types: [], skills: { must: [], nice: [] } });

  await waitUntilIdle();
}, 10000);

test('GET /:id/stream for an unknown run id returns 404 JSON without opening a stream', async () => {
  const res = await runs.request('/999999/stream');
  expect(res.status).toBe(404);
  const body = await res.json();
  expect(typeof body.error).toBe('string');
});

test('GET /:id/stream for a non-numeric run id returns 404 JSON', async () => {
  const res = await runs.request('/not-a-number/stream');
  expect(res.status).toBe(404);
});

test('GET / limit query param: non-numeric falls back to the default instead of a 500', async () => {
  memDb.run('INSERT INTO runs (started_at, sources_total) VALUES (0, 0)');
  const res = await runs.request('/?limit=abc');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.runs)).toBe(true);
});

test('GET / limit query param: a fractional value is clamped to an int', async () => {
  for (let i = 0; i < 3; i++) memDb.run('INSERT INTO runs (started_at, sources_total) VALUES (0, 0)');
  const res = await runs.request('/?limit=2.5');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.runs.length).toBeLessThanOrEqual(2);
});

test('GET / limit query param: an out-of-range value is clamped to 100', async () => {
  const res = await runs.request('/?limit=99999');
  expect(res.status).toBe(200);
});
