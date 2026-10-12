import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseLinkedIn, parseLinkedInDetail, LinkedInAdapter } from './linkedin';
import { HttpStatusError } from '../core/fetch';

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

// Trimmed real shape from a guest search for keywords=flutter&location=india.
// Card 2's metro-area label ("Mumbai Metropolitan Region") happens to already
// resolve via the gazetteer (core/geo.ts) — only a card the gazetteer cannot
// resolve at all should ever get the searched location appended (S-6).
const INDIA_HTML = `
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:1">
    <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-1"></a>
    <h3 class="base-search-card__title">Backend Engineer</h3>
    <h4 class="base-search-card__subtitle"><a href="y">Acme</a></h4>
    <span class="job-search-card__location">Bengaluru, Karnataka, India</span>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:2">
    <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-2"></a>
    <h3 class="base-search-card__title">Mobile Engineer</h3>
    <h4 class="base-search-card__subtitle"><a href="y">Globex</a></h4>
    <span class="job-search-card__location">Mumbai Metropolitan Region</span>
  </div>
</li>`;

// A single card whose location the gazetteer cannot resolve to any place at
// all — the only shape S-6 still appends the searched location to.
const UNRESOLVED_METRO_HTML = `
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:3">
    <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/x-3"></a>
    <h3 class="base-search-card__title">Platform Engineer</h3>
    <h4 class="base-search-card__subtitle"><a href="y">Initech</a></h4>
    <span class="job-search-card__location">Greater Nowhereville Area</span>
  </div>
</li>`;

// Trimmed real shape from the guest `seeMoreJobPostings/search` fragment: a
// `<ul>` of `<li>` cards. Card 1 is complete; card 2 uses the `--new` listdate
// variant and a remote/location signal; card 3 is missing a title (dropped).
const HTML = `
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4426342261">
    <a class="base-card__full-link" href="https://pl.linkedin.com/jobs/view/backend-developer-at-acme-4426342261?position=1&refId=abc&trackingId=xyz">
      <span class="sr-only">Backend Developer</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Backend Developer (Python)</h3>
      <h4 class="base-search-card__subtitle">
        <a class="hidden-nested-link" href="https://de.linkedin.com/company/acme">Acme GmbH</a>
      </h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">Poland</span>
        <time class="job-search-card__listdate" datetime="2026-06-09">3 days ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:4426353014">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/staff-sre-remote-at-globex-4426353014?trk=public_jobs">
      <span class="sr-only">Staff SRE</span>
    </a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title">Staff SRE — Remote</h3>
      <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="x">Globex</a></h4>
      <div class="base-search-card__metadata">
        <span class="job-search-card__location">European Union</span>
        <time class="job-search-card__listdate--new" datetime="2026-06-12">1 day ago</time>
      </div>
    </div>
  </div>
</li>
<li>
  <div class="base-card base-search-card job-search-card" data-entity-urn="urn:li:jobPosting:999">
    <a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/x-999"></a>
    <div class="base-search-card__info">
      <h3 class="base-search-card__title"></h3>
      <h4 class="base-search-card__subtitle"><a href="y">Initech</a></h4>
    </div>
  </div>
</li>`;

