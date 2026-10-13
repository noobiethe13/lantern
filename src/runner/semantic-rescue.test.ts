import { beforeEach, describe, expect, test } from 'bun:test';
import { bus, memDb, resetDb, seedEmbeddingsOff } from '../test-harness';
import type { Criteria } from '../core/filter';
import type { ScanEvent } from './progress';

// ../test-harness already loaded server.ts, so these dynamic imports resolve to the
// shared mocked db. Every candidate carries a pre-populated embedding BLOB and the
// query vector is injected, so no test loads the ONNX model.
const { serializeVector } = await import('../core/embed');
const { applySemanticRescue } = await import('./semantic-rescue');
const { TITLE_MISSING_REASON } = await import('../core/filter');
const {
  RESCUE_MAX_PROMOTIONS,
  RESCUE_MIN_JD_CHARS,
  RESCUE_MIN_QUERY_FLOOR,
  RESCUE_MIN_SIMILARITY_QUERY,
  RESCUE_MIN_SURVIVORS,
} = await import('../core/semantic-rescue');

const criteria: Criteria = { title: { positive: ['backend engineer', 'backend'], negative: [] } };
const TITLE_ONLY = JSON.stringify([TITLE_MISSING_REASON]);
const JD = 'You will build backend services, APIs and data stores for our platform. '.repeat(5);

/** Unit vector whose cosine with axis `axis` is exactly `sim`. */
function vecWithSim(sim: number, axis = 0): Uint8Array {
  const v = new Float32Array(384);
  v[axis] = sim;
  v[axis === 0 ? 1 : 0] = Math.sqrt(1 - sim * sim);
  return serializeVector(v);
}
const queryVec = (() => {
  const v = new Float32Array(384);
  v[0] = 1;
  return v;
})();
const embedQuery = async () => queryVec;

let sourceId: number;
let runId: number;
let n = 0;

beforeEach(() => {
  resetDb();
  sourceId = memDb
    .query<{ id: number }, []>(
      "INSERT INTO sources (type, identifier, display_name, enabled, created_at) VALUES ('greenhouse','acme','Acme',1,0) RETURNING id",
    )
    .get()!.id;
  runId = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at, jobs_l1_pass) VALUES (0, 3) RETURNING id').get()!.id;
});

function addJob(over: Record<string, unknown> = {}): number {
  const cols = {
    source_id: sourceId,
    url: `https://x.test/${++n}`,
    title: 'Software Engineer II',
    company: 'Acme',
    company_norm: 'acme',
    jd_text: JD,
    content_hash: `h${n}`,
    first_seen: 0,
    last_seen: 0,
    last_run_id: runId,
    l1_pass: 0,
    l1_reasons: TITLE_ONLY,
    embedding: vecWithSim(0.9),
    ...over,
  };
  const keys = Object.keys(cols);
  return memDb
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- column set is dynamic per call site
    .query<{ id: number }, any[]>(`INSERT INTO jobs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')}) RETURNING id`)
    .get(...Object.values(cols))!.id;
}

function state(id: number): { l1_pass: number; l1_rescued: number } {
  return memDb.query<{ l1_pass: number; l1_rescued: number }, [number]>('SELECT l1_pass, l1_rescued FROM jobs WHERE id = ?').get(id)!;
}

