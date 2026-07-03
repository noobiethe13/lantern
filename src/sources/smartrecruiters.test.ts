import { describe, expect, test } from 'bun:test';
import { parseSmartRecruiters } from './smartrecruiters';

describe('parseSmartRecruiters', () => {
  test('rewrites api ref to public jobs URL', () => {
    const json = {
      content: [
        {
          id: 'abc',
          name: 'Data Engineer',
          ref: 'https://api.smartrecruiters.com/v1/companies/Bosch/postings/abc',
          location: { fullLocation: 'Stuttgart, Germany', remote: false },
          releasedDate: '2026-04-10T00:00:00Z',
        },
      ],
    };
    const jobs = parseSmartRecruiters(json, 'Bosch');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: 'abc',
      title: 'Data Engineer',
      url: 'https://jobs.smartrecruiters.com/Bosch/postings/abc',
      company: 'Bosch',
      location: 'Stuttgart, Germany',
    });
  });

  test('assembles location from parts and appends Remote', () => {
    const json = {
      content: [
        {
          id: '1',
          name: 'X',
          ref: 'https://api.smartrecruiters.com/v1/companies/Acme/postings/1',
          location: { city: 'Munich', country: 'Germany', remote: true },
        },
      ],
    };
    expect(parseSmartRecruiters(json, 'Acme')[0].location).toBe('Munich, Germany, Remote');
  });

  test('synthesises URL from company slug + id when ref missing', () => {
    const json = { content: [{ id: '99', name: 'Staff SRE', location: {} }] };
    expect(parseSmartRecruiters(json, 'Acme Corp')[0].url).toBe(
      'https://jobs.smartrecruiters.com/acme-corp/99-staff-sre',
    );
  });

  test('drops entries whose ref is off-host and have no id to synthesise from', () => {
    const json = { content: [{ name: 'X', ref: 'https://evil.com/x', location: {} }] };
    expect(parseSmartRecruiters(json, 'Acme')).toHaveLength(0);
  });

  test('returns [] for non-array content', () => {
    expect(parseSmartRecruiters({}, 'Acme')).toEqual([]);
    expect(parseSmartRecruiters(null, 'Acme')).toEqual([]);
  });
});
