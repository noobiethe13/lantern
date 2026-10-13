import { describe, expect, test } from 'bun:test';
import {
  addUrl,
  blocksForPrefix,
  buildCandidates,
  bulkSource,
  cdxNumPages,
  cdxPageUrls,
  extractSlug,
  listCrawls,
  parseCdxBlock,
  prettifySlug,
  renderDiscoveredFile,
  surtPrefix,
  verifyCandidates,
  workableCompanyName,
  type CdxDeps,
  type SlugCounts,
} from './discover-boards-lib';

describe('extractSlug', () => {
  test('greenhouse: all three hosts, plus the embed widget', () => {
    expect(extractSlug('greenhouse', 'https://boards.greenhouse.io/airbnb/jobs/123')).toBe('airbnb');
    expect(extractSlug('greenhouse', 'https://job-boards.greenhouse.io/Anthropic')).toBe('Anthropic');
    expect(extractSlug('greenhouse', 'https://job-boards.eu.greenhouse.io/mollie')).toBe('mollie');
    expect(extractSlug('greenhouse', 'https://boards.greenhouse.io/embed/job_board?for=stripe')).toBe('stripe');
    expect(extractSlug('greenhouse', 'https://boards.greenhouse.io/embed/job_app?for=stripe')).toBeNull();
    expect(extractSlug('greenhouse', 'https://boards.greenhouse.io/embed/job_board')).toBeNull();
  });

  test('ashby, lever, workable: first path segment, junk and reserved dropped', () => {
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/lakera.ai/abc-123')).toBe('lakera.ai');
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/Ramp')).toBe('Ramp');
    expect(extractSlug('lever', 'https://jobs.lever.co/spotify/uuid/apply')).toBe('spotify');
    expect(extractSlug('workable', 'https://apply.workable.com/huggingface/j/ABC/')).toBe('huggingface');
    expect(extractSlug('workable', 'https://apply.workable.com/api/v1/widget/accounts/x')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/favicon.ico')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/static/app.js')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/robots.txt')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/%2e%2e%2fadmin')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/bad..dots')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/trailing-')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com/' + 'a'.repeat(65))).toBeNull();
  });

  test('wrong host or type never matches', () => {
    expect(extractSlug('lever', 'https://jobs.ashbyhq.com/acme')).toBeNull();
    expect(extractSlug('ashby', 'https://evil.example/jobs.ashbyhq.com/acme')).toBeNull();
    expect(extractSlug('ashby', 'https://jobs.ashbyhq.com.evil.example/acme')).toBeNull();
    expect(extractSlug('ashby', 'ftp://jobs.ashbyhq.com/acme')).toBeNull();
    expect(extractSlug('ashby', 'not a url')).toBeNull();
  });

  test('smartrecruiters: both hosts and the oneclick-ui route', () => {
    expect(extractSlug('smartrecruiters', 'https://jobs.smartrecruiters.com/BoschGroup/743999')).toBe('BoschGroup');
    expect(extractSlug('smartrecruiters', 'https://careers.smartrecruiters.com/Visa')).toBe('Visa');
    expect(extractSlug('smartrecruiters', 'https://jobs.smartrecruiters.com/oneclick-ui/company/Acme/publication/1')).toBe('Acme');
    expect(extractSlug('smartrecruiters', 'https://jobs.smartrecruiters.com/oneclick-ui/other')).toBeNull();
  });

  test('rippling: skips locale segments but not a slug followed by /jobs', () => {
    expect(extractSlug('rippling', 'https://ats.rippling.com/acme/jobs/42')).toBe('acme');
    expect(extractSlug('rippling', 'https://ats.rippling.com/en-GB/acme/jobs')).toBe('acme');
    expect(extractSlug('rippling', 'https://ats.rippling.com/en/acme')).toBe('acme');
    expect(extractSlug('rippling', 'https://ats.rippling.com/ab/jobs/42')).toBe('ab');
    expect(extractSlug('rippling', 'https://ats.rippling.com/en-GB')).toBeNull();
    expect(extractSlug('rippling', 'https://ats.rippling.com/es-419/acme/jobs')).toBe('acme');
    expect(extractSlug('rippling', 'https://ats.rippling.com/es-419')).toBeNull();
    expect(extractSlug('rippling', 'https://ats.rippling.com/pt-BR/acme')).toBe('acme');
  });

  test('subdomain types: one label under the exact suffix, lowercased, reserved dropped', () => {
    expect(extractSlug('recruitee', 'https://Acme.recruitee.com/o/engineer')).toBe('acme');
    expect(extractSlug('recruitee', 'https://www.recruitee.com/')).toBeNull();
    expect(extractSlug('recruitee', 'https://api.recruitee.com/x')).toBeNull();
    expect(extractSlug('recruitee', 'https://a.b.recruitee.com/')).toBeNull();
    expect(extractSlug('recruitee', 'https://recruitee.com/')).toBeNull();
    expect(extractSlug('personio', 'https://acme.jobs.personio.de/job/1')).toBe('acme');
    expect(extractSlug('personio', 'https://acme.jobs.personio.com/')).toBe('acme');
    expect(extractSlug('personio', 'https://acme.personio.de/')).toBeNull();
    expect(extractSlug('breezy', 'https://acme-co.breezy.hr/p/abc')).toBe('acme-co');
    expect(extractSlug('breezy', 'https://app.breezy.hr/')).toBeNull();
    expect(extractSlug('teamtailor', 'https://acme.teamtailor.com/jobs/1-x')).toBe('acme');
    expect(extractSlug('teamtailor', 'https://acme.na.teamtailor.com/jobs')).toBeNull();
    expect(extractSlug('teamtailor', 'https://career.teamtailor.com/')).toBeNull();
    expect(extractSlug('teamtailor', 'https://tt.teamtailor.com/jobs')).toBeNull();
  });
});

