import { afterEach, describe, expect, test } from 'bun:test';
import type { Job, SourceContext } from '../core/job';
import { HttpStatusError } from '../core/fetch';
import { WorkableAdapter, isWorkableSearchInstructionsPage, parseWorkableMarkdown } from './workable';

// Shape captured live (apply.workable.com/kahoot/jobs.md). The [View] link
// points at a markdown *document* (…/jobs/view/<code>.md, text/markdown),
// not the apply page.
const FEED = `# Acme jobs

| Title | Department | Location | Type | Salary | Posted | Details |
| --- | --- | --- | --- | --- | --- | --- |
| Backend Engineer | Engineering | Berlin | Full-time | — | 2026-09-03 | [View](https://apply.workable.com/acme/jobs/view/ABC123.md) |
| Product Designer | Design | Remote | Full-time | — | 2026-06-01 | [View](https://apply.workable.com/acme/jobs/view/DEF456.md) |
`;

describe('parseWorkableMarkdown', () => {
  test('parses table rows and builds the apply URL from slug + shortcode (not the markdown-document link)', () => {
    const jobs = parseWorkableMarkdown(FEED, 'Acme');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: 'ABC123',
      title: 'Backend Engineer',
      location: 'Berlin',
      company: 'Acme',
      url: 'https://apply.workable.com/acme/j/ABC123/',
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-09-03'));
    expect(jobs[1].title).toBe('Product Designer');
  });

  test('skips the header row', () => {
    const jobs = parseWorkableMarkdown(FEED, 'Acme');
    expect(jobs.some(j => j.title === 'Title')).toBe(false);
  });

  test('drops rows whose [View] URL is off-host or not the /jobs/view/<code>.md shape', () => {
    const offHost = `| Evil Role | Eng | Remote | FT | — | 2026-01-01 | [View](https://evil.com/x.md) |`;
    expect(parseWorkableMarkdown(offHost, 'Acme')).toHaveLength(0);

    const wrongShape = `| Old Role | Eng | Remote | FT | — | 2026-01-01 | [View](https://apply.workable.com/acme/j/ABC123.md) |`;
    expect(parseWorkableMarkdown(wrongShape, 'Acme')).toHaveLength(0);
  });

  test('ignores non-table / non-[View] lines', () => {
    expect(parseWorkableMarkdown('just prose\n\n# heading', 'Acme')).toEqual([]);
  });

  test('returns [] for non-string input', () => {
    expect(parseWorkableMarkdown(undefined as unknown as string, 'Acme')).toEqual([]);
  });

  describe('Salary column parsing', () => {
    test('parses a "CUR min-max" annual range', () => {
      // Live shape: "INR 4,000,000–7,500,000" (en dash).
      const row = `| Technical Architect | Eng | Hyderabad, India | Full-time | INR 4,000,000–7,500,000 | 2026-09-24 | [View](https://apply.workable.com/weekday-1/jobs/view/25F5D44A77.md) |`;
      expect(parseWorkableMarkdown(row, 'Weekday')[0]).toMatchObject({
        salary_min_usd: 4_000_000, salary_max_usd: 7_500_000, salary_currency: 'INR',
      });
    });

    test('nulls when the Salary column is the "—" placeholder', () => {
      expect(parseWorkableMarkdown(FEED, 'Acme')[0]).toMatchObject({
        salary_min_usd: null, salary_max_usd: null, salary_currency: null,
      });
    });
  });
});

describe('isWorkableSearchInstructionsPage', () => {
  test('detects the "too many openings" instructions page', () => {
    const text = '> This company has 718 open positions. Use the search endpoint to filter results.';
    expect(isWorkableSearchInstructionsPage(text)).toBe(true);
  });

  test('is false for a normal job table', () => {
    expect(isWorkableSearchInstructionsPage(FEED)).toBe(false);
  });
});

describe('WorkableAdapter — large-account search fallback', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const INSTRUCTIONS_PAGE = '# Weekday AI\n\n> This company has 718 open positions. Use the search endpoint to filter results.\n';
  const SEARCH_RESULT = `| Title | Department | Location | Type | Salary | Posted | Details |
| --- | --- | --- | --- | --- | --- | --- |
| Flutter Engineer | Eng | Remote | Full-time | — | 2026-09-01 | [View](https://apply.workable.com/weekday-1/jobs/view/AAAAAAAAAA.md) |
`;

  function makeCtx(keywords: string[] | undefined): SourceContext {
    return {
      sourceId: 1,
      config: { identifier: 'weekday-1', display_name: 'Weekday' },
      keywords,
      emitProgress: () => {},
      abortSignal: new AbortController().signal,
    };
  }

  test('retries with ?query=<keyword> (capped at 3, deduped) when the default feed is the instructions page', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('?query=')) return new Response(SEARCH_RESULT, { status: 200 });
      return new Response(INSTRUCTIONS_PAGE, { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const job of new WorkableAdapter().fetch(makeCtx(['flutter', 'backend', 'sre', 'devops']))) jobs.push(job);

    // Same shortcode from every keyword search — deduped to one job.
    expect(jobs).toHaveLength(1);
    expect(jobs[0].external_id).toBe('AAAAAAAAAA');
    // 1 default-feed fetch + at most 3 keyword searches (4th keyword unused).
    expect(calls).toHaveLength(4);
    expect(calls.filter(u => u.includes('?query=')).map(u => decodeURIComponent(u))).toEqual([
      expect.stringContaining('query=flutter'),
      expect.stringContaining('query=backend'),
      expect.stringContaining('query=sre'),
    ]);
  });

  test('throws a clear error when the instructions page is hit with no criteria keywords', async () => {
    globalThis.fetch = (async () => new Response(INSTRUCTIONS_PAGE, { status: 200 })) as unknown as typeof fetch;

    async function drain() {
      const jobs: Job[] = [];
      for await (const job of new WorkableAdapter().fetch(makeCtx(undefined))) jobs.push(job);
      return jobs;
    }
    await expect(drain()).rejects.toThrow(/too large.*search keyword/i);
  });

  test('a failed keyword search does not abort the remaining keyword searches (M-1)', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      if (url.includes('query=flutter')) throw new HttpStatusError(404, null, 'not found');
      if (url.includes('?query=')) return new Response(SEARCH_RESULT, { status: 200 });
      return new Response(INSTRUCTIONS_PAGE, { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const job of new WorkableAdapter().fetch(makeCtx(['flutter', 'backend']))) jobs.push(job);

    expect(jobs).toHaveLength(1); // from the 'backend' search only
    expect(calls.filter(u => u.includes('?query=')).length).toBe(2); // both attempted
  });

  test('throws only once every keyword search has failed', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('?query=')) throw new HttpStatusError(404, null, 'not found');
      return new Response(INSTRUCTIONS_PAGE, { status: 200 });
    }) as unknown as typeof fetch;

    async function drain() {
      const jobs: Job[] = [];
      for await (const job of new WorkableAdapter().fetch(makeCtx(['flutter', 'backend']))) jobs.push(job);
      return jobs;
    }
    await expect(drain()).rejects.toThrow(/all search requests failed/i);
  });
});
