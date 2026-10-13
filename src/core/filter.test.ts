import { describe, expect, test } from 'bun:test';
import { l1Filter, termMatches, TITLE_MISSING_REASON, type Criteria } from './filter';
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

describe('l1Filter — title-only misses (semantic-rescue candidates)', () => {
  const c: Criteria = {
    title: { positive: ['frontend'], negative: ['intern'] },
    location: { remote_required: false, allowed: ['uk'] },
    salary_min_usd: 100_000,
  };

  test('a title-only failure carries exactly the stable title reason', () => {
    expect(l1Filter(job(), c).reasons).toEqual([TITLE_MISSING_REASON]);
  });

  test('any additional failure makes the reasons list differ, so it is not a candidate', () => {
    const other = (over: Partial<Job>) => l1Filter(job(over), c).reasons;
    expect(other({ location: 'Berlin, Germany' })).toEqual([TITLE_MISSING_REASON, expect.stringContaining('not in allowed list')]);
    expect(other({ title: 'Backend Intern' })).toHaveLength(2);
    expect(other({ salary_min_usd: 50_000, salary_max_usd: 60_000, salary_currency: 'USD' })).toHaveLength(2);
    expect(other({ posted_at: 1 })).toEqual([TITLE_MISSING_REASON]); // freshness gate is off without maxAgeDays
    expect(l1Filter(job({ posted_at: 1 }), c, { now: 40 * 86_400_000, maxAgeDays: 7 }).reasons).toHaveLength(2);
  });

  test('a passing title yields no title reason', () => {
    expect(l1Filter(job({ title: 'Frontend Engineer' }), c).reasons).toEqual([]);
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

  test('worldwide remote jobs pass the allow-list', () => {
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

describe('l1Filter — freshness gate', () => {
  const now = 1000 * 86_400_000; // fixed reference "now" (day 1000) in ms
  const daysAgo = (n: number) => now - n * 86_400_000;

  test('passes a job posted within the window', () => {
    expect(l1Filter(job({ posted_at: daysAgo(3) }), {}, { now, maxAgeDays: 7 }).pass).toBe(true);
  });

  test('drops a job posted older than the window, with a freshness reason', () => {
    const r = l1Filter(job({ posted_at: daysAgo(20) }), {}, { now, maxAgeDays: 7 });
    expect(r.pass).toBe(false);
    expect(r.reasons.some(x => x.includes('freshness'))).toBe(true);
  });

  test('passes a job with no posted date (cannot date it)', () => {
    expect(l1Filter(job({ posted_at: null }), {}, { now, maxAgeDays: 7 }).pass).toBe(true);
    expect(l1Filter(job(), {}, { now, maxAgeDays: 7 }).pass).toBe(true); // posted_at undefined
  });

  test('no gate when maxAgeDays is 0 or absent', () => {
    expect(l1Filter(job({ posted_at: daysAgo(365) }), {}, { now, maxAgeDays: 0 }).pass).toBe(true);
    expect(l1Filter(job({ posted_at: daysAgo(365) }), {}).pass).toBe(true);
  });

  test('exactly at the boundary passes (older is strict)', () => {
    expect(l1Filter(job({ posted_at: daysAgo(7) }), {}, { now, maxAgeDays: 7 }).pass).toBe(true);
  });

  test('a future posted date passes', () => {
    expect(l1Filter(job({ posted_at: now + 86_400_000 }), {}, { now, maxAgeDays: 7 }).pass).toBe(true);
  });
});

describe('termMatches — whole-word matching', () => {
  const cases: [string, string, boolean][] = [
    // term, hay, expected
    ['us', 'Remote - US', true],
    ['us', 'Remote - Australia', false],
    ['us', 'Austin, TX', false],
    ['us', 'Brussels', false],
    ['us', 'Limassol, Cyprus', false],
    ['us', 'Mauritius', false],
    ['us', 'Business hours IST', false],
    ['usa', 'Lausanne', false],
    ['usa', 'Busan', false],
    ['usa', 'Remote (USA only)', true],
    ['intern', 'Internal Tools Engineer', false],
    ['intern', 'International Payments Engineer', false],
    ['intern', 'Software Engineering Intern', true],
    ['java', 'JavaScript Engineer', false],
    ['java', 'Java Developer', true],
    ['meta', 'Metabase', false],
    ['meta', 'MetaMask', false],
    ['meta', 'Metaview', false],
    ['meta', 'Meta Platforms', true],
    ['x', 'Dropbox', false],
    ['x', 'Netflix', false],
    ['x', 'X', true],
    ['india', 'Indianapolis, IN', false],
    ['india', 'Remote - Indianapolis, Indiana', false],
    ['india', 'Bengaluru, India', true],
    ['uk', 'Kyiv, Ukraine', false],
    ['uk', 'London, UK', true],
    ['ios', 'Biostatistician', false],
    ['ios', 'iOS Engineer', true],
    ['pm', 'Business Development Representative', false],
    ['pm', 'Senior PM, Payments', true],
    ['full stack', 'Full-Stack Engineer', true],
    ['full stack', 'Fullstack Developer', true],
    ['full stack', 'Full Stack Developer', true],
    ['site reliability', 'Site-Reliability Engineer', true],
    ['node.js', 'Node.js Developer', true],
    ['node.js', 'Nodejs Developer', false],
    ['c++', 'C++ Engineer', true],
    ['c#', 'C# / .NET Developer', true],
    ['.net', 'ASP.NET Developer', true],
    ['.net', '.NET Engineer', true],
    ['ci/cd', 'CI/CD Engineer', true],
    ['ci/cd', 'CI-CD Engineer', true],
    ['zurich', 'Zürich', true],
    ['', 'anything', false],
    ['   ', 'anything', false],
  ];
  for (const [term, hay, expected] of cases) {
    test(`"${term}" in "${hay}" → ${expected}`, () => {
      expect(termMatches(hay, term)).toBe(expected);
    });
  }
});

describe('l1Filter — whole-word terms across rules', () => {
  test('block "us" leaves unrelated places containing "us" alone', () => {
    const c: Criteria = { location: { remote_required: false, allowed: [], block: ['us'] } };
    for (const location of [
      'Remote - Australia', 'Brussels', 'Limassol, Cyprus', 'Mauritius',
      'Business hours IST', 'Lausanne', 'Busan',
    ]) {
      expect(l1Filter(job({ location }), c).pass).toBe(true);
    }
    expect(l1Filter(job({ location: 'Remote - US' }), c).pass).toBe(false);
    // "us" resolves to the United States in the gazetteer, so a US city is blocked
    // on geography rather than on the letters in "Austin".
    expect(l1Filter(job({ location: 'Austin, TX' }), c).pass).toBe(false);
  });

  test('negative "intern" / positive "java" are whole-word', () => {
    const neg: Criteria = { title: { positive: [], negative: ['intern'] } };
    expect(l1Filter(job({ title: 'Engineer, Internal Tools' }), neg).pass).toBe(true);
    expect(l1Filter(job({ title: 'International Payments Engineer' }), neg).pass).toBe(true);
    expect(l1Filter(job({ title: 'Backend Intern' }), neg).pass).toBe(false);
    const pos: Criteria = { title: { positive: ['java'], negative: [] } };
    expect(l1Filter(job({ title: 'JavaScript Engineer' }), pos).pass).toBe(false);
    expect(l1Filter(job({ title: 'Java Engineer' }), pos).pass).toBe(true);
  });

  test('positive "ios"/"pm" do not match inside words; hyphenated compounds match', () => {
    const c: Criteria = { title: { positive: ['ios', 'pm', 'full stack', 'site reliability'], negative: [] } };
    expect(l1Filter(job({ title: 'Biostatistician' }), c).pass).toBe(false);
    expect(l1Filter(job({ title: 'Business Development Representative' }), c).pass).toBe(false);
    for (const title of ['Full-Stack Engineer', 'Fullstack Developer', 'Site-Reliability Engineer']) {
      expect(l1Filter(job({ title }), c).pass).toBe(true);
    }
  });

  test('company excludes are whole-word', () => {
    const c: Criteria = { exclude_companies: ['meta', 'x'] };
    for (const company of ['Metabase', 'MetaMask', 'Metaview', 'Dropbox', 'Netflix']) {
      expect(l1Filter(job({ company }), c).pass).toBe(true);
    }
    expect(l1Filter(job({ company: 'Meta' }), c).pass).toBe(false);
    expect(l1Filter(job({ company: 'X' }), c).pass).toBe(false);
  });

  test('allowed "uk" does not admit Ukraine', () => {
    const c: Criteria = { location: { remote_required: false, allowed: ['uk'] } };
    expect(l1Filter(job({ location: 'Kyiv, Ukraine' }), c).pass).toBe(false);
  });
});

describe('l1Filter — geography (gazetteer)', () => {
  const india: Criteria = {
    location: { remote_required: false, allowed: ['india'], always_allow: ['india'] },
  };

  test('allowed ["india"] admits Indian cities that never say "India"', () => {
    for (const location of [
      'Bangalore', 'Hyderabad', 'Gurugram', 'Bengaluru - BLR1', 'IN - Bengaluru',
      'Pune/Pimpri-Chinchwad Area', 'Mumbai Metropolitan Region', 'Greater Chennai Area',
      'Hybrid - Bangalore', 'Greater Lucknow Area', 'Noida, Uttar Pradesh', 'Kochi, Kerala',
    ]) {
      expect(l1Filter(job({ location }), india).reasons).toEqual([]);
    }
  });

  test('allowed ["india"] rejects Indiana/Indianapolis and other countries', () => {
    for (const location of [
      'Indianapolis, IN', 'Indianapolis, Indiana', 'Austin, TX', 'Berlin, Germany', 'London, UK',
    ]) {
      const r = l1Filter(job({ location }), india);
      expect(r.pass).toBe(false);
      expect(r.reasons.join()).toContain('not in allowed list');
    }
  });

  test('block ["united states"] blocks a US city named only by its state code', () => {
    const c: Criteria = { location: { remote_required: false, allowed: [], block: ['united states'] } };
    expect(l1Filter(job({ location: 'Austin, TX' }), c).reasons.join()).toContain('blocked by');
    expect(l1Filter(job({ location: 'Chennai, TN' }), c).pass).toBe(true);
    // A region only partly inside the blocked country is not dropped on a guess.
    expect(l1Filter(job({ location: 'Remote - Americas' }), c).pass).toBe(true);
  });

  test('always_allow rescues via the gazetteer too', () => {
    const c: Criteria = {
      location: { remote_required: false, allowed: [], block: ['united states'], always_allow: ['india'] },
    };
    expect(l1Filter(job({ location: 'San Francisco, CA or Bangalore' }), c).pass).toBe(true);
  });
});

describe('l1Filter — remote eligibility (home region)', () => {
  const india: Criteria = {
    location: { remote_required: false, allowed: ['india'], always_allow: ['india'] },
  };

  test('remote jobs restricted to other regions fail', () => {
    const cases: [string, boolean | undefined][] = [
      ['Remote - US', undefined],
      ['Remote - United States', undefined],
      ['United States - Remote', undefined],
      ['Canada - Remote (ON, AB, BC, or NS Only)', undefined],
      ['San Francisco, CA, US; Remote, US', undefined],
      ['Remote (EMEA)', undefined],
      ['United States', true],
      ['Philippines', true],
      ['USA', true],
    ];
    for (const [location, remote] of cases) {
      const r = l1Filter(job({ location, remote }), india);
      expect(r.pass).toBe(false);
      expect(r.reasons.join()).toContain('remote but restricted to');
    }
    expect(l1Filter(job({ location: 'Remote - US' }), india).reasons).toEqual([
      'remote but restricted to United States',
    ]);
  });

  test('remote jobs open to the home region (or anywhere) pass', () => {
    const cases: [string, boolean | undefined][] = [
      ['Remote', undefined],
      ['Anywhere', true],
      ['Worldwide', true],
      ['Remote - India', undefined],
      ['India (Remote)', undefined],
      ['APAC', true],
      ['Remote - Asia Pacific', undefined],
      ['', true],
      ['Australia, Canada, India, United Kingdom, United States', true],
      ['Remote - US or Bangalore', undefined],
      ['Remote (Global), US preferred', undefined],
      ['Remote - Springfield', undefined], // unrecognized place → no signal → pass
    ];
    for (const [location, remote] of cases) {
      expect(l1Filter(job({ location, remote }), india).reasons).toEqual([]);
    }
  });

  test('home region from always_allow alone engages the rule', () => {
    const home: Criteria = { location: { remote_required: true, allowed: [], always_allow: ['india'] } };
    expect(l1Filter(job({ location: 'Remote - US' }), home).pass).toBe(false);
    expect(l1Filter(job({ location: 'Remote - India' }), home).pass).toBe(true);
  });

  test('regions contain countries: allowed ["europe"] admits a remote Germany job', () => {
    const eu: Criteria = { location: { remote_required: false, allowed: ['europe'] } };
    expect(l1Filter(job({ location: 'Remote - Germany' }), eu).pass).toBe(true);
    expect(l1Filter(job({ location: 'Remote - US' }), eu).pass).toBe(false);
  });

  test('without a home region, remote jobs are location-agnostic as before', () => {
    const open: Criteria = { location: { remote_required: false, allowed: [], block: [] } };
    expect(l1Filter(job({ location: 'Remote - US' }), open).pass).toBe(true);
    // An allow-list of unrecognized terms can't be evaluated against places.
    const unknown: Criteria = { location: { remote_required: false, allowed: ['springfield'] } };
    expect(l1Filter(job({ location: 'Remote - US' }), unknown).pass).toBe(true);
  });

  test('an allowed term that matches the text literally still passes a remote job', () => {
    const c: Criteria = { location: { remote_required: false, allowed: ['berlin', 'remote'] } };
    expect(l1Filter(job({ location: 'Remote - US' }), c).pass).toBe(true);
  });
});

describe('l1Filter — salary range vs floor', () => {
  const c: Criteria = { salary_min_usd: 150000, salary_currency: 'USD' };
  const cases: [number | null, number | null, boolean][] = [
    [140000, 190000, true], // range reaches the floor
    [140000, 149999, false], // whole range below the floor
    [140000, null, false], // min-only below: unchanged
    [160000, null, true], // min-only above: unchanged
    [null, 120000, false], // max-only below
    [null, 200000, true],
  ];
  for (const [min, max, pass] of cases) {
    test(`${min}–${max} vs 150000 floor → ${pass ? 'pass' : 'fail'}`, () => {
      const j = job({ salary_min_usd: min, salary_max_usd: max, salary_currency: 'USD' });
      expect(l1Filter(j, c).pass).toBe(pass);
    });
  }

  test('currency comparison is case-insensitive on both sides', () => {
    const lower: Criteria = { salary_min_usd: 150000, salary_currency: 'usd' };
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'USD' }), lower).pass).toBe(false);
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'usd' }), c).pass).toBe(false);
    expect(l1Filter(job({ salary_min_usd: 90000, salary_currency: 'EUR' }), lower).pass).toBe(true);
  });
});

