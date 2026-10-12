import { describe, expect, test } from 'bun:test';
import type { SourceContext } from '../core/job';
import { pickKeywords, pickLocation, stripUrlQuery } from './gated-util';

function ctx(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    sourceId: 1,
    config: {},
    emitProgress: () => {},
    abortSignal: new AbortController().signal,
    ...overrides,
  };
}

describe('pickLocation', () => {
  test('returns the first non-empty location, trimmed', () => {
    expect(pickLocation(ctx({ locations: ['  India  ', 'Germany'] }))).toBe('India');
  });

  test('skips blank entries to find the first usable one', () => {
    expect(pickLocation(ctx({ locations: ['', '   ', 'Remote-EU'] }))).toBe('Remote-EU');
  });

  test('returns "" when no place is named, even if remote is required (no "Remote" fallback)', () => {
    expect(pickLocation(ctx({ remoteRequired: true }))).toBe('');
    expect(pickLocation(ctx({ locations: [], remoteRequired: true }))).toBe('');
  });

  test('returns "" when locations is absent', () => {
    expect(pickLocation(ctx())).toBe('');
  });
});

describe('pickKeywords', () => {
  test('trims, lowercases, drops empties, dedupes, and drops redundant containing keywords', () => {
    const keywords = ['Flutter', ' ', 'flutter developer', 'dart', 'flutter'];
    expect(pickKeywords(ctx({ keywords }), 3)).toEqual(['flutter', 'dart']);
  });

  test('caps to max after cleaning, not before', () => {
    const keywords = ['flutter', 'flutter', 'flutter', 'dart', 'kotlin'];
    expect(pickKeywords(ctx({ keywords }), 2)).toEqual(['flutter', 'dart']);
  });

  test('keeps unrelated keywords that do not contain one another', () => {
    expect(pickKeywords(ctx({ keywords: ['backend', 'frontend', 'devops'] }), 5)).toEqual([
      'backend',
      'frontend',
      'devops',
    ]);
  });

  test('returns [] when no keywords are set', () => {
    expect(pickKeywords(ctx(), 3)).toEqual([]);
  });

  test('a whole-word-unrelated keyword survives even when it is a raw substring of another (M-2)', () => {
    // "java" is a raw substring of "javascript", but not the same whole word —
    // a naive .includes() check would wrongly drop it as "redundant".
    expect(pickKeywords(ctx({ keywords: ['javascript', 'java'] }), 5)).toEqual(['javascript', 'java']);
    expect(pickKeywords(ctx({ keywords: ['java', 'javascript'] }), 5)).toEqual(['java', 'javascript']);
  });
});

describe('stripUrlQuery', () => {
  test('drops query string and fragment', () => {
    expect(stripUrlQuery('https://x.com/jobs/view/123?refId=abc&trk=xyz')).toBe(
      'https://x.com/jobs/view/123',
    );
  });

  test('returns null for absent/unparseable href', () => {
    expect(stripUrlQuery(undefined)).toBeNull();
    expect(stripUrlQuery(null)).toBeNull();
    expect(stripUrlQuery('not a url')).toBeNull();
  });
});
