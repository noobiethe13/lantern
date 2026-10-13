import { describe, expect, test } from 'bun:test';
import { detectBoard } from './index';

describe('detectBoard', () => {
  test('recognises the original board URL shapes', () => {
    expect(detectBoard('https://jobs.lever.co/acme')).toEqual({ type: 'lever', identifier: 'acme' });
    expect(detectBoard('https://acme.bamboohr.com/careers')).toEqual({ type: 'bamboohr', identifier: 'acme' });
  });

  test('recognises Breezy {slug}.breezy.hr URLs', () => {
    expect(detectBoard('https://acme.breezy.hr/')).toEqual({ type: 'breezy', identifier: 'acme' });
    expect(detectBoard('https://my-co.breezy.hr/p/abc123-engineer')).toEqual({ type: 'breezy', identifier: 'my-co' });
  });

  test('recognises Rippling ats.rippling.com/{slug} URLs', () => {
    expect(detectBoard('https://ats.rippling.com/acme-careers/jobs')).toEqual({ type: 'rippling', identifier: 'acme-careers' });
    expect(detectBoard('https://ats.rippling.com/rippling/jobs/84d388b6')).toEqual({ type: 'rippling', identifier: 'rippling' });
  });

  test('skips a leading locale segment on Rippling URLs but keeps short slugs', () => {
    expect(detectBoard('https://ats.rippling.com/en-GB/acme/jobs')).toEqual({ type: 'rippling', identifier: 'acme' });
    expect(detectBoard('https://ats.rippling.com/fr/acme')).toEqual({ type: 'rippling', identifier: 'acme' });
    expect(detectBoard('https://ats.rippling.com/ab/jobs')).toEqual({ type: 'rippling', identifier: 'ab' });
    expect(detectBoard('https://ats.rippling.com/ab')).toEqual({ type: 'rippling', identifier: 'ab' });
  });

  test('rejects reserved Teamtailor product subdomains', () => {
    for (const host of ['app', 'www', 'api', 'support']) {
      expect(detectBoard(`https://${host}.teamtailor.com/`)).toBeNull();
    }
  });

  test('recognises Teamtailor {slug}.teamtailor.com URLs but not the marketing site', () => {
    expect(detectBoard('https://career.teamtailor.com/jobs')).toEqual({ type: 'teamtailor', identifier: 'career' });
    expect(detectBoard('https://my-company.teamtailor.com/jobs/123-x')).toEqual({ type: 'teamtailor', identifier: 'my-company' });
    expect(detectBoard('https://www.teamtailor.com/en/')).toBeNull();
  });

  test('does not match look-alike hosts or unknown URLs', () => {
    expect(detectBoard('https://evil.example/ats.rippling.com/acme')).toBeNull();
    expect(detectBoard('https://acme.breezy.hr.evil.example/')).toBeNull();
    expect(detectBoard('https://acme.teamtailor.com.evil.example/')).toBeNull();
    expect(detectBoard('https://example.com/careers')).toBeNull();
  });
});
