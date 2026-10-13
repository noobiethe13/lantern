import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseWorkingNomads, WorkingNomadsAdapter } from './workingnomads';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

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

// Trimmed real exposed_jobs shape.
const FIXTURE = [
  {
    url: 'https://www.workingnomads.com/job/go/1925654/',
    title: 'Senior Backend Developer (Node.js / Nest.js)',
    description: '<h3><strong>About us:</strong></h3><p>Talent has no borders.</p>',
    company_name: ' Proxify ',
    category_name: 'Development',
    tags: 'back-end,nodejs',
    location: 'Time zone: CET (+/- 3 hours)',
    pub_date: '2026-10-08T12:54:14-04:00',
  },
  {
    url: 'https://www.workingnomads.com/job/go/1925000/',
    title: 'Customer Success Manager',
    description: '<p>Help customers.</p>',
    company_name: 'Acme',
    category_name: 'Customer Success',
    tags: '',
    location: 'Global',
    pub_date: '2026-10-07T10:00:00-04:00',
  },
];

describe('parseWorkingNomads', () => {
  test('maps a matching job: remote, location passthrough, JD, id from URL, posted_at', () => {
    const jobs = parseWorkingNomads(FIXTURE, ['backend developer']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '1925654',
      title: 'Senior Backend Developer (Node.js / Nest.js)',
      url: 'https://www.workingnomads.com/job/go/1925654/',
      company: 'Proxify',
      location: 'Time zone: CET (+/- 3 hours)',
      remote: true,
    });
    expect(jobs[0].jd_text).toContain('Talent has no borders.');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-10-08T12:54:14-04:00'));
  });

  test('filters by whole-word title match, not substring', () => {
    expect(parseWorkingNomads(FIXTURE, ['java'])).toEqual([]);
    expect(parseWorkingNomads(FIXTURE, ['customer success manager'])).toHaveLength(1);
  });

  test('admits a generic title whose description names a keyword as a whole word', () => {
    const generic = { ...FIXTURE[1], title: 'Software Engineer II', description: '<p>Build backend services in Go.</p>' };
    expect(parseWorkingNomads([generic], ['backend'])).toHaveLength(1);
    expect(parseWorkingNomads([generic], ['back'])).toEqual([]);
  });

  test('empty keywords match nothing', () => {
    expect(parseWorkingNomads(FIXTURE, [])).toEqual([]);
  });

  test('drops entries missing url, title or company; omits empty jd_text', () => {
    const rows = [
      { ...FIXTURE[0], url: '' },
      { ...FIXTURE[0], title: '' },
      { ...FIXTURE[0], company_name: '' },
      { ...FIXTURE[0], description: '' },
    ];
    const jobs = parseWorkingNomads(rows, ['backend developer']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jd_text).toBeUndefined();
  });

  test('returns [] for a non-array response', () => {
    expect(parseWorkingNomads({}, ['x'])).toEqual([]);
    expect(parseWorkingNomads(null, ['x'])).toEqual([]);
  });
});

describe('WorkingNomadsAdapter.fetch', () => {
  test('yields nothing and makes no request when keywords are empty', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('[]');
    }) as unknown as typeof fetch;
    expect(await collect(new WorkingNomadsAdapter().fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('fetches the feed once and yields only keyword matches', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify(FIXTURE), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const jobs = await collect(new WorkingNomadsAdapter().fetch(ctx({ keywords: ['backend developer'] })));
    expect(calls).toBe(1);
    expect(jobs.map(j => j.external_id)).toEqual(['1925654']);
  });

  test('propagates a failed request', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(collect(new WorkingNomadsAdapter().fetch(ctx({ keywords: ['backend developer'] })))).rejects.toThrow();
  });
});
