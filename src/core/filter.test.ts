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

describe('l1Filter — seniority gate (junior/mid only)', () => {
  const juniorMid: Criteria = { seniority: { allowed: ['junior', 'mid'] } };

  test('drops senior-marked titles when criteria is junior/mid', () => {
    for (const title of [
      'Senior DevOps Engineer',
      'Sr. Software Engineer',
      'Staff Software Engineer',
      'Principal Data Platform Engineer',
      'Director of Engineering',
      'VP of Infrastructure',
      'Head of Platform',
    ]) {
      const r = l1Filter(job({ title }), juniorMid);
      expect(r.pass).toBe(false);
      expect(r.reasons.join()).toContain('senior+ level');
    }
  });

  test('keeps genuinely junior/mid titles', () => {
    expect(l1Filter(job({ title: 'DevOps Engineer' }), juniorMid).pass).toBe(true);
    expect(l1Filter(job({ title: 'Cloud Engineer II' }), juniorMid).pass).toBe(true);
  });

  test('does NOT gate role words that are level-ambiguous (manager/lead/architect)', () => {
    for (const title of ['Product Manager', 'Product Lead', 'Solutions Architect']) {
      expect(l1Filter(job({ title }), juniorMid).pass).toBe(true);
    }
  });

  test('word boundaries: "SRE" and "VPN" are not senior markers', () => {
    expect(l1Filter(job({ title: 'SRE (Site Reliability Engineer)' }), juniorMid).pass).toBe(true);
    expect(l1Filter(job({ title: 'VPN Infrastructure Engineer' }), juniorMid).pass).toBe(true);
  });

  test('does not fire when the criteria allows senior+', () => {
    const withSenior: Criteria = { seniority: { allowed: ['mid', 'senior'] } };
    expect(l1Filter(job({ title: 'Senior DevOps Engineer' }), withSenior).pass).toBe(true);
  });

  test('does not fire when seniority is unstated or empty', () => {
    expect(l1Filter(job({ title: 'Senior DevOps Engineer' }), {}).pass).toBe(true);
    const empty: Criteria = { seniority: { allowed: [] } };
    expect(l1Filter(job({ title: 'Senior DevOps Engineer' }), empty).pass).toBe(true);
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

describe('l1Filter — location block / always_allow tiers', () => {
  const c: Criteria = {
    location: { remote_required: false, allowed: [], block: ['united states', 'usa'] },
  };

  test('block rejects a matching location', () => {
    const r = l1Filter(job({ location: 'New York, United States' }), c);
    expect(r.pass).toBe(false);
    expect(r.reasons.join()).toContain('blocked by');
  });

  test('block applies even to geo-restricted remote roles', () => {
    expect(l1Filter(job({ location: 'Remote (USA only)', remote: true }), c).pass).toBe(false);
  });

  test('block leaves non-matching locations alone', () => {
    expect(l1Filter(job({ location: 'London, UK' }), c).pass).toBe(true);
  });

  test('empty/missing location passes despite a block list', () => {
    expect(l1Filter(job({ location: '' }), c).pass).toBe(true);
    expect(l1Filter(job({ location: undefined }), c).pass).toBe(true);
  });

  test('always_allow overrides block on a multi-region string', () => {
    const home: Criteria = {
      location: { remote_required: false, allowed: [], block: ['india'], always_allow: ['new york'] },
    };
    expect(l1Filter(job({ location: 'Remote — New York or India' }), home).pass).toBe(true);
    // …but a string naming only the blocked region is still rejected.
    expect(l1Filter(job({ location: 'Bengaluru, India' }), home).pass).toBe(false);
  });

  test('always_allow also rescues from the allowed-list constraint', () => {
    const both: Criteria = {
      location: { remote_required: false, allowed: ['uk'], always_allow: ['india'] },
    };
    expect(l1Filter(job({ location: 'Bengaluru, India' }), both).pass).toBe(true);
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
  test('fails when a same-currency salary is below the floor', () => {
    const c: Criteria = { salary_min_usd: 120000, salary_currency: 'USD' };
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'USD' }), c).pass).toBe(false);
  });

  test('floor currency defaults to USD when the criteria omits it', () => {
    const c: Criteria = { salary_min_usd: 120000 };
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'USD' }), c).pass).toBe(false);
  });

  test('passes when salary is unknown (floor only filters reported pay)', () => {
    const c: Criteria = { salary_min_usd: 120000, salary_currency: 'USD' };
    expect(l1Filter(job({ salary_min_usd: null }), c).pass).toBe(true);
  });

  test('passes when the job amount has no currency tag (cannot compare)', () => {
    const c: Criteria = { salary_min_usd: 120000, salary_currency: 'USD' };
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: null }), c).pass).toBe(true);
  });

  test('passes a below-floor amount in a different currency (defers to L2)', () => {
    const c: Criteria = { salary_min_usd: 120000, salary_currency: 'USD' };
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'EUR' }), c).pass).toBe(true);
  });

  test('fails a below-floor amount when both sides share a non-USD currency', () => {
    const c: Criteria = { salary_min_usd: 100000, salary_currency: 'EUR' };
    expect(l1Filter(job({ salary_min_usd: 80000, salary_currency: 'EUR' }), c).pass).toBe(false);
  });

  test('fails an excluded company', () => {
    const c: Criteria = { exclude_companies: ['acme'] };
    expect(l1Filter(job(), c).pass).toBe(false);
  });
});
