import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseMuse, categoriesForKeywords, museLocations, TheMuseAdapter } from './themuse';

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

// Trimmed real /api/public/jobs result shape.
function museJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 21820572,
    name: 'Senior Backend Engineer',
    contents: '<p>Build APIs.</p>',
    publication_date: '2026-07-07T18:29:34Z',
    locations: [{ name: 'Flexible / Remote' }, { name: 'Mexico City, Mexico' }],
    categories: [{ name: 'Software Engineering' }],
    refs: { landing_page: 'https://www.themuse.com/jobs/zillow/senior-backend-engineer' },
    company: { id: 1, short_name: 'zillow', name: 'Zillow ' },
    ...overrides,
  };
}

describe('parseMuse', () => {
  test('maps a remote job: url, company, remote flag, location, JD, posted_at', () => {
    const jobs = parseMuse({ results: [museJob()] }, ['backend engineer']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '21820572',
      title: 'Senior Backend Engineer',
      url: 'https://www.themuse.com/jobs/zillow/senior-backend-engineer',
      company: 'Zillow',
      remote: true,
      location: 'Remote, Mexico City, Mexico',
    });
    expect(jobs[0].jd_text).toBe('Build APIs.');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-07-07T18:29:34Z'));
    expect(jobs[0].salary_min_usd).toBeUndefined();
  });

  test('a job with no Flexible / Remote location is not flagged remote', () => {
    const job = museJob({ locations: [{ name: 'Austin, TX' }] });
    const [parsed] = parseMuse({ results: [job] }, ['backend engineer']);
    expect(parsed.remote).toBe(false);
    expect(parsed.location).toBe('Austin, TX');
  });

  test('drops titles that do not whole-word match a keyword', () => {
    const other = museJob({ id: 2, name: 'Sensor Integration Engineer', refs: { landing_page: 'https://www.themuse.com/jobs/x/2' } });
    expect(parseMuse({ results: [museJob(), other] }, ['backend engineer']).map(j => j.external_id)).toEqual(['21820572']);
  });

  test('admits a generic title whose description names a keyword as a whole word', () => {
    const generic = museJob({ name: 'Software Engineer II', contents: '<p>You will build the backend engineer tooling.</p>' });
    expect(parseMuse({ results: [generic] }, ['backend engineer'])).toHaveLength(1);
  });

  test('drops jobs missing url, title or company', () => {
    const results = [museJob({ refs: {} }), museJob({ name: '' }), museJob({ company: {} })];
    expect(parseMuse({ results }, ['backend engineer'])).toEqual([]);
  });

  test('omits jd_text (undefined, not "") when contents is empty', () => {
    expect(parseMuse({ results: [museJob({ contents: '' })] }, ['backend engineer'])[0].jd_text).toBeUndefined();
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseMuse({}, ['x'])).toEqual([]);
    expect(parseMuse(null, ['x'])).toEqual([]);
  });
});

describe('categoriesForKeywords', () => {
  test('maps role keywords to Muse categories, most-hit first, capped at 3', () => {
    expect(categoriesForKeywords(['backend engineer', 'software developer'])[0]).toBe('Software Engineering');
    expect(categoriesForKeywords(['data analyst'])).toContain('Data and Analytics');
    const many = categoriesForKeywords(['software engineer', 'data analyst', 'product manager', 'designer', 'recruiter']);
    expect(many.length).toBeLessThanOrEqual(3);
  });

  test('returns [] when no keyword maps to a category', () => {
    expect(categoriesForKeywords(['bartender'])).toEqual([]);
  });
});

describe('museLocations', () => {
  test('is remote-only when remote is required or no place is in Muse format', () => {
    expect(museLocations({ remoteRequired: true, locations: ['London, United Kingdom'] })).toEqual(['Flexible / Remote']);
    expect(museLocations({ locations: ['India', 'Bangalore', 'Europe'] })).toEqual(['Flexible / Remote']);
  });

  test('adds up to two "City, Country" places after remote when remote is not required', () => {
    expect(museLocations({ locations: ['India', 'London, United Kingdom', 'New York, NY', 'Berlin, Germany'] })).toEqual([
      'Flexible / Remote',
      'London, United Kingdom',
      'New York, NY',
    ]);
  });
});

describe('TheMuseAdapter.fetch', () => {
  test('yields nothing and makes no request when keywords are empty or unmapped', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    expect(await collect(new TheMuseAdapter(0).fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(await collect(new TheMuseAdapter(0).fetch(ctx({ keywords: ['bartender'] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('queries the remote location, pages 0-based, and stops at page_count', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const refs = { landing_page: `https://www.themuse.com/jobs/z/${page}` };
      return jsonResponse({ page, page_count: 2, results: [museJob({ id: page, refs })] });
    }) as unknown as typeof fetch;

    const jobs = await collect(new TheMuseAdapter(0).fetch(ctx({ keywords: ['backend engineer'] })));
    expect(jobs).toHaveLength(2);
    expect(urls).toHaveLength(2);
    const q = new URL(urls[0]).searchParams;
    expect(q.get('category')).toBe('Software Engineering');
    expect(q.get('location')).toBe('Flexible / Remote');
    expect(q.get('page')).toBe('0');
  });

  test('walks every mapped category, and a failed request ends only that category', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      const q = new URL(url).searchParams;
      if (q.get('category') === 'Software Engineering') throw new Error('network down');
      const refs = { landing_page: 'https://www.themuse.com/jobs/z/data' };
      return jsonResponse({ page: 0, page_count: 9, results: [museJob({ name: 'Data Analyst', refs })] });
    }) as unknown as typeof fetch;

    const jobs = await collect(new TheMuseAdapter(0).fetch(ctx({ keywords: ['software engineer', 'data analyst'] })));
    const cats = urls.map(u => new URL(u).searchParams.get('category'));
    expect(new Set(cats)).toEqual(new Set(['Software Engineering', 'Data and Analytics']));
    // failed category: first page only (3 attempts = fetchJson retries), never page 1
    const swePages = urls.filter(u => new URL(u).searchParams.get('category') === 'Software Engineering');
    expect(swePages.every(u => new URL(u).searchParams.get('page') === '0')).toBe(true);
    // healthy category pages on to its page_count cap of 9
    expect(cats.filter(c => c === 'Data and Analytics')).toHaveLength(9);
    expect(jobs).toHaveLength(1);
  });

  test('delays the first page of a later category too, not just later pages', async () => {
    globalThis.fetch = (async () => jsonResponse({ page: 0, page_count: 1, results: [] })) as unknown as typeof fetch;
    const started = Date.now();
    await collect(new TheMuseAdapter(100).fetch(ctx({ keywords: ['software engineer', 'data analyst'] })));
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  test('stops requesting pages once aborted', async () => {
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ page: 0, page_count: 9, results: [museJob()] });
    }) as unknown as typeof fetch;
    const iter = new TheMuseAdapter(0).fetch(ctx({ keywords: ['backend engineer'], abortSignal: ac.signal }));
    for await (const _job of iter) {
      ac.abort();
    }
    expect(calls).toBe(1);
  });

  test('throws once every request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(collect(new TheMuseAdapter(0).fetch(ctx({ keywords: ['backend engineer'] })))).rejects.toThrow();
  });
});