describe('parseLinkedIn', () => {
  test('parses cards, strips tracking params, derives id from urn', () => {
    const jobs = parseLinkedIn(HTML);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: '4426342261',
      title: 'Backend Developer (Python)',
      url: 'https://pl.linkedin.com/jobs/view/backend-developer-at-acme-4426342261',
      company: 'Acme GmbH',
      location: 'Poland',
      remote: false,
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-06-09'));
  });

  test('handles the --new listdate variant and flags remote from title', () => {
    const job = parseLinkedIn(HTML)[1];
    expect(job).toMatchObject({ external_id: '4426353014', remote: true });
    expect(job.posted_at).toBe(Date.parse('2026-06-12'));
  });

  test('omits jd_text entirely (null in DB, not a ghost flag)', () => {
    expect(parseLinkedIn(HTML)[0].jd_text).toBeUndefined();
  });

  test('drops cards missing a title', () => {
    expect(parseLinkedIn(HTML).some(j => j.external_id === '999')).toBe(false);
  });

  test('returns [] for empty input', () => {
    expect(parseLinkedIn('')).toEqual([]);
  });

  test('leaves a location alone when it already contains the searched place', () => {
    const job = parseLinkedIn(INDIA_HTML, 'india')[0];
    expect(job.location).toBe('Bengaluru, Karnataka, India');
  });

  test('does not append when the card location already resolves to a place via the gazetteer (S-6)', () => {
    // "Mumbai Metropolitan Region" doesn't literally contain "india", but
    // core/geo.ts placesIn() already resolves it to India — it already names a
    // place, so it must never be appended to.
    const job = parseLinkedIn(INDIA_HTML, 'india')[1];
    expect(job.location).toBe('Mumbai Metropolitan Region');
  });

  test('appends the searched place to a metro-area location the gazetteer cannot resolve at all', () => {
    const job = parseLinkedIn(UNRESOLVED_METRO_HTML, 'india')[0];
    expect(job.location).toBe('Greater Nowhereville Area, india');
  });

  test('does not augment location when no location was searched', () => {
    const job = parseLinkedIn(INDIA_HTML)[1];
    expect(job.location).toBe('Mumbai Metropolitan Region');
  });
});

describe('parseLinkedInDetail', () => {
  test('extracts JD text from show-more-less-html__markup', () => {
    const html = `
      <section class="show-more-less-html">
        <div class="show-more-less-html__markup">
          <p>We are hiring a <strong>Backend Engineer</strong>.</p>
          <ul><li>Python</li><li>PostgreSQL</li></ul>
        </div>
      </section>`;
    const jd = parseLinkedInDetail(html);
    expect(jd).toContain('Backend Engineer');
    expect(jd).toContain('Python');
    expect(jd).toContain('PostgreSQL');
  });

  test('falls back to description__text when markup container is absent', () => {
    const html = '<div class="description__text"><p>Fallback description body.</p></div>';
    expect(parseLinkedInDetail(html)).toContain('Fallback description body');
  });

  test('returns null (not "") when no JD container is present', () => {
    expect(parseLinkedInDetail('<div class="other">nope</div>')).toBeNull();
  });

  test('returns null for empty input', () => {
    expect(parseLinkedInDetail('')).toBeNull();
  });
});

describe('LinkedInAdapter.fetch query params', () => {
  test('sends f_TPR when maxAgeDays is set', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response('', { status: 200 }); // empty page → 0 cards → loop stops
    }) as unknown as typeof fetch;

    await collect(
      new LinkedInAdapter().fetch(ctx({ keywords: ['flutter'], locations: ['India'], maxAgeDays: 7 })),
    );
    expect(calledUrl).toContain('f_TPR=r604800');
    expect(calledUrl).toContain('location=India');
  });

  test('sends f_WT=2 instead of a "Remote" location string when remote is required and no place is named', async () => {
    let calledUrl = '';
    globalThis.fetch = (async (url: string) => {
      calledUrl = url;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    await collect(new LinkedInAdapter().fetch(ctx({ keywords: ['flutter'], remoteRequired: true })));
    expect(calledUrl).toContain('f_WT=2');
    expect(calledUrl).not.toContain('location=');
  });

  test('does not fetch a detail page inline (enrichment happens via enrich(), not fetch())', async () => {
    // Abort right after the first page so the test doesn't pay the real
    // inter-page politeness delay for a second, unneeded page.
    const controller = new AbortController();
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      controller.abort();
      return new Response(INDIA_HTML, { status: 200 });
    }) as unknown as typeof fetch;

    const jobs = await collect(
      new LinkedInAdapter().fetch(ctx({ keywords: ['flutter'], abortSignal: controller.signal })),
    );
    expect(jobs).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls.every(u => !u.includes('/jobPosting/'))).toBe(true);
    expect(jobs.every(j => j.jd_text === undefined)).toBe(true);
  });
});

