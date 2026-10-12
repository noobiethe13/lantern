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
  test('parses positions and synthesises the posting URL from id (location excludes department)', () => {
    const jobs = parsePersonioXml(XML, 'Acme', HOST);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      external_id: '101',
      title: 'Senior Frontend Engineer',
      url: 'https://acme.jobs.personio.de/job/101?language=en',
      company: 'Acme',
      // Previously joined as "Berlin · Engineering" — department is not a
      // location and must not gate an office allow-list match.
      location: 'Berlin',
    });
    expect(jobs[0].posted_at).toBe(Date.parse('2026-05-20T10:00:00+00:00'));
  });

  test('includes every additionalOffices > office alongside the primary office', () => {
    // Live shape: office "Munich" with additionalOffices > office "Berlin" —
    // an allow-list of just [berlin] previously missed this job entirely
    // because "department" polluted the joined location and additionalOffices
    // was ignored.
    const xml = `<workzag-jobs>
      <position>
        <id>1</id><name>Staff Software Engineer, Data Platform</name>
        <office>Munich</office>
        <department>Product and Tech</department>
        <additionalOffices><office>Berlin</office></additionalOffices>
      </position>
    </workzag-jobs>`;
    expect(parsePersonioXml(xml, 'Acme', HOST)[0].location).toBe('Munich; Berlin');
  });

  test('dedupes when additionalOffices repeats the primary office', () => {
    const xml = `<workzag-jobs>
      <position>
        <id>1</id><name>X</name>
        <office>Berlin</office>
        <additionalOffices><office>Berlin</office><office>Munich</office></additionalOffices>
      </position>
    </workzag-jobs>`;
    expect(parsePersonioXml(xml, 'Acme', HOST)[0].location).toBe('Berlin; Munich');
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

  test('extracts jd_text from jobDescription values (HTML stripped)', () => {
    const xml = `<workzag-jobs>
      <position>
        <id>9</id><name>Platform Engineer</name>
        <jobDescriptions>
          <jobDescription><name>Role</name><value><![CDATA[<p>Own the <b>platform</b></p>]]></value></jobDescription>
          <jobDescription><name>Requirements</name><value><![CDATA[<ul><li>Kubernetes</li></ul>]]></value></jobDescription>
        </jobDescriptions>
      </position>
    </workzag-jobs>`;
    const jd = parsePersonioXml(xml, 'Acme', HOST)[0].jd_text;
    expect(jd).toContain('Own the platform');
    expect(jd).toContain('Kubernetes');
    expect(jd).not.toContain('<');
  });
});