describe('applySemanticRescue (query anchor, too few survivors)', () => {
  test('promotes title-only misses at or above the threshold and marks them rescued', async () => {
    const close = addJob({ embedding: vecWithSim(RESCUE_MIN_SIMILARITY_QUERY + 0.1) });
    const far = addJob({ embedding: vecWithSim(RESCUE_MIN_SIMILARITY_QUERY - 0.1) });
    const events: ScanEvent[] = [];
    bus.subscribe(runId, (e: ScanEvent) => events.push(e));

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);

    expect(state(close)).toEqual({ l1_pass: 1, l1_rescued: 1 });
    expect(state(far)).toEqual({ l1_pass: 0, l1_rescued: 0 });
    expect(memDb.query<{ n: number }, [number]>('SELECT jobs_l1_pass AS n FROM runs WHERE id = ?').get(runId)!.n).toBe(4);
    const done = events.filter(e => e.type === 'rescue_done');
    expect(done).toHaveLength(1);
    expect(done[0].msg).toBe('Semantic rescue: 1 job promoted');
  });

  test('only title-only misses with a real JD are candidates', async () => {
    const otherReason = addJob({ l1_reasons: JSON.stringify([TITLE_MISSING_REASON, 'company excluded']) });
    const passed = addJob({ l1_pass: 1, l1_reasons: null });
    const noJd = addJob({ jd_text: null });
    const thinJd = addJob({ jd_text: 'backend '.repeat(5).slice(0, RESCUE_MIN_JD_CHARS - 1) });
    const ok = addJob();

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);

    for (const id of [otherReason, noJd, thinJd]) expect(state(id)).toEqual({ l1_pass: 0, l1_rescued: 0 });
    expect(state(passed)).toEqual({ l1_pass: 1, l1_rescued: 0 });
    expect(state(ok)).toEqual({ l1_pass: 1, l1_rescued: 1 });
  });

  test('promotes at most RESCUE_MAX_PROMOTIONS, best similarity first', async () => {
    const total = RESCUE_MAX_PROMOTIONS + 5;
    // Similarity 0.99 down to roughly 0.55: all above the threshold, strictly ordered.
    const ids = Array.from({ length: total }, (_, i) => addJob({ embedding: vecWithSim(0.99 - i * 0.01) }));

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(RESCUE_MAX_PROMOTIONS);

    expect(ids.slice(0, RESCUE_MAX_PROMOTIONS).every(id => state(id).l1_rescued === 1)).toBe(true);
    expect(ids.slice(RESCUE_MAX_PROMOTIONS).every(id => state(id).l1_rescued === 0)).toBe(true);
  });

  test('is scoped to the given run', async () => {
    const otherRun = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (0) RETURNING id').get()!.id;
    const stale = addJob({ last_run_id: otherRun });
    const mine = addJob();

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(state(stale)).toEqual({ l1_pass: 0, l1_rescued: 0 });
    expect(state(mine).l1_rescued).toBe(1);
  });

  test('is idempotent: a second pass over the same run promotes nothing more', async () => {
    addJob();
    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(0);
  });

  test('no-ops when semantic ranking is disabled', async () => {
    seedEmbeddingsOff();
    const id = addJob();
    let embedded = false;
    expect(await applySemanticRescue(runId, criteria, { embedQuery: async () => ((embedded = true), queryVec) })).toBe(0);
    expect(embedded).toBe(false);
    expect(state(id)).toEqual({ l1_pass: 0, l1_rescued: 0 });
  });

  test('no-ops without a query anchor', async () => {
    const id = addJob();
    expect(await applySemanticRescue(runId, {}, { embedQuery })).toBe(0);
    expect(state(id).l1_pass).toBe(0);
  });

  test('an embedding failure is swallowed and leaves L1 verdicts untouched', async () => {
    const id = addJob();
    const failing = async (): Promise<never> => {
      throw new Error('model unavailable');
    };
    expect(await applySemanticRescue(runId, criteria, { embedQuery: failing })).toBe(0);
    expect(state(id)).toEqual({ l1_pass: 0, l1_rescued: 0 });
  });
});

/** Unit vector with exact cosine `q` to axis 0 (the query) and `c` to axis 2 (the survivors). */
function vecAt(q: number, c: number): Uint8Array {
  const v = new Float32Array(384);
  v[0] = q;
  v[2] = c;
  v[3] = Math.sqrt(Math.max(0, 1 - q * q - c * c));
  return serializeVector(v);
}

