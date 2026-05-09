import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';

export function parseLever(json: unknown, company: string): Job[] {
  if (!Array.isArray(json)) return [];
  return json.map((j: unknown) => {
    const job = j as Record<string, unknown>;
    const cats = job['categories'] as Record<string, unknown> | undefined;
    return {
      external_id: String(job['id'] ?? ''),
      title: (job['text'] as string) ?? '',
      url: (job['hostedUrl'] as string) ?? '',
      company,
      location: (cats?.['location'] as string) ?? '',
      posted_at: (job['createdAt'] as number) ?? null,
    };
  });
}

export class LeverAdapter implements SourceAdapter {
  type = 'lever' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    const apiUrl = `https://api.lever.co/v0/postings/${identifier}`;
    ctx.emitProgress(`Fetching ${display_name} (Lever)…`);

    const json = await fetchJson(apiUrl);
    const jobs = parseLever(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
