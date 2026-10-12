import { describe, expect, test } from 'bun:test';
import { classifyLiveness, MIN_CONTENT, type LivenessInput } from './liveness';

const FILLER = 'Senior engineer role building distributed systems. '.repeat(20);

function input(overrides: Partial<LivenessInput> = {}): LivenessInput {
  return {
    status: 200,
    finalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
    bodyText: FILLER,
    applyControls: [],
    ...overrides,
  };
}

describe('classifyLiveness', () => {
  test('404/410 → expired', () => {
    expect(classifyLiveness(input({ status: 404 })).result).toBe('expired');
    expect(classifyLiveness(input({ status: 410 })).result).toBe('expired');
  });

  test('hard-expired body pattern → expired', () => {
    const r = classifyLiveness(input({ bodyText: `${FILLER} This job has expired.` }));
    expect(r.result).toBe('expired');
  });

  test('visible apply control → active', () => {
    const r = classifyLiveness(input({ applyControls: ['Apply for this job'] }));
    expect(r).toEqual({ result: 'active', reason: 'visible apply control' });
  });

  test('substantial content, no apply control → uncertain', () => {
    expect(classifyLiveness(input()).result).toBe('uncertain');
  });

  test('thin content on a regular host → expired', () => {
    const r = classifyLiveness(input({ bodyText: 'x'.repeat(MIN_CONTENT - 1) }));
    expect(r).toEqual({ result: 'expired', reason: 'insufficient content' });
  });

  test('thin content on a client-rendered (SPA) host → uncertain, not expired', () => {
    for (const url of [
      'https://jobs.ashbyhq.com/acme/123',
      'https://apply.workable.com/acme/j/ABC123/',
    ]) {
      const r = classifyLiveness(input({ finalUrl: url, bodyText: 'loading…' }));
      expect(r.result).toBe('uncertain');
    }
  });

  test('non-2xx other than 404/410 → uncertain, even with a thin body', () => {
    for (const status of [403, 429, 500, 503, 999]) {
      const r = classifyLiveness(input({ status, bodyText: 'Just a moment...' }));
      expect(r).toEqual({ result: 'uncertain', reason: `HTTP ${status}` });
    }
  });

  test('a visible apply control wins over an inline "no longer available" string', () => {
    const r = classifyLiveness(input({
      bodyText: `${FILLER} This job is no longer available.`,
      applyControls: ['Apply for this job'],
    }));
    expect(r.result).toBe('active');
  });

  test('"closed on <date>" alone is not an expiry signal', () => {
    for (const text of ['Our offices are closed on July 4.', 'Office closed on 25 Dec for holidays.']) {
      expect(classifyLiveness(input({ bodyText: `${FILLER} ${text}` })).result).toBe('uncertain');
    }
    // Explicit application-closed wording still expires.
    expect(classifyLiveness(input({ bodyText: `${FILLER} Applications have closed.` })).result).toBe('expired');
  });

  test('BambooHR and Workday shells are client-rendered hosts', () => {
    for (const url of [
      'https://acme.bamboohr.com/careers/42',
      'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Pune/Engineer_R123',
    ]) {
      expect(classifyLiveness(input({ finalUrl: url, bodyText: 'loading…' })).result).toBe('uncertain');
    }
  });

  test('hard-expired pattern wins even on an SPA host', () => {
    const r = classifyLiveness(input({
      finalUrl: 'https://jobs.ashbyhq.com/acme/123',
      bodyText: 'Job not found',
    }));
    expect(r.result).toBe('expired');
  });
});
