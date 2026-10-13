import { z } from 'zod';
import { EMPLOYMENT_TYPES } from '../core/employment-type';

const SENIORITY_LEVELS = ['junior', 'mid', 'senior', 'staff', 'principal', 'unknown'] as const;

export const VerdictShape = z.object({
  fit: z.boolean(),
  score: z.number().min(0).max(1),
  // Falls back to "unknown" instead of failing the whole batch when the model
  // drifts off-enum (e.g. "lead") — one bad job in a 20-job batch used to sink
  // all 20. Preprocess (not .catch()) deliberately, AND deliberately passes
  // `undefined` through untouched rather than also defaulting it: zod-to-json-schema
  // decides a field is optional by probing `schema.safeParse(undefined).success`
  // — a preprocess (or .catch()) that coerces a missing value into 'unknown' makes
  // that probe succeed, which drops `seniority` from the emitted schema's
  // `required` list (misleading the model into thinking the field can be omitted).
  // Leaving `undefined` unconverted keeps that probe failing (still required) while
  // still coercing any off-enum *value* the model does send.
  seniority: z.preprocess(
    (v) =>
      v === undefined ? v : typeof v === 'string' && (SENIORITY_LEVELS as readonly string[]).includes(v) ? v : 'unknown',
    z.enum(SENIORITY_LEVELS),
  ),
  stack_match: z.array(z.string()),
  remote_confirmed: z.boolean(),
  // A stray non-integer (the model occasionally doesn't round) is rounded
  // instead of rejected. Preprocessing before the .int() check keeps the
  // --json-schema output identical (still "integer"); only parsing is lenient.
  salary_min_usd: z.preprocess(
    (v) => (typeof v === 'number' ? Math.round(v) : v),
    z.number().int().nullable(),
  ),
  // At least one reason is still required; a verdict that pads past 3 is
  // trimmed rather than failing the whole batch.
  reasons: z.array(z.string()).min(1).transform((arr) => arr.slice(0, 3)),
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

// Resume-aware L2 (opt-in): when a master resume is provided, every verdict
// additionally carries a background-fit sub-score + gap list. A separate shape
// (rather than optional fields on VerdictShape) keeps `--json-schema` strict in
// both modes — the fields are required when the resume is present, absent when
// it is not. runL2Pass picks the shape at call time.
export const ResumeVerdictShape = VerdictShape.extend({
  background_fit: z.number().min(0).max(1),
  gaps: z.array(z.string()).max(4),
});
export type ResumeVerdict = z.infer<typeof ResumeVerdictShape>;

export const BatchVerdictWithResumeShape = z.object({
  verdicts: z.array(ResumeVerdictShape.extend({ job_id: z.number().int() })),
});
export type BatchVerdictWithResume = z.infer<typeof BatchVerdictWithResumeShape>;

// Every free-text term list gets trimmed and blank-stripped — the model
// occasionally emits a stray "" or padded entry, which would otherwise become
// an always-matching (or always-blank) L1 term.
const TermList = z.array(z.string()).transform((arr) => arr.map((s) => s.trim()).filter((s) => s.length > 0));

export const COMPANY_STAGES = ['startup', 'scaleup', 'enterprise'] as const;
export type CompanyStage = (typeof COMPANY_STAGES)[number];

// An enum list that drops off-enum entries instead of failing the whole nl-filter
// parse (one drifted "freelance" would otherwise cost a retry and then a 502).
// Same shape as VerdictShape.seniority: `undefined` is passed through untouched so
// zod-to-json-schema's `safeParse(undefined)` probe keeps the field in `required`.
// "Empty = any" is carried by an empty array, not null, for the same reason.
const enumList = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) =>
      Array.isArray(v)
        ? [...new Set(v.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : x)))].filter(
            (x) => typeof x === 'string' && (values as readonly string[]).includes(x),
          )
        : v,
    z.array(z.enum(values)),
  );

export const NLFilterShape = z.object({
  title: z.object({
    positive: TermList,
    negative: TermList,
  }),
  location: z.object({
    remote_required: z.boolean(),
    allowed: TermList,
    block: TermList,
    always_allow: TermList,
  }),
  seniority: z.object({
    allowed: z.array(z.enum(['junior', 'mid', 'senior', 'staff', 'principal'])),
  }),
  // Literal years-of-experience range, independent of seniority.allowed — L2's
  // experience-ceiling rubric reads this directly since seniority levels alone
  // lose precision ("1 to 3 yoe" collapses to ["junior","mid"], which no longer
  // says "3" is the ceiling). null (not {min:null,max:null}) when unstated.
  experience_years: z
    .object({
      min: z.number().int().nullable(),
      max: z.number().int().nullable(),
    })
    .nullable(),
  salary_min_usd: z.number().int().nullable(),
  // ISO code the salary floor is expressed in (the _usd suffix above is legacy —
  // the amount is native to this currency). 'USD' when the user gave $ or a bare
  // number. L1 only applies the floor to jobs tagged with the same currency.
  // Uppercased defensively — a lowercase "usd" would never equal a job's
  // stored (uppercase) currency, silently disabling the L1 salary floor.
  salary_currency: z.string().transform((s) => s.trim().toUpperCase()),
  exclude_companies: TermList,
  // The fields below postdate stored criteria rows: they are required here on
  // purpose, so a pre-upgrade row fails safeParse and routes/runs.ts regenerates
  // it via nl-filter instead of reusing it. Consumers (filter.ts, prompts) still
  // tolerate their absence for a no-query re-scan of such a row.
  // Empty = any.
  employment_types: enumList(EMPLOYMENT_TYPES),
  visa_sponsorship_required: z.boolean(),
  // must: hard requirements (a miss is fit=false at L2). nice: score boosters only.
  skills: z.object({ must: TermList, nice: TermList }),
  // include/exclude are industry keywords. exclude is also matched as whole words
  // against title and company by L1, so entries should be short ("crypto").
  industries: z.object({ include: TermList, exclude: TermList }),
  company_stage: enumList(COMPANY_STAGES),
});
export type NLFilter = z.infer<typeof NLFilterShape>;
