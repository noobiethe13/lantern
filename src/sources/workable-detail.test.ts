import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { WorkableAdapter, parseWorkableDetail } from './workable';

// Shape captured live (apply.workable.com/api/v2/accounts/epignosis/jobs/A206DBCFFE, 2026-10-12).
const DETAIL = {
  shortcode: 'A206DBCFFE',
  title: 'Customer Support Engineer',
  description: '<p>Own <b>customer</b> issues.</p>',
  requirements: '<p>Know HTML:</p><ul> <li>APIs</li></ul>',
  benefits: '<p>Learning budget</p>',
};

const JOB: Job = {
  external_id: 'A206DBCFFE',
  title: 'Customer Support Engineer',
  url: 'https://apply.workable.com/epignosis/j/A206DBCFFE/',
  company: 'Epignosis',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeCtx(messages: string[] = [], identifier = 'epignosis'): SourceContext {
  return {
    sourceId: 1,
    config: { identifier, display_name: 'Epignosis' },
    emitProgress: (m: string) => messages.push(m),
    abortSignal: new AbortController().signal,
  };
}

describe('parseWorkableDetail', () => {
  test('joins description, requirements and benefits in that order', () => {
    expect(parseWorkableDetail(DETAIL)!.jd_text).toBe('Own customer issues.\n\nKnow HTML:\nAPIs\n\nLearning budget');
  });

  test('skips missing parts and returns null when all are empty', () => {
    expect(parseWorkableDetail({ description: '<p>Only this</p>', requirements: null })!.jd_text).toBe('Only this');
    expect(parseWorkableDetail({ description: '', requirements: ' ', benefits: '' })).toBeNull();
    expect(parseWorkableDetail(null)).toBeNull();
  });
});

describe('WorkableAdapter.enrich', () => {
  test('fetches the per-job JSON and returns the JD', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(DETAIL), { status: 200 });
    }) as unknown as typeof fetch;
    const patch = await new WorkableAdapter().enrich(JOB, makeCtx());
    expect(patch?.jd_text).toContain('Own customer issues.');
    expect(urls).toEqual(['https://apply.workable.com/api/v2/accounts/epignosis/jobs/A206DBCFFE']);
  });

  test('makes no request for a malformed shortcode or slug', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new WorkableAdapter();
    expect(await adapter.enrich({ ...JOB, external_id: '../x' }, makeCtx())).toBeNull();
    expect(await adapter.enrich({ ...JOB, external_id: undefined }, makeCtx())).toBeNull();
    expect(await adapter.enrich(JOB, makeCtx([], '../admin'))).toBeNull();
    expect(calls).toBe(0);
  });

  test('returns null (not a throw) when the fetch fails', async () => {
    const messages: string[] = [];
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await new WorkableAdapter().enrich(JOB, makeCtx(messages))).toBeNull();
    expect(messages.some(m => m.includes('enrich failed'))).toBe(true);
  });
});