describe('LinkedInAdapter.fetch — per-keyword error isolation (M-1)', () => {
  test('a request failure for one keyword does not abort the remaining keywords', async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.includes('keywords=flutter')) throw new HttpStatusError(404, null, 'not found');
      if (url.includes('start=0')) return new Response(INDIA_HTML, { status: 200 });
      return new Response('', { status: 200 }); // second page ends this keyword's pagination
    }) as unknown as typeof fetch;

    const jobs = await collect(new LinkedInAdapter().fetch(ctx({ keywords: ['flutter', 'backend'] })));
    expect(jobs).toHaveLength(2); // from the 'backend' keyword only
  });

  test('throws only once every keyword has failed', async () => {
    globalThis.fetch = (async () => {
      throw new HttpStatusError(404, null, 'not found');
    }) as unknown as typeof fetch;

    await expect(
      collect(new LinkedInAdapter().fetch(ctx({ keywords: ['flutter', 'backend'] })))
    ).rejects.toThrow('LinkedIn: all requests failed');
  });
});

describe('LinkedInAdapter.enrich', () => {
  test('fetches and returns { jd_text } on success', async () => {
    globalThis.fetch = (async () =>
      new Response('<div class="description__text"><p>Great role.</p></div>', { status: 200 })
    ) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    const patch = await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: '123' }, ctx());
    expect(patch?.jd_text).toContain('Great role');
  });

  test('returns null without fetching when the job has no external_id', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    const patch = await adapter.enrich({ url: 'https://x', title: 't', company: 'c' }, ctx());
    expect(patch).toBeNull();
    expect(called).toBe(false);
  });

  test('disables further enrichment for the rest of the run after a 429', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      throw new HttpStatusError(429, null, 'HTTP 429');
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    const job = { url: 'https://x', title: 't', company: 'c', external_id: '1' };
    expect(await adapter.enrich(job, ctx())).toBeNull();
    expect(call).toBe(1);

    // A second call should be a no-op — no further network request.
    expect(await adapter.enrich({ ...job, external_id: '2' }, ctx())).toBeNull();
    expect(call).toBe(1);
  });

  test('disables further enrichment after three consecutive failures', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    for (let i = 0; i < 3; i++) {
      await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: String(i) }, ctx());
    }
    expect(call).toBe(3);

    // The 4th job should be skipped entirely — the breaker is now open.
    await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: '4' }, ctx());
    expect(call).toBe(3);
  }, 10_000); // 3 real DETAIL_DELAY_MS (1.5s) waits — above bun's 5s default

  test('a later success resets the consecutive-failure counter', async () => {
    let call = 0;
    globalThis.fetch = (async () => {
      call++;
      if (call === 2) return new Response('<div class="description__text">ok</div>', { status: 200 });
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    const job = (id: string) => ({ url: 'https://x', title: 't', company: 'c', external_id: id });
    await adapter.enrich(job('1'), ctx()); // fail (1/3)
    await adapter.enrich(job('2'), ctx()); // success — resets counter
    await adapter.enrich(job('3'), ctx()); // fail (1/3 again)
    await adapter.enrich(job('4'), ctx()); // fail (2/3)
    expect(call).toBe(4); // breaker never opened — no run reached 3 in a row
  }, 10_000); // 4 real DETAIL_DELAY_MS (1.5s) waits — above bun's 5s default

  test('fetch() resets the circuit breaker for a fresh run (adapter is a reused singleton)', async () => {
    let call = 0;
    globalThis.fetch = (async (url: string) => {
      call++;
      if (typeof url === 'string' && url.includes('/jobPosting/')) throw new HttpStatusError(429, null, 'HTTP 429');
      return new Response('', { status: 200 }); // empty search page
    }) as unknown as typeof fetch;

    const adapter = new LinkedInAdapter();
    await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: '1' }, ctx());
    expect(await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: '2' }, ctx())).toBeNull();
    const callsAfterDisable = call;

    await collect(adapter.fetch(ctx({ keywords: ['flutter'] }))); // a new run

    call = 0;
    globalThis.fetch = (async () => new Response('<div class="description__text">ok</div>', { status: 200 })) as unknown as typeof fetch;
    const patch = await adapter.enrich({ url: 'https://x', title: 't', company: 'c', external_id: '3' }, ctx());
    expect(patch?.jd_text).toBe('ok');
    // Sanity: the breaker really had opened before the reset — job 1's 429
    // disabled it immediately, so job 2 never even reached the network.
    expect(callsAfterDisable).toBe(1);
  }, 10_000); // 3 real DETAIL_DELAY_MS (1.5s) waits — above bun's 5s default
});
