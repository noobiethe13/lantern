import { z } from 'zod';

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
});

export type Job = z.infer<typeof JobShape>;

export interface SourceContext {
  sourceId: number;
  config: Record<string, unknown>;
  /** Positive title keywords from the active criteria. Keyword-global
   *  aggregator adapters use these to drive their query; per-company board
   *  adapters ignore them. */
  keywords?: string[];
  emitProgress: (msg: string, n?: number) => void;
  abortSignal: AbortSignal;
}

export type SourceType =
  | 'greenhouse'
  | 'ashby'
  | 'lever'
  | 'recruitee'
  | 'smartrecruiters'
  | 'workable'
  | 'personio'
  | 'remoteok'
  | 'arbeitnow'
  | 'himalayas';

export interface SourceAdapter {
  type: SourceType;
  fetch(ctx: SourceContext): AsyncIterable<Job>;
}
