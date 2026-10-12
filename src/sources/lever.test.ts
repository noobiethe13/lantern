import { describe, expect, test } from 'bun:test';
import { parseLever } from './lever';

describe('parseLever', () => {
  test('maps core fields and category location', () => {
    const json = [{
      id: 'abc', text: 'Staff Engineer', hostedUrl: 'https://jobs.lever.co/acme/abc',
      categories: { location: 'London' }, createdAt: 1780540143000,
    }];
    expect(parseLever(json, 'Acme')[0]).toMatchObject({
      external_id: 'abc', title: 'Staff Engineer',
      url: 'https://jobs.lever.co/acme/abc', company: 'Acme', location: 'London',
      posted_at: 1780540143000,
    });
  });

  test('prefers descriptionPlain for jd_text, falls back to HTML description', () => {
    const plain = [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1', descriptionPlain: 'Plain JD body' }];
    expect(parseLever(plain, 'Acme')[0].jd_text).toBe('Plain JD body');

    const html = [{ id: '2', text: 'Y', hostedUrl: 'https://jobs.lever.co/acme/2', description: '<p>HTML <b>body</b></p>' }];
    expect(parseLever(html, 'Acme')[0].jd_text).toBe('HTML body');
  });

  test('jd_text undefined when no description', () => {
    const json = [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1' }];
    expect(parseLever(json, 'Acme')[0].jd_text).toBeUndefined();
  });

  test('returns [] for non-array input', () => {
    expect(parseLever({}, 'Acme')).toEqual([]);
  });

  test('maps annual salaryRange to native-currency fields', () => {
    const json = [{
      id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
      salaryRange: { min: 120000, max: 150000, currency: 'usd', interval: 'per-year-salary' },
    }];
    expect(parseLever(json, 'Acme')[0]).toMatchObject({
      salary_min_usd: 120000, salary_max_usd: 150000, salary_currency: 'USD',
    });
  });

  test('treats missing interval as annual', () => {
    const json = [{
      id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
      salaryRange: { min: 80000, max: 95000, currency: 'EUR' },
    }];
    expect(parseLever(json, 'Acme')[0]).toMatchObject({
      salary_min_usd: 80000, salary_max_usd: 95000, salary_currency: 'EUR',
    });
  });

  test('skips non-annual intervals (never compare hourly to an annual floor)', () => {
    const json = [{
      id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
      salaryRange: { min: 40, max: 60, currency: 'USD', interval: 'per-hour-wage' },
    }];
    expect(parseLever(json, 'Acme')[0]).toMatchObject({
      salary_min_usd: null, salary_max_usd: null, salary_currency: null,
    });
  });

  test('nulls when salaryRange absent or malformed', () => {
    const absent = [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1' }];
    expect(parseLever(absent, 'Acme')[0]).toMatchObject({
      salary_min_usd: null, salary_max_usd: null, salary_currency: null,
    });

    const malformed = [{
      id: '2', text: 'Y', hostedUrl: 'https://jobs.lever.co/acme/2',
      salaryRange: { currency: 'USD' },
    }];
    expect(parseLever(malformed, 'Acme')[0]).toMatchObject({
      salary_min_usd: null, salary_max_usd: null, salary_currency: null,
    });
  });

  describe('workplaceType -> remote + location suffix', () => {
    test('remote: true when workplaceType is "remote", even for a job located in a specific city', () => {
      // Live case: Spotify postings with workplaceType:"remote" located "New York, NY".
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        workplaceType: 'remote', categories: { location: 'New York, NY' },
      }];
      const job = parseLever(json, 'Acme')[0];
      expect(job.remote).toBe(true);
      expect(job.location).toBe('New York, NY');
    });

    test('hybrid appends " (Hybrid)" so L1\'s onsite regex can act, and remote is false', () => {
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        workplaceType: 'hybrid', categories: { location: 'London' },
      }];
      const job = parseLever(json, 'Acme')[0];
      expect(job.remote).toBe(false);
      expect(job.location).toBe('London (Hybrid)');
    });

    test('onsite appends " (On-site)" and remote is false', () => {
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        workplaceType: 'onsite', categories: { location: 'Dubai' },
      }];
      const job = parseLever(json, 'Acme')[0];
      expect(job.remote).toBe(false);
      expect(job.location).toBe('Dubai (On-site)');
    });

    test('hybrid/onsite never suffix an empty base location — it must stay empty (lenient in L1)', () => {
      const hybrid = parseLever(
        [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1', workplaceType: 'hybrid', categories: {} }],
        'Acme'
      )[0];
      expect(hybrid.location).toBe('');
      const onsite = parseLever(
        [{ id: '2', text: 'Y', hostedUrl: 'https://jobs.lever.co/acme/2', workplaceType: 'onsite', categories: {} }],
        'Acme'
      )[0];
      expect(onsite.location).toBe('');
    });

    test('workplaceType absent leaves remote false and location unsuffixed', () => {
      const json = [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1', categories: { location: 'London' } }];
      const job = parseLever(json, 'Acme')[0];
      expect(job.remote).toBe(false);
      expect(job.location).toBe('London');
    });
  });

  describe('location: allLocations + country', () => {
    test('joins and dedupes categories.allLocations', () => {
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        categories: { location: 'London', allLocations: ['London', 'Stockholm', 'London'] },
      }];
      expect(parseLever(json, 'Acme')[0].location).toBe('London; Stockholm');
    });

    test('falls back to categories.location when allLocations is absent', () => {
      const json = [{ id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1', categories: { location: 'Dubai' } }];
      expect(parseLever(json, 'Acme')[0].location).toBe('Dubai');
    });

    test('appends the country display name from ISO2 `country` when the location lacks it', () => {
      // Live shape: cred { location: "bengaluru", country: "IN" }.
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        categories: { location: 'bengaluru' }, country: 'IN',
      }];
      expect(parseLever(json, 'Acme')[0].location).toBe('bengaluru, India');
    });

    test('does not double-append when the location string already names the country', () => {
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        categories: { location: 'Patna, Bihar, India' }, country: 'IN',
      }];
      expect(parseLever(json, 'Acme')[0].location).toBe('Patna, Bihar, India');
    });

    test('ignores an invalid/empty country code', () => {
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        categories: { location: 'Remote' }, country: '',
      }];
      expect(parseLever(json, 'Acme')[0].location).toBe('Remote');
    });
  });

  describe('jd_text assembled from lists[] and additionalPlain', () => {
    test('includes list headings + content and additionalPlain even when descriptionPlain omits them', () => {
      // Live case: Spotify's "Who You Are" requirements bullet lives only in
      // lists[], never in descriptionPlain.
      const json = [{
        id: '1', text: 'X', hostedUrl: 'https://jobs.lever.co/acme/1',
        descriptionPlain: 'Intro paragraph.',
        lists: [
          { text: 'Who You Are', content: '<div><li>Experience with Kotlin</li></div>' },
        ],
        additionalPlain: 'Equal opportunity employer.',
      }];
      const jd = parseLever(json, 'Acme')[0].jd_text;
      expect(jd).toContain('Intro paragraph.');
      expect(jd).toContain('Who You Are');
      expect(jd).toContain('Experience with Kotlin');
      expect(jd).toContain('Equal opportunity employer.');
    });
  });

  describe('incomplete postings', () => {
    test('skips a posting with no hostedUrl', () => {
      const json = [{ id: '1', text: 'X' }];
      expect(parseLever(json, 'Acme')).toEqual([]);
    });

    test('skips a posting with no title', () => {
      const json = [{ id: '1', hostedUrl: 'https://jobs.lever.co/acme/1' }];
      expect(parseLever(json, 'Acme')).toEqual([]);
    });
  });
});
