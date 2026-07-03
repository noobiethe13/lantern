import { describe, expect, test } from 'bun:test';
import { parseWorkableMarkdown } from './workable';

const FEED = `# Acme jobs

| Title | Department | Location | Type | Salary | Posted | Details |
| --- | --- | --- | --- | --- | --- | --- |
| Backend Engineer | Engineering | Berlin | Full-time | — | 3d ago | [View](https://apply.workable.com/acme/j/ABC123.md) |
| Product Designer | Design | Remote | Full-time | — | 1w ago | [View](https://apply.workable.com/acme/j/DEF456.md) |
`;

describe('parseWorkableMarkdown', () => {
  test('parses table rows into jobs', () => {
    const jobs = parseWorkableMarkdown(FEED, 'Acme');
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      title: 'Backend Engineer',
      location: 'Berlin',
      company: 'Acme',
      url: 'https://apply.workable.com/acme/j/ABC123',
    });
    expect(jobs[1].title).toBe('Product Designer');
  });

  test('skips the header row', () => {
    const jobs = parseWorkableMarkdown(FEED, 'Acme');
    expect(jobs.some(j => j.title === 'Title')).toBe(false);
  });

  test('drops rows whose [View] URL is off-host', () => {
    const feed = `| Evil Role | Eng | Remote | FT | — | 1d | [View](https://evil.com/x.md) |`;
    expect(parseWorkableMarkdown(feed, 'Acme')).toHaveLength(0);
  });

  test('ignores non-table / non-[View] lines', () => {
    expect(parseWorkableMarkdown('just prose\n\n# heading', 'Acme')).toEqual([]);
  });

  test('returns [] for non-string input', () => {
    expect(parseWorkableMarkdown(undefined as unknown as string, 'Acme')).toEqual([]);
  });
});
