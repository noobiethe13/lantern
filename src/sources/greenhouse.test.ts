import { describe, expect, test } from 'bun:test';
import { parseGreenhouse } from './greenhouse';

describe('parseGreenhouse', () => {
  test('maps core fields and the nested location name', () => {
    const json = {
      jobs: [{
        id: 5, title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/5',
        location: { name: 'Remote — US' }, updated_at: '2026-05-01T00:00:00.000Z',
      }],
    };
    const jobs = parseGreenhouse(json, 'Acme');
    expect(jobs[0]).toMatchObject({
      external_id: '5', title: 'Backend Engineer',
      url: 'https://boards.greenhouse.io/acme/jobs/5', company: 'Acme', location: 'Remote — US',
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-05-01T00:00:00.000Z'));
  });

  test('decodes entity-encoded `content` (?content=true) into plain jd_text', () => {
    // Greenhouse returns content as HTML entities: "&lt;p&gt;…&lt;/p&gt;".
    const json = {
      jobs: [{
        id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
        content: '&lt;p&gt;Hello &amp; welcome&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;',
      }],
    };
    const jd = parseGreenhouse(json, 'Acme')[0].jd_text;
    expect(jd).toContain('Hello & welcome');
    expect(jd).toContain('Go');
    expect(jd).not.toContain('<');
    expect(jd).not.toContain('&lt;');
  });

  test('jd_text is undefined when content is absent', () => {
    const json = { jobs: [{ id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] };
    expect(parseGreenhouse(json, 'Acme')[0].jd_text).toBeUndefined();
  });

  describe('posted_at: first_published over updated_at', () => {
    test('prefers first_published when present — updated_at bumps on any edit', () => {
      // Live case: Anthropic postings updated long after first publish (max
      // observed gap 885 days) previously looked freshly-posted.
      const json = {
        jobs: [{
          id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
          first_published: '2024-01-01T00:00:00.000Z', updated_at: '2026-06-01T00:00:00.000Z',
        }],
      };
      expect(parseGreenhouse(json, 'Acme')[0].posted_at).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    });

    test('falls back to updated_at when first_published is absent', () => {
      const json = {
        jobs: [{ id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', updated_at: '2026-06-01T00:00:00.000Z' }],
      };
      expect(parseGreenhouse(json, 'Acme')[0].posted_at).toBe(Date.parse('2026-06-01T00:00:00.000Z'));
    });
  });

  describe('location: appends a missing country from offices[].location', () => {
    test('appends the country when location.name has none', () => {
      const json = {
        jobs: [{
          id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
          location: { name: 'New York City, NY; San Francisco, CA | New York City, NY' },
          offices: [
            { location: 'New York, New York, United States' },
            { location: 'San Francisco, California, United States' },
          ],
        }],
      };
      expect(parseGreenhouse(json, 'Acme')[0].location).toBe(
        'New York City, NY; San Francisco, CA | New York City, NY, United States',
      );
    });

    test('does not double-append when the country is already present', () => {
      const json = {
        jobs: [{
          id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1',
          location: { name: 'Dublin, IE' },
          offices: [{ location: 'Dublin, IE' }],
        }],
      };
      expect(parseGreenhouse(json, 'Acme')[0].location).toBe('Dublin, IE');
    });

    test('leaves location unchanged when offices is absent', () => {
      const json = { jobs: [{ id: 1, title: 'X', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Singapore' } }] };
      expect(parseGreenhouse(json, 'Acme')[0].location).toBe('Singapore');
    });
  });

  describe('incomplete postings', () => {
    test('skips a posting with no absolute_url', () => {
      const json = { jobs: [{ id: 1, title: 'X' }] };
      expect(parseGreenhouse(json, 'Acme')).toEqual([]);
    });

    test('skips a posting with no title', () => {
      const json = { jobs: [{ id: 1, absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] };
      expect(parseGreenhouse(json, 'Acme')).toEqual([]);
    });
  });
});
