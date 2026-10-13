import { test, expect, describe } from 'bun:test';
import {
  PREF_MAX_ADJUST,
  PREF_MAX_PER_COMPANY,
  PREF_MIN_DISLIKED,
  PREF_MIN_LIKED,
  buildPreferenceModel,
  compareRank,
  preferenceAdjustments,
  rawPreference,
  type PreferenceSample,
  type RankableJob,
  type TriageSignal,
} from './preference';

const v = (...xs: number[]) => Float32Array.from(xs);
const sample = (vec: Float32Array, signal: TriageSignal, company = 'c'): PreferenceSample => ({ vec, signal, company });
const norm = (x: Float32Array) => Math.sqrt(x.reduce((a, b) => a + b * b, 0));

/** Three liked samples spread over distinct companies, all along the x axis. */
const likedAxis = () => [1, 2, 3].map((i) => sample(v(1, 0, 0), 'liked', `co${i}`));

describe('buildPreferenceModel', () => {
  test('is off until the liked side reaches the minimum', () => {
    expect(buildPreferenceModel([])).toBeNull();
    const two = likedAxis().slice(0, PREF_MIN_LIKED - 1);
    expect(buildPreferenceModel(two)).toBeNull();
    expect(buildPreferenceModel(likedAxis())).not.toBeNull();
  });

  test('dismissals alone never activate it', () => {
    const only = [1, 2, 3, 4].map((i) => sample(v(0, 1, 0), 'disliked', `co${i}`));
    expect(buildPreferenceModel(only)).toBeNull();
  });

  test('liked centroid is the unit-length mean', () => {
    const m = buildPreferenceModel([
      sample(v(1, 0, 0), 'liked', 'a'),
      sample(v(0, 1, 0), 'liked', 'b'),
      sample(v(1, 1, 0), 'liked', 'c'),
    ])!;
    expect(norm(m.liked)).toBeCloseTo(1, 5);
    // mean = (2,2,0)/3, so it lies on the x=y diagonal
    expect(m.liked[0]).toBeCloseTo(m.liked[1], 5);
    expect(m.liked[2]).toBe(0);
    expect(m.likedCount).toBe(3);
  });

  test('the dismissed centroid needs its own minimum, otherwise it is ignored', () => {
    const few = [...likedAxis(), sample(v(0, 1, 0), 'disliked', 'x'), sample(v(0, 1, 0), 'disliked', 'y')];
    expect(few.filter((s) => s.signal === 'disliked').length).toBeLessThan(PREF_MIN_DISLIKED);
    const m = buildPreferenceModel(few)!;
    expect(m.disliked).toBeNull();
    expect(rawPreference(m, v(0, 1, 0))).toBe(0);

    const enough = [...likedAxis(), ...[1, 2, 3].map((i) => sample(v(0, 1, 0), 'disliked', `d${i}`))];
    const withD = buildPreferenceModel(enough)!;
    expect(withD.disliked).not.toBeNull();
    expect(rawPreference(withD, v(0, 1, 0))).toBeLessThan(0);
  });

  test('caps contributions per company so one employer cannot drag the centroid', () => {
    // 5 shortlisted from "big" all point along y, one each from two small companies along x.
    const samples = [
      ...[1, 2, 3, 4, 5].map(() => sample(v(0, 1, 0), 'liked', 'big')),
      sample(v(1, 0, 0), 'liked', 'a'),
      sample(v(1, 0, 0), 'liked', 'b'),
    ];
    const m = buildPreferenceModel(samples)!;
    expect(m.likedCount).toBe(PREF_MAX_PER_COMPANY + 2);
    // uncapped: y component would be 5/7 of the mean. Capped: 2 y vs 2 x, so equal.
    expect(m.liked[0]).toBeCloseTo(m.liked[1], 5);
  });

  test('one company alone can never satisfy the minimum', () => {
    const oneCo = [1, 2, 3, 4].map(() => sample(v(1, 0, 0), 'liked', 'only'));
    expect(buildPreferenceModel(oneCo)).toBeNull();
  });

  test('samples arrive newest first, so the cap keeps the newest per company', () => {
    const samples = [
      sample(v(1, 0, 0), 'liked', 'a'), // newest
      sample(v(1, 0, 0), 'liked', 'a'),
      sample(v(0, 1, 0), 'liked', 'a'), // oldest, over the cap
      sample(v(1, 0, 0), 'liked', 'b'),
    ];
    const m = buildPreferenceModel(samples)!;
    expect(m.liked[1]).toBe(0);
  });
});

