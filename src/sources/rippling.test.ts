import { afterEach, describe, expect, test } from 'bun:test';
import { JobShape } from '../core/job';
import type { Job, SourceContext } from '../core/job';
import { RipplingAdapter, parseRipplingList, ripplingDetailPatch } from './rippling';

const ID_A = '84d388b6-7656-434c-8862-0312eb6b97ac';
const ID_B = '4be1f2a0-1111-4222-8333-444455556666';

// Shapes captured live (ats.rippling.com/api/v2/board/rippling, 2026-10-12): the
// list repeats a job once per location, and the detail carries the HTML body.
const LIST_PAGE = {
  items: [
    {
      id: ID_A,
      name: 'Business Operations Manager',
      url: `https://ats.rippling.com/rippling/jobs/${ID_A}`,
      department: { name: 'Bizops' },
      locations: [{ name: 'New York, NY', country: 'United States', countryCode: 'US', workplaceType: 'ON_SITE' }],
      language: 'en-US',
    },
    {
      id: ID_A,
      name: 'Business Operations Manager',
      url: `https://ats.rippling.com/rippling/jobs/${ID_A}`,
      department: { name: 'Bizops' },
      locations: [{ name: 'San Francisco, CA', country: 'United States', countryCode: 'US', workplaceType: 'ON_SITE' }],
      language: 'en-US',
    },
    {
      id: ID_B,
      name: 'HR Associate',
      url: 'https://elsewhere.example/job',
      department: { name: 'People' },
      locations: [{ name: 'Philippines', country: 'Philippines', countryCode: 'PH', workplaceType: 'REMOTE' }],
    },
    { id: '', name: 'No id' },
  ],
  page: 0,
  pageSize: 100,
  totalItems: 3,
  totalPages: 1,
};

const DETAIL = {
  uuid: ID_A,
  name: 'Business Operations Manager',
  description: {
    company: '<div><h2>About Rippling</h2><p>One place for HR, IT and Finance.</p></div>',
    role: '<div><p>Own <b>strategy</b> and ops</p></div>',
  },
  workLocations: ['San Francisco, CA', 'New York, NY'],
  createdOn: '2026-03-31T17:37:26.093000-07:00',
  payRangeDetails: [{ location: 'US', currency: 'USD', frequency: 'YEAR', rangeStart: 170000, rangeEnd: 250000, isRemote: false }],
};

describe('parseRipplingList', () => {
  test('merges per-location duplicates, keeps on-host url, flags REMOTE locations', () => {
    const { items, totalPages } = parseRipplingList(LIST_PAGE, 'Rippling', 'rippling');
    expect(totalPages).toBe(1);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      external_id: ID_A,
      title: 'Business Operations Manager',
      url: `https://ats.rippling.com/rippling/jobs/${ID_A}`,
      company: 'Rippling',
      location: 'New York, NY; San Francisco, CA',
      remote: false,
    });
    expect(items[0].jd_text).toBeUndefined();
    expect(items[1]).toMatchObject({ location: 'Philippines', remote: true, url: `https://ats.rippling.com/rippling/jobs/${ID_B}` });
  });

  test('tolerates malformed input', () => {
    expect(parseRipplingList(null, 'R', 'rippling')).toEqual({ items: [], totalPages: 1 });
    expect(parseRipplingList({ items: 'x', totalPages: 4 }, 'R', 'rippling')).toEqual({ items: [], totalPages: 4 });
  });

  test('every mapped job satisfies JobShape', () => {
    for (const job of parseRipplingList(LIST_PAGE, 'Rippling', 'rippling').items) expect(JobShape.safeParse(job).success).toBe(true);
  });
});

