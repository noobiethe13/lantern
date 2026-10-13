import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseHimalayas, HimalayasAdapter } from './himalayas';

// NOTE: the salary fixtures below now set `salaryPeriod` (matching the real
// API shape) because G12 gates salary mapping on an annual/yearly period —
// the old fixtures (no salaryPeriod at all) pinned the pre-fix behavior of
// mapping salary regardless of period, which would incorrectly turn an
// hourly/weekly rate into an implied yearly one.

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

function job(guid: string, title = 'Flutter Developer') {
  return {
    title,
    companyName: 'Acme',
    guid,
    applicationLink: `https://himalayas.app/companies/acme/jobs/${guid}`,
  };
}

describe('parseHimalayas', () => {
  test('maps a posting using applicationLink + guid', () => {
    const json = {
      jobs: [
        {
          title: 'Node.JS Developer',
          companyName: 'Acme',
          guid: 'job-123',
          applicationLink: 'https://himalayas.app/companies/acme/jobs/node-123',
          currency: 'USD',
          minSalary: 120000,
          maxSalary: 160000,
          salaryPeriod: 'annual',
          locationRestrictions: ['United States', 'Canada'],
          pubDate: 1780540143,
          description: '<p>Great <b>role</b></p>',
        },
      ],
    };
    const jobs = parseHimalayas(json);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'job-123',
      title: 'Node.JS Developer',
      url: 'https://himalayas.app/companies/acme/jobs/node-123',
      company: 'Acme',
      location: 'United States, Canada',
      remote: true,
      salary_min_usd: 120000,
      salary_max_usd: 160000,
      jd_text: 'Great role',
    });
    expect(jobs[0].posted_at).toBe(1780540143000);
  });

  test('keeps non-USD salary with its native currency tag', () => {
    const json = {
      jobs: [
        {
          title: 'X',
          companyName: 'A',
          guid: 'g',
          applicationLink: 'https://x',
          currency: 'EUR',
          minSalary: 50000,
          maxSalary: 70000,
          salaryPeriod: 'yearly',
        },
      ],
    };
    const job = parseHimalayas(json)[0];
    expect(job.salary_min_usd).toBe(50000);
    expect(job.salary_max_usd).toBe(70000);
    expect(job.salary_currency).toBe('EUR');
  });

  test('drops entries missing title, applicationLink, or company', () => {
    const json = {
      jobs: [
        { title: '', companyName: 'A', applicationLink: 'https://x' },
        { title: 'T', companyName: 'A', applicationLink: '' },
        { title: 'T', companyName: '', applicationLink: 'https://x' },
      ],
    };
    expect(parseHimalayas(json)).toHaveLength(0);
  });

  test('returns [] for non-array jobs', () => {
    expect(parseHimalayas({})).toEqual([]);
    expect(parseHimalayas(null)).toEqual([]);
  });

  test('annualises an hourly rate instead of reading it as yearly', () => {
    const json = {
      jobs: [
        { ...job('h1'), currency: 'USD', minSalary: 60, maxSalary: 60, salaryPeriod: 'hourly' },
      ],
    };
    const j = parseHimalayas(json)[0];
    expect(j.salary_min_usd).toBe(124800);
    expect(j.salary_max_usd).toBe(124800);
    expect(j.salary_currency).toBe('USD');
  });

  test('drops pay whose period is unknown', () => {
    const json = { jobs: [{ ...job('h2'), currency: 'USD', minSalary: 60, maxSalary: 80, salaryPeriod: 'sprint' }] };
    expect(parseHimalayas(json)[0].salary_currency).toBeNull();
  });

  test('sets location to "Worldwide" when locationRestrictions is an explicit empty array', () => {
    const json = { jobs: [{ ...job('w1'), locationRestrictions: [] }] };
    expect(parseHimalayas(json)[0].location).toBe('Worldwide');
  });

  test('leaves location "" when locationRestrictions is absent (not a confirmed worldwide signal)', () => {
    const json = { jobs: [job('w2')] };
    expect(parseHimalayas(json)[0].location).toBe('');
  });

  test('omits jd_text (undefined, not "") when description is missing', () => {
    const json = { jobs: [job('d1')] };
    expect(parseHimalayas(json)[0].jd_text).toBeUndefined();
  });
});

