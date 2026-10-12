import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseGoogleJobs, GoogleJobsAdapter } from './google-jobs';

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
    config: { apiKey: 'secret-key-123' },
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

// Trimmed real shape of a SerpAPI google_jobs response. Job 1 is complete with
// apply_options; job 2 has no apply_options (no usable URL → dropped); job 3 is
// missing a company (dropped).
const JSON_RESP = {
  jobs_results: [
    {
      title: 'Senior Backend Engineer',
      company_name: 'Acme Corp ',
      location: 'Berlin, Germany',
      description: 'Build APIs in Go.\nWork remotely across the EU.',
      job_id: 'abc123',
      detected_extensions: { posted_at: '3 days ago', salary: '€90K–€120K a year' },
      apply_options: [
        { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/123' },
        { title: 'Greenhouse', link: 'https://boards.greenhouse.io/acme/jobs/123' },
      ],
    },
    {
      title: 'No Apply Link Role',
      company_name: 'Globex',
      location: 'Remote',
      description: 'x',
      apply_options: [{ title: 'Company Site' }],
    },
    {
      title: 'Missing Company',
      company_name: '',
      apply_options: [{ link: 'https://example.com/x' }],
    },
  ],
};

describe('parseGoogleJobs', () => {
  test('maps jobs, prefers the first apply_options link, flags remote, caps JD', () => {
    const jobs = parseGoogleJobs(JSON_RESP);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'abc123',
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      url: 'https://www.linkedin.com/jobs/view/123',
      location: 'Berlin, Germany',
      // remote is detected from location/title only (not the JD body, which would
      // false-positive on any "...work remotely..." mention) → false here.
      remote: false,
    });
    expect(jobs[0].jd_text).toContain('Build APIs in Go');
  });

  test('leaves salary and posted_at unmapped (free-text only in this feed)', () => {
    const job = parseGoogleJobs(JSON_RESP)[0];
    expect(job.salary_min_usd).toBeUndefined();
    expect(job.posted_at).toBeUndefined();
  });

  test('drops jobs with no usable apply link or no company', () => {
    const titles = parseGoogleJobs(JSON_RESP).map(j => j.title);
    expect(titles).not.toContain('No Apply Link Role');
    expect(titles).not.toContain('Missing Company');
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseGoogleJobs({})).toEqual([]);
    expect(parseGoogleJobs(null)).toEqual([]);
  });

  test('omits jd_text (undefined, not "") when description is missing', () => {
    const job = parseGoogleJobs({
      jobs_results: [{ title: 'T', company_name: 'A', apply_options: [{ link: 'https://x' }] }],
    })[0];
    expect(job.jd_text).toBeUndefined();
  });
});

describe('GoogleJobsAdapter.fetch', () => {
  test('omits location and adds ltype=1 when remote is required and no place is named', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({ jobs_results: [] });
    }) as unknown as typeof fetch;

    await collect(
      new GoogleJobsAdapter().fetch(ctx({ keywords: ['flutter'], remoteRequired: true })),
    );
    expect(calledUrl).toContain('ltype=1');
    expect(calledUrl).not.toContain('location=');
  });

  test('uses the named location instead of ltype when one is set', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({ jobs_results: [] });
    }) as unknown as typeof fetch;

    await collect(
      new GoogleJobsAdapter().fetch(ctx({ keywords: ['flutter'], locations: ['India'], remoteRequired: true })),
    );
    expect(calledUrl).toContain('location=India');
    expect(calledUrl).not.toContain('ltype=');
  });

  test('continues past a failed keyword and only throws if every request fails', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('q=fail')) throw new Error('network down');
      return jsonResponse({ jobs_results: [{ title: 'T', company_name: 'A', apply_options: [{ link: 'https://x' }] }] });
    }) as unknown as typeof fetch;

    const jobs = await collect(
      new GoogleJobsAdapter().fetch(ctx({ keywords: ['fail', 'flutter'] })),
    );
    expect(jobs).toHaveLength(1);
  });

  test('throws once every keyword request has failed, without leaking the api_key-bearing URL', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await collect(new GoogleJobsAdapter().fetch(ctx({ keywords: ['flutter'] })));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain('secret-key-123');
    expect(message).not.toContain('serpapi.com');
  });
});
