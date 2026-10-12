import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseJobicy, JobicyAdapter } from './jobicy';

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

// Trimmed real shape of a Jobicy /api/v2/remote-jobs response. Job 1 is complete;
// job 2 has no url (dropped); job 3 has no title (dropped).
const JSON_RESP = {
  jobs: [
    {
      id: 146762,
      url: 'https://jobicy.com/jobs/146762-principal-devops-engineer',
      jobTitle: 'Principal DevOps Engineer',
      companyName: 'Zartis ',
      jobGeo: 'Europe',
      jobLevel: 'Senior',
      jobDescription: '<div><strong>Build</strong> cloud platforms.</div>',
      pubDate: '2026-06-18T23:31:00Z',
    },
    { id: 2, url: '', jobTitle: 'No URL', companyName: 'X' },
    { id: 3, url: 'https://jobicy.com/jobs/3', jobTitle: '', companyName: 'Y' },
  ],
};

describe('parseJobicy', () => {
  test('maps jobs, flags remote, trims company, extracts JD + posted_at', () => {
    const jobs = parseJobicy(JSON_RESP);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '146762',
      title: 'Principal DevOps Engineer',
      company: 'Zartis',
      url: 'https://jobicy.com/jobs/146762-principal-devops-engineer',
      location: 'Europe',
      remote: true,
    });
    expect(jobs[0].jd_text).toContain('Build cloud platforms');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-06-18T23:31:00Z'));
  });

  test('drops jobs missing a url or title', () => {
    const titles = parseJobicy(JSON_RESP).map(j => j.title);
    expect(titles).not.toContain('No URL');
    expect(parseJobicy(JSON_RESP).some(j => j.external_id === '3')).toBe(false);
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseJobicy({})).toEqual([]);
    expect(parseJobicy(null)).toEqual([]);
  });

  test('maps salary when the period is yearly/annual', () => {
    const json = {
      jobs: [
        {
          id: 1, url: 'https://x/1', jobTitle: 'T', companyName: 'Canonical',
          salaryMin: 48000, salaryMax: 70000, salaryCurrency: 'USD', salaryPeriod: 'yearly',
        },
      ],
    };
    const job = parseJobicy(json)[0];
    expect(job.salary_min_usd).toBe(48000);
    expect(job.salary_max_usd).toBe(70000);
    expect(job.salary_currency).toBe('USD');
  });

  test('does not map salary for a non-annual period', () => {
    const json = {
      jobs: [
        {
          id: 1, url: 'https://x/1', jobTitle: 'T', companyName: 'A',
          salaryMin: 40, salaryMax: 60, salaryCurrency: 'USD', salaryPeriod: 'hourly',
        },
      ],
    };
    const job = parseJobicy(json)[0];
    expect(job.salary_min_usd).toBeNull();
    expect(job.salary_max_usd).toBeNull();
    expect(job.salary_currency).toBeNull();
  });

  test('omits jd_text (undefined, not "") when description is missing', () => {
    const json = { jobs: [{ id: 1, url: 'https://x/1', jobTitle: 'T', companyName: 'A' }] };
    expect(parseJobicy(json)[0].jd_text).toBeUndefined();
  });
});

describe('JobicyAdapter.fetch', () => {
  test('continues past a failed keyword and only throws if every request fails', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('tag=fail')) throw new Error('network down');
      return jsonResponse({ jobs: [{ id: 1, url: 'https://x/1', jobTitle: 'T', companyName: 'A' }] });
    }) as unknown as typeof fetch;

    const jobs = await collect(new JobicyAdapter().fetch(ctx({ keywords: ['fail', 'flutter'] })));
    expect(jobs).toHaveLength(1);
  });

  test('throws once every keyword request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    await expect(
      collect(new JobicyAdapter().fetch(ctx({ keywords: ['flutter'] }))),
    ).rejects.toThrow();
  });
});
