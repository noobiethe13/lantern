import { describe, expect, test } from 'bun:test';
import { parseJobicy } from './jobicy';

// Trimmed real shape of a Jobicy /api/v2/remote-jobs response. Job 1 is complete;
// job 2 has no url (dropped); job 3 has no title (dropped).
const JSON_RESP = {
  jobs: [
    {
      id: 146762,
      url: 'https://jobicy.com/jobs/146762-principal-devops-engineer',
      jobTitle: 'Principal DevOps Engineer',
      companyName: 'Zartis ',
      jobGeo: 'Europe',
      jobLevel: 'Senior',
      jobDescription: '<div><strong>Build</strong> cloud platforms.</div>',
      pubDate: '2026-06-18T23:31:00Z',
    },
    { id: 2, url: '', jobTitle: 'No URL', companyName: 'X' },
    { id: 3, url: 'https://jobicy.com/jobs/3', jobTitle: '', companyName: 'Y' },
  ],
};

describe('parseJobicy', () => {
  test('maps jobs, flags remote, trims company, extracts JD + posted_at', () => {
    const jobs = parseJobicy(JSON_RESP);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '146762',
      title: 'Principal DevOps Engineer',
      company: 'Zartis',
      url: 'https://jobicy.com/jobs/146762-principal-devops-engineer',
      location: 'Europe',
      remote: true,
    });
    expect(jobs[0].jd_text).toContain('Build cloud platforms');
    expect(jobs[0].posted_at).toBe(Date.parse('2026-06-18T23:31:00Z'));
  });

  test('drops jobs missing a url or title', () => {
    const titles = parseJobicy(JSON_RESP).map(j => j.title);
    expect(titles).not.toContain('No URL');
    expect(parseJobicy(JSON_RESP).some(j => j.external_id === '3')).toBe(false);
  });

  test('returns [] for a malformed/empty response', () => {
    expect(parseJobicy({})).toEqual([]);
    expect(parseJobicy(null)).toEqual([]);
  });
});
