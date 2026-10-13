import { afterEach, describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { parseWeWorkRemotely, WeWorkRemotelyAdapter } from './weworkremotely';

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

// Trimmed real category feed. Item 1 lists explicit countries, item 2 is
// worldwide, item 3 has no "Company: " prefix (dropped), item 4 is off-keyword.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss">
  <channel>
    <title>We Work Remotely: Back-End Programming Jobs</title>
    <item>
      <title>Twikey: Senior Java Developer</title>
      <region>Anywhere in the World</region>
      <country>🇦🇩 Andorra, 🇧🇦 Bosnia and Herzegovina, and 🇺🇦 Ukraine</country>
      <state>Région Flamande</state>
      <category>Back-End Programming</category>
      <description>&lt;img src="https://x/logo.gif" /&gt;&lt;p&gt;Build &lt;strong&gt;scalable&lt;/strong&gt; systems.&lt;/p&gt;</description>
      <pubDate>Thu, 17 Sep 2026 10:51:23 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/twikey-senior-java-developer</guid>
      <link>https://weworkremotely.com/remote-jobs/twikey-senior-java-developer</link>
    </item>
    <item>
      <title>Reddit: Senior Java Developer: Platform</title>
      <region>Anywhere in the World</region>
      <country></country>
      <description></description>
      <pubDate>Mon, 14 Sep 2026 07:31:07 +0000</pubDate>
      <guid>https://weworkremotely.com/remote-jobs/reddit-senior-java-developer-platform</guid>
      <link>https://weworkremotely.com/remote-jobs/reddit-senior-java-developer-platform</link>
    </item>
    <item>
      <title>No company prefix here</title>
      <link>https://weworkremotely.com/remote-jobs/no-prefix</link>
    </item>
    <item>
      <title>Acme: Office Manager</title>
      <region>USA Only</region>
      <link>https://weworkremotely.com/remote-jobs/acme-office-manager</link>
    </item>
  </channel>
</rss>`;

describe('parseWeWorkRemotely', () => {
  test('splits "Company: Role", uses the explicit country list as location, extracts JD and date', () => {
    const jobs = parseWeWorkRemotely(RSS, ['java developer']);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: 'twikey-senior-java-developer',
      company: 'Twikey',
      title: 'Senior Java Developer',
      url: 'https://weworkremotely.com/remote-jobs/twikey-senior-java-developer',
      remote: true,
      location: 'Andorra, Bosnia and Herzegovina, Ukraine',
    });
    expect(jobs[0].jd_text).toBe('Build scalable systems.');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-09-17T10:51:23Z'));
  });

  test('splits on the first ": " only and maps "Anywhere in the World" to Worldwide', () => {
    const job = parseWeWorkRemotely(RSS, ['java developer'])[1];
    expect(job.company).toBe('Reddit');
    expect(job.title).toBe('Senior Java Developer: Platform');
    expect(job.location).toBe('Worldwide');
    expect(job.jd_text).toBeUndefined();
  });

  test('passes a restricted region through verbatim', () => {
    const [job] = parseWeWorkRemotely(RSS, ['office manager']);
    expect(job.location).toBe('USA Only');
  });

  test('drops items without a company prefix and off-keyword titles', () => {
    const titles = parseWeWorkRemotely(RSS, ['java developer', 'prefix']).map(j => j.title);
    expect(titles).not.toContain('No company prefix here');
    expect(parseWeWorkRemotely(RSS, ['java developer']).map(j => j.company)).not.toContain('Acme');
  });

  test('admits a generic title whose description names a keyword as a whole word', () => {
    // Twikey's description says "scalable systems", so only a body keyword can admit it.
    expect(parseWeWorkRemotely(RSS, ['scalable']).map(j => j.company)).toEqual(['Twikey']);
  });

  test('returns [] for empty or non-feed input', () => {
    expect(parseWeWorkRemotely('', ['x'])).toEqual([]);
    expect(parseWeWorkRemotely('<html></html>', ['x'])).toEqual([]);
  });
});

describe('WeWorkRemotelyAdapter.fetch', () => {
  test('yields nothing and makes no request when keywords are empty', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(RSS);
    }) as unknown as typeof fetch;
    expect(await collect(new WeWorkRemotelyAdapter().fetch(ctx({ keywords: [] })))).toEqual([]);
    expect(calls).toBe(0);
  });

  test('walks all 11 category feeds, dedupes by URL, and survives a failed feed', async () => {
    const requested = new Set<string>();
    globalThis.fetch = (async (url: string) => {
      requested.add(url);
      if (url.includes('remote-design-jobs')) throw new Error('network down');
      return new Response(RSS);
    }) as unknown as typeof fetch;
    const jobs = await collect(new WeWorkRemotelyAdapter(0).fetch(ctx({ keywords: ['java developer'] })));
    expect(jobs).toHaveLength(2);
    expect(requested.size).toBe(11);
  });

  test('stops requesting feeds once aborted', async () => {
    const ac = new AbortController();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(RSS);
    }) as unknown as typeof fetch;
    const iter = new WeWorkRemotelyAdapter(0).fetch(ctx({ keywords: ['java developer'], abortSignal: ac.signal }));
    for await (const _job of iter) {
      ac.abort();
    }
    expect(calls).toBe(1);
  });
});
