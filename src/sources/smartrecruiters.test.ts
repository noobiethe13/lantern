import { describe, expect, test } from 'bun:test';
import { parseSmartRecruiters } from './smartrecruiters';

describe('parseSmartRecruiters', () => {
  test('builds the public URL from company.identifier + id — no "/postings/" segment, no title slug', () => {
    // Live case: the old "/postings/" rewrite (from j.ref) 404s on the public
    // host; jobs.smartrecruiters.com/<identifier>/<id> is the working format.
    const json = {
      content: [
        {
          id: '744000151768679',
          name: 'Data Engineer',
          company: { identifier: 'Wise', name: 'Wise' },
          location: { fullLocation: 'Singapore, , Singapore', remote: false },
          releasedDate: '2026-04-10T00:00:00Z',
        },
      ],
    };
    const jobs = parseSmartRecruiters(json, 'Wise', 'wise');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      external_id: '744000151768679',
      title: 'Data Engineer',
      url: 'https://jobs.smartrecruiters.com/Wise/744000151768679',
      company: 'Wise',
      location: 'Singapore, , Singapore',
    });
  });

  test('falls back to the source identifier when a posting omits company.identifier', () => {
    // The source identifier is the true casing (e.g. "BoschGroup"), never a
    // slugified display name ("Bosch Group" -> "bosch-group" is wrong).
    const json = { content: [{ id: '1', name: 'X', location: {} }] };
    expect(parseSmartRecruiters(json, 'Bosch Group', 'BoschGroup')[0].url).toBe(
      'https://jobs.smartrecruiters.com/BoschGroup/1',
    );
  });

  test('assembles location from city/region + country display name, and appends Remote', () => {
    // Live shape: location.country is a lowercase ISO2 code ("us", "in"), not a full name.
    const json = {
      content: [{ id: '1', name: 'X', location: { city: 'Munich', country: 'de', remote: true } }],
    };
    expect(parseSmartRecruiters(json, 'Acme', 'acme')[0].location).toBe('Munich, Germany, Remote');
  });

  test('assembles location including region when present', () => {
    const json = {
      content: [{ id: '1', name: 'X', location: { city: 'Austin', region: 'TX', country: 'us' } }],
    };
    expect(parseSmartRecruiters(json, 'Acme', 'acme')[0].location).toBe('Austin, TX, United States');
  });

  test('prefers fullLocation over assembling from parts', () => {
    const json = {
      content: [{ id: '1', name: 'X', location: { fullLocation: 'Remote - Anywhere', city: 'Munich', country: 'de' } }],
    };
    expect(parseSmartRecruiters(json, 'Acme', 'acme')[0].location).toBe('Remote - Anywhere');
  });

  test('drops entries with no title or no id', () => {
    const json = {
      content: [
        { id: '1', name: '', location: {} },
        { name: 'No Id', location: {} },
      ],
    };
    expect(parseSmartRecruiters(json, 'Acme', 'acme')).toHaveLength(0);
  });

  test('returns [] for non-array content', () => {
    expect(parseSmartRecruiters({}, 'Acme', 'acme')).toEqual([]);
    expect(parseSmartRecruiters(null, 'Acme', 'acme')).toEqual([]);
  });
});
