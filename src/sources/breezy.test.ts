import { afterEach, describe, expect, test } from 'bun:test';
import { JobShape } from '../core/job';
import type { Job, SourceContext } from '../core/job';
import { BreezyAdapter, parseBreezy, parseBreezySalary } from './breezy';

const HOST = 'gecko.breezy.hr';

// Shapes captured live (gecko / duolingo .breezy.hr/json?verbose=true, 2026-10-12).
const POSITIONS = [
  {
    id: '61ce5a82a568',
    friendly_id: '61ce5a82a568-backend-engineer',
    name: 'Backend Engineer',
    url: 'https://gecko.breezy.hr/p/61ce5a82a568-backend-engineer',
    published_date: '2026-09-01T10:00:00.000Z',
    type: { id: 'fullTime', name: 'Full-Time' },
    location: { country: { name: 'Germany', id: 'DE' }, name: 'Rostock, DE', city: 'Rostock', primary: true, is_remote: false },
    locations: [
      { country: { name: 'Germany', id: 'DE' }, name: 'Rostock, DE', city: 'Rostock', primary: true, is_remote: false },
      { name: 'Berlin, DE', is_remote: false },
    ],
    department: 'Engineering',
    salary: '€70.000 – €90.000 / year',
    description: '<p>Build the <b>platform</b>&nbsp;with us</p>',
  },
  {
    id: '4ab15c2e5b05',
    friendly_id: '4ab15c2e5b05-country-marketing-manager',
    name: 'Country Marketing Manager',
    url: 'https://gecko.breezy.hr/p/4ab15c2e5b05-country-marketing-manager',
    published_date: '2026-05-28T13:00:55.828Z',
    location: { country: { name: 'Nigeria', id: 'NG' }, primary: true, is_remote: true, remote_details: { value: 'remote-location' }, name: 'Nigeria' },
    locations: [],
    salary: '',
    description: '',
  },
];

describe('parseBreezy', () => {
  test('maps location, posted_at, jd_text, salary and keeps the on-host url', () => {
    const [job] = parseBreezy(POSITIONS, 'Gecko', HOST);
    expect(job).toMatchObject({
      external_id: '61ce5a82a568',
      title: 'Backend Engineer',
      url: 'https://gecko.breezy.hr/p/61ce5a82a568-backend-engineer',
      company: 'Gecko',
      location: 'Rostock, DE; Berlin, DE',
      remote: false,
      salary_min_usd: 70000,
      salary_max_usd: 90000,
      salary_currency: 'EUR',
    });
    expect(job.jd_text).toBe('Build the platform with us');
    expect(job.posted_at).toBe(Date.parse('2026-09-01T10:00:00.000Z'));
  });

  test('flags remote from remote_details, appends Remote, omits empty jd_text', () => {
    const job = parseBreezy(POSITIONS, 'Gecko', HOST)[1];
    expect(job.remote).toBe(true);
    expect(job.location).toBe('Nigeria; Remote');
    expect(job.jd_text).toBeUndefined();
    expect(job.salary_currency).toBeUndefined();
  });

  test('maps a bare-$ salary to USD only when every location is in the US', () => {
    const base = { id: 'a', name: 'X', url: 'https://gecko.breezy.hr/p/a', salary: '$120,000 – $150,000 / year' };
    const us = { ...base, locations: [{ name: 'Austin, TX', country: { id: 'US' } }] };
    const mixed = { ...base, locations: [{ name: 'Austin, TX', country: { id: 'US' } }, { name: 'Toronto', country: { id: 'CA' } }] };
    expect(parseBreezy([us], 'Gecko', HOST)[0]).toMatchObject({ salary_min_usd: 120000, salary_currency: 'USD' });
    expect(parseBreezy([mixed], 'Gecko', HOST)[0].salary_currency).toBeUndefined();
    expect(parseBreezy([base], 'Gecko', HOST)[0].salary_min_usd).toBeUndefined();
  });

  test('hybrid is not remote even when is_remote is set', () => {
    const json = [{ id: 'a', name: 'X', url: 'https://gecko.breezy.hr/p/a', location: { name: 'Oslo', is_remote: true, remote_details: { value: 'hybrid' } } }];
    expect(parseBreezy(json, 'Gecko', HOST)[0].remote).toBe(false);
  });

  test('rebuilds an off-host url from friendly_id and drops nameless positions', () => {
    const json = [
      { id: 'a', friendly_id: 'a-dev', name: 'Dev', url: 'https://evil.example/p/a' },
      { id: 'b', friendly_id: 'b-x', name: '', url: 'https://gecko.breezy.hr/p/b' },
    ];
    const jobs = parseBreezy(json, 'Gecko', HOST);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toBe('https://gecko.breezy.hr/p/a-dev');
  });

  test('returns [] for non-array input', () => {
    expect(parseBreezy({}, 'Gecko', HOST)).toEqual([]);
    expect(parseBreezy(null, 'Gecko', HOST)).toEqual([]);
  });

  test('every mapped job satisfies JobShape', () => {
    for (const job of parseBreezy(POSITIONS, 'Gecko', HOST)) expect(JobShape.safeParse(job).success).toBe(true);
  });
});

