import { describe, expect, test } from 'bun:test';
import { spearmanRho, ndcgAtK, precisionAtK, meanRankOfPositives, classifyOrdering } from './ranking-metrics';

describe('spearmanRho', () => {
  test('perfectly monotonic series → +1', () => {
    expect(spearmanRho([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 6);
  });

  test('perfectly reversed series → -1', () => {
    expect(spearmanRho([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 6);
  });

  test('partial agreement → known intermediate value', () => {
    // ranks x=[1,2,3], y=[1,3,2]; Pearson over those ranks = 0.5
    expect(spearmanRho([1, 2, 3], [1, 3, 2])).toBeCloseTo(0.5, 6);
  });

  test('ties get averaged ranks (no NaN, sign preserved)', () => {
    const rho = spearmanRho([1, 2, 2, 4], [1, 2, 3, 4]);
    expect(Number.isNaN(rho)).toBe(false);
    expect(rho).toBeGreaterThan(0.8);
  });

  test('degenerate input → 0', () => {
    expect(spearmanRho([1], [1])).toBe(0); // n < 2
    expect(spearmanRho([], [])).toBe(0);
    expect(spearmanRho([1, 2, 3], [1, 2])).toBe(0); // length mismatch
    expect(spearmanRho([1, 1, 1], [1, 2, 3])).toBe(0); // constant series, no variance
  });
});

describe('ndcgAtK', () => {
  test('ideal order → 1', () => {
    expect(ndcgAtK([3, 2, 1], 3)).toBeCloseTo(1, 6);
  });

  test('worst order → known < 1 value', () => {
    // dcg([1,2,3]) / dcg([3,2,1]) = 3.76186 / 4.76186 ≈ 0.79
    expect(ndcgAtK([1, 2, 3], 3)).toBeCloseTo(0.79, 2);
  });

  test('k limits the evaluated depth', () => {
    // top slot has 0 gain, the only gain sits at position 3 → 0 within depth 1
    expect(ndcgAtK([0, 0, 5], 1)).toBe(0);
  });

  test('no gain anywhere → 0', () => {
    expect(ndcgAtK([0, 0, 0], 3)).toBe(0);
    expect(ndcgAtK([], 5)).toBe(0);
  });
});

describe('precisionAtK', () => {
  test('counts positives within the first k', () => {
    expect(precisionAtK([true, false, true, false], 2)).toBeCloseTo(0.5, 6);
    expect(precisionAtK([true, true, false, false], 2)).toBeCloseTo(1, 6);
  });

  test('k beyond length clamps to the whole list', () => {
    expect(precisionAtK([true, false, true, false], 99)).toBeCloseTo(0.5, 6);
  });

  test('k <= 0 or empty → 0', () => {
    expect(precisionAtK([true, true], 0)).toBe(0);
    expect(precisionAtK([], 5)).toBe(0);
  });
});

describe('meanRankOfPositives', () => {
  test('averages the 1-indexed positions of positives', () => {
    expect(meanRankOfPositives([false, true, false, true])).toBe(3); // (2+4)/2
    expect(meanRankOfPositives([true, true])).toBe(1.5); // (1+2)/2
  });

  test('no positives → NaN', () => {
    expect(Number.isNaN(meanRankOfPositives([false, false]))).toBe(true);
    expect(Number.isNaN(meanRankOfPositives([]))).toBe(true);
  });
});

describe('classifyOrdering', () => {
  const big = { n: 100, positives: 30 };

  test('too few scored or too few fits → inconclusive', () => {
    expect(classifyOrdering({ n: 12, positives: 30, rho: 0.9, meanRankCosine: 5, meanRankArrival: 50, precisionCosine: 1, precisionArrival: 0 }).label).toBe('inconclusive');
    expect(classifyOrdering({ n: 100, positives: 6, rho: 0.9, meanRankCosine: 5, meanRankArrival: 50, precisionCosine: 1, precisionArrival: 0 }).label).toBe('inconclusive');
  });

  test('all signals favour cosine → positive', () => {
    const v = classifyOrdering({ ...big, rho: 0.5, meanRankCosine: 10, meanRankArrival: 40, precisionCosine: 0.6, precisionArrival: 0.2 });
    expect(v.label).toBe('positive');
    expect(v.meanRankGain).toBe(30); // 40 - 10, surfaced earlier
  });

  test('all signals favour arrival → negative', () => {
    expect(classifyOrdering({ ...big, rho: -0.3, meanRankCosine: 40, meanRankArrival: 10, precisionCosine: 0.1, precisionArrival: 0.3 }).label).toBe('negative');
  });

  test('conflicting signals → mixed (the bug case: precision up but mean-rank worse)', () => {
    // Run #4 shape: precision@k slightly better, mean-rank worse, ρ≈0.
    const v = classifyOrdering({ ...big, rho: 0.02, meanRankCosine: 48.67, meanRankArrival: 44.83, precisionCosine: 0.1, precisionArrival: 0.0 });
    expect(v.label).toBe('mixed');
    expect(v.meanRankGain).toBeLessThan(0); // honestly negative direction
  });

  test('no positives (NaN mean ranks) is inconclusive, not a crash', () => {
    const v = classifyOrdering({ n: 100, positives: 0, rho: 0, meanRankCosine: NaN, meanRankArrival: NaN, precisionCosine: 0, precisionArrival: 0 });
    expect(v.label).toBe('inconclusive');
    expect(v.meanRankGain).toBe(0);
  });
});