describe('candidates', () => {
  test('addUrl folds case variants and counts crawled urls', () => {
    const counts: SlugCounts = {};
    addUrl(counts, 'ashby', 'https://jobs.ashbyhq.com/Ramp/a');
    addUrl(counts, 'ashby', 'https://jobs.ashbyhq.com/Ramp/b');
    addUrl(counts, 'ashby', 'https://jobs.ashbyhq.com/ramp');
    expect(addUrl(counts, 'ashby', 'https://jobs.ashbyhq.com/static/x.js')).toBe(false);
    expect(counts).toEqual({ ramp: { Ramp: 2, ramp: 1 } });
  });

  test('buildCandidates drops seeded boards case-insensitively, keeps the commonest variant, ranks and caps', () => {
    const slugs = {
      ashby: {
        ramp: { Ramp: 2, ramp: 1 },
        seeded: { seeded: 9 },
        big: { big: 50 },
        small: { small: 1 },
      },
      lever: { acme: { acme: 3 } },
    };
    const seeded = new Set(['ashby::seeded']);
    const all = buildCandidates(slugs, seeded, 100);
    expect(all.candidates.map(c => `${c.type}:${c.identifier}`)).toEqual([
      'ashby:big', 'ashby:Ramp', 'ashby:small', 'lever:acme',
    ]);
    expect(all.found).toEqual({ ashby: 3, lever: 1 });

    const capped = buildCandidates(slugs, seeded, 2);
    expect(capped.candidates.filter(c => c.type === 'ashby').map(c => c.identifier)).toEqual(['big', 'Ramp']);
    expect(capped.capped).toEqual({ ashby: 1 });
  });

  test('prettifySlug and workableCompanyName', () => {
    expect(prettifySlug('acme-corp')).toBe('Acme Corp');
    expect(prettifySlug('lakera.ai')).toBe('Lakera Ai');
    expect(prettifySlug('web3-2024')).toBe('Web3 2024');
    expect(workableCompanyName('# Hugging Face — All Open Positions\n\n> x')).toBe('Hugging Face');
    expect(workableCompanyName('no heading here')).toBeUndefined();
  });
});

function fakeFetch(responses: (Response | Error)[]): { deps: CdxDeps; calls: string[]; sleeps: number[] } {
  const calls: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return {
    deps: { fetchImpl, sleep: async ms => void sleeps.push(ms), backoffMs: 10, maxAttempts: 4 },
    calls,
    sleeps,
  };
}

