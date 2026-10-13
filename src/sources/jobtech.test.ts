import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { JobShape } from '../core/job';
import { JobTechAdapter, parseJobTech } from './jobtech';

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

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const ADS = 'https://arbetsformedlingen.se/platsbanken/annonser';

// Trimmed real /search hit shape.
function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: '31574200',
    webpage_url: `${ADS}/31574200`,
    headline: ' Backend Developer ',
    description: { text: 'Uppdrag: Senior Backend Developer', text_formatted: '<p><strong>Uppdrag:</strong> Senior Backend Developer</p>' },
    employer: { name: 'Rasulson Consulting AB', workplace: 'Rasulson Consulting AB' },
    workplace_model: null,
    workplace_address: { municipality: 'Stockholm', region: 'Stockholms län', country: 'Sverige', city: null },
    workplace_addresses: [{ municipality: 'Stockholm', region: 'Stockholms län', country: 'Sverige', city: null }],
    publication_date: '2026-10-09T00:00:00',
    removed: false,
    ...overrides,
  };
}

function page(n: number, startId: number, total = 5000) {
  return {
    total: { value: total },
    hits: Array.from({ length: n }, (_, i) => hit({ id: String(startId + i), webpage_url: `${ADS}/${startId + i}` })),
  };
}

describe('parseJobTech', () => {
  test('maps a hit: location mapped to Sweden, JD from formatted text, no salary', () => {
    const jobs = parseJobTech({ hits: [hit()] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '31574200',
      title: 'Backend Developer',
      url: `${ADS}/31574200`,
      company: 'Rasulson Consulting AB',
      location: 'Stockholm, Sweden',
      posted_at: Date.parse('2026-10-09T00:00:00Z'),
    });
    expect(jobs[0].remote).toBeUndefined();
    expect(jobs[0].salary_min_usd).toBeUndefined();
    expect(jobs[0].jd_text).toBe('Uppdrag: Senior Backend Developer');
    expect(JobShape.safeParse(jobs[0]).success).toBe(true);
  });

  test('workplace_model maps to the remote flag only when stated', () => {
    const remote = hit({ workplace_model: { label: 'Distansarbete' } });
    const onsite = hit({ workplace_model: { label: 'Arbete på plats' } });
    expect(parseJobTech({ hits: [remote] })[0].remote).toBe(true);
    expect(parseJobTech({ hits: [onsite] })[0].remote).toBe(false);
  });

  test('lists up to three distinct municipalities; no address falls back to Sweden', () => {
    const addr = (m: string) => ({ municipality: m, country: 'Sverige' });
    const many = hit({ workplace_addresses: [addr('Stockholm'), addr('Solna'), addr('Stockholm'), addr('Uppsala'), addr('Lund')] });
    expect(parseJobTech({ hits: [many] })[0].location).toBe('Stockholm, Solna, Uppsala, Sweden');
    const none = hit({ workplace_address: null, workplace_addresses: [] });
    expect(parseJobTech({ hits: [none] })[0].location).toBe('Sweden');
  });

  test('falls back to an id-derived URL and employer.workplace, and omits empty jd_text', () => {
    const j = parseJobTech({
      hits: [hit({ webpage_url: null, employer: { name: null, workplace: 'Acme' }, description: { text: '' } })],
    })[0];
    expect(j.url).toBe(`${ADS}/31574200`);
    expect(j.company).toBe('Acme');
    expect(j.jd_text).toBeUndefined();
  });

  test('a non-https webpage_url is replaced by the id-derived URL', () => {
    for (const bad of ['http://arbetsformedlingen.se/x', 'javascript:alert(1)']) {
      expect(parseJobTech({ hits: [hit({ webpage_url: bad })] })[0].url).toBe(`${ADS}/31574200`);
    }
  });

  test('skips removed ads and entries missing title or company', () => {
    const hits = [hit({ removed: true }), hit({ headline: '' }), hit({ employer: {} }), hit({ id: '2' })];
    expect(parseJobTech({ hits }).map(j => j.external_id)).toEqual(['2']);
  });

  test('returns [] for a malformed response', () => {
    expect(parseJobTech({})).toEqual([]);
    expect(parseJobTech(null)).toEqual([]);
  });
});

describe('JobTechAdapter.fetch', () => {
  test('yields nothing and makes no request when keywords are empty', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse({ hits: [] });
    }) as unknown as typeof fetch;
    expect(await collect(new JobTechAdapter(0).fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('queries by keyword, does not prefilter on title (rescue candidates) and dedupes by URL', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return jsonResponse({
        total: { value: 3 },
        hits: [hit(), hit({ id: '9', webpage_url: `${ADS}/9`, headline: 'Sjuksköterska' }), hit()],
      });
    }) as unknown as typeof fetch;
    const jobs = await collect(new JobTechAdapter(0).fetch(ctx({ keywords: ['backend developer'] })));
    expect(jobs.map(j => j.external_id)).toEqual(['31574200', '9']);
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]!);
    expect(u.host).toBe('jobsearch.api.jobtechdev.se');
    expect(u.searchParams.get('q')).toBe('backend developer');
    expect(u.searchParams.get('limit')).toBe('100');
  });

  test('paginates by offset while pages are full, bounded to 3 pages', async () => {
    const offsets: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      offsets.push(new URL(String(input)).searchParams.get('offset')!);
      return jsonResponse(page(100, offsets.length * 1000));
    }) as unknown as typeof fetch;
    const jobs = await collect(new JobTechAdapter(0).fetch(ctx({ keywords: ['backend developer'] })));
    expect(offsets).toEqual(['0', '100', '200']);
    expect(jobs).toHaveLength(300);
  });

  test('stops requesting once aborted', async () => {
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return jsonResponse(page(100, 0));
    }) as unknown as typeof fetch;
    const iter = new JobTechAdapter(0).fetch(ctx({ keywords: ['backend developer'], abortSignal: ac.signal }));
    for await (const _job of iter) ac.abort();
    expect(calls).toBe(1);
  });

  test('throws once every request has failed', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(collect(new JobTechAdapter(0).fetch(ctx({ keywords: ['backend developer'] })))).rejects.toThrow();
  });
});