describe('ripplingDetailPatch', () => {
  test('builds jd_text (role before company), posted_at and an annual salary', () => {
    const patch = ripplingDetailPatch(DETAIL)!;
    expect(patch.jd_text).toBe('Own strategy and ops\n\nAbout Rippling\nOne place for HR, IT and Finance.');
    expect(patch.posted_at).toBe(Date.parse('2026-03-31T17:37:26.093000-07:00'));
    expect(patch).toMatchObject({ salary_min_usd: 170000, salary_max_usd: 250000, salary_currency: 'USD' });
  });

  test('annualises hourly pay, skips mixed-currency or unknown-frequency pay, returns null without a description', () => {
    const hourly = { ...DETAIL, payRangeDetails: [{ currency: 'USD', frequency: 'HOUR', rangeStart: 40, rangeEnd: 60 }] };
    expect(ripplingDetailPatch(hourly)).toMatchObject({ salary_min_usd: 83200, salary_max_usd: 124800, salary_currency: 'USD' });
    const odd = { ...DETAIL, payRangeDetails: [{ currency: 'USD', frequency: 'ONCE', rangeStart: 40, rangeEnd: 60 }] };
    expect(ripplingDetailPatch(odd)!.salary_currency).toBeUndefined();
    const mixed = {
      ...DETAIL,
      payRangeDetails: [
        { currency: 'USD', frequency: 'YEAR', rangeStart: 100000, rangeEnd: 150000 },
        { currency: 'GBP', frequency: 'YEAR', rangeStart: 80000, rangeEnd: 120000 },
      ],
    };
    expect(ripplingDetailPatch(mixed)!.salary_currency).toBeUndefined();
    expect(ripplingDetailPatch({ ...DETAIL, description: {} })).toBeNull();
    expect(ripplingDetailPatch(null)).toBeNull();
  });

  test('spans the lowest and highest yearly bound across same-currency regions', () => {
    const regional = {
      ...DETAIL,
      payRangeDetails: [
        { currency: 'USD', frequency: 'YEAR', rangeStart: 170000, rangeEnd: 250000 },
        { currency: 'USD', frequency: 'YEAR', rangeStart: 150000, rangeEnd: 220000 },
      ],
    };
    expect(ripplingDetailPatch(regional)).toMatchObject({ salary_min_usd: 150000, salary_max_usd: 250000 });
  });
});

describe('RipplingAdapter', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeCtx(messages: string[] = []): SourceContext {
    return {
      sourceId: 1,
      config: { identifier: 'rippling', display_name: 'Rippling' },
      emitProgress: (m: string) => messages.push(m),
      abortSignal: new AbortController().signal,
    };
  }

  test('walks every page, merges a job repeated across pages, and makes no detail requests', async () => {
    const urls: string[] = [];
    const lateLocation = {
      ...LIST_PAGE.items[1],
      locations: [{ name: 'Remote - US', workplaceType: 'REMOTE' }],
    };
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      if (url.includes('/jobs?page=0')) {
        return new Response(JSON.stringify({ ...LIST_PAGE, items: LIST_PAGE.items.slice(0, 2), totalPages: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ...LIST_PAGE, page: 1, items: [lateLocation, LIST_PAGE.items[2]], totalPages: 2 }), { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const j of new RipplingAdapter().fetch(makeCtx())) jobs.push(j);

    expect(jobs.map(j => j.external_id)).toEqual([ID_A, ID_B]);
    expect(jobs[0].location).toBe('New York, NY; San Francisco, CA; Remote - US');
    expect(jobs[0].remote).toBe(true);
    expect(jobs.every(j => j.jd_text === undefined)).toBe(true);
    expect(urls).toHaveLength(2);
    expect(urls.every(u => u.startsWith('https://ats.rippling.com/api/v2/board/rippling/jobs?page='))).toBe(true);
  });

  test('enrich fills the JD for one job and returns null on failure', async () => {
    const job: Job = { external_id: ID_A, title: 'X', url: 'https://ats.rippling.com/rippling/jobs/x', company: 'Rippling' };
    globalThis.fetch = (async () => new Response(JSON.stringify(DETAIL), { status: 200 })) as unknown as typeof fetch;
    const patch = await new RipplingAdapter().enrich(job, makeCtx());
    expect(patch?.jd_text).toContain('Own strategy and ops');
    expect(patch).toMatchObject({ salary_min_usd: 170000, salary_max_usd: 250000, salary_currency: 'USD' });

    const messages: string[] = [];
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await new RipplingAdapter().enrich(job, makeCtx(messages))).toBeNull();
    expect(messages.some(m => m.includes('enrich failed'))).toBe(true);
  });
});