describe('CDX client', () => {
  test('listCrawls keeps well-formed ids in order', async () => {
    const { deps } = fakeFetch([
      new Response(JSON.stringify([{ id: 'CC-MAIN-2026-39' }, { id: 'weird' }, { id: 'CC-MAIN-2026-33' }])),
    ]);
    expect(await listCrawls(deps)).toEqual(['CC-MAIN-2026-39', 'CC-MAIN-2026-33']);
  });

  test('cdxNumPages reads the pages field', async () => {
    const { deps, calls } = fakeFetch([new Response('{"pages": 12, "pageSize": 5, "blocks": 60}\n')]);
    expect(await cdxNumPages(deps, 'CC-MAIN-2026-39', 'jobs.ashbyhq.com/*')).toBe(12);
    expect(calls[0]).toContain('/CC-MAIN-2026-39-index?url=jobs.ashbyhq.com%2F*');
    expect(calls[0]).toContain('showNumPages=true');
  });

  test('retries 503 and network errors with backoff, then succeeds', async () => {
    const { deps, sleeps } = fakeFetch([
      new Response('busy', { status: 503 }),
      new Error('socket closed'),
      new Response('{"pages": 3}'),
    ]);
    expect(await cdxNumPages(deps, 'CC-MAIN-2026-39', 'x.com/*')).toBe(3);
    expect(sleeps).toEqual([10, 20]);
  });

  test('honors Retry-After on 429', async () => {
    const { deps, sleeps } = fakeFetch([
      new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      new Response('{"pages": 1}'),
    ]);
    await cdxNumPages(deps, 'CC-MAIN-2026-39', 'x.com/*');
    expect(sleeps).toEqual([7000]);
  });

  test('a 404 is permanent and gives up after the attempt cap otherwise', async () => {
    const gone = fakeFetch([new Response('nope', { status: 404 })]);
    await expect(cdxNumPages(gone.deps, 'CC-MAIN-1', 'x.com/*')).rejects.toThrow('404');
    expect(gone.calls).toHaveLength(1);

    const down = fakeFetch(Array.from({ length: 4 }, () => new Response('', { status: 503 })));
    await expect(cdxNumPages(down.deps, 'CC-MAIN-1', 'x.com/*')).rejects.toThrow('4 attempts');
  });

  test('refuses a base URL that points at a private host', async () => {
    const { deps } = fakeFetch([]);
    await expect(listCrawls({ ...deps, baseUrl: 'http://127.0.0.1:8080' })).rejects.toThrow('private');
  });

  test('cdxPageUrls parses ndjson and counts malformed lines', async () => {
    const body = ['{"url": "https://a.test/1"}', '', 'garbage{', '{"nourl": 1}', '{"url": "https://a.test/2"}'].join('\n');
    const { deps } = fakeFetch([new Response(body)]);
    expect(await cdxPageUrls(deps, 'CC-MAIN-1', 'a.test/*', 0)).toEqual({
      urls: ['https://a.test/1', 'https://a.test/2'],
      malformed: 2,
    });
  });
});

describe('verifyCandidates', () => {
  test('respects the global and per-type caps, and turns a probe throw into an error result', async () => {
    const candidates = [
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'ashby' as const, identifier: `a${i}`, weight: 1 })),
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'lever' as const, identifier: `l${i}`, weight: 1 })),
    ];
    let inFlight = 0;
    let maxGlobal = 0;
    const perType: Record<string, number> = {};
    const maxPerType: Record<string, number> = {};
    const results = new Map<string, string>();

    await verifyCandidates(
      candidates,
      async c => {
        inFlight++;
        perType[c.type] = (perType[c.type] ?? 0) + 1;
        maxGlobal = Math.max(maxGlobal, inFlight);
        maxPerType[c.type] = Math.max(maxPerType[c.type] ?? 0, perType[c.type]);
        await new Promise(r => setTimeout(r, 5));
        inFlight--;
        perType[c.type]--;
        if (c.identifier === 'a3') throw new Error('boom');
        return { status: 'ok', jobs: 2 };
      },
      (c, r) => void results.set(c.identifier, r.status),
      { concurrency: 5, perType: 2, delayMs: 0, sleep: async () => {} },
    );

    expect(results.size).toBe(12);
    expect(results.get('a3')).toBe('error');
    expect(results.get('l5')).toBe('ok');
    expect(maxGlobal).toBeLessThanOrEqual(5);
    expect(maxPerType['ashby']).toBeLessThanOrEqual(2);
    expect(maxPerType['lever']).toBeLessThanOrEqual(2);
  });

  test('shouldStop halts new probes', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ type: 'ashby' as const, identifier: `a${i}`, weight: 1 }));
    let seen = 0;
    await verifyCandidates(
      candidates,
      async () => ({ status: 'ok', jobs: 1 }),
      () => void seen++,
      { concurrency: 1, perType: 1, delayMs: 0, sleep: async () => {}, shouldStop: () => seen >= 3 },
    );
    expect(seen).toBe(3);
  });
});

