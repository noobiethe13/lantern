import { describe, expect, test } from 'bun:test';
import { htmlToText, toMillis, matchesAny } from './aggregator-util';

describe('htmlToText', () => {
  test('strips tags and decodes common entities', () => {
    expect(htmlToText('<p>Hello&nbsp;&amp; <b>world</b></p>')).toBe('Hello & world');
  });

  test('turns block tags into newlines', () => {
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
  });

  test('drops script/style content', () => {
    expect(htmlToText('keep<script>evil()</script><style>x{}</style>ok')).toBe('keep ok');
  });

  test('caps to the given length', () => {
    expect(htmlToText('x'.repeat(100), 10)).toHaveLength(10);
  });

  test('returns empty string for nullish input', () => {
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(null)).toBe('');
  });
});

describe('toMillis', () => {
  test('treats small numbers as unix seconds', () => {
    expect(toMillis(1780540143)).toBe(1780540143000);
  });

  test('passes through millisecond numbers', () => {
    expect(toMillis(1780540143000)).toBe(1780540143000);
  });

  test('parses ISO strings', () => {
    expect(toMillis('2026-06-02T20:15:53Z')).toBe(Date.parse('2026-06-02T20:15:53Z'));
  });

  test('returns null for missing / unparseable values', () => {
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('not a date')).toBeNull();
    expect(toMillis(NaN)).toBeNull();
  });
});

describe('matchesAny', () => {
  test('matches a keyword in any part, case-insensitively', () => {
    expect(matchesAny(['node'], 'Senior NODE Developer')).toBe(true);
    expect(matchesAny(['node'], 'Backend Engineer', ['golang', 'NodeJS'])).toBe(true);
  });

  test('returns false when nothing matches', () => {
    expect(matchesAny(['python'], 'Node Developer', ['react'])).toBe(false);
  });

  test('empty keyword list matches nothing', () => {
    expect(matchesAny([], 'anything')).toBe(false);
  });
});
