import { afterEach, describe, expect, test } from 'bun:test';
import { JobShape } from '../core/job';
import type { Job, SourceContext } from '../core/job';
import { TeamtailorAdapter, parseTeamtailorRss } from './teamtailor';

const HOST = 'career.teamtailor.com';

// Modelled on career.teamtailor.com/jobs.rss (2026-10-12), description trimmed.
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>Teamtailor</title>
    <description>Current job openings</description>
    <link>https://career.teamtailor.com/jobs</link>
    <item>
      <title>UK Account Executive - SMB</title>
      <description>&lt;h4&gt;Let's build&lt;/h4&gt;&lt;p&gt;Own your &lt;strong&gt;pipeline&lt;/strong&gt;&lt;/p&gt;</description>
      <pubDate>Fri, 24 Jul 2026 09:05:16 +0200</pubDate>
      <link>https://career.teamtailor.com/jobs/8118064-uk-account-executive-smb</link>
      <remoteStatus>hybrid</remoteStatus>
      <guid>4ff07fd5-3ac0-4333-8f4c-955380396321</guid>
      <tt:locations>
        <tt:location>
          <tt:name>London</tt:name>
          <tt:address>16 Laystall Court</tt:address>
          <tt:city>London</tt:city>
          <tt:country>United Kingdom</tt:country>
        </tt:location>
        <tt:location>
          <tt:name>Stockholm HQ</tt:name>
          <tt:city>Stockholm</tt:city>
          <tt:country>Sweden</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>Sales</tt:department>
    </item>
    <item>
      <title>Backend Engineer</title>
      <description>&lt;p&gt;Remote role&lt;/p&gt;</description>
      <pubDate>Mon, 21 Sep 2026 16:36:16 +0200</pubDate>
      <link>https://jobs.customdomain.example/jobs/8429402-backend-engineer</link>
      <remoteStatus>fully</remoteStatus>
      <guid>ba0c90cd-8ff9-4e4d-8d26-5611833b6ae4</guid>
      <tt:locations/>
    </item>
    <item>
      <title>Off-host without id</title>
      <link>https://evil.example/somewhere</link>
      <guid>x</guid>
    </item>
    <item>
      <title></title>
      <link>https://career.teamtailor.com/jobs/1-x</link>
    </item>
  </channel>
</rss>`;

describe('parseTeamtailorRss', () => {
  test('maps title, tt locations, hybrid status, posted_at and decoded jd_text', () => {
    const [job] = parseTeamtailorRss(RSS, 'Teamtailor', HOST);
    expect(job).toMatchObject({
      external_id: '4ff07fd5-3ac0-4333-8f4c-955380396321',
      title: 'UK Account Executive - SMB',
      url: 'https://career.teamtailor.com/jobs/8118064-uk-account-executive-smb',
      company: 'Teamtailor',
      location: 'London, United Kingdom; Stockholm, Sweden',
      remote: false,
    });
    expect(job.jd_text).toBe("Let's build\nOwn your pipeline");
    expect(job.posted_at).toBe(Date.parse('Fri, 24 Jul 2026 09:05:16 +0200'));
  });

  test('fully remote, empty tt:locations, and off-host link rewritten onto the tenant host', () => {
    const job = parseTeamtailorRss(RSS, 'Teamtailor', HOST)[1];
    expect(job.remote).toBe(true);
    expect(job.location).toBe('');
    expect(job.url).toBe('https://career.teamtailor.com/jobs/8429402-backend-engineer');
  });

  test('drops items with no title or no usable link', () => {
    expect(parseTeamtailorRss(RSS, 'Teamtailor', HOST)).toHaveLength(2);
  });

  test('empty or non-string input yields []', () => {
    expect(parseTeamtailorRss('', 'T', HOST)).toEqual([]);
    expect(parseTeamtailorRss(undefined as unknown as string, 'T', HOST)).toEqual([]);
  });

  test('every mapped job satisfies JobShape', () => {
    for (const job of parseTeamtailorRss(RSS, 'Teamtailor', HOST)) expect(JobShape.safeParse(job).success).toBe(true);
  });
});

describe('TeamtailorAdapter', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeCtx(identifier: string): SourceContext {
    return { sourceId: 1, config: { identifier, display_name: 'Teamtailor' }, emitProgress: () => {}, abortSignal: new AbortController().signal };
  }

  test('fetches jobs.rss from the tenant host only', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(RSS, { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const j of new TeamtailorAdapter().fetch(makeCtx('career'))) jobs.push(j);
    expect(jobs).toHaveLength(2);
    expect(urls).toEqual(['https://career.teamtailor.com/jobs.rss']);
  });

  test('accepts hyphenated slugs and rejects path-escaping ones', async () => {
    globalThis.fetch = (async () => new Response(RSS, { status: 200 })) as unknown as typeof fetch;
    const drain = async (slug: string) => {
      for await (const _ of new TeamtailorAdapter().fetch(makeCtx(slug))) void _;
    };
    await expect(drain('my-company')).resolves.toBeUndefined();
    await expect(drain('../admin')).rejects.toThrow(/not a valid slug/);
  });
});
