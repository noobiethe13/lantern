import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { JobShape } from '../core/job';
import {
  HnHiringAdapter,
  parseHnComment,
  parseHnHeader,
  parseHnSalary,
  parseHnThread,
  parseHnThreadIds,
} from './hn-hiring';

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

function comment(id: number, text: string | null, extra: Record<string, unknown> = {}) {
  return { id, type: 'comment', text, created_at: '2026-10-01T15:02:37.000Z', created_at_i: 1790866957, children: [], ...extra };
}

describe('parseHnSalary', () => {
  test.each([
    ['Sidekick | SWE | $170k to $230k Base + Equity', { min: 170000, max: 230000, currency: 'USD' }],
    ['PAGNOS | Cloud Engineer | €75k–80k | German', { min: 75000, max: 80000, currency: 'EUR' }],
    ['Planlab | PE | 100k-160k GBP + 0.25-0.75% Equity', { min: 100000, max: 160000, currency: 'GBP' }],
    ['Spade | Roles | $130-240K+ (depending)', { min: 130000, max: 240000, currency: 'USD' }],
    ['Mainmatter | REMOTE (EU) | 100–140k€', { min: 100000, max: 140000, currency: 'EUR' }],
    ['X | Y | $120,000 - $150,000 a year', { min: 120000, max: 150000, currency: 'USD' }],
    ['X | Y | CA$90k-120k', { min: 90000, max: 120000, currency: 'CAD' }],
  ])('%s', (line, expected) => {
    expect(parseHnSalary(line)).toEqual(expected);
  });

  test.each([
    'Arrangr | Growth | Fixed-fee project ($12K, milestone-based)',
    'X | Y | 100k-160k + equity',
    'X | Y | 0.5% - 1.5% equity',
    'X | Y | $50-80/hr',
    'X | Y | $50 - $80 per hour',
    'X | Y | $8k-10k per month',
    'X | Y | 2020-2024 founded',
    'X | Y | Competitive salary',
  ])('rejects ambiguous: %s', line => {
    expect(parseHnSalary(line)).toBeNull();
  });
});

describe('parseHnHeader', () => {
  test('canonical order', () => {
    expect(
      parseHnHeader('Acme Corp | Senior Backend Engineer, Data Engineer | Berlin or REMOTE (EU) | Full-time | $150k-$190k | https://acme.com/jobs'),
    ).toEqual({
      company: 'Acme Corp',
      role: 'Senior Backend Engineer, Data Engineer',
      location: 'Berlin or REMOTE (EU)',
      remote: true,
      salary: { min: 150000, max: 190000, currency: 'USD' },
    });
  });

  test('location before role, URL in the company segment, empty segments', () => {
    const h = parseHnHeader('Snout https://snout.com/ | | Remote US or Ontario, Canada | Staff Engineer | Full Time')!;
    expect(h.company).toBe('Snout');
    expect(h.role).toBe('Staff Engineer');
    expect(h.location).toBe('Remote US or Ontario, Canada');
    expect(h.remote).toBe(true);
  });

  test('company with a parenthesised URL and onsite-only location', () => {
    const h = parseHnHeader('Smarkets (https://www.smarkets.com) | Backend Developer | Hybrid - Onsite (London, UK)')!;
    expect(h.company).toBe('Smarkets');
    expect(h.role).toBe('Backend Developer');
    expect(h.remote).toBe(false);
  });

  test('a money segment containing a role word is not the role', () => {
    const h = parseHnHeader('Spade | Multiple Engineering Roles | ONSITE NYC or REMOTE (US/Can) | $130-240K+ (depending on role/level) + equity')!;
    expect(h.role).toBe('Multiple Engineering Roles');
    expect(h.salary?.min).toBe(130000);
  });

  test('falls back to the first lettered leftover segment when no role words, skipping symbol decoration', () => {
    expect(parseHnHeader('Thunder Compute (YC S24) | C++ Systems, Infrastructure, BizOps | San Francisco (Onsite) | https://x.com')!.role).toBe(
      'C++ Systems, Infrastructure, BizOps',
    );
    expect(parseHnHeader('Sudowrite | https://sudowrite.com | √ REMOTE (US) | √ PMF')!.role).toBe('');
  });

  test('"no remote" is not remote; unknown workplace stays undefined', () => {
    expect(parseHnHeader('Acme | Engineer | London | ONSITE, no remote')!.remote).toBe(false);
    expect(parseHnHeader('Acme | Engineer | Full-time')!.remote).toBeUndefined();
  });

  test('strips a trailing parenthetical from the company', () => {
    expect(parseHnHeader('Acme (YC W21) | Backend Engineer | Remote')!.company).toBe('Acme');
    expect(parseHnHeader('Thunder Compute (YC S24) | Backend Engineer | Remote')!.company).toBe('Thunder Compute');
  });

  test('a role segment carrying its location splits them', () => {
    const h = parseHnHeader('Acme | Senior Backend Engineer, Remote (US) | Full-time')!;
    expect(h.role).toBe('Senior Backend Engineer');
    expect(h.location).toBe('Remote (US)');
    expect(h.remote).toBe(true);
    const onsite = parseHnHeader('Acme | Backend Engineer, Data Engineer, ONSITE Berlin')!;
    expect(onsite.role).toBe('Backend Engineer, Data Engineer');
    expect(onsite.location).toBe('ONSITE Berlin');
    expect(onsite.remote).toBe(false);
  });

  test('a leftover like "Fintech" never displaces a real role segment', () => {
    expect(parseHnHeader('Acme | Fintech | Senior Backend Engineer | Remote')!.role).toBe('Senior Backend Engineer');
    expect(parseHnHeader('Acme | Fintech | Remote')!.role).toBe('Fintech');
  });

  test('rejects lines outside the pipe convention', () => {
    expect(parseHnHeader('PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript')).toBeNull();
    expect(parseHnHeader('Acme only')).toBeNull();
    expect(parseHnHeader('https://acme.com | Engineer')).toBeNull();
  });
});

