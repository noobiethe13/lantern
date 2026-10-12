import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseArbeitnow, ArbeitnowAdapter } from './arbeitnow';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

function item(n: number, createdAtSec: number) {
  return {
    slug: `job-${n}`,
    company_name: 'Acme',
    title: 'Flutter Developer',
    url: `https://www.arbeitnow.com/jobs/x/job-${n}`,
    tags: ['flutter'],
    created_at: createdAtSec,
  };
}

describe('parseArbeitnow', () => {
  test('maps a matching posting from the data array', () => {
    const json = {
      data: [
        {
          slug: 'node-dev-berlin-254093',
          company_name: 'Centric GmbH',
          title: 'Node Developer',
          description: '<p>Backend <b>work</b></p>',
          remote: true,
          url: 'https://www.arbeitnow.com/jobs/companies/centric/node-dev-berlin-254093',
          tags: ['Remote', 'Node'],
          created_at: 1780619432,
        },
      ],
    };
    const jobs = parseArbeitnow(json, ['node']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'node-dev-berlin-254093',
      title: 'Node Developer',
      company: 'Centric GmbH',
      url: 'https://www.arbeitnow.com/jobs/companies/centric/node-dev-berlin-254093',
      remote: true,
      jd_text: 'Backend work',
    });
    expect(jobs[0].posted_at).toBe(1780619432000);
  });

  test('filters out postings that do not match a keyword', () => {
    const json = {
      data: [
        { slug: 's', company_name: 'A', title: 'HR Manager', url: 'https://x', tags: ['HR'] },
      ],
    };
    expect(parseArbeitnow(json, ['node'])).toHaveLength(0);
  });

  test('matches keyword found only in tags', () => {
    const json = {
      data: [
        { slug: 's', company_name: 'A', title: 'Backend Engineer', url: 'https://x', tags: ['NodeJS'] },
      ],
    };
    expect(parseArbeitnow(json, ['node'])).toHaveLength(1);
  });

  test('returns [] for non-array data', () => {
    expect(parseArbeitnow({}, ['node'])).toEqual([]);
    expect(parseArbeitnow(null, ['node'])).toEqual([]);
  });

  test('omits jd_text (undefined, not "") when description is missing', () => {
    const json = { data: [{ slug: 's', company_name: 'A', title: 'Node Dev', url: 'https://x', tags: ['node'] }] };
    expect(parseArbeitnow(json, ['node'])[0].jd_text).toBeUndefined();
  });
});

describe('ArbeitnowAdapter.fetch', () => {
  const now = Date.now();
  const recentSec = Math.floor((now - 60_000) / 1000);

  test('follows links.next across pages and merges results', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url === 'https://www.arbeitnow.com/api/job-board-api') {
        return jsonResponse({
          data: [item(1, recentSec)],
          links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
        });
      }
      if (url.includes('page=2')) {
        return jsonResponse({ data: [item(2, recentSec)], links: { next: null } });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const jobs = await collect(new ArbeitnowAdapter().fetch(ctx({ keywords: ['flutter'] })));
    expect(jobs.map(j => j.external_id).sort()).toEqual(['job-1', 'job-2']);
    expect(calls).toHaveLength(2); // stopped once links.next was null
  });

  test('stops paginating once a page is past the maxAgeDays freshness window', async () => {
    const oldSec = Math.floor((now - 10 * 86_400_000) / 1000); // 10 days ago
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url === 'https://www.arbeitnow.com/api/job-board-api') {
        return jsonResponse({
          data: [item(1, recentSec)],
          links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
        });
      }
      if (url.includes('page=2')) {
        // This page's oldest item is already past the 7-day cutoff.
        return jsonResponse({
          data: [item(2, oldSec)],
          links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=3' },
        });
      }
      throw new Error(`unexpected url ${url}`); // page 3 should never be requested
    }) as unknown as typeof fetch;

    const jobs = await collect(
      new ArbeitnowAdapter().fetch(ctx({ keywords: ['flutter'], maxAgeDays: 7 })),
    );
    expect(jobs.map(j => j.external_id).sort()).toEqual(['job-1', 'job-2']);
    expect(calls).toHaveLength(2); // page 2's staleness stopped it short of page 3
  });

  test('caps pagination at MAX_PAGES even when links.next keeps going', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      return jsonResponse({
        data: [item(call, recentSec)],
        links: { next: `https://www.arbeitnow.com/api/job-board-api?page=${call + 1}` },
      });
    }) as unknown as typeof fetch;

    const jobs = await collect(new ArbeitnowAdapter().fetch(ctx({ keywords: ['flutter'] })));
    expect(call).toBeLessThanOrEqual(6);
    expect(jobs.length).toBe(call);
    // Real between-page politeness delays (PAGE_DELAY_MS x up to 5 hops) push
    // this comfortably past bun's default 5000ms test timeout.
  }, 10000);

  test('throws when the very first page fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      collect(new ArbeitnowAdapter().fetch(ctx({ keywords: ['flutter'] }))),
    ).rejects.toThrow();
  });

  test('keeps already-fetched jobs and does not throw when a later page fails', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          data: [item(1, recentSec)],
          links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
        });
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const jobs = await collect(new ArbeitnowAdapter().fetch(ctx({ keywords: ['flutter'] })));
    expect(jobs).toHaveLength(1);
  });
});