describe('l1Filter — seniority gate refinements', () => {
  const juniorMid: Criteria = { seniority: { allowed: ['junior', 'mid'] } };
  const cases: [string, boolean][] = [
    ['Staff Accountant', true],
    ['Staff Nurse', true],
    ['Staff Writer', true],
    ['Research Fellow, Machine Learning', true],
    ['AI Fellow (Early Career)', true],
    ['Software Engineer II', true],
    ['Flutter Developer 3+ years', true],
    ['Senior Staff Engineer', false],
    ['Staff Software Engineer', false],
    ['Staff Data Scientist', false],
    ['Staff Mobile Engineer', false],
    ['Snr DevOps Engineer', false],
    ['SDE III - Mobile (Flutter)', false],
    ['SDE-3', false],
    ['Software Engineer III', false],
    ['Software Engineer IV', false],
    ['Distinguished Engineer', false],
    ['Tech Lead, Flutter', true], // lead stays ungated (documented choice)
    // S-3: a years-of-experience callout must never be misread as ladder rung 3/4/5.
    ['Flutter Developer 3 Years', true],
    ['Flutter Developer - 3 Yrs Exp', true],
    ['Flutter Developer 3-5 Yrs', true],
    ['Developer - 4 Years', true],
  ];
  for (const [title, pass] of cases) {
    test(`"${title}" → ${pass ? 'pass' : 'drop'}`, () => {
      expect(l1Filter(job({ title }), juniorMid).pass).toBe(pass);
    });
  }
});