describe('parseHnComment', () => {
  const html =
    'Acme Corp | Senior Backend Engineer | Berlin or REMOTE (EU) | $150k-$190k<p>We build payments with Go.<p>Apply: <a href="https:&#x2F;&#x2F;acme.com&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;acme.com&#x2F;jobs</a>';

  test('maps header + comment metadata, JD is the full plain text, URL is the HN item', () => {
    const job = parseHnComment(comment(101, html), ['backend engineer'])!;
    expect(job).toMatchObject({
      external_id: '101',
      title: 'Senior Backend Engineer',
      url: 'https://news.ycombinator.com/item?id=101',
      company: 'Acme Corp',
      location: 'Berlin or REMOTE (EU)',
      remote: true,
      salary_min_usd: 150000,
      salary_max_usd: 190000,
      salary_currency: 'USD',
      posted_at: 1790866957000,
    });
    expect(job.jd_text).toContain('We build payments with Go.');
    expect(job.jd_text).toContain('https://acme.com/jobs');
    expect(JobShape.safeParse(job).success).toBe(true);
  });

  test('a terse header is admitted via the body but the title is never rewritten', () => {
    const terse = comment(102, 'Acme | Engineers | Remote<p>We are hiring backend engineers to scale our Go services.');
    expect(parseHnComment(terse, ['backend engineers'])!.title).toBe('Engineers');
    const noRole = comment(103, 'Acme | London, UK | Full-time<p>Looking for a backend engineer.');
    expect(parseHnComment(noRole, ['backend engineer'])!.title).toBe('Open roles');
  });

  test('title does not depend on which keyword admitted the post', () => {
    const c = comment(105, 'Acme | Data Engineer | Remote<p>Python and SQL.');
    expect(parseHnComment(c, ['python'])!.title).toBe('Data Engineer');
    expect(parseHnComment(c, ['sql'])!.title).toBe('Data Engineer');
  });

  test('keyword matching is whole-word', () => {
    const c = comment(104, 'Acme | JavaScript Engineer | Remote<p>We use JavaScript.');
    expect(parseHnComment(c, ['java'])).toBeNull();
  });

  test('skips deleted, empty and non-conforming comments', () => {
    expect(parseHnComment(comment(1, null), ['engineer'])).toBeNull();
    expect(parseHnComment(comment(2, '  '), ['engineer'])).toBeNull();
    expect(parseHnComment(comment(3, 'Looking for an engineer<p>no pipes here'), ['engineer'])).toBeNull();
    expect(parseHnComment(comment(4, 'Acme | Designer | Remote'), ['engineer'])).toBeNull();
  });
});

