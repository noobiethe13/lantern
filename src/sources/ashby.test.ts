import { describe, expect, test } from 'bun:test';
import { parseAshby } from './ashby';

describe('parseAshby', () => {
  test('maps fields, compensation, and string/object locations', () => {
    const json = {
      jobs: [{
        id: 'j1', title: 'ML Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/j1',
        location: 'Remote',
        compensation: {
          summaryComponents: [
            { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 150000, maxValue: 200000 },
            { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
          ],
        },
        publishedAt: '2026-05-01T00:00:00.000Z',
      }],
    };
    expect(parseAshby(json, 'Acme')[0]).toMatchObject({
      external_id: 'j1', title: 'ML Engineer', url: 'https://jobs.ashbyhq.com/acme/j1',
      company: 'Acme', location: 'Remote',
      salary_min_usd: 150000, salary_max_usd: 200000, salary_currency: 'EUR',
    });
  });

  test('ignores non-annual / non-salary comp components', () => {
    const json = {
      jobs: [{
        id: 'h1', title: 'Contractor', jobUrl: 'https://jobs.ashbyhq.com/acme/h1',
        compensation: {
          summaryComponents: [
            { compensationType: 'Salary', interval: '1 HOUR', currencyCode: 'USD', minValue: 50, maxValue: 80 },
          ],
        },
      }],
    };
    expect(parseAshby(json, 'Acme')[0]).toMatchObject({
      salary_min_usd: null, salary_max_usd: null, salary_currency: null,
    });
  });

  test('no compensation object yields null salary', () => {
    const json = { jobs: [{ id: 'n1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/n1' }] };
    expect(parseAshby(json, 'Acme')[0]).toMatchObject({
      salary_min_usd: null, salary_max_usd: null, salary_currency: null,
    });
  });

  test('prefers descriptionPlain for jd_text, falls back to descriptionHtml', () => {
    const plain = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', descriptionPlain: 'Plain body' }] };
    expect(parseAshby(plain, 'Acme')[0].jd_text).toBe('Plain body');

    const html = { jobs: [{ id: '2', title: 'Y', jobUrl: 'https://jobs.ashbyhq.com/acme/2', descriptionHtml: '<p>HTML <b>body</b></p>' }] };
    expect(parseAshby(html, 'Acme')[0].jd_text).toBe('HTML body');
  });

  test('jd_text undefined when no description', () => {
    const json = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1' }] };
    expect(parseAshby(json, 'Acme')[0].jd_text).toBeUndefined();
  });

  describe('workplaceType/isRemote -> remote + location suffix', () => {
    test('remote: true when workplaceType is "Remote", even located "Europe"', () => {
      // Live case: Linear, 30/30 workplaceType:"Remote" postings located "Europe"/"North America".
      const json = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', location: 'Europe', workplaceType: 'Remote' }] };
      const job = parseAshby(json, 'Acme')[0];
      expect(job.remote).toBe(true);
      expect(job.location).toBe('Europe');
    });

    test('Hybrid workplaceType wins over a true isRemote (Linear\'s hybrid London role)', () => {
      const json = {
        jobs: [{
          id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1',
          location: 'London', workplaceType: 'Hybrid', isRemote: true,
        }],
      };
      const job = parseAshby(json, 'Acme')[0];
      expect(job.remote).toBe(false);
      expect(job.location).toBe('London (Hybrid)');
    });

    test('Onsite workplaceType appends " (On-site)" and remote is false', () => {
      const json = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', location: 'Dubai', workplaceType: 'Onsite' }] };
      const job = parseAshby(json, 'Acme')[0];
      expect(job.remote).toBe(false);
      expect(job.location).toBe('Dubai (On-site)');
    });

    test('hybrid/onsite never suffix an empty base location — it must stay empty (lenient in L1)', () => {
      const hybrid = parseAshby(
        { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', workplaceType: 'Hybrid' }] },
        'Acme'
      )[0];
      expect(hybrid.location).toBe('');
      const onsite = parseAshby(
        { jobs: [{ id: '2', title: 'Y', jobUrl: 'https://jobs.ashbyhq.com/acme/2', workplaceType: 'Onsite' }] },
        'Acme'
      )[0];
      expect(onsite.location).toBe('');
    });

    test('falls back to isRemote only when workplaceType is absent', () => {
      const json = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', location: 'Anywhere', isRemote: true }] };
      expect(parseAshby(json, 'Acme')[0].remote).toBe(true);
    });

    test('workplaceType and isRemote both absent -> remote false', () => {
      const json = { jobs: [{ id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1', location: 'Somewhere' }] };
      expect(parseAshby(json, 'Acme')[0].remote).toBe(false);
    });
  });

  describe('location: secondaryLocations + postal country', () => {
    test('joins primary + secondaryLocations[].location, deduped', () => {
      const json = {
        jobs: [{
          id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1',
          location: 'London',
          secondaryLocations: [{ location: 'Stockholm' }, { location: 'London' }],
        }],
      };
      expect(parseAshby(json, 'Acme')[0].location).toBe('London; Stockholm');
    });

    test('appends address.postalAddress.addressCountry when the string lacks it', () => {
      // Live case: sarvam, location "Bengaluru", addressCountry "India".
      const json = {
        jobs: [{
          id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1',
          location: 'Bengaluru',
          address: { postalAddress: { addressCountry: 'India' } },
        }],
      };
      expect(parseAshby(json, 'Acme')[0].location).toBe('Bengaluru, India');
    });

    test('does not double-append when the country is already present', () => {
      const json = {
        jobs: [{
          id: '1', title: 'X', jobUrl: 'https://jobs.ashbyhq.com/acme/1',
          location: 'Bengaluru, India',
          address: { postalAddress: { addressCountry: 'India' } },
        }],
      };
      expect(parseAshby(json, 'Acme')[0].location).toBe('Bengaluru, India');
    });
  });

  describe('incomplete postings', () => {
    test('skips a posting with no jobUrl', () => {
      const json = { jobs: [{ id: '1', title: 'X' }] };
      expect(parseAshby(json, 'Acme')).toEqual([]);
    });

    test('skips a posting with no title', () => {
      const json = { jobs: [{ id: '1', jobUrl: 'https://jobs.ashbyhq.com/acme/1' }] };
      expect(parseAshby(json, 'Acme')).toEqual([]);
    });
  });
});
