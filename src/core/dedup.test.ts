import { describe, expect, test } from 'bun:test';
import { normalizeCompany, roleTokens, rolesMatch, shouldFold } from './dedup';

describe('normalizeCompany', () => {
  test('lowercases', () => {
    expect(normalizeCompany('Stripe')).toBe('stripe');
  });

  test('strips Inc / Ltd / Corp / LLC suffix', () => {
    expect(normalizeCompany('Stripe Inc')).toBe('stripe');
    expect(normalizeCompany('Stripe, Inc.')).toBe('stripe');
    expect(normalizeCompany('Acme Ltd')).toBe('acme');
    expect(normalizeCompany('Acme LLC')).toBe('acme');
    expect(normalizeCompany('Acme Corp')).toBe('acme');
    expect(normalizeCompany('Acme Corporation')).toBe('acme');
  });

  test('handles smart quotes and trailing punctuation', () => {
    expect(normalizeCompany("O’Reilly")).toBe('oreilly');
    expect(normalizeCompany('Anthropic.')).toBe('anthropic');
  });

  test('collapses multiple companies referring to the same firm', () => {
    const variants = ['Stripe', 'Stripe Inc', 'Stripe, Inc.', 'STRIPE LLC'];
    const norms = variants.map(normalizeCompany);
    expect(new Set(norms).size).toBe(1);
  });
});

describe('roleTokens', () => {
  test('lowercases and splits on punctuation', () => {
    expect([...roleTokens('Senior Software Engineer (Backend)')].sort())
      .toEqual(['backend', 'engineer', 'senior', 'software']);
  });

  test('drops stopwords and remote/hybrid noise', () => {
    expect([...roleTokens('Engineer (Remote, Full-Time)')].sort())
      .toEqual(['engineer']);
  });

  test('keeps short technical tokens like C++ / C# / .net', () => {
    const tokens = roleTokens('C++ Developer at the Backend');
    expect(tokens.has('c++')).toBe(true);
    expect(tokens.has('developer')).toBe(true);
    expect(tokens.has('backend')).toBe(true);
  });
});

describe('rolesMatch', () => {
  test('identical titles match', () => {
    expect(rolesMatch('Software Engineer', 'Software Engineer')).toBe(true);
  });

  test('subset matches (more specific vs less specific)', () => {
    expect(rolesMatch('Senior Engineer', 'Senior Engineer (Backend)')).toBe(true);
  });

  test('high-overlap variants match', () => {
    expect(rolesMatch('Senior Software Engineer', 'Software Engineer, Senior')).toBe(true);
  });

  test('different seniority does not falsely match', () => {
    expect(rolesMatch('Junior Engineer', 'Staff Engineer')).toBe(false);
  });

  test('totally different roles do not match', () => {
    expect(rolesMatch('Software Engineer', 'Product Designer')).toBe(false);
  });

  test('empty title sides do not match', () => {
    expect(rolesMatch('', 'Engineer')).toBe(false);
    expect(rolesMatch('Engineer', '')).toBe(false);
  });

  test('single-token subset does not falsely match', () => {
    // "Engineer" is a subset of "Mechanical Engineer" but only 1 token —
    // the subset rule requires ≥2 tokens to avoid this kind of false positive.
    expect(rolesMatch('Engineer', 'Mechanical Engineer')).toBe(false);
  });

  test('a level word on one side only is a different role, not a rewording', () => {
    expect(rolesMatch('Senior Software Engineer', 'Software Engineer')).toBe(false);
    expect(rolesMatch('Software Engineer Intern', 'Software Engineer')).toBe(false);
  });

  test('abbreviated level word (with/without trailing dot) still blocks a bare title', () => {
    expect(rolesMatch('Sr. DevOps Engineer', 'DevOps Engineer')).toBe(false);
  });

  test('ladder numerals distinguish otherwise-identical titles', () => {
    expect(rolesMatch('Software Engineer III, Mobile', 'Software Engineer II, Mobile')).toBe(false);
  });

  test('legitimate case: work-mode suffix still matches (not a level word)', () => {
    expect(rolesMatch('Software Engineer (Remote)', 'Software Engineer')).toBe(true);
  });

  test('legitimate case: same abbreviated level word with/without trailing dot matches', () => {
    expect(rolesMatch('Sr Flutter Engineer', 'Sr. Flutter Engineer')).toBe(true);
  });
});

describe('shouldFold', () => {
  test('same role, same (normalized) location -> fold', () => {
    expect(shouldFold(
      { title: 'Software Engineer', location: 'Berlin, Germany' },
      { title: 'Software Engineer', location: '  berlin, germany ' },
    )).toBe(true);
  });

  test('same role, different location -> do not fold', () => {
    expect(shouldFold(
      { title: 'Software Engineer', location: 'London, UK' },
      { title: 'Software Engineer', location: 'Berlin, Germany' },
    )).toBe(false);
  });

  test('same role, one side missing location -> fold (nothing to contradict)', () => {
    expect(shouldFold(
      { title: 'Software Engineer', location: null },
      { title: 'Software Engineer', location: 'Berlin, Germany' },
    )).toBe(true);
  });

  test('different role (level mismatch) -> never folds regardless of location', () => {
    expect(shouldFold(
      { title: 'Senior Software Engineer', location: 'Berlin, Germany' },
      { title: 'Software Engineer', location: 'Berlin, Germany' },
    )).toBe(false);
  });
});
