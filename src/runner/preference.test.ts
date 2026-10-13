import { test, expect, beforeEach } from 'bun:test';
import { insertSource, insertJob, resetDb, seedEmbeddingsOff } from '../test-harness';
import type { L2JobRow } from './scan';

// ../test-harness already loaded server.ts, so these dynamic imports resolve to the
// shared mocked db (a static import could evaluate before the mock is armed).
const { calibrationReport, loadPreferenceModel } = await import('./preference');
const { prerankSurvivors } = await import('./preranker');

beforeEach(() => {
  resetDb();
});

const vec = (...xs: number[]) => Buffer.from(Float32Array.from(xs).buffer);

/** Insert a triaged job; `status`/`applied_at` decide its taste signal. */
function triaged(src: number, company: string, status: string, embedding: Buffer | null, extra: Record<string, unknown> = {}) {
  return insertJob(src, { company, company_norm: company, status, embedding, ...extra });
}

function seedTaste(src: number) {
  for (const c of ['a', 'b', 'c']) triaged(src, c, 'shortlist', vec(1, 0, 0));
  for (const c of ['x', 'y', 'z']) triaged(src, c, 'hidden', vec(0, 1, 0));
}

test('no model until three shortlisted jobs carry a vector', () => {
  const src = insertSource();
  triaged(src, 'a', 'shortlist', vec(1, 0, 0));
  triaged(src, 'b', 'shortlist', vec(1, 0, 0));
  triaged(src, 'c', 'shortlist', null); // triaged but never embedded
  expect(loadPreferenceModel()).toBeNull();
  triaged(src, 'd', 'applied', vec(1, 0, 0));
  expect(loadPreferenceModel()?.likedCount).toBe(3);
});

test('is a no-op when embeddings are switched off', () => {
  seedTaste(insertSource());
  expect(loadPreferenceModel()).not.toBeNull();
  seedEmbeddingsOff();
  expect(loadPreferenceModel()).toBeNull();
});

test('signals: applied outranks status, an employer rejection after applying is still a like', () => {
  const src = insertSource();
  triaged(src, 'a', 'shortlist', vec(1, 0, 0));
  triaged(src, 'b', 'offer', vec(1, 0, 0));
  triaged(src, 'c', 'rejected', vec(1, 0, 0), { applied_at: 5 }); // they rejected me
  triaged(src, 'd', 'rejected', vec(0, 1, 0)); // I rejected it
  triaged(src, 'e', 'new', vec(0, 1, 0));
  const m = loadPreferenceModel()!;
  expect(m.likedCount).toBe(3);
  expect(m.dislikedCount).toBe(1);
});

test('calibration: mean score per call and the disagreements', () => {
  const src = insertSource();
  const scored = (company: string, status: string, score: number, fit: number) =>
    triaged(src, company, status, null, { l2_score: score, l2_fit: fit, l2_verdict_json: '{}' });
  scored('a', 'shortlist', 0.9, 1);
  scored('b', 'applied', 0.7, 1);
  scored('c', 'shortlist', 0.4, 0); // liked but graded a non-fit
  scored('d', 'hidden', 0.8, 1); // dismissed but graded a fit
  scored('e', 'hidden', 0.2, 0);
  triaged(src, 'f', 'hidden', null); // triaged under an older search, no verdict

  const r = calibrationReport();
  expect(r.liked.triaged).toBe(3);
  expect(r.liked.scored).toBe(3);
  expect(r.liked.mean_score).toBeCloseTo((0.9 + 0.7 + 0.4) / 3, 5);
  expect(r.liked.not_fit).toBe(1);
  expect(r.disliked.triaged).toBe(3);
  expect(r.disliked.scored).toBe(2);
  expect(r.disliked.mean_score).toBeCloseTo(0.5, 5);
  expect(r.disliked.fit).toBe(1);
  expect(r.preference.active).toBe(false);
});

test('calibration with nothing triaged is empty, not an error', () => {
  const r = calibrationReport();
  expect(r.liked).toEqual({ triaged: 0, scored: 0, mean_score: null, fit: 0, not_fit: 0 });
  expect(r.disliked.triaged).toBe(0);
});

const survivor = (id: number, embedding: Buffer): L2JobRow => ({ id, title: 't', company: 'c', location: null, jd_text: null, embedding });

test('prerank: a liked-looking survivor moves ahead of an equally query-relevant one', async () => {
  const src = insertSource();
  seedTaste(src);
  // Both survivors are equally close to the query (the x/y diagonal), but one leans
  // toward what the user shortlisted and the other toward what they hid.
  const likedVec = vec(0.8, 0.6, 0);
  const dislikedVec = vec(0.6, 0.8, 0);
  const liked = insertJob(src, { embedding: likedVec });
  const disliked = insertJob(src, { embedding: dislikedVec });
  const embedQuery = async () => Float32Array.from([0.7071, 0.7071, 0]);

  const ids = (await prerankSurvivors([survivor(disliked, dislikedVec), survivor(liked, likedVec)], 'q', { embedQuery })).map((j) => j.id);
  expect(ids).toEqual([liked, disliked]);
});

test('prerank: taste cannot overturn a clear query-similarity gap', async () => {
  const src = insertSource();
  seedTaste(src);
  // "near" is the query; "tasty" matches the shortlist's axis but is far from the query.
  const nearVec = vec(0, 0, 1);
  const tastyVec = vec(1, 0, 0);
  const near = insertJob(src, { embedding: nearVec });
  const tasty = insertJob(src, { embedding: tastyVec });
  const embedQuery = async () => Float32Array.from([0, 0, 1]);

  const ids = (await prerankSurvivors([survivor(tasty, tastyVec), survivor(near, nearVec)], 'q', { embedQuery })).map((j) => j.id);
  expect(ids).toEqual([near, tasty]);
});

test('prerank: with no taste the order is purely query similarity', async () => {
  const src = insertSource();
  const nearVec = vec(1, 0, 0);
  const farVec = vec(0, 1, 0);
  const near = insertJob(src, { embedding: nearVec });
  const far = insertJob(src, { embedding: farVec });
  const embedQuery = async () => Float32Array.from([1, 0, 0]);

  const ids = (await prerankSurvivors([survivor(far, farVec), survivor(near, nearVec)], 'q', { embedQuery })).map((j) => j.id);
  expect(ids).toEqual([near, far]);
});
