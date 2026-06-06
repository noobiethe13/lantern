import { describe, expect, test } from 'bun:test';
import { l1Filter, type Criteria } from './filter';
import type { Job } from './job';

function job(overrides: Partial<Job> = {}): Job {
  return {
    url: 'https://example.com/job/1',
    title: 'Senior Backend Engineer',
    company: 'Acme',
    location: 'London, UK',
    ...overrides,
  };
}

describe('l1Filter — title', () => {
  test('passes when a positive keyword is in the title', () => {
    const c: Criteria = { title: { positive: ['backend'], negative: [] } };
    expect(l1Filter(job(), c).pass).toBe(true);
  });

  test('fails when no positive keyword matches', () => {
    const c: Criteria = { title: { positive: ['frontend'], negative: [] } };
    const r = l1Filter(job(), c);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toContain('positive keyword');
  });

  test('fails on a negative keyword', () => {
    const c: Criteria = { title: { positive: [], negative: ['senior'] } };
    const r = l1Filter(job(), c);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toContain('negative keyword');
  });
});

describe('l1Filter — location allow-list', () => {
  const c: Criteria = { location: { remote_required: false, allowed: ['uk', 'united kingdom'] } };

  test('passes when location matches an allowed place', () => {
    expect(l1Filter(job({ location: 'London, UK' }), c).pass).toBe(true);
  });

  test('fails when a non-remote location is not in the allow-list', () => {
    const r = l1Filter(job({ location: 'Berlin, Germany' }), c);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toContain('allowed list');
  });

  test('remote jobs bypass the allow-list', () => {
    expect(l1Filter(job({ location: 'Remote — Worldwide' }), c).pass).toBe(true);
    expect(l1Filter(job({ location: 'Anywhere', remote: true }), c).pass).toBe(true);
  });

  test('missing or empty location passes (sparse provider data)', () => {
    expect(l1Filter(job({ location: '' }), c).pass).toBe(true);
    expect(l1Filter(job({ location: undefined }), c).pass).toBe(true);
  });

  test('empty allow-list imposes no location constraint', () => {
    const open: Criteria = { location: { remote_required: false, allowed: [] } };
    expect(l1Filter(job({ location: 'Berlin, Germany' }), open).pass).toBe(true);
  });
});

describe('l1Filter — remote_required', () => {
  const c: Criteria = { location: { remote_required: true, allowed: [] } };

  test('fails an on-site/hybrid job', () => {
    const r = l1Filter(job({ location: 'Hybrid — Munich' }), c);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toContain('not remote');
  });

  test('passes a remote job', () => {
    expect(l1Filter(job({ location: 'Remote (EU)' }), c).pass).toBe(true);
  });
});

describe('l1Filter — salary + excludes', () => {
  test('fails when a reported salary is below the floor', () => {
    const c: Criteria = { salary_min_usd: 120000 };
    expect(l1Filter(job({ salary_min_usd: 90000 }), c).pass).toBe(false);
  });

  test('passes when salary is unknown (floor only filters reported pay)', () => {
    const c: Criteria = { salary_min_usd: 120000 };
    expect(l1Filter(job({ salary_min_usd: null }), c).pass).toBe(true);
  });

  test('fails an excluded company', () => {
    const c: Criteria = { exclude_companies: ['acme'] };
    expect(l1Filter(job(), c).pass).toBe(false);
  });
});