describe('parseHnThread', () => {
  test('only top-level comments are postings; replies are ignored', () => {
    const reply = comment(11, 'Acme | Backend Engineer | Remote');
    const top = comment(10, 'Beta | Backend Engineer | Remote', { children: [reply] });
    const jobs = parseHnThread({ children: [top, comment(12, null)] }, ['backend engineer']);
    expect(jobs.map(j => j.external_id)).toEqual(['10']);
  });

  test('empty keywords or a malformed tree yield nothing', () => {
    expect(parseHnThread({ children: [comment(1, 'A | Engineer | Remote')] }, [])).toEqual([]);
    expect(parseHnThread({}, ['engineer'])).toEqual([]);
  });
});

describe('parseHnThreadIds', () => {
  test('keeps only "Who is hiring?" stories, newest first, limited', () => {
    const hits = [
      { objectID: '3', title: 'Ask HN: Who wants to be hired? (October 2026)' },
      { objectID: '2', title: 'Ask HN: Who is hiring? (October 2026)' },
      { objectID: '1', title: 'Ask HN: Freelancer? Seeking freelancer? (October 2026)' },
      { objectID: '0', title: 'Ask HN: Who is hiring? (September 2026)' },
      { objectID: 'x/../y', title: 'Ask HN: Who is hiring? (bad id)' },
      { objectID: '9', title: 'Ask HN: Who is hiring? (July 2026)' },
    ];
    expect(parseHnThreadIds({ hits })).toEqual(['2', '0']);
    expect(parseHnThreadIds({ hits }, 3)).toEqual(['2', '0', '9']);
    expect(parseHnThreadIds({})).toEqual([]);
  });
});

describe('HnHiringAdapter.fetch', () => {
  const search = {
    hits: [
      { objectID: '200', title: 'Ask HN: Who is hiring? (October 2026)' },
      { objectID: '199', title: 'Ask HN: Who wants to be hired? (October 2026)' },
      { objectID: '100', title: 'Ask HN: Who is hiring? (September 2026)' },
      { objectID: '99', title: 'Ask HN: Who is hiring? (August 2026)' },
    ],
  };
  const threadFor = (n: number) => ({ children: [comment(n, `Co${n} | Backend Engineer | Remote`)] });

  function mockHn(onUrl?: (u: string) => void) {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input);
      onUrl?.(u);
      if (u.includes('/search_by_date')) return jsonResponse(search);
      return jsonResponse(threadFor(Number(u.split('/items/')[1])));
    }) as unknown as typeof fetch;
  }

  test('yields nothing and makes no request when keywords are empty', async () => {
    let calls = 0;
    mockHn(() => calls++);
    expect(await collect(new HnHiringAdapter(0).fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('searches once, then fetches the two newest hiring threads', async () => {
    const urls: string[] = [];
    mockHn(u => urls.push(u));
    const jobs = await collect(new HnHiringAdapter(0).fetch(ctx({ keywords: ['backend engineer'] })));
    expect(urls).toEqual([
      expect.stringContaining('hn.algolia.com/api/v1/search_by_date'),
      'https://hn.algolia.com/api/v1/items/200',
      'https://hn.algolia.com/api/v1/items/100',
    ]);
    expect(jobs.map(j => j.external_id)).toEqual(['200', '100']);
  });

  test('tolerates one failed thread but throws when all fail', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes('/search_by_date')) return jsonResponse(search);
      if (u.endsWith('/200')) return new Response('nf', { status: 404 });
      return jsonResponse(threadFor(100));
    }) as unknown as typeof fetch;
    const jobs = await collect(new HnHiringAdapter(0).fetch(ctx({ keywords: ['backend engineer'] })));
    expect(jobs.map(j => j.external_id)).toEqual(['100']);

    globalThis.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('/search_by_date')) return jsonResponse(search);
      return new Response('nf', { status: 404 });
    }) as unknown as typeof fetch;
    await expect(collect(new HnHiringAdapter(0).fetch(ctx({ keywords: ['backend engineer'] })))).rejects.toThrow();
  });

  test('stops requesting threads once aborted', async () => {
    const ac = new AbortController();
    let threadCalls = 0;
    mockHn(u => {
      if (u.includes('/items/')) threadCalls++;
    });
    const iter = new HnHiringAdapter(0).fetch(ctx({ keywords: ['backend engineer'], abortSignal: ac.signal }));
    for await (const _job of iter) ac.abort();
    expect(threadCalls).toBe(1);
  });
});
