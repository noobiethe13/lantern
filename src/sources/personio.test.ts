import { describe, expect, test } from 'bun:test';
import { parsePersonioXml } from './personio';

const HOST = 'acme.jobs.personio.de';

const XML = `<?xml version="1.0" encoding="utf-8"?>
<workzag-jobs>
  <position>
    <id>101</id>
    <name>Senior Frontend Engineer</name>
    <office>Berlin</office>
    <department>Engineering</department>
    <employmentType>permanent</employmentType>
    <createdAt>2026-05-20T10:00:00+00:00</createdAt>
  </position>
  <position>
    <id>102</id>
    <name>Sales Lead</name>
    <office>Munich</office>
    <department>Sales</department>
  </position>
</workzag-jobs>`;

describe('parsePersonioXml', () => {
  test('parses positions and synthesises the posting URL from id', () => {
    const jobs = parsePersonioXml(XML, 'Acme', HOST);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: '101',
      title: 'Senior Frontend Engineer',
      url: 'https://acme.jobs.personio.de/job/101?language=en',
      company: 'Acme',
      location: 'Berlin · Engineering',
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-05-20T10:00:00+00:00'));
  });

  test('posted_at is null when createdAt is absent', () => {
    expect(parsePersonioXml(XML, 'Acme', HOST)[1].posted_at).toBeNull();
  });

  test('drops positions missing id or name', () => {
    const xml = `<workzag-jobs>
      <position><id>1</id><name></name></position>
      <position><name>No Id</name></position>
    </workzag-jobs>`;
    expect(parsePersonioXml(xml, 'Acme', HOST)).toHaveLength(0);
  });

  test('returns [] for empty or non-string input', () => {
    expect(parsePersonioXml('', 'Acme', HOST)).toEqual([]);
    expect(parsePersonioXml(undefined as unknown as string, 'Acme', HOST)).toEqual([]);
  });
});