describe('preferenceAdjustments', () => {
  const model = buildPreferenceModel([
    ...likedAxis(),
    ...[1, 2, 3].map((i) => sample(v(0, 1, 0), 'disliked', `d${i}`)),
  ])!;

  test('liked-looking jobs get a positive delta, dismissed-looking a negative one, centered on the view', () => {
    const adj = preferenceAdjustments(model, [
      { id: 1, vec: v(1, 0, 0) },
      { id: 2, vec: v(0.7, 0.7, 0) },
      { id: 3, vec: v(0, 1, 0) },
    ]);
    expect(adj.get(1)!).toBeGreaterThan(0);
    expect(adj.get(3)!).toBeLessThan(0);
    // the median job sits at the center
    expect(adj.get(2)!).toBeCloseTo(0, 5);
  });

  test('every delta stays inside the cap, however extreme the vectors', () => {
    const adj = preferenceAdjustments(model, [
      { id: 1, vec: v(1, 0, 0) },
      { id: 2, vec: v(0, 1, 0) },
      { id: 3, vec: v(0, 0, 1) },
      { id: 4, vec: v(0, -1, 0) },
      { id: 5, vec: v(-1, 0, 0) },
    ]);
    for (const d of adj.values()) expect(Math.abs(d)).toBeLessThanOrEqual(PREF_MAX_ADJUST);
    expect(Math.max(...adj.values())).toBe(PREF_MAX_ADJUST);
  });

  test('jobs without a vector get no entry', () => {
    const adj = preferenceAdjustments(model, [{ id: 1, vec: v(1, 0, 0) }, { id: 2, vec: null }, { id: 3, vec: undefined }]);
    expect([...adj.keys()]).toEqual([1]);
  });
});

describe('compareRank', () => {
  const job = (id: number, over: Partial<RankableJob> = {}): RankableJob => ({
    id, l2_score: 0.8, l2_fit: 1, l1_pass: 1, first_seen: 1, ...over,
  });
  const order = (jobs: RankableJob[], adj: [number, number][] = []) =>
    [...jobs].sort(compareRank(new Map(adj))).map((j) => j.id);

  test('without a delta it is plain score order', () => {
    expect(order([job(1, { l2_score: 0.6 }), job(2, { l2_score: 0.9 })])).toEqual([2, 1]);
  });

  test('a near-tie is reordered by the delta', () => {
    const jobs = [job(1, { l2_score: 0.82 }), job(2, { l2_score: 0.8 })];
    expect(order(jobs)).toEqual([1, 2]);
    expect(order(jobs, [[2, PREF_MAX_ADJUST]])).toEqual([2, 1]);
  });

  test('a clear score gap is never overturned', () => {
    // 0.9 vs 0.6: even the full +/-cap on both sides leaves 0.8 > 0.7
    const jobs = [job(1, { l2_score: 0.9 }), job(2, { l2_score: 0.6 })];
    expect(order(jobs, [[1, -PREF_MAX_ADJUST], [2, PREF_MAX_ADJUST]])).toEqual([1, 2]);
  });

  test('a non-fit never rises above a fit, even with the full delta', () => {
    const jobs = [job(1, { l2_score: 0.55, l2_fit: 1 }), job(2, { l2_score: 0.58, l2_fit: 0 })];
    expect(order(jobs, [[2, PREF_MAX_ADJUST], [1, -PREF_MAX_ADJUST]])).toEqual([1, 2]);
  });

  test('scored jobs lead, then L1 survivors, then recency', () => {
    const jobs = [
      job(1, { l2_score: null, l2_fit: null, l1_pass: 0, first_seen: 9 }),
      job(2, { l2_score: null, l2_fit: null, l1_pass: 1, first_seen: 1 }),
      job(3, { l2_score: null, l2_fit: null, l1_pass: 1, first_seen: 5 }),
      job(4, { l2_score: 0.2, l2_fit: 0 }),
    ];
    expect(order(jobs)).toEqual([4, 3, 2, 1]);
  });
});

test('compareRank falls back to id so fully tied jobs have a stable order', () => {
  const j = (id: number): RankableJob => ({ id, l2_score: null, l2_fit: null, l1_pass: 1, first_seen: 5 });
  expect([j(1), j(3), j(2)].sort(compareRank(new Map())).map((x) => x.id)).toEqual([3, 2, 1]);
});
