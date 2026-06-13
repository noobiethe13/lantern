import { describe, expect, test } from 'bun:test';
import {
  cosineSim,
  criteriaToQueryText,
  deserializeVector,
  serializeVector,
  topKSimilar,
  EMBED_DIM,
} from './embed';
import type { Criteria } from './filter';

describe('cosineSim', () => {
  test('identical normalized vectors → 1', () => {
    const v = new Float32Array([0.6, 0.8]); // unit length
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  test('orthogonal vectors → 0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSim(a, b)).toBeCloseTo(0, 5);
  });

  test('opposite vectors → -1', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineSim(a, b)).toBeCloseTo(-1, 5);
  });

  test('length mismatch → 0 (defensive, e.g. a stale vector from another model)', () => {
    expect(cosineSim(new Float32Array([1, 0, 0]), new Float32Array([1, 0]))).toBe(0);
  });
});

describe('serializeVector / deserializeVector', () => {
  test('round-trips exact float values', () => {
    const v = new Float32Array([0.1, -0.25, 1, 0, 3.5]);
    const round = deserializeVector(serializeVector(v));
    expect(round).not.toBeNull();
    expect(Array.from(round!)).toEqual(Array.from(v));
  });

  test('round-trips a full-width vector', () => {
    const v = new Float32Array(EMBED_DIM);
    for (let i = 0; i < EMBED_DIM; i++) v[i] = Math.sin(i);
    const round = deserializeVector(serializeVector(v));
    expect(round?.length).toBe(EMBED_DIM);
    expect(round![100]).toBeCloseTo(Math.sin(100), 6);
  });

  test('deserialize rejects null / empty / non-multiple-of-4 lengths', () => {
    expect(deserializeVector(null)).toBeNull();
    expect(deserializeVector(undefined)).toBeNull();
    expect(deserializeVector(new Uint8Array(0))).toBeNull();
    expect(deserializeVector(new Uint8Array(5))).toBeNull();
  });

  test('deserialize copies — does not alias the source buffer', () => {
    const v = new Float32Array([1, 2]);
    const buf = serializeVector(v);
    const round = deserializeVector(buf)!;
    buf[0] = 0xff; // mutate the source bytes
    expect(round[0]).toBe(1); // the copy is unaffected
  });
});

describe('topKSimilar', () => {
  const target = new Float32Array([1, 0]);
  const candidates = [
    { vec: new Float32Array([1, 0]), item: 'same' },
    { vec: new Float32Array([0.7071, 0.7071]), item: 'diag' },
    { vec: new Float32Array([0, 1]), item: 'ortho' },
    { vec: new Float32Array([-1, 0]), item: 'opposite' },
  ];

  test('returns top-k ordered by descending similarity', () => {
    const out = topKSimilar(target, candidates, 2);
    expect(out.map(o => o.item)).toEqual(['same', 'diag']);
    expect(out[0].sim).toBeCloseTo(1, 4);
    expect(out[1].sim).toBeCloseTo(0.7071, 4);
  });

  test('k larger than the pool returns the whole pool, still ranked', () => {
    const out = topKSimilar(target, candidates, 99);
    expect(out.map(o => o.item)).toEqual(['same', 'diag', 'ortho', 'opposite']);
  });

  test('k <= 0 returns empty', () => {
    expect(topKSimilar(target, candidates, 0)).toEqual([]);
    expect(topKSimilar(target, candidates, -3)).toEqual([]);
  });

  test('empty candidate pool returns empty', () => {
    expect(topKSimilar(target, [], 5)).toEqual([]);
  });
});

describe('criteriaToQueryText', () => {
  test('joins title keywords, seniority, remote, and locations', () => {
    const c: Criteria = {
      title: { positive: ['backend engineer', 'platform'], negative: [] },
      seniority: { allowed: ['senior'] },
      location: { remote_required: true, allowed: ['Europe'] },
    };
    expect(criteriaToQueryText(c)).toBe('backend engineer, platform, senior, remote, Europe');
  });

  test('omits absent sections and skips remote when not required', () => {
    const c: Criteria = { title: { positive: ['data scientist'], negative: [] } };
    expect(criteriaToQueryText(c)).toBe('data scientist');
  });

  test('empty criteria → empty string (pre-ranker no-ops on this)', () => {
    expect(criteriaToQueryText({})).toBe('');
  });
});
