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

  test('sets remote: true from offer.remote regardless of whether location is empty (previously only worked when it was)', () => {
    const withCity = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'NYC', remote: true }] };
    const job = parseRecruitee(withCity, 'Acme', HOST)[0];
    expect(job.remote).toBe(true);
    expect(job.location).toBe('NYC');

    const noLocation = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', remote: true }] };
    expect(parseRecruitee(noLocation, 'Acme', HOST)[0].remote).toBe(true);
  });

  test('remote: false when offer.remote is absent/false', () => {
    const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'Berlin' }] };
    expect(parseRecruitee(json, 'Acme', HOST)[0].remote).toBe(false);
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

  describe('location: locations[] (all entries, not just the first)', () => {
    test('joins every locations[] entry — offer.location only covers locations[0]', () => {
      // Live shape: a Recruitee offer with 2 `locations[]` entries (Istanbul,
      // Sofia) but `offer.location` preformatted from locations[0] only.
      const json = {
        offers: [{
          id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x',
          location: 'İstanbul, İstanbul, Türkiye',
          locations: [
            { city: 'İstanbul', state: 'İstanbul', country: 'Türkiye' },
            { city: 'Sofia', state: 'Sofia (stolitsa)', country: 'Bulgaria' },
          ],
        }],
      };
      expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe(
        'İstanbul, İstanbul, Türkiye; Sofia, Sofia (stolitsa), Bulgaria',
      );
    });

    test('falls back to city/country fields when locations[] is absent', () => {
      const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'Berlin', country: 'Germany' }] };
      expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe('Berlin, Germany');
    });
  });

  describe('hybrid/on_site -> location suffix (only when not remote)', () => {
    test('appends " (Hybrid)" when offer.hybrid is true and the offer is not remote', () => {
      const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'Amsterdam', hybrid: true }] };
      expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe('Amsterdam (Hybrid)');
    });

    test('appends " (On-site)" when offer.on_site is true and the offer is not remote', () => {
      const json = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'Dubai', on_site: true }] };
      expect(parseRecruitee(json, 'Acme', HOST)[0].location).toBe('Dubai (On-site)');
    });

    test('a remote offer is not suffixed even when hybrid/on_site flags are also set', () => {
      const json = {
        offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', city: 'Amsterdam', remote: true, hybrid: true, on_site: true }],
      };
      const job = parseRecruitee(json, 'Acme', HOST)[0];
      expect(job.remote).toBe(true);
      expect(job.location).toBe('Amsterdam');
    });

    test('hybrid/on_site never suffix an empty base location — it must stay empty (lenient in L1)', () => {
      const hybrid = { offers: [{ id: 1, title: 'X', url: 'https://acme.recruitee.com/o/x', hybrid: true }] };
      expect(parseRecruitee(hybrid, 'Acme', HOST)[0].location).toBe('');
      const onsite = { offers: [{ id: 2, title: 'Y', url: 'https://acme.recruitee.com/o/y', on_site: true }] };
      expect(parseRecruitee(onsite, 'Acme', HOST)[0].location).toBe('');
    });
  });
});
