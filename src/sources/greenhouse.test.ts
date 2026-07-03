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
});