describe('parseBreezySalary', () => {
  test('parses yearly ranges with currency symbols and k suffix', () => {
    expect(parseBreezySalary('$55,000 – $60,000 / year', true)).toEqual({ salary_min_usd: 55000, salary_max_usd: 60000, salary_currency: 'USD' });
    expect(parseBreezySalary('£40k - £50k / year')).toEqual({ salary_min_usd: 40000, salary_max_usd: 50000, salary_currency: 'GBP' });
    expect(parseBreezySalary('EUR 60,000 – 75,000 / year')?.salary_currency).toBe('EUR');
  });

  test('open-ended and single figures', () => {
    expect(parseBreezySalary('$36,000+ / year', true)).toEqual({ salary_min_usd: 36000, salary_max_usd: null, salary_currency: 'USD' });
    expect(parseBreezySalary('$80,000 / year', true)).toMatchObject({ salary_min_usd: 80000, salary_max_usd: 80000 });
  });

  test('a bare $ is only USD for US-only postings, otherwise unmapped', () => {
    expect(parseBreezySalary('$55,000 – $60,000 / year')).toBeNull();
    expect(parseBreezySalary('$55,000 – $60,000 / year', false)).toBeNull();
    expect(parseBreezySalary('USD 55,000 – 60,000 / year')?.salary_currency).toBe('USD');
  });

  test('rejects hourly, daily, unitless, implausible and non-string input', () => {
    expect(parseBreezySalary('$16 – $18 / hour', true)).toBeNull();
    expect(parseBreezySalary('$150 – $170 / day')).toBeNull();
    expect(parseBreezySalary('$40,000 – $60,000')).toBeNull();
    expect(parseBreezySalary('$14 – $16 / year', true)).toBeNull();
    expect(parseBreezySalary('')).toBeNull();
    expect(parseBreezySalary(undefined)).toBeNull();
  });
});

describe('BreezyAdapter', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function makeCtx(identifier: string): SourceContext {
    return { sourceId: 1, config: { identifier, display_name: 'Gecko' }, emitProgress: () => {}, abortSignal: new AbortController().signal };
  }

  test('makes a single verbose request pinned to the tenant host', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(POSITIONS), { status: 200 });
    }) as unknown as typeof fetch;

    const jobs: Job[] = [];
    for await (const j of new BreezyAdapter().fetch(makeCtx('gecko'))) jobs.push(j);
    expect(jobs).toHaveLength(2);
    expect(urls).toEqual(['https://gecko.breezy.hr/json?verbose=true']);
  });

  test('rejects a slug that could escape the host', async () => {
    const drain = async () => {
      for await (const _ of new BreezyAdapter().fetch(makeCtx('evil.com/x'))) void _;
    };
    await expect(drain()).rejects.toThrow(/not a valid slug/);
  });
});
