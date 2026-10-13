import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseRemotive, reserveCall, RemotiveAdapter, type RemotiveBudgetStore } from './remotive';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-12T12:00:00Z');

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function ctx(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    sourceId: 1,
    config: {},
    emitProgress: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

function memoryStore(initial: number[] = []): RemotiveBudgetStore & { saved: number[] } {
  const store = {
    saved: initial,
    reserve(now: number, gapMs: number) {
      const { result, timestamps } = reserveCall(store.saved, now, gapMs);
      store.saved = timestamps;
      return result;
    },
  };
  return store;
}

function adapter(store: RemotiveBudgetStore): RemotiveAdapter {
  return new RemotiveAdapter(store, 0, () => NOW);
}

// Trimmed real /api/remote-jobs shape (the response also carries legal-notice keys).
const RESP = {
  '0-legal-notice': 'Please link back to Remotive',
  'job-count': 2,
  jobs: [
    {
      id: 2091045,
      url: 'https://remotive.com/remote-jobs/software-dev/senior-backend-2091045',
      title: 'Senior Backend Engineer',
      company_name: ' Unio Digital ',
      category: 'Software Development',
      publication_date: '2026-10-07T01:11:09',
      candidate_required_location: 'USA Only',
      salary: 'OTE $25k - $35k',
      description: '<p>Build services.</p>',
    },
    { id: 2, url: '', title: 'No URL', company_name: 'X' },
  ],
};

describe('parseRemotive', () => {
  test('maps a job: remote, restriction as location, JD, UTC posted_at; salary text is not mapped', () => {
    const jobs = parseRemotive(RESP);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '2091045',
      title: 'Senior Backend Engineer',
      url: 'https://remotive.com/remote-jobs/software-dev/senior-backend-2091045',
      company: 'Unio Digital',
      location: 'USA Only',
      remote: true,
    });
    expect(jobs[0].jd_text).toBe('Build services.');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-10-07T01:11:09Z'));
    expect(jobs[0].salary_min_usd).toBeUndefined();
  });

  test('omits jd_text (undefined, not "") when the description is empty', () => {
    const json = { jobs: [{ ...RESP.jobs[0], description: '' }] };
    expect(parseRemotive(json)[0].jd_text).toBeUndefined();
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseRemotive({})).toEqual([]);
    expect(parseRemotive(null)).toEqual([]);
  });
});

describe('reserveCall', () => {
  test('allows up to 4 calls in a rolling 24h window, then reports exhausted', () => {
    let ts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = reserveCall(ts, NOW, 0);
      expect(r.result.status).toBe('ok');
      ts = r.timestamps;
    }
    expect(reserveCall(ts, NOW, 0).result.status).toBe('exhausted');
  });

  test('prunes calls older than 24h', () => {
    const old = [NOW - 25 * HOUR, NOW - 30 * HOUR, NOW - 26 * HOUR, NOW - 27 * HOUR];
    const r = reserveCall(old, NOW, 0);
    expect(r.result.status).toBe('ok');
    expect(r.timestamps).toEqual([NOW]);
  });

  test('makes a call wait until the gap since the newest persisted call has passed', () => {
    const r = reserveCall([NOW - 10_000], NOW, 31_000);
    expect(r.result).toEqual({ status: 'wait', waitMs: 21_000 });
    expect(r.timestamps).toEqual([NOW - 10_000]);
    expect(reserveCall([NOW - 31_000], NOW, 31_000).result.status).toBe('ok');
  });

  test('two reservations against one store exhaust the budget between them', () => {
    const store = memoryStore();
    const granted: boolean[] = [];
    for (let i = 0; i < 6; i++) granted.push(store.reserve(NOW, 0).status === 'ok');
    expect(granted.filter(Boolean)).toHaveLength(4);
    expect(store.saved).toHaveLength(4);
  });
});

describe('RemotiveAdapter.fetch', () => {
  test('yields nothing, makes no request and spends no budget when keywords are empty', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(RESP);
    }) as unknown as typeof fetch;
    const store = memoryStore();
    expect(await collect(adapter(store).fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
    expect(store.saved).toEqual([]);
  });

  test('one request per keyword (capped at 2), each recorded in the persisted budget', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return jsonResponse(RESP);
    }) as unknown as typeof fetch;
    const store = memoryStore();
    const jobs = await collect(adapter(store).fetch(ctx({ keywords: ['backend engineer', 'python', 'golang'] })));
    expect(jobs).toHaveLength(1); // same URL from both requests dedupes
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]).searchParams.get('search')).toBe('backend engineer');
    expect(store.saved).toEqual([NOW, NOW]);
  });

  test('stops before the cap when the daily budget runs out mid-scan', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(RESP);
    }) as unknown as typeof fetch;
    const store = memoryStore([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR]);
    await collect(adapter(store).fetch(ctx({ keywords: ['backend engineer', 'python'] })));
    expect(calls).toBe(1);
    expect(store.saved).toHaveLength(4);
  });

  test('two concurrent Remotive rows share the ledger and never exceed 4 calls', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(RESP);
    }) as unknown as typeof fetch;
    const store = memoryStore([NOW - HOUR]);
    const run = () => collect(adapter(store).fetch(ctx({ keywords: ['backend engineer', 'python'] })));
    await Promise.all([run(), run()]);
    expect(calls).toBe(3);
    expect(store.saved).toHaveLength(4);
  });

  test('waits out the spacing gap recorded by an earlier scan before calling', async () => {
    globalThis.fetch = (async () => jsonResponse(RESP)) as unknown as typeof fetch;
    const store = memoryStore([Date.now()]);
    const started = Date.now();
    await collect(new RemotiveAdapter(store, 80).fetch(ctx({ keywords: ['backend engineer'] })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(store.saved).toHaveLength(2);
  });

  test('makes no request once the budget is used up', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(RESP);
    }) as unknown as typeof fetch;
    const store = memoryStore([NOW - HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR, NOW - 4 * HOUR]);
    expect(await collect(adapter(store).fetch(ctx({ keywords: ['backend engineer'] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('a failed request still spends budget, is not retried, and throws when all fail', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const store = memoryStore();
    await expect(collect(adapter(store).fetch(ctx({ keywords: ['backend engineer'] })))).rejects.toThrow();
    expect(calls).toBe(1);
    expect(store.saved).toEqual([NOW]);
  });
});
