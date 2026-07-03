import { describe, expect, test } from 'bun:test';
import { runPool } from './pool';

describe('runPool', () => {
  test('processes every item exactly once', async () => {
    const seen: string[] = [];
    await runPool(['a', 'b', 'c', 'd', 'e'], 2, async (x) => {
      seen.push(x);
    });
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('never exceeds the concurrency limit, but does run in parallel', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  test('a throwing worker is reported via onError and does not halt the rest', async () => {
    const done: number[] = [];
    const errored: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      2,
      async (x) => {
        if (x === 2) throw new Error('boom');
        done.push(x);
      },
      (item) => errored.push(item),
    );
    expect(done.sort()).toEqual([1, 3, 4]);
    expect(errored).toEqual([2]);
  });

  test('without onError, a throwing worker rejects the pool', async () => {
    await expect(
      runPool([1], 1, async () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
  });

  test('empty items resolves without calling the worker', async () => {
    let called = false;
    await runPool([], 4, async () => {
      called = true;
    });
    expect(called).toBe(false);
  });

  test('limit larger than the pool still processes all', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3], 99, async (x) => {
      seen.push(x);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });
});
