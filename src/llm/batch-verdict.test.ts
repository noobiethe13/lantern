import { describe, expect, test } from 'bun:test';
import { batchVerdictPrompt, type BatchVerdictJob } from './prompts';
import { BatchVerdictShape } from './schemas';

const job = (id: number, over: Partial<BatchVerdictJob> = {}): BatchVerdictJob => ({
  id,
  title: `Engineer ${id}`,
  company: `Co ${id}`,
  location: 'Remote',
  jdText: 'x'.repeat(10_000),
  ...over,
});

describe('batchVerdictPrompt', () => {
  test('lists every job_id so verdicts can map back', () => {
    const prompt = batchVerdictPrompt('title: backend', [job(1), job(42), job(7)]);
    for (const id of [1, 42, 7]) {
      expect(prompt).toContain(`job_id: ${id}`);
    }
    expect(prompt).toContain('Jobs (3)');
  });

  test('caps each JD at the 4KB preview (injection-length guard)', () => {
    const prompt = batchVerdictPrompt('c', [job(1)]);
    // The full 10K JD must not survive; the slice keeps at most ~4096 chars.
    expect(prompt).not.toContain('x'.repeat(4097));
    expect(prompt).toContain('x'.repeat(4096));
  });
});

describe('BatchVerdictShape', () => {
  test('parses an array of verdicts keyed by job_id', () => {
    const parsed = BatchVerdictShape.parse({
      verdicts: [
        {
          job_id: 5,
          fit: true,
          score: 0.8,
          seniority: 'senior',
          stack_match: ['go'],
          remote_confirmed: true,
          salary_min_usd: 120000,
          reasons: ['matches stack'],
        },
      ],
    });
    expect(parsed.verdicts[0]!.job_id).toBe(5);
  });

  test('rejects a verdict missing job_id', () => {
    const bad = {
      verdicts: [
        {
          fit: true,
          score: 0.5,
          seniority: 'mid',
          stack_match: [],
          remote_confirmed: false,
          salary_min_usd: null,
          reasons: ['ok'],
        },
      ],
    };
    expect(BatchVerdictShape.safeParse(bad).success).toBe(false);
  });
});
