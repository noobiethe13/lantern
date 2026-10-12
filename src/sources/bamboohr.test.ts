import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { BambooHrAdapter, parseBambooList, bambooDetailToJob, bambooListItemToJob } from './bamboohr';

// Shapes captured live (trundl.bamboohr.com, 2026-06-13).
const LIST = {
  meta: { totalCount: 2 },
  result: [
    {
      id: '52',
      jobOpeningName: 'Assistant Manager – Finance',
      departmentLabel: 'Finance',
      location: { city: 'Hyderabad', state: 'Telangana' },
      isRemote: null,
    },
    { id: '53', jobOpeningName: 'Staff Engineer', isRemote: true },
    { id: '', jobOpeningName: 'No Id' },
  ],
};

const DETAIL = {
  meta: {},
  result: {
    jobOpening: {
      jobOpeningShareUrl: 'https://trundl.bamboohr.com/careers/52',
      jobOpeningName: 'Assistant Manager – Finance',
      jobOpeningStatus: 'Open',
      departmentLabel: 'Finance',
      location: { city: 'Hyderabad', state: 'Telangana', addressCountry: 'India' },
      description: '<p>Own the <b>books</b></p>',
      datePosted: '2026-03-02',
      compensation: null,
      isRemote: false,
    },
  },
};

describe('parseBambooList', () => {
  test('enumerates id/title/remote/location, drops entries missing id', () => {
    const items = parseBambooList(LIST);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: '52', title: 'Assistant Manager – Finance', isRemote: false, location: 'Hyderabad, Telangana' });
    expect(items[1].isRemote).toBe(true);
    expect(items[1].location).toBe('Remote');
  });

  test('returns [] for non-array input', () => {
    expect(parseBambooList({})).toEqual([]);
    expect(parseBambooList(null)).toEqual([]);
  });

  test('falls back to atsLocation when location fields are null, and treats locationType "1"/1 as remote', () => {
    // Live shape (bitly): location {city:null,state:null}, atsLocation
    // {country:"United States",...}, locationType 1 (a number on this
    // endpoint, a string "1" on others), isRemote null.
    const json = {
      result: [{
        id: '8', jobOpeningName: 'Support Engineer',
        location: { city: null, state: null },
        atsLocation: { country: 'United States', state: null, city: null },
        isRemote: null,
        locationType: 1,
      }],
    };
    const items = parseBambooList(json);
    expect(items[0].location).toBe('United States, Remote');
    expect(items[0].isRemote).toBe(true);
  });
});

describe('bambooDetailToJob', () => {
  test('builds a Job with jd_text, location, posted_at from detail', () => {
    const job = bambooDetailToJob(DETAIL, 'Trundl', 'trundl', '52')!;
    expect(job).toMatchObject({
      external_id: '52',
      title: 'Assistant Manager – Finance',
      url: 'https://trundl.bamboohr.com/careers/52',
      company: 'Trundl',
      location: 'Hyderabad, Telangana, India',
      remote: false,
    });
    expect(job.jd_text).toBe('Own the books');
    expect(job.posted_at).toBe(Date.parse('2026-03-02'));
  });

  test('appends Remote to location when isRemote', () => {
    const detail = JSON.parse(JSON.stringify(DETAIL));
    detail.result.jobOpening.isRemote = true;
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')!.location).toContain('Remote');
  });

  test('synthesises url when shareUrl absent; null on missing title', () => {
    const detail = JSON.parse(JSON.stringify(DETAIL));
    delete detail.result.jobOpening.jobOpeningShareUrl;
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')!.url).toBe(
      'https://trundl.bamboohr.com/careers/52',
    );
    detail.result.jobOpening.jobOpeningName = '';
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')).toBeNull();
  });

  test('falls back to atsLocation when location fields are null, and locationType "1" implies remote', () => {
    const detail = {
      result: {
        jobOpening: {
          jobOpeningName: 'Support Engineer',
          location: { city: null, state: null, postalCode: null, addressCountry: null },
          atsLocation: { country: 'United States', countryId: '1', state: null, city: null },
          locationType: '1',
          isRemote: undefined,
        },
      },
    };
    const job = bambooDetailToJob(detail, 'Bitly', 'bitly', '8')!;
    expect(job.location).toBe('United States, Remote');
    expect(job.remote).toBe(true);
  });
});

describe('bambooListItemToJob (fallback past detail cap)', () => {
  test('builds a Job with no jd_text', () => {
    const job = bambooListItemToJob({ id: '99', title: 'SRE', isRemote: true, location: 'Remote' }, 'Trundl', 'trundl');
    expect(job).toMatchObject({ external_id: '99', title: 'SRE', remote: true, location: 'Remote' });
    expect(job.url).toBe('https://trundl.bamboohr.com/careers/99');
    expect(job.jd_text).toBeUndefined();
  });
});

describe('BambooHrAdapter — detail-fetch failure handling', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeCtx(): SourceContext {
    return {
      sourceId: 1,
      config: { identifier: 'trundl', display_name: 'Trundl' },
      emitProgress: () => {},
      abortSignal: new AbortController().signal,
    };
  }

  const LIST_RESPONSE = JSON.stringify({
    result: [
      { id: '1', jobOpeningName: 'A' },
      { id: '2', jobOpeningName: 'B' },
    ],
  });

  test('a single detail failure still yields both jobs (degraded fallback), not silently swallowed', async () => {
    let progressMessages: string[] = [];
    let call = 0;
    globalThis.fetch = (async (url: string) => {
      call++;
      if (url.includes('/careers/list')) return new Response(LIST_RESPONSE, { status: 200 });
      if (url.includes('/careers/1/detail')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ result: { jobOpening: { jobOpeningName: 'B', location: {} } } }), { status: 200 });
    }) as unknown as typeof fetch;

    const ctx = makeCtx();
    ctx.emitProgress = (msg: string) => progressMessages.push(msg);
    const jobs: Job[] = [];
    for await (const job of new BambooHrAdapter().fetch(ctx)) jobs.push(job);

    expect(jobs).toHaveLength(2);
    expect(progressMessages.some(m => m.includes('detail fetch failed for job 1'))).toBe(true);
  });

  test('throws when every detail fetch failed while the list had jobs', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('/careers/list')) return new Response(LIST_RESPONSE, { status: 200 });
      return new Response('boom', { status: 500 });
    }) as unknown as typeof fetch;

    async function drain() {
      const jobs: Job[] = [];
      for await (const job of new BambooHrAdapter().fetch(makeCtx())) jobs.push(job);
      return jobs;
    }
    await expect(drain()).rejects.toThrow(/all 2 detail fetches failed/);
  });
});
