import { z } from 'zod';

export const VerdictShape = z.object({
  fit: z.boolean(),
  score: z.number().min(0).max(1),
  seniority: z.enum(['junior', 'mid', 'senior', 'staff', 'principal', 'unknown']),
  stack_match: z.array(z.string()),
  remote_confirmed: z.boolean(),
  salary_min_usd: z.number().int().nullable(),
  reasons: z.array(z.string()).min(1).max(3),
});
export type Verdict = z.infer<typeof VerdictShape>;

// Batched L2: one call grades N jobs to amortize the ~15K per-subprocess
// cold-start overhead. Each verdict carries the job_id it grades so results map
// back to rows. Wrapped in an object (not a bare top-level array) because
// `--json-schema` handles object roots more reliably.
export const BatchVerdictShape = z.object({
  verdicts: z.array(VerdictShape.extend({ job_id: z.number().int() })),
});
export type BatchVerdict = z.infer<typeof BatchVerdictShape>;

export const NLFilterShape = z.object({
  title: z.object({
    positive: z.array(z.string()),
    negative: z.array(z.string()),
  }),
  location: z.object({
    remote_required: z.boolean(),
    allowed: z.array(z.string()),
    block: z.array(z.string()),
    always_allow: z.array(z.string()),
  }),
  seniority: z.object({
    allowed: z.array(z.enum(['junior', 'mid', 'senior', 'staff', 'principal'])),
  }),
  salary_min_usd: z.number().int().nullable(),
  // ISO code the salary floor is expressed in (the _usd suffix above is legacy —
  // the amount is native to this currency). 'USD' when the user gave $ or a bare
  // number. L1 only applies the floor to jobs tagged with the same currency.
  salary_currency: z.string(),
  exclude_companies: z.array(z.string()),
});
export type NLFilter = z.infer<typeof NLFilterShape>;
