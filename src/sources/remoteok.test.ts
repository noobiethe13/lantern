import { describe, expect, test } from 'bun:test';
import { parseRemoteOk } from './remoteok';

const legalNotice = { last_updated: '2026-06-04', legal: 'See remoteok.com/terms' };

describe('parseRemoteOk', () => {
  test('skips the legal-notice element and keyword-filters the rest', () => {
    const json = [
      legalNotice,
      {
        id: '1132813',
        position: 'Senior Node Developer',
        company: 'Eastern Airlines',
        tags: ['node', 'backend'],
        location: 'Worldwide',
        url: 'https://remoteOK.com/remote-jobs/node-1132813',
        epoch: 1780540143,
        salary_min: 100000,
        salary_max: 150000,
        description: '<p>Join <b>us</b></p>',
      },
      {
        id: '2',
        position: 'Marketing Lead',
        company: 'Acme',
        tags: ['marketing'],
        url: 'https://remoteOK.com/remote-jobs/mkt-2',
      },
    ];
    const jobs = parseRemoteOk(json, ['node']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '1132813',
      title: 'Senior Node Developer',
      company: 'Eastern Airlines',
      url: 'https://remoteOK.com/remote-jobs/node-1132813',
      remote: true,
      salary_min_usd: 100000,
      salary_max_usd: 150000,
      jd_text: 'Join us',
    });
    expect(jobs[0].posted_at).toBe(1780540143000);
  });

  test('matches keyword in tags even when title does not contain it', () => {
    const json = [
      legalNotice,
      { id: '3', position: 'Backend Engineer', company: 'A', tags: ['NodeJS'], url: 'https://x' },
    ];
    expect(parseRemoteOk(json, ['node'])).toHaveLength(1);
  });

  test('empty keywords matches nothing', () => {
    const json = [legalNotice, { id: '4', position: 'Node Dev', company: 'A', url: 'https://x' }];
    expect(parseRemoteOk(json, [])).toHaveLength(0);
  });

  test('returns [] for non-array input', () => {
    expect(parseRemoteOk({}, ['node'])).toEqual([]);
    expect(parseRemoteOk(null, ['node'])).toEqual([]);
  });
});