describe('HimalayasAdapter.fetch', () => {
  test('paginates via &page=N until an empty/short page, dropping the misleading limit param', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (!url.includes('page=')) {
        return jsonResponse({ offset: 0, limit: 20, totalCount: 25, jobs: Array.from({ length: 20 }, (_, i) => job(`p1-${i}`)) });
      }
      if (url.includes('page=2')) {
        return jsonResponse({ offset: 20, limit: 20, totalCount: 25, jobs: Array.from({ length: 5 }, (_, i) => job(`p2-${i}`)) });
      }
      throw new Error(`unexpected url ${url}`);
    }) as unknown as typeof fetch;

    const jobs = await collect(new HimalayasAdapter().fetch(ctx({ keywords: ['flutter'] })));
    expect(jobs).toHaveLength(25); // 20 + 5, stopped once offset+len (25) >= totalCount
    expect(calls.every(u => !u.includes('limit='))).toBe(true);
    expect(calls[0]).not.toContain('page=');
    expect(calls[1]).toContain('page=2');
  });

  test('a mid-list page short of `limit` does not stop pagination early (S-5)', async () => {
    // totalCount 188 with a page intermittently returning 18/20 — offset+limit
    // hasn't reached totalCount yet, so pagination must continue past it instead
    // of treating "short of limit" as "list exhausted".
    globalThis.fetch = (async (url: string) => {
      const m = url.match(/page=(\d+)/);
      const page = m ? Number(m[1]) : 1;
      const offset = (page - 1) * 20;
      const len = page === 1 ? 18 : 20; // page 1 comes back short mid-list
      return jsonResponse({
        offset,
        limit: 20,
        totalCount: 188,
        jobs: Array.from({ length: len }, (_, i) => job(`p${page}-${i}`)),
      });
    }) as unknown as typeof fetch;

    const jobs = await collect(new HimalayasAdapter().fetch(ctx({ keywords: ['flutter'] })));
    // MAX_PAGES (5) caps it before totalCount is ever reached — 18 + 20*4 = 98 —
    // the point is it did NOT stop after the 18-job page 1.
    expect(jobs).toHaveLength(18 + 20 * 4);
  });

  test('appends &country= for a named location, retrying once unscoped on totalCount 0', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('country=')) {
        return jsonResponse({ offset: 0, limit: 20, totalCount: 0, jobs: [] }); // e.g. a city, not recognised
      }
      return jsonResponse({ offset: 0, limit: 20, totalCount: 1, jobs: [job('local')] });
    }) as unknown as typeof fetch;

    const jobs = await collect(
      new HimalayasAdapter().fetch(ctx({ keywords: ['flutter'], locations: ['Springfield'] })),
    );
    expect(jobs).toHaveLength(1);
    expect(calls[0]).toContain('country=Springfield');
    expect(calls[1]).not.toContain('country=');
  });

  test('does not append &country= when no place is named (Himalayas is remote-only already)', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return jsonResponse({ offset: 0, limit: 20, totalCount: 0, jobs: [] });
    }) as unknown as typeof fetch;

    await collect(new HimalayasAdapter().fetch(ctx({ keywords: ['flutter'], remoteRequired: true })));
    expect(calls.every(u => !u.includes('country='))).toBe(true);
  });

  test('continues to the next keyword after one fails, and only throws if every request fails', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('q=fail')) throw new Error('network down');
      return jsonResponse({ offset: 0, limit: 20, totalCount: 1, jobs: [job('ok')] });
    }) as unknown as typeof fetch;

    const jobs = await collect(
      new HimalayasAdapter().fetch(ctx({ keywords: ['fail', 'flutter'] })),
    );
    expect(jobs).toHaveLength(1);
  });

  test('throws once every request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      collect(new HimalayasAdapter().fetch(ctx({ keywords: ['flutter'] }))),
    ).rejects.toThrow();
  });
});
