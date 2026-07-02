import { describe, expect, test } from 'bun:test';
import { parseGoogleJobs } from './google-jobs';

// Trimmed real shape of a SerpAPI google_jobs response. Job 1 is complete with
// apply_options; job 2 has no apply_options (no usable URL → dropped); job 3 is
// missing a company (dropped).
const JSON_RESP = {
  jobs_results: [
    {
      title: 'Senior Backend Engineer',
      company_name: 'Acme Corp ',
      location: 'Berlin, Germany',
      description: 'Build APIs in Go.\nWork remotely across the EU.',
      job_id: 'abc123',
      detected_extensions: { posted_at: '3 days ago', salary: '€90K–€120K a year' },
      apply_options: [
        { title: 'LinkedIn', link: 'https://www.linkedin.com/jobs/view/123' },
        { title: 'Greenhouse', link: 'https://boards.greenhouse.io/acme/jobs/123' },
      ],
    },
    {
      title: 'No Apply Link Role',
      company_name: 'Globex',
      location: 'Remote',
      description: 'x',
      apply_options: [{ title: 'Indeed' }],
    },
    {
      title: 'Missing Company',
      company_name: '',
      apply_options: [{ link: 'https://example.com/x' }],
    },
  ],
};

describe('parseGoogleJobs', () => {
  test('maps jobs, prefers the first apply_options link, flags remote, caps JD', () => {
    const jobs = parseGoogleJobs(JSON_RESP);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'abc123',
      title: 'Senior Backend Engineer',
      company: 'Acme Corp',
      url: 'https://www.linkedin.com/jobs/view/123',
      location: 'Berlin, Germany',
      // remote is detected from location/title only (not the JD body, which would
      // false-positive on any "...work remotely..." mention) → false here.
      remote: false,
    });
    expect(jobs[0].jd_text).toContain('Build APIs in Go');
  });

  test('leaves salary and posted_at unmapped (free-text only in this feed)', () => {
    const job = parseGoogleJobs(JSON_RESP)[0];
    expect(job.salary_min_usd).toBeUndefined();
    expect(job.posted_at).toBeUndefined();
  });

  test('drops jobs with no usable apply link or no company', () => {
    const titles = parseGoogleJobs(JSON_RESP).map(j => j.title);
    expect(titles).not.toContain('No Apply Link Role');
    expect(titles).not.toContain('Missing Company');
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseGoogleJobs({})).toEqual([]);
    expect(parseGoogleJobs(null)).toEqual([]);
  });
});
