import { describe, expect, test } from 'bun:test';
import { parseBambooList, bambooDetailToJob, bambooListItemToJob } from './bamboohr';

// Shapes captured live (trundl.bamboohr.com, 2026-06-13).
const LIST = {
  meta: { totalCount: 2 },
  result: [
    {
      id: '52',
      jobOpeningName: 'Assistant Manager – Finance',
      departmentLabel: 'Finance',
      location: { city: 'Hyderabad', state: 'Telangana' },
      isRemote: null,
    },
    { id: '53', jobOpeningName: 'Staff Engineer', isRemote: true },
    { id: '', jobOpeningName: 'No Id' },
  ],
};

const DETAIL = {
  meta: {},
  result: {
    jobOpening: {
      jobOpeningShareUrl: 'https://trundl.bamboohr.com/careers/52',
      jobOpeningName: 'Assistant Manager – Finance',
      jobOpeningStatus: 'Open',
      departmentLabel: 'Finance',
      location: { city: 'Hyderabad', state: 'Telangana', addressCountry: 'India' },
      description: '<p>Own the <b>books</b></p>',
      datePosted: '2026-03-02',
      compensation: null,
      isRemote: false,
    },
  },
};

describe('parseBambooList', () => {
  test('enumerates id/title/remote, drops entries missing id', () => {
    const items = parseBambooList(LIST);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: '52', title: 'Assistant Manager – Finance', isRemote: false });
    expect(items[1].isRemote).toBe(true);
  });

  test('returns [] for non-array input', () => {
    expect(parseBambooList({})).toEqual([]);
    expect(parseBambooList(null)).toEqual([]);
  });
});

describe('bambooDetailToJob', () => {
  test('builds a Job with jd_text, location, posted_at from detail', () => {
    const job = bambooDetailToJob(DETAIL, 'Trundl', 'trundl', '52')!;
    expect(job).toMatchObject({
      external_id: '52',
      title: 'Assistant Manager – Finance',
      url: 'https://trundl.bamboohr.com/careers/52',
      company: 'Trundl',
      location: 'Hyderabad, Telangana, India',
      remote: false,
    });
    expect(job.jd_text).toBe('Own the books');
    expect(job.posted_at).toBe(Date.parse('2026-03-02'));
  });

  test('appends Remote to location when isRemote', () => {
    const detail = JSON.parse(JSON.stringify(DETAIL));
    detail.result.jobOpening.isRemote = true;
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')!.location).toContain('Remote');
  });

  test('synthesises url when shareUrl absent; null on missing title', () => {
    const detail = JSON.parse(JSON.stringify(DETAIL));
    delete detail.result.jobOpening.jobOpeningShareUrl;
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')!.url).toBe(
      'https://trundl.bamboohr.com/careers/52',
    );
    detail.result.jobOpening.jobOpeningName = '';
    expect(bambooDetailToJob(detail, 'Trundl', 'trundl', '52')).toBeNull();
  });
});

describe('bambooListItemToJob (fallback past detail cap)', () => {
  test('builds a Job with no jd_text', () => {
    const job = bambooListItemToJob({ id: '99', title: 'SRE', isRemote: true }, 'Trundl', 'trundl');
    expect(job).toMatchObject({ external_id: '99', title: 'SRE', remote: true });
    expect(job.url).toBe('https://trundl.bamboohr.com/careers/99');
    expect(job.jd_text).toBeUndefined();
  });
});
