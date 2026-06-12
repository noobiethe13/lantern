import { describe, expect, test } from 'bun:test';
import {
  RESUME_TEXT_MAX,
  ResumeSettingsSchema,
  resumeChangeAffectsVerdicts,
} from './resume';

describe('ResumeSettingsSchema', () => {
  test('accepts a normal settings object', () => {
    expect(ResumeSettingsSchema.safeParse({ enabled: true, text: 'me' }).success).toBe(true);
  });

  test('rejects text over the cap', () => {
    const over = { enabled: true, text: 'x'.repeat(RESUME_TEXT_MAX + 1) };
    expect(ResumeSettingsSchema.safeParse(over).success).toBe(false);
  });
});

describe('resumeChangeAffectsVerdicts', () => {
  const s = (enabled: boolean, text: string) => ({ enabled, text });

  test('toggle flip always invalidates (scores gain/lose resume context)', () => {
    expect(resumeChangeAffectsVerdicts(s(false, 'cv'), s(true, 'cv'))).toBe(true);
    expect(resumeChangeAffectsVerdicts(s(true, 'cv'), s(false, 'cv'))).toBe(true);
  });

  test('text change while enabled invalidates', () => {
    expect(resumeChangeAffectsVerdicts(s(true, 'old cv'), s(true, 'new cv'))).toBe(true);
  });

  test('text change while disabled does not invalidate', () => {
    expect(resumeChangeAffectsVerdicts(s(false, 'old'), s(false, 'new'))).toBe(false);
  });

  test('no-op save does not invalidate', () => {
    expect(resumeChangeAffectsVerdicts(s(true, 'cv'), s(true, 'cv'))).toBe(false);
    expect(resumeChangeAffectsVerdicts(s(false, ''), s(false, ''))).toBe(false);
  });

  test('whitespace-only text change does not invalidate', () => {
    expect(resumeChangeAffectsVerdicts(s(true, 'cv'), s(true, '  cv \n'))).toBe(false);
  });
});
