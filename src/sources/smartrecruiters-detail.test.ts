import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { SmartRecruitersAdapter } from './smartrecruiters';
import { SmartRecruitersSearchAdapter } from './smartrecruiters-search';
import { parseSmartRecruitersDetail, smartRecruitersRefs } from './smartrecruiters-detail';

// Shape captured live (api.smartrecruiters.com/v1/companies/Wise/postings/<id>, 2026-10-12).
const DETAIL = {
  id: '744000154996699',
  name: 'FinCrime Operations Team Lead - PEP',
  company: { name: 'Wise', identifier: 'Wise' },
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p>Wise moves <strong>money</strong> fast.</p>' },
      jobDescription: { title: 'Job Description', text: '<p>Lead the <b>FinCrime</b> team.</p>' },
      qualifications: { title: 'Qualifications', text: '<ul><li>5y experience</li></ul>' },
      additionalInformation: { title: 'Additional Information', text: '' },
    },
  },
  compensation: { min: 2150000, max: 2950000, currency: 'INR', period: 'YEARLY' },
};

const JOB: Job = {
  external_id: '744000154996699',
  title: 'FinCrime Operations Team Lead - PEP',
  url: 'https://jobs.smartrecruiters.com/Wise/744000154996699',
  company: 'Wise',
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeCtx(messages: string[] = []): SourceContext {
  return {
    sourceId: 1,
    config: { identifier: 'Wise', display_name: 'Wise' },
    emitProgress: (m: string) => messages.push(m),
    abortSignal: new AbortController().signal,
  };
}

describe('parseSmartRecruitersDetail', () => {
  test('orders role sections before the company blurb and skips empty ones', () => {
    expect(parseSmartRecruitersDetail(DETAIL)!.jd_text).toBe('Lead the FinCrime team.\n\n5y experience\n\nWise moves money fast.');
  });

  test('maps a yearly pay range with its currency', () => {
    expect(parseSmartRecruitersDetail(DETAIL)).toMatchObject({
      salary_min_usd: 2150000,
      salary_max_usd: 2950000,
      salary_currency: 'INR',
    });
  });

  test('annualises hourly pay, leaves null, unknown-period, mislabelled or inverted compensation unmapped', () => {
    expect(parseSmartRecruitersDetail({ ...DETAIL, compensation: null })!.salary_currency).toBeUndefined();
    const hourly = { ...DETAIL, compensation: { min: 40, max: 60, currency: 'USD', period: 'HOURLY' } };
    expect(parseSmartRecruitersDetail(hourly)).toMatchObject({ salary_min_usd: 83200, salary_max_usd: 124800, salary_currency: 'USD' });
    const mislabelled = { ...DETAIL, compensation: { min: 90000, max: 120000, currency: 'USD', period: 'HOURLY' } };
    expect(parseSmartRecruitersDetail(mislabelled)!.salary_currency).toBeUndefined();
    const oneOff = { ...DETAIL, compensation: { min: 40, max: 60, currency: 'USD', period: 'ONCE' } };
    expect(parseSmartRecruitersDetail(oneOff)!.salary_currency).toBeUndefined();
    const inverted = { ...DETAIL, compensation: { min: 90, max: 10, currency: 'USD', period: 'YEARLY' } };
    expect(parseSmartRecruitersDetail(inverted)!.salary_currency).toBeUndefined();
  });

  test('returns null without any section text', () => {
    expect(parseSmartRecruitersDetail({ jobAd: { sections: {} } })).toBeNull();
    expect(parseSmartRecruitersDetail(null)).toBeNull();
  });
});

describe('smartRecruitersRefs', () => {
  test('recovers company (with its own casing) and posting id from the public URL', () => {
    expect(smartRecruitersRefs(JOB)).toEqual({ company: 'Wise', postingId: '744000154996699' });
  });

  test('rejects off-host, wrong-shape, traversal and id-mismatch inputs', () => {
    const bad = (url: string, external_id = '744000154996699') => smartRecruitersRefs({ ...JOB, url, external_id });
    expect(bad('https://evil.example/Wise/744000154996699')).toBeNull();
    expect(bad('http://jobs.smartrecruiters.com/Wise/744000154996699')).toBeNull();
    expect(bad('https://jobs.smartrecruiters.com/Wise')).toBeNull();
    expect(bad('https://jobs.smartrecruiters.com/Wise/744000154996699/extra')).toBeNull();
    expect(bad('https://jobs.smartrecruiters.com/Wi%2Fse/744000154996699')).toBeNull();
    expect(bad('https://jobs.smartrecruiters.com/Wise/744000154996699', '999')).toBeNull();
    expect(bad('not a url')).toBeNull();
  });
});

describe.each([
  ['SmartRecruitersAdapter', () => new SmartRecruitersAdapter()],
  ['SmartRecruitersSearchAdapter', () => new SmartRecruitersSearchAdapter()],
])('%s.enrich', (_name, make) => {
  test('fetches the posting detail and returns the JD patch', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(DETAIL), { status: 200 });
    }) as unknown as typeof fetch;
    const patch = await make().enrich!(JOB, makeCtx());
    expect(patch?.jd_text).toContain('Lead the FinCrime team.');
    expect(urls).toEqual(['https://api.smartrecruiters.com/v1/companies/Wise/postings/744000154996699']);
  });

  test('makes no request for a malformed URL', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await make().enrich!({ ...JOB, url: 'https://jobs.smartrecruiters.com/../x/1' }, makeCtx())).toBeNull();
    expect(await make().enrich!({ ...JOB, url: 'https://jobs.smartrecruiters.com/Wise/a b' }, makeCtx())).toBeNull();
    expect(calls).toBe(0);
  });

  test('returns null (not a throw) when the fetch fails', async () => {
    const messages: string[] = [];
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await make().enrich!(JOB, makeCtx(messages))).toBeNull();
    expect(messages.some(m => m.includes('enrich failed'))).toBe(true);
  });
});
