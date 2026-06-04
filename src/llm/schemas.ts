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

export const NLFilterShape = z.object({
  title: z.object({
    positive: z.array(z.string()),
    negative: z.array(z.string()),
  }),
  location: z.object({
    remote_required: z.boolean(),
    allowed: z.array(z.string()),
  }),
  seniority: z.object({
    allowed: z.array(z.enum(['junior', 'mid', 'senior', 'staff', 'principal'])),
  }),
  salary_min_usd: z.number().int().nullable(),
  exclude_companies: z.array(z.string()),
});
export type NLFilter = z.infer<typeof NLFilterShape>;