describe('l1Filter — blank terms are ignored', () => {
  test('blank company excludes exclude nothing', () => {
    expect(l1Filter(job({ company: 'Acme Corp' }), { exclude_companies: ['', ' '] }).pass).toBe(true);
  });

  test('blank positive terms do not disable the title rule', () => {
    const c: Criteria = { title: { positive: ['', 'frontend'], negative: [' '] } };
    expect(l1Filter(job({ title: 'Backend Engineer' }), c).pass).toBe(false);
    expect(l1Filter(job({ title: 'Frontend Engineer' }), c).pass).toBe(true);
  });

  test('blank allowed/always_allow terms neither bypass nor constrain', () => {
    const c: Criteria = {
      location: { remote_required: false, allowed: ['', 'india'], always_allow: [''] },
    };
    expect(l1Filter(job({ location: 'Berlin, Germany' }), c).pass).toBe(false);
    expect(l1Filter(job({ location: 'Pune' }), c).pass).toBe(true);
    const onlyBlank: Criteria = { location: { remote_required: false, allowed: [' '] } };
    expect(l1Filter(job({ location: 'Berlin, Germany' }), onlyBlank).pass).toBe(true);
  });

  test('whitespace around terms is trimmed', () => {
    const c: Criteria = { title: { positive: ['  flutter '], negative: [] } };
    expect(l1Filter(job({ title: 'Flutter Developer' }), c).pass).toBe(true);
  });
});

