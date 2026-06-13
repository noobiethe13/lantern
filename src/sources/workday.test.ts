import { describe, expect, test } from 'bun:test';
import { parseWorkday, parseWorkdayPostedOn, resolveWorkdayHost } from './workday';

// Shape captured live (salesforce.wd12.myworkdayjobs.com cxs feed, 2026-06-13).
const PAGE = {
  total: 748,
  jobPostings: [
    {
      title: 'Senior Recruiter',
      externalPath: '/job/California---San-Francisco/Senior-Recruiter_JR337973',
      locationsText: '2 Locations',
      postedOn: 'Posted Today',
      bulletFields: ['JR337973'],
    },
    {
      title: 'Staff SRE (Remote)',
      externalPath: '/job/Canada---Toronto/Staff-SRE_JR345898',
      locationsText: 'Canada - Toronto',
      postedOn: 'Posted 5 Days Ago',
      bulletFields: [],
    },
    { title: '', externalPath: '/job/x_JR1', postedOn: 'Posted Today' }, // dropped: no title
    { title: 'Bad path', externalPath: 'job/no-leading-slash', postedOn: 'Posted Today' }, // dropped
  ],
};

const NOW = Date.parse('2026-06-13T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('resolveWorkdayHost', () => {
  test('derives host from tenant + dc', () => {
    expect(resolveWorkdayHost({ identifier: 'salesforce', display_name: 'x', site: 's', dc: 'wd12' }))
      .toBe('salesforce.wd12.myworkdayjobs.com');
  });
  test('honors explicit host override', () => {
    expect(resolveWorkdayHost({ identifier: 'sf', display_name: 'x', site: 's', host: 'careers.wd5.myworkdayjobs.com' }))
      .toBe('careers.wd5.myworkdayjobs.com');
  });
  test('rejects a non-Workday host', () => {
    expect(() => resolveWorkdayHost({ identifier: 'evil', display_name: 'x', site: 's', host: 'evil.com' }))
      .toThrow();
  });
});

describe('parseWorkdayPostedOn', () => {
  test('handles today/yesterday/N days/30+ days', () => {
    expect(parseWorkdayPostedOn('Posted Today', NOW)).toBe(NOW);
    expect(parseWorkdayPostedOn('Posted Yesterday', NOW)).toBe(NOW - DAY);
    expect(parseWorkdayPostedOn('Posted 5 Days Ago', NOW)).toBe(NOW - 5 * DAY);
    expect(parseWorkdayPostedOn('Posted 30+ Days Ago', NOW)).toBe(NOW - 30 * DAY);
    expect(parseWorkdayPostedOn('whenever', NOW)).toBeNull();
    expect(parseWorkdayPostedOn(undefined, NOW)).toBeNull();
  });
});

describe('parseWorkday', () => {
  const jobs = parseWorkday(PAGE, 'salesforce.wd12.myworkdayjobs.com', 'External_Career_Site', 'Salesforce', NOW);

  test('builds public URL from host + site + externalPath, id from bulletFields', () => {
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: 'JR337973',
      title: 'Senior Recruiter',
      url: 'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Senior-Recruiter_JR337973',
      company: 'Salesforce',
      location: '2 Locations',
      remote: false,
    });
    expect(jobs[0].posted_at).toBe(NOW);
  });

  test('falls back to path segment for id when bulletFields empty; flags remote', () => {
    expect(jobs[1].external_id).toBe('Staff-SRE_JR345898');
    expect(jobs[1].remote).toBe(true);
    expect(jobs[1].posted_at).toBe(NOW - 5 * DAY);
  });

  test('omits jd_text (deferred) so it is not ghost-flagged', () => {
    expect(jobs[0].jd_text).toBeUndefined();
  });

  test('drops postings with no title or a non-absolute externalPath', () => {
    expect(jobs.some(j => j.title === 'Bad path')).toBe(false);
  });
});