describe('applySemanticRescue (survivor centroid anchor)', () => {
  const addSurvivors = (n: number, over: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) =>
      addJob({ l1_pass: 1, l1_reasons: null, embedding: vecWithSim(1, 2), company_norm: `co${i}`, ...over }),
    );

  test('with enough survivors, candidates are judged against their centroid, not the query', async () => {
    addSurvivors(RESCUE_MIN_SURVIVORS);
    // Axis 0 is the query, axis 2 the survivors: a candidate near the survivors (and
    // not hopelessly far from the query) is promoted, one near only the query is not.
    const nearSurvivors = addJob({ embedding: vecAt(0.4, 0.9) });
    const nearQuery = addJob({ embedding: vecWithSim(0.9, 0) });

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(state(nearSurvivors).l1_rescued).toBe(1);
    expect(state(nearQuery).l1_rescued).toBe(0);
  });

  test('one survivor short of the minimum falls back to the query anchor', async () => {
    addSurvivors(RESCUE_MIN_SURVIVORS - 1);
    const nearSurvivors = addJob({ embedding: vecWithSim(1, 2) });
    const nearQuery = addJob({ embedding: vecWithSim(0.9, 0) });

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(state(nearQuery).l1_rescued).toBe(1);
    expect(state(nearSurvivors).l1_rescued).toBe(0);
  });

  test('survivors from other runs and previously rescued jobs do not count toward the centroid', async () => {
    const otherRun = memDb.query<{ id: number }, []>('INSERT INTO runs (started_at) VALUES (0) RETURNING id').get()!.id;
    addSurvivors(RESCUE_MIN_SURVIVORS, { last_run_id: otherRun });
    addSurvivors(RESCUE_MIN_SURVIVORS, { l1_rescued: 1 });
    const nearQuery = addJob({ embedding: vecWithSim(0.9, 0) });

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(state(nearQuery).l1_rescued).toBe(1);
  });

  test('best similarity to the centroid wins the cap', async () => {
    addSurvivors(RESCUE_MIN_SURVIVORS);
    const total = RESCUE_MAX_PROMOTIONS + 3;
    const ids = Array.from({ length: total }, (_, i) => addJob({ embedding: vecAt(0.3, 0.95 - i * 0.005) }));
    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(RESCUE_MAX_PROMOTIONS);
    expect(ids.slice(RESCUE_MAX_PROMOTIONS).every(id => state(id).l1_rescued === 0)).toBe(true);
  });

  test('one company dominating the survivors cannot drag the centroid onto its own boilerplate', async () => {
    // 30 Bigco survivors share boilerplate (axis 2). Five other companies' survivors
    // sit on the query axis. Uncapped, the centroid would be ~99% Bigco boilerplate and
    // reject the genuine near-query candidate. Capped at 3 per company it is mostly query.
    addSurvivors(30, { company_norm: 'bigco' });
    Array.from({ length: 5 }, (_, i) => addJob({ l1_pass: 1, l1_reasons: null, embedding: vecWithSim(1, 0), company_norm: `other${i}` }));
    const genuine = addJob({ embedding: vecAt(0.95, 0) });
    // Bigco boilerplate job: very close to the (uncapped) centroid, unrelated to the query.
    const boilerplate = addJob({ embedding: vecAt(0, 1), company_norm: 'bigco' });

    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(1);
    expect(state(genuine).l1_rescued).toBe(1);
    expect(state(boilerplate).l1_rescued).toBe(0);
  });

  test('a candidate under the query floor is never promoted, even if it sits on the centroid', async () => {
    addSurvivors(RESCUE_MIN_SURVIVORS);
    const onCentroidOffQuery = addJob({ embedding: vecAt(RESCUE_MIN_QUERY_FLOOR - 0.1, 0.9) });
    expect(await applySemanticRescue(runId, criteria, { embedQuery })).toBe(0);
    expect(state(onCentroidOffQuery).l1_rescued).toBe(0);
  });

  test('announces the pass before scoring', async () => {
    addSurvivors(RESCUE_MIN_SURVIVORS);
    addJob({ embedding: vecAt(0.4, 0.9) });
    const events: ScanEvent[] = [];
    bus.subscribe(runId, (e: ScanEvent) => events.push(e));
    await applySemanticRescue(runId, criteria, { embedQuery });
    expect(events.map(e => e.type)).toEqual(['rescue_start', 'rescue_done']);
    expect(events[0].msg).toBe('Semantic rescue: scoring 1 candidates…');
  });
});
