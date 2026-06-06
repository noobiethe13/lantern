import { describe, expect, test } from 'bun:test';
import { parseRecruitee } from './recruitee';

const HOST = 'acme.recruitee.com';

describe('parseRecruitee', () => {
  test('maps offers with on-host URLs', () => {
    const json = {
      offers: [
        {
          id: 12,
          title: 'Backend Engineer',
          careers_url: 'https://acme.recruitee.com/o/backend-engineer',
          city: 'Berlin',
          country: 'Germany',
          published_at: '2026-05-01T00:00:00.000Z',
        },
      ],
    };
    const jobs = parseRecruitee(json, 'Acme', HOST);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '12',
      title: 'Backend Engineer',
      url: 'https://acme.recruitee.com/o/backend-engineer',
      company: 'Acme',
      location: 'Berlin, Germany',
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-05-01T00:00:00.000Z'));
  });

  test('appends Remote to location when flagged', () => {
    const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'NYC', remote: true }] };
    expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe('NYC, Remote');
  });

  test('prefers explicit location field', () => {
    const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'NYC', location: 'Anywhere' }] };
    expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe('Anywhere');
  });

  test('synthesises on-host URL from slug when careers_url is a custom domain', () => {
    const json = {
      offers: [{ id: 1, title: 'X', careers_url: 'https://vacatures.acme.nl/o/x', slug: 'x-role' }],
    };
    expect(parseRecruitee(json, 'Acme', HOST)[0].url).toBe('https://acme.recruitee.com/o/x-role');
  });

  test('drops offers whose URL is off-host and have no slug', () => {
    const json = { offers: [{ id: 1, title: 'X', url: 'https://evil.com/o/x' }] };
    expect(parseRecruitee(json, 'Acme', HOST)).toHaveLength(0);
  });

  test('drops offers with no title or no URL', () => {
    const json = {
      offers: [
        { id: 1, title: '', url: 'https://acme.recruitee.com/o/x' },
        { id: 2, title: 'Y', url: '' },
      ],
    };
    expect(parseRecruitee(json, 'Acme', HOST)).toHaveLength(0);
  });

  test('returns [] for non-array offers', () => {
    expect(parseRecruitee({}, 'Acme', HOST)).toEqual([]);
    expect(parseRecruitee(null, 'Acme', HOST)).toEqual([]);
  });

  test('extracts jd_text from description + requirements (HTML stripped)', () => {
    const json = {
      offers: [{
        id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x',
        description: '<p>Build <b>things</b></p>',
        requirements: '<ul><li>5y Node</li></ul>',
      }],
    };
    const jd = parseRecruitee(json, 'Acme', HOST)[0].jd_text;
    expect(jd).toContain('Build things');
    expect(jd).toContain('5y Node');
    expect(jd).not.toContain('<');
  });

  test('leaves jd_text undefined when no description fields', () => {
    const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x' }] };
    expect(parseRecruitee(json, 'Acme', HOST)[0].jd_text).toBeUndefined();
  });
});
