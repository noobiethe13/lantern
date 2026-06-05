import { describe, expect, test } from 'bun:test';
import { parseHimalayas } from './himalayas';

describe('parseHimalayas', () => {
  test('maps a posting using applicationLink + guid', () => {
    const json = {
      jobs: [
        {
          title: 'Node.JS Developer',
          companyName: 'Acme',
          guid: 'job-123',
          applicationLink: 'https://himalayas.app/companies/acme/jobs/node-123',
          currency: 'USD',
          minSalary: 120000,
          maxSalary: 160000,
          locationRestrictions: ['United States', 'Canada'],
          pubDate: 1780540143,
          description: '<p>Great <b>role</b></p>',
        },
      ],
    };
    const jobs = parseHimalayas(json);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'job-123',
      title: 'Node.JS Developer',
      url: 'https://himalayas.app/companies/acme/jobs/node-123',
      company: 'Acme',
      location: 'United States, Canada',
      remote: true,
      salary_min_usd: 120000,
      salary_max_usd: 160000,
      jd_text: 'Great role',
    });
    expect(jobs[0].posted_at).toBe(1780540143000);
  });

  test('ignores salary when currency is not USD', () => {
    const json = {
      jobs: [
        {
          title: 'X',
          companyName: 'A',
          guid: 'g',
          applicationLink: 'https://x',
          currency: 'EUR',
          minSalary: 50000,
          maxSalary: 70000,
        },
      ],
    };
    const job = parseHimalayas(json)[0];
    expect(job.salary_min_usd).toBeNull();
    expect(job.salary_max_usd).toBeNull();
  });

  test('drops entries missing title, applicationLink, or company', () => {
    const json = {
      jobs: [
        { title: '', companyName: 'A', applicationLink: 'https://x' },
        { title: 'T', companyName: 'A', applicationLink: '' },
        { title: 'T', companyName: '', applicationLink: 'https://x' },
      ],
    };
    expect(parseHimalayas(json)).toHaveLength(0);
  });

  test('returns [] for non-array jobs', () => {
    expect(parseHimalayas({})).toEqual([]);
    expect(parseHimalayas(null)).toEqual([]);
  });
});