describe('l1Filter — employment type', () => {
  const c = (types: NonNullable<Criteria['employment_types']>): Criteria => ({ employment_types: types });

  test('an unstated type passes', () => {
    expect(l1Filter(job({ title: 'Backend Engineer' }), c(['contract'])).pass).toBe(true);
  });

  test('no employment_types means any', () => {
    expect(l1Filter(job({ title: 'Engineering Intern' }), c([])).pass).toBe(true);
    expect(l1Filter(job({ title: 'Engineering Intern' }), {}).pass).toBe(true);
  });

  test('drops a title that states an unwanted type', () => {
    const r = l1Filter(job({ title: 'Software Engineering Intern' }), c(['full_time']));
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('employment type internship not wanted');
  });

  test('keeps a title that states a wanted type', () => {
    expect(l1Filter(job({ title: 'Backend Engineer (Contract)' }), c(['contract'])).pass).toBe(true);
    expect(l1Filter(job({ title: 'Summer Internship' }), c(['internship'])).pass).toBe(true);
  });

  test('a title stating several types passes when any is wanted', () => {
    expect(l1Filter(job({ title: 'Engineer (Contract / Full-time)' }), c(['full_time'])).pass).toBe(true);
  });

  test('whole-word: International and Internal are not interns', () => {
    expect(l1Filter(job({ title: 'International Sales Lead' }), c(['full_time'])).pass).toBe(true);
    expect(l1Filter(job({ title: 'Internal Tools Engineer' }), c(['full_time'])).pass).toBe(true);
  });

  test('a contract-management title is not a contract role', () => {
    expect(l1Filter(job({ title: 'Contract Manager' }), c(['full_time'])).pass).toBe(true);
  });

  test('uses the ATS structured field when the title is silent', () => {
    expect(l1Filter(job({ title: 'Backend Engineer', employment_type: 'part_time' }), c(['full_time'])).pass).toBe(false);
    expect(l1Filter(job({ title: 'Backend Engineer', employment_type: 'full_time' }), c(['full_time'])).pass).toBe(true);
  });

  test('title and structured field are unioned, so either can save the job', () => {
    expect(l1Filter(job({ title: 'Engineer (Contract)', employment_type: 'full_time' }), c(['contract'])).pass).toBe(true);
  });

  test('the reason is distinct from the semantic-rescue reason', () => {
    const r = l1Filter(job({ title: 'Marketing Intern' }), {
      title: { positive: ['backend'], negative: [] },
      employment_types: ['full_time'],
    });
    expect(r.reasons).toHaveLength(2);
    expect(r.reasons[0]).toBe(TITLE_MISSING_REASON);
    expect(r.reasons).not.toEqual([TITLE_MISSING_REASON]);
  });
});

