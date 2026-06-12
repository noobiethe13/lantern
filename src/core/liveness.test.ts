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

  test('hard-expired pattern wins even on an SPA host', () => {
    const r = classifyLiveness(input({
      finalUrl: 'https://jobs.ashbyhq.com/acme/123',
      bodyText: 'Job not found',
    }));
    expect(r.result).toBe('expired');
  });
});
