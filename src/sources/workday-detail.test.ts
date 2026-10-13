import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { WorkdayAdapter, parseWorkdayDetail, workdayExternalPath } from './workday';

// Shape captured live (salesforce.wd12.myworkdayjobs.com/wday/cxs/.../job/..., 2026-10-12).
const DETAIL = {
  jobPostingInfo: {
    title: 'Named Account Executive',
    jobDescription: '<p style="text-align:left">Sell <b>things</b> daily.</p><ul><li>Quota</li></ul>',
    location: 'India - Gurgaon',
    startDate: '2026-10-12',
    timeType: 'Full time',
  },
};

const HOST = 'acme.wd12.myworkdayjobs.com';
const SITE = 'External_Career_Site';
const JOB: Job = {
  external_id: 'JR357373',
  title: 'Named Account Executive',
  url: `https://${HOST}/${SITE}/job/India---Gurgaon/Account-Exec_JR357373`,
  company: 'Acme',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeCtx(messages: string[] = []): SourceContext {
  return {
    sourceId: 1,
    config: { identifier: 'acme', display_name: 'Acme', site: SITE, dc: 'wd12' },
    emitProgress: (m: string) => messages.push(m),
    abortSignal: new AbortController().signal,
  };
}

describe('workdayExternalPath', () => {
  const url = (path: string) => `https://${HOST}/${SITE}${path}`;

  test('recovers the externalPath from the stored job URL', () => {
    expect(workdayExternalPath(JOB.url, HOST, SITE)).toBe('/job/India---Gurgaon/Account-Exec_JR357373');
  });

  test('rejects another host, another site, traversal and encoded escapes', () => {
    expect(workdayExternalPath(`https://evil.example/${SITE}/job/x/y`, HOST, SITE)).toBeNull();
    expect(workdayExternalPath(`https://${HOST}/Other/job/x/y`, HOST, SITE)).toBeNull();
    expect(workdayExternalPath(`http://${HOST}/${SITE}/job/x/y`, HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/../../other'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x%2Fy/z'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x/..%5c..'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x/%252e%252e/y'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x%00/y'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x%3Fy/z'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job/x%0a/z'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath(url('/job'), HOST, SITE)).toBeNull();
    expect(workdayExternalPath('not a url', HOST, SITE)).toBeNull();
  });
});

describe('parseWorkdayDetail', () => {
  test('extracts jobDescription as plain text and nothing else', () => {
    expect(parseWorkdayDetail(DETAIL)).toEqual({ jd_text: 'Sell things daily.\nQuota' });
  });

  test('returns null for an empty or missing body', () => {
    expect(parseWorkdayDetail({ jobPostingInfo: { jobDescription: '' } })).toBeNull();
    expect(parseWorkdayDetail({})).toBeNull();
    expect(parseWorkdayDetail(null)).toBeNull();
  });
});

describe('WorkdayAdapter.enrich', () => {
  test('GETs the cxs detail on the tenant host and returns the JD', async () => {
    const calls: { url: string; method?: string }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(JSON.stringify(DETAIL), { status: 200 });
    }) as unknown as typeof fetch;
    const patch = await new WorkdayAdapter().enrich(JOB, makeCtx());
    expect(patch?.jd_text).toContain('Sell things daily.');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://${HOST}/wday/cxs/acme/${SITE}/job/India---Gurgaon/Account-Exec_JR357373`);
    expect(calls[0].method ?? 'GET').toBe('GET');
  });

  test('makes no request for an off-host or traversal URL', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new WorkdayAdapter();
    expect(await adapter.enrich({ ...JOB, url: `https://evil.example/${SITE}/job/x/y` }, makeCtx())).toBeNull();
    expect(await adapter.enrich({ ...JOB, url: `https://${HOST}/${SITE}/job/../../other` }, makeCtx())).toBeNull();
    expect(calls).toBe(0);
  });

  test('returns null (not a throw) when the fetch fails', async () => {
    const messages: string[] = [];
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await new WorkdayAdapter().enrich(JOB, makeCtx(messages))).toBeNull();
    expect(messages.some(m => m.includes('enrich failed'))).toBe(true);
  });
});
