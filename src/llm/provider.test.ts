import { describe, expect, test } from 'bun:test';
import { classifyErrorMessage, MODEL_OVERRIDE_RE } from './provider';

describe('classifyErrorMessage', () => {
  const cases: Array<[string, 'fatal' | 'transient']> = [
    ['claude cli exit 1: API Error: 401 unauthorized', 'fatal'],
    ['claude cli exit 1: API Error: 403 forbidden', 'fatal'],
    ['claude cli exit 1: Invalid API key · Please run /login', 'fatal'],
    ['claude cli exit 1: Not logged in · Please run /login', 'fatal'],
    // Bun's own missing-executable message carries no "ENOENT"/"command not
    // found" text, so it used to fall through to transient (and got retried
    // forever for a CLI that will never appear on PATH by itself).
    ['Executable not found in $PATH: "claude"', 'fatal'],
    // A bare digit match on "401"/"403" anywhere used to misclassify these —
    // a request id containing "4031" as a substring, or an unrelated "403" in
    // prose, must NOT flip an otherwise-transient error to fatal.
    ['claude cli exit 1: API Error: 500 {"request_id":"req_011CV4031XYZ"}', 'transient'],
    ['claude cli exit 1: API Error: 529 {"type":"overloaded_error","request_id":"req_011CV4031XYZ"}', 'transient'],
    ['job 4031: salary 403 USD', 'transient'],
    ['claude cli exit 1: API Error: 404 {"type":"not_found_error"}', 'transient'],
    ['claude cli exit 1: Claude AI usage limit reached|1790000000', 'transient'],
    ['claude-code: schema error Expected number, received string at verdicts.0.job_id', 'transient'],
  ];

  for (const [msg, expected] of cases) {
    test(`"${msg.slice(0, 60)}..." -> ${expected}`, () => {
      expect(classifyErrorMessage(msg)).toBe(expected);
    });
  }
});

describe('MODEL_OVERRIDE_RE', () => {
  test('accepts real model ids', () => {
    for (const id of ['claude-opus-4-7', 'sonnet', 'claude-opus-5-5[1m]', 'claude-haiku-4-5']) {
      expect(MODEL_OVERRIDE_RE.test(id)).toBe(true);
    }
  });

  test('rejects a value that could be re-parsed as a CLI flag', () => {
    expect(MODEL_OVERRIDE_RE.test('--dangerously-skip-permissions')).toBe(false);
    expect(MODEL_OVERRIDE_RE.test('-x')).toBe(false);
  });

  test('rejects blank, overlong, and whitespace-containing values', () => {
    expect(MODEL_OVERRIDE_RE.test('')).toBe(false);
    expect(MODEL_OVERRIDE_RE.test('a'.repeat(101))).toBe(false);
    expect(MODEL_OVERRIDE_RE.test('has space')).toBe(false);
    expect(MODEL_OVERRIDE_RE.test('semi;colon')).toBe(false);
  });
});
