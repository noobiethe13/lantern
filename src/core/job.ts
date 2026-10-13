import { z } from 'zod';
import { EMPLOYMENT_TYPES } from './employment-type';

export const JobShape = z.object({
  external_id: z.string().optional(),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  // Native amounts in salary_currency (the _usd suffix is legacy). salary_currency
  // is the ISO code, or null/absent when the source reported none.
  salary_min_usd: z.number().int().nullable().optional(),
  salary_max_usd: z.number().int().nullable().optional(),
  salary_currency: z.string().nullable().optional(),
  posted_at: z.number().int().nullable().optional(),
  jd_text: z.string().optional(),
  // Only from an ATS's structured commitment field (Lever, Ashby). Used by L1 and
  // persisted (jobs.employment_type) so the board cache can re-run L1 on stored rows.
  // Absent means "unknown", never "full time".
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
});

export type Job = z.infer<typeof JobShape>;

export interface SourceContext {
  sourceId: number;
  config: Record<string, unknown>;
  /** Positive title keywords from the active criteria. Keyword-global
   *  aggregator adapters use these to drive their query; per-company board
   *  adapters ignore them. */
  keywords?: string[];
  /** Allowed locations from the active criteria. Aggregators whose API takes
   *  a location parameter use these to scope the query; per-company board
   *  adapters ignore them (L1 still applies the location rules either way). */
  locations?: string[];
  /** Whether the active criteria requires remote roles. */
  remoteRequired?: boolean;
  /** Freshness window in days from the active criteria, when the search sets
   *  one. Adapters whose API takes a recency filter (e.g. LinkedIn's `f_TPR`)
   *  use it to scope the query; others ignore it. Populated by the runner. */
  maxAgeDays?: number;
  emitProgress: (msg: string, n?: number) => void;
  abortSignal: AbortSignal;
  /** A per-company adapter calls this when this fetch's result depended on the search
   *  keywords (Workable's ?query= fallback for accounts too large for the default feed).
   *  The runner then never serves the board from its board cache. */
  markQueryDependent?: () => void;
}

export type SourceType =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'recruitee'
  | 'smartrecruiters'
  | 'workable'
  | 'personio'
  | 'bamboohr'
  | 'workday'
  | 'remoteok'
  | 'arbeitnow'
  | 'himalayas'
  | 'linkedin'
  | 'google_jobs'
  | 'jobicy'
  | 'themuse'
  | 'smartrecruiters_search'
  | 'workingnomads'
  | 'weworkremotely'
  | 'remotive'
  | 'jobtech'
  | 'hn_hiring'
  | 'breezy'
  | 'rippling'
  | 'teamtailor';

export interface SourceAdapter {
  type: SourceType;
  fetch(ctx: SourceContext): AsyncIterable<Job>;
  /**
   * Optional per-job enrichment for expensive extra detail (e.g. a JD that
   * needs its own request) that shouldn't be fetched for every candidate up
   * front. The runner calls this only for jobs that already passed L1, within
   * a per-run budget — never over the full unfiltered `fetch()` stream.
   * Returns a partial Job patch to merge (e.g. `{ jd_text }`), or null when
   * nothing was found. Adapters should treat their own fetch failures as
   * recoverable and return null rather than throw.
   */
  enrich?(job: Job, ctx: SourceContext): Promise<Partial<Job> | null>;
  /**
   * True when the listing never carries salary and enrich() is the only place it
   * comes from (Rippling, SmartRecruiters). The runner then keeps the stored
   * salary for listing-only re-sightings instead of reading its absence as the
   * employer removing it. Adapters whose listing has salary must not set this.
   */
  salaryFromEnrich?: boolean;
  /**
   * True when one job's jd_text can contain other roles' pay (HN "Who is hiring"
   * comments), so the runner must not read a salary out of the description text.
   * The adapter's own structured parse still applies.
   */
  jdSalaryUnreliable?: boolean;
}