describe('renderDiscoveredFile', () => {
  const meta = { crawls: ['CC-MAIN-2026-39'], generated_at: '2026-10-12', candidates: { ashby: 3 }, verified: { ashby: 2 } };
  const board = (type: 'ashby' | 'lever', identifier: string) => ({
    type, identifier, display_name: prettifySlug(identifier), jobs: 7, verified_at: '2026-10-12',
  });

  test('is valid JSON, sorted by type then case-insensitive identifier, one entry per line', () => {
    const text = renderDiscoveredFile(meta, [board('lever', 'zed'), board('ashby', 'beta'), board('ashby', 'Alpha')]);
    const parsed = JSON.parse(text) as { generated: { crawls: string[] }; sources: { identifier: string }[] };
    expect(parsed.generated.crawls).toEqual(['CC-MAIN-2026-39']);
    expect(parsed.sources.map(s => s.identifier)).toEqual(['Alpha', 'beta', 'zed']);
    expect(text.split('\n').filter(l => l.startsWith('    {'))).toHaveLength(3);
  });

  test('entries carry only type, identifier and display_name (no per-run churn)', () => {
    const text = renderDiscoveredFile(meta, [board('ashby', 'one')]);
    const entry = (JSON.parse(text) as { sources: object[] }).sources[0];
    expect(Object.keys(entry)).toEqual(['type', 'identifier', 'display_name']);
    expect(text).not.toContain('verified_at":"2026');
  });

  test('is independent of input order', () => {
    const a = renderDiscoveredFile(meta, [board('ashby', 'one'), board('ashby', 'two')]);
    const b = renderDiscoveredFile(meta, [board('ashby', 'two'), board('ashby', 'one')]);
    expect(a).toBe(b);
  });
});

describe('bulk index reader', () => {
  test('surtPrefix handles host/* and *.domain queries', () => {
    expect(surtPrefix('jobs.ashbyhq.com/*')).toBe('com,ashbyhq,jobs)/');
    expect(surtPrefix('job-boards.eu.greenhouse.io/*')).toBe('io,greenhouse,eu,job-boards)/');
    expect(surtPrefix('*.recruitee.com')).toBe('com,recruitee,');
    expect(surtPrefix('*.jobs.personio.de')).toBe('de,personio,jobs,');
  });

  const cluster = [
    'com,aaa)/ 20260101000000\tcdx-00000.gz\t0\t100\t1',
    'com,ashbyhq,jobs)/acme 20260101000000\tcdx-00000.gz\t100\t100\t2',
    'com,ashbyhq,jobs)/zed 20260101000000\tcdx-00001.gz\t200\t100\t3',
    'com,zzz)/ 20260101000000\tcdx-00001.gz\t300\t100\t4',
  ].join('\n');

  test('blocksForPrefix includes the block that starts before the range, and stops after it', () => {
    expect(blocksForPrefix(cluster, 'com,ashbyhq,jobs)/')).toEqual([
      { file: 'cdx-00000.gz', offset: 0, length: 100 },
      { file: 'cdx-00000.gz', offset: 100, length: 100 },
      { file: 'cdx-00001.gz', offset: 200, length: 100 },
    ]);
  });

  test('blocksForPrefix falls back to the preceding block when the range sits inside one block', () => {
    expect(blocksForPrefix(cluster, 'com,bbb)/')).toEqual([{ file: 'cdx-00001.gz', offset: 200, length: 100 }]);
    expect(blocksForPrefix(cluster, 'aaa,')).toEqual([]);
  });

  test('parseCdxBlock reads the JSON part of surt-prefixed records', () => {
    const text = [
      'com,ashbyhq,jobs)/acme 20260101000000 {"url": "https://jobs.ashbyhq.com/acme", "status": "200"}',
      'com,ashbyhq,jobs)/cut 20260101000000 {"url": "https://jobs.ash',
    ].join('\n');
    expect(parseCdxBlock(text)).toEqual({ urls: ['https://jobs.ashbyhq.com/acme'], malformed: 1 });
  });

  test('bulkSource fetches only the ranged block for a page and gunzips it', async () => {
    const calls: { url: string; range: string | null }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), range: new Headers(init.headers).get('range') });
      return new Response('compressed');
    }) as unknown as typeof fetch;
    const source = bulkSource(
      { fetchImpl, sleep: async () => {} },
      async () => cluster,
      data => {
        expect(new TextDecoder().decode(data)).toBe('compressed');
        return 'com,ashbyhq,jobs)/acme 2026 {"url": "https://jobs.ashbyhq.com/acme"}';
      },
      async () => ['CC-MAIN-2026-39', 'CC-MAIN-2026-34'],
    );
    expect(await source.crawls(1)).toEqual(['CC-MAIN-2026-39']);
    expect(await source.numPages('CC-MAIN-2026-39', 'jobs.ashbyhq.com/*')).toBe(3);
    expect(await source.pageUrls('CC-MAIN-2026-39', 'jobs.ashbyhq.com/*', 1)).toEqual({
      urls: ['https://jobs.ashbyhq.com/acme'],
      malformed: 0,
    });
    expect(calls).toEqual([
      {
        url: 'https://data.commoncrawl.org/cc-index/collections/CC-MAIN-2026-39/indexes/cdx-00000.gz',
        range: 'bytes=100-199',
      },
    ]);
  });
});
