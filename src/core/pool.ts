// Bounded-concurrency async pool. Runs `worker` over `items` with at most `limit`
// in flight, starting the next item the instant one finishes — a sliding window,
// not fixed batches, so one slow item never idles the others. The scan runner uses
// it to fan out across hundreds of source adapters without head-of-line blocking.

/**
 * Resolves when every item has been processed. A worker that throws is routed to
 * `onError` (and the pool keeps going); without an `onError` handler the rejection
 * propagates and the pool rejects. `limit` is clamped to [1, items.length].
 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  onError?: (item: T, err: unknown) => void,
): Promise<void> {
  const n = items.length;
  if (n === 0) return;
  const width = Math.min(Math.max(1, Math.floor(limit) || 1), n);

  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= n) return;
      try {
        await worker(items[i], i);
      } catch (err) {
        if (onError) onError(items[i], err);
        else throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, runner));
}
