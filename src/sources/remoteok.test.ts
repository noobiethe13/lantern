import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseRemoteOk, RemoteOkAdapter } from './remoteok';

const legalNotice = { last_updated: '2026-06-04', legal: 'See remoteok.com/terms' };

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

describe('parseRemoteOk', () => {
  test('skips the legal-notice element and keyword-filters the rest', () => {
    const json = [
      legalNotice,
      {
        id: '1132813',
        position: 'Senior Node Developer',
        company: 'Eastern Airlines',
        tags: ['node', 'backend'],
        location: 'Worldwide',
        url: 'https://remoteOK.com/remote-jobs/node-1132813',
        epoch: 1780540143,
        salary_min: 100000,
        salary_max: 150000,
        description: '<p>Join <b>us</b></p>',
      },
      {
        id: '2',
        position: 'Marketing Lead',
        company: 'Acme',
        tags: ['marketing'],
        url: 'https://remoteOK.com/remote-jobs/mkt-2',
      },
    ];
    const jobs = parseRemoteOk(json, ['node']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '1132813',
      title: 'Senior Node Developer',
      company: 'Eastern Airlines',
      url: 'https://remoteOK.com/remote-jobs/node-1132813',
      remote: true,
      salary_min_usd: 100000,
      salary_max_usd: 150000,
      jd_text: 'Join us',
    });
    expect(jobs[0].posted_at).toBe(1780540143000);
  });

  test('matches keyword in tags even when title does not contain it', () => {
    const json = [
      legalNotice,
      { id: '3', position: 'Backend Engineer', company: 'A', tags: ['NodeJS'], url: 'https://x' },
    ];
    expect(parseRemoteOk(json, ['node'])).toHaveLength(1);
  });

  test('empty keywords matches nothing', () => {
    const json = [legalNotice, { id: '4', position: 'Node Dev', company: 'A', url: 'https://x' }];
    expect(parseRemoteOk(json, [])).toHaveLength(0);
  });

  test('returns [] for non-array input', () => {
    expect(parseRemoteOk({}, ['node'])).toEqual([]);
    expect(parseRemoteOk(null, ['node'])).toEqual([]);
  });

  test('decodes HTML entities in title and company', () => {
    const json = [
      legalNotice,
      {
        id: '5',
        position: 'Node &amp; Go Developer',
        company: 'Transportation Partners &amp; Logistics',
        tags: ['node'],
        url: 'https://x',
      },
    ];
    const job = parseRemoteOk(json, ['node'])[0];
    expect(job.title).toBe('Node & Go Developer');
    expect(job.company).toBe('Transportation Partners & Logistics');
  });

  test('omits jd_text (undefined, not "") when description is missing', () => {
    const json = [legalNotice, { id: '6', position: 'Node Dev', company: 'A', tags: ['node'], url: 'https://x' }];
    expect(parseRemoteOk(json, ['node'])[0].jd_text).toBeUndefined();
  });
});

describe('RemoteOkAdapter.fetch', () => {
  test('fetches the main feed plus a tag-scoped request per single-word keyword, merged by id', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('tag=flutter')) {
        return jsonResponse([legalNotice, { id: '10', position: 'Flutter Dev', company: 'A', tags: ['flutter'], url: 'https://x/10' }]);
      }
      // main feed: one job that also matches, one that doesn't
      return jsonResponse([
        legalNotice,
        { id: '10', position: 'Flutter Dev', company: 'A', tags: ['flutter'], url: 'https://x/10' },
        { id: '11', position: 'Backend Engineer', company: 'B', tags: ['node'], url: 'https://x/11' },
      ]);
    }) as unknown as typeof fetch;

    const adapter = new RemoteOkAdapter();
    const jobs = await collect(adapter.fetch(ctx({ keywords: ['flutter'] })));
    expect(jobs.map(j => j.external_id).sort()).toEqual(['10']); // "Backend Engineer" doesn't match "flutter"
    expect(calls.some(u => u === 'https://remoteok.com/api')).toBe(true);
    expect(calls.some(u => u.includes('tag=flutter'))).toBe(true);
  });

  test('does not issue a tag request for multi-word keywords', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return jsonResponse([legalNotice]);
    }) as unknown as typeof fetch;

    const adapter = new RemoteOkAdapter();
    await collect(adapter.fetch(ctx({ keywords: ['senior backend'] })));
    expect(calls).toEqual(['https://remoteok.com/api']); // only the main feed, no tag= request
  });

  test('continues past a failed request and only throws if every request fails', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 1) throw new Error('network down'); // main feed fails
      return jsonResponse([legalNotice, { id: '20', position: 'Flutter Dev', company: 'A', tags: ['flutter'], url: 'https://x/20' }]);
    }) as unknown as typeof fetch;

    const adapter = new RemoteOkAdapter();
    const jobs = await collect(adapter.fetch(ctx({ keywords: ['flutter'] })));
    expect(jobs).toHaveLength(1); // the tag request still succeeded
  });

  test('throws once every request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const adapter = new RemoteOkAdapter();
    // Multi-word keyword → only the main feed is requested (no tag= request),
    // keeping this test's retry backoff to a single request.
    await expect(collect(adapter.fetch(ctx({ keywords: ['senior backend'] })))).rejects.toThrow();
  });
});
