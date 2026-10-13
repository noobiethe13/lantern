import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseSmartRecruitersSearch, SmartRecruitersSearchAdapter } from './smartrecruiters-search';

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

// Trimmed real /sr-jobs/search shapes.
const ONSITE = {
  id: '744000154984287',
  name: 'Backend Engineer',
  company: { identifier: 'Wise', name: 'Wise' },
  releasedDate: '2026-10-12T10:41:27.898Z',
  location: { city: 'London', country: 'gb', remote: false, hybrid: false },
  shortLocation: 'London, United Kingdom',
};
const REMOTE = {
  id: '744000154936638',
  name: 'Senior Frontend Software Engineer',
  company: { identifier: 'ACCESA', name: 'Accesa' },
  releasedDate: '2026-10-12T07:18:29.761Z',
  location: { city: 'Employees can work remotely', country: 'ro', remote: true, hybrid: false },
  shortLocation: 'Employees can work remotely, Romania',
};
const HYBRID = {
  id: '3',
  name: 'Backend Engineer',
  company: { identifier: 'TOPdesk', name: 'TOPdesk' },
  location: { city: 'Delft', country: 'nl', remote: false, hybrid: true },
  shortLocation: 'Delft, Netherlands',
};

describe('parseSmartRecruitersSearch', () => {
  test('builds the public posting URL without a /postings/ segment', () => {
    const [job] = parseSmartRecruitersSearch({ content: [ONSITE] });
    expect(job).toMatchObject({
      external_id: '744000154984287',
      url: 'https://jobs.smartrecruiters.com/Wise/744000154984287',
      company: 'Wise',
      title: 'Backend Engineer',
      location: 'London, United Kingdom',
      remote: false,
    });
    expect(job.posted_at).toBe(Date.parse('2026-10-12T10:41:27.898Z'));
  });

  test('omits jd_text entirely (never an empty string)', () => {
    const [job] = parseSmartRecruitersSearch({ content: [ONSITE] });
    expect('jd_text' in job).toBe(false);
  });

  test('flags remote and strips the "Employees can work remotely" placeholder city', () => {
    const [job] = parseSmartRecruitersSearch({ content: [REMOTE] });
    expect(job.remote).toBe(true);
    expect(job.location).toBe('Remote, Romania');
  });

  test('surfaces hybrid in the location text for L1', () => {
    const [job] = parseSmartRecruitersSearch({ content: [HYBRID] });
    expect(job.remote).toBe(false);
    expect(job.location).toBe('Hybrid, Delft, Netherlands');
  });

  test('drops postings missing id, title or company identifier', () => {
    const content = [{ ...ONSITE, id: '' }, { ...ONSITE, name: '' }, { ...ONSITE, company: {} }];
    expect(parseSmartRecruitersSearch({ content })).toEqual([]);
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseSmartRecruitersSearch({})).toEqual([]);
    expect(parseSmartRecruitersSearch(null)).toEqual([]);
  });
});

describe('SmartRecruitersSearchAdapter.fetch', () => {
  test('yields nothing and makes no request when keywords are empty', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ content: [] });
    }) as unknown as typeof fetch;
    expect(await collect(new SmartRecruitersSearchAdapter().fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('sends the keyword as a quoted phrase, and locationType=remote only when remote is required', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return jsonResponse({ content: [ONSITE] });
    }) as unknown as typeof fetch;

    await collect(new SmartRecruitersSearchAdapter().fetch(ctx({ keywords: ['backend engineer'] })));
    await collect(new SmartRecruitersSearchAdapter().fetch(ctx({ keywords: ['backend engineer'], remoteRequired: true })));
    expect(new URL(urls[0]).searchParams.get('keyword')).toBe('"backend engineer"');
    expect(new URL(urls[0]).searchParams.has('locationType')).toBe(false);
    expect(new URL(urls[1]).searchParams.get('locationType')).toBe('remote');
  });

  test('continues past a failed keyword and dedupes the rest', async () => {
    globalThis.fetch = (async (url: string) => {
      if (decodeURIComponent(url).includes('"fail"')) throw new Error('network down');
      return jsonResponse({ content: [ONSITE] });
    }) as unknown as typeof fetch;
    const jobs = await collect(new SmartRecruitersSearchAdapter().fetch(ctx({ keywords: ['fail', 'flutter', 'dart'] })));
    expect(jobs).toHaveLength(1);
  });

  test('throws once every keyword request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(
      collect(new SmartRecruitersSearchAdapter().fetch(ctx({ keywords: ['flutter'] }))),
    ).rejects.toThrow();
  });
});
