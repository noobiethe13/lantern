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
});
