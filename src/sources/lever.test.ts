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
});
