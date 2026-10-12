import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { WorkdayAdapter, parseWorkday, parseWorkdayPostedOn, resolveWorkdayHost } from './workday';

// Shape captured live (salesforce.wd12.myworkdayjobs.com cxs feed, 2026-06-13).
const PAGE = {
  total: 748,
  jobPostings: [
    {
      title: 'Senior Recruiter',
      externalPath: '/job/California---San-Francisco/Senior-Recruiter_JR337973',
      locationsText: '2 Locations',
      postedOn: 'Posted Today',
      bulletFields: ['JR337973'],
    },
    {
      title: 'Staff SRE (Remote)',
      externalPath: '/job/Canada---Toronto/Staff-SRE_JR345898',
      locationsText: 'Canada - Toronto',
      postedOn: 'Posted 5 Days Ago',
      bulletFields: [],
    },
    { title: '', externalPath: '/job/x_JR1', postedOn: 'Posted Today' }, // dropped: no title
    { title: 'Bad path', externalPath: 'job/no-leading-slash', postedOn: 'Posted Today' }, // dropped
  ],
};

const NOW = Date.parse('2026-06-13T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolveWorkdayHost', () => {
  test('derives host from tenant + dc', () => {
    expect(resolveWorkdayHost({ identifier: 'salesforce', display_name: 'x', site: 's', dc: 'wd12' }))
      .toBe('salesforce.wd12.myworkdayjobs.com');
  });
  test('honors explicit host override', () => {
    expect(resolveWorkdayHost({ identifier: 'sf', display_name: 'x', site: 's', host: 'careers.wd5.myworkdayjobs.com' }))
      .toBe('careers.wd5.myworkdayjobs.com');
  });
  test('rejects a non-Workday host', () => {
    expect(() => resolveWorkdayHost({ identifier: 'evil', display_name: 'x', site: 's', host: 'evil.com' }))
      .toThrow();
  });
});

describe('parseWorkdayPostedOn', () => {
  test('handles today/yesterday/N days/30+ days', () => {
    expect(parseWorkdayPostedOn('Posted Today', NOW)).toBe(NOW);
    expect(parseWorkdayPostedOn('Posted Yesterday', NOW)).toBe(NOW - DAY);
    expect(parseWorkdayPostedOn('Posted 5 Days Ago', NOW)).toBe(NOW - 5 * DAY);
    expect(parseWorkdayPostedOn('Posted 30+ Days Ago', NOW)).toBe(NOW - 30 * DAY);
    expect(parseWorkdayPostedOn('whenever', NOW)).toBeNull();
    expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
  });
});

describe('parseWorkday', () => {
  const jobs = parseWorkday(PAGE, 'salesforce.wd12.myworkdayjobs.com', 'External_Career_Site', 'Salesforce', NOW);

  test('builds public URL from host + site + externalPath, id from bulletFields', () => {
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: 'JR337973',
      title: 'Senior Recruiter',
      url: 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Senior-Recruiter_JR337973',
      company: 'Salesforce',
      // "2 Locations" alone is unmatchable against any allowed location — was
      // stored verbatim (and even flagged remote: false), so L1 dropped every
      // such posting. Now decoded from externalPath, with remote left unknown.
      location: 'California, San Francisco (+1 more)',
    });
    expect(jobs[0].remote).toBeUndefined();
    expect(jobs[0].posted_at).toBe(NOW);
  });

  test('falls back to path segment for id when bulletFields empty; flags remote', () => {
    expect(jobs[1].external_id).toBe('Staff-SRE_JR345898');
    expect(jobs[1].remote).toBe(true);
    expect(jobs[1].posted_at).toBe(NOW - 5 * DAY);
  });

  test('omits jd_text (deferred) so it is not ghost-flagged', () => {
    expect(jobs[0].jd_text).toBeUndefined();
  });

  test('drops postings with no title or a non-absolute externalPath', () => {
    expect(jobs.some(j => j.title === 'Bad path')).toBe(false);
  });

  describe('"N Locations" decoding', () => {
    test('decodes the primary location from externalPath and appends "(+N more)"', () => {
      expect(jobs[0].location).toBe('California, San Francisco (+1 more)');
    });

    test('decodes a larger count correctly (11 Locations -> +10 more)', () => {
      const page = {
        total: 1,
        jobPostings: [{
          title: 'SVP', externalPath: '/job/India---Bangalore/SVP_JR1', locationsText: '11 Locations',
          postedOn: 'Posted Today', bulletFields: ['JR1'],
        }],
      };
      const decoded = parseWorkday(page, 'acme.wd1.myworkdayjobs.com', 'site', 'Acme', NOW)[0];
      expect(decoded.location).toBe('India, Bangalore (+10 more)');
      expect(decoded.remote).toBeUndefined();
    });

    test('falls back to the raw "N Locations" text when externalPath has no decodable segment', () => {
      const page = { total: 1, jobPostings: [{ title: 'X', externalPath: '/job//X_JR1', locationsText: '3 Locations', bulletFields: ['JR1'] }] };
      expect(parseWorkday(page, 'acme.wd1.myworkdayjobs.com', 'site', 'Acme', NOW)[0].location).toBe('3 Locations');
    });
  });
});

describe('WorkdayAdapter pagination', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeCtx(): SourceContext {
    return {
      sourceId: 1,
      config: { identifier: 'acme', display_name: 'Acme', site: 'External_Career_Site', dc: 'wd12' },
      emitProgress: () => {},
      abortSignal: new AbortController().signal,
    };
  }

  function makePage(count: number, startAt: number) {
    return {
      // Workday only reports `total` accurately on page 0 — later pages
      // report 0. This helper mirrors that live behavior via `startAt`.
      total: startAt === 0 ? 45 : 0,
      jobPostings: Array.from({ length: count }, (_, i) => {
        const n = startAt + i;
        return {
          title: `Job ${n}`,
          externalPath: `/job/Remote/Job-${n}_JR${n}`,
          locationsText: 'Remote',
          postedOn: 'Posted Today',
          bulletFields: [`JR${n}`],
        };
      }),
    };
  }

  test('does not stop after page 1 just because later pages report total: 0', async () => {
    // Live bug: offset + PAGE_SIZE >= reported(0) is true on page 1 onward,
    // ending the loop after only 40 of 1,527 postings on a real board. Here:
    // 45 total across pages of 20/20/5 — must fetch all 3 pages.
    const pages = [makePage(20, 0), makePage(20, 20), makePage(5, 40)];
    let call = 0;
    globalThis.fetch = (async () => {
      const page = pages[call] ?? { total: 0, jobPostings: [] };
      call++;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const job of new WorkdayAdapter().fetch(makeCtx())) jobs.push(job);
    expect(jobs).toHaveLength(45);
    expect(call).toBe(3);
  });

  test('stops on a short page even when total was never reported', async () => {
    const pages = [makePage(20, 0), { total: undefined, jobPostings: Array.from({ length: 3 }, (_, i) => ({
      title: `Job ${20 + i}`, externalPath: `/job/Remote/Job-${20 + i}_JR${20 + i}`, locationsText: 'Remote', bulletFields: [`JR${20 + i}`],
    })) }];
    let call = 0;
    globalThis.fetch = (async () => {
      const page = pages[call] ?? { jobPostings: [] };
      call++;
      return new Response(JSON.stringify(page), { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const job of new WorkdayAdapter().fetch(makeCtx())) jobs.push(job);
    expect(jobs).toHaveLength(23);
    expect(call).toBe(2);
  });
});
