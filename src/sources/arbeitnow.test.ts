import { describe, expect, test } from 'bun:test';
import { parseArbeitnow } from './arbeitnow';

describe('parseArbeitnow', () => {
  test('maps a matching posting from the data array', () => {
    const json = {
      data: [
        {
          slug: 'node-dev-berlin-254093',
          company_name: 'Centric GmbH',
          title: 'Node Developer',
          description: '<p>Backend <b>work</b></p>',
          remote: true,
          url: 'https://www.arbeitnow.com/jobs/companies/centric/node-dev-berlin-254093',
          tags: ['Remote', 'Node'],
          created_at: 1780619432,
        },
      ],
    };
    const jobs = parseArbeitnow(json, ['node']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'node-dev-berlin-254093',
      title: 'Node Developer',
      company: 'Centric GmbH',
      url: 'https://www.arbeitnow.com/jobs/companies/centric/node-dev-berlin-254093',
      remote: true,
      jd_text: 'Backend work',
    });
    expect(jobs[0].posted_at).toBe(1780619432000);
  });

  test('filters out postings that do not match a keyword', () => {
    const json = {
      data: [
        { slug: 's', company_name: 'A', title: 'HR Manager', url: 'https://x', tags: ['HR'] },
      ],
    };
    expect(parseArbeitnow(json, ['node'])).toHaveLength(0);
  });

  test('matches keyword found only in tags', () => {
    const json = {
      data: [
        { slug: 's', company_name: 'A', title: 'Backend Engineer', url: 'https://x', tags: ['NodeJS'] },
      ],
    };
    expect(parseArbeitnow(json, ['node'])).toHaveLength(1);
  });

  test('returns [] for non-array data', () => {
    expect(parseArbeitnow({}, ['node'])).toEqual([]);
    expect(parseArbeitnow(null, ['node'])).toEqual([]);
  });
});
