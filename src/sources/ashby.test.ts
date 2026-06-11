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
});