describe('l1Filter — visa sponsorship', () => {
  const need: Criteria = { visa_sponsorship_required: true };

  test('drops a JD that explicitly refuses sponsorship', () => {
    const r = l1Filter(job({ jd_text: 'Great role. We are unable to sponsor visas.' }), need);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toContain('no visa sponsorship');
  });

  test('passes a JD that is silent, missing, or offers sponsorship', () => {
    expect(l1Filter(job({ jd_text: 'Build things in Go.' }), need).pass).toBe(true);
    expect(l1Filter(job(), need).pass).toBe(true);
    expect(l1Filter(job({ jd_text: 'We can sponsor visas.' }), need).pass).toBe(true);
  });

  test('does nothing unless the user needs sponsorship', () => {
    const jd = 'We are unable to sponsor visas.';
    expect(l1Filter(job({ jd_text: jd }), { visa_sponsorship_required: false }).pass).toBe(true);
    expect(l1Filter(job({ jd_text: jd }), {}).pass).toBe(true);
  });
});

describe('l1Filter — industries.exclude', () => {
  const c: Criteria = { industries: { include: [], exclude: ['crypto', 'defense'] } };

  test('drops on a whole-word hit in the company name', () => {
    const r = l1Filter(job({ company: 'Crypto Labs' }), c);
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toBe('industry excluded: "crypto"');
  });

  test('drops on a whole-word hit in the title', () => {
    expect(l1Filter(job({ title: 'Defense Systems Engineer' }), c).pass).toBe(false);
  });

  test('never reads the job description', () => {
    expect(l1Filter(job({ jd_text: 'We are not a crypto company but our clients work in defense.' }), c).pass).toBe(true);
  });

  test('is whole-word, so cryptography and defensive pass', () => {
    expect(l1Filter(job({ title: 'Cryptography Engineer' }), c).pass).toBe(true);
    expect(l1Filter(job({ title: 'Defensive Security Analyst' }), c).pass).toBe(true);
  });

  test('function-ambiguous words match the company name only, never the title', () => {
    const f: Criteria = { industries: { include: [], exclude: ['finance', 'security', 'health', 'insurance', 'crypto'] } };
    for (const title of ['Finance Platform Engineer', 'Security Engineer', 'Health Data Scientist', 'Insurance Data Engineer']) {
      expect(l1Filter(job({ title }), f).pass).toBe(true);
    }
    expect(l1Filter(job({ company: 'Acme Insurance Group' }), f).pass).toBe(false);
    expect(l1Filter(job({ company: 'Health Catalyst' }), f).pass).toBe(false);
    // Industry-specific words still match titles.
    expect(l1Filter(job({ title: 'Crypto Exchange Engineer' }), f).pass).toBe(false);
  });

  test('industries.include, skills and company_stage never gate L1', () => {
    const only: Criteria = {
      industries: { include: ['climate'], exclude: [] },
      skills: { must: ['rust'], nice: ['go'] },
      company_stage: ['startup'],
    };
    expect(l1Filter(job(), only).pass).toBe(true);
  });
});

describe('l1Filter — performance', () => {
  test('10k jobs through a full criteria stay fast (terms compiled once per criteria)', () => {
    const c: Criteria = {
      title: { positive: ['flutter', 'mobile', 'dart', 'android', 'ios'], negative: ['intern', 'manager'] },
      location: { remote_required: false, allowed: ['india', 'bangalore'], block: ['us'], always_allow: ['india'] },
      seniority: { allowed: ['junior', 'mid'] },
      salary_min_usd: 1000000,
      salary_currency: 'INR',
      exclude_companies: ['meta', 'acme staffing'],
    };
    const locations = ['Remote - US', 'Bengaluru, Karnataka, India', 'Austin, TX', 'Remote', 'Remote (EMEA)'];
    const jobs = Array.from({ length: 10_000 }, (_, i) =>
      job({ title: `Flutter Developer ${i}`, location: locations[i % locations.length], company: `Co ${i}` }));
    const t0 = performance.now();
    for (const j of jobs) l1Filter(j, c);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});
