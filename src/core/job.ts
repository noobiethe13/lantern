import { z } from 'zod';

export const JobShape = z.object({
  external_id: z.string().optional(),
  url: z.string().url(),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  remote: z.boolean().optional(),
  salary_min_usd: z.number().int().nullable().optional(),
  salary_max_usd: z.number().int().nullable().optional(),
  posted_at: z.number().int().nullable().optional(),
  jd_text: z.string().optional(),
});

export type Job = z.infer<typeof JobShape>;

export interface SourceContext {
  sourceId: number;
  config: Record<string, unknown>;
  emitProgress: (msg: string, n?: number) => void;
  abortSignal: AbortSignal;
}

export interface SourceAdapter {
  type: 'greenhouse' | 'ashby' | 'lever' | 'hn-whos-hiring' | 'generic-url';
  fetch(ctx: SourceContext): AsyncIterable<Job>;
}
