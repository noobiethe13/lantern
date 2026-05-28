import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';

const ASHBY_ALLOWED_HOSTS = ['api.ashbyhq.com'];

export function parseAshby(json: unknown, company: string): Job[] {
  const data = json as { jobs?: unknown[] };
  return (data.jobs ?? []).map((j: unknown) => {
    const job = j as Record<string, unknown>;
    const comp = job['compensationTierSummary'] as
      | Record<string, unknown>
      | undefined;
    const loc = job['location'];
    return {
      external_id: String(job['id'] ?? ''),
      title: (job['title'] as string) ?? '',
      url: (job['jobUrl'] as string) ?? '',
      company,
      location:
        typeof loc === 'string'
          ? loc
          : ((loc as Record<string, unknown>)?.['name'] as string) ?? '',
      salary_min_usd: (comp?.['min'] as number) ?? null,
      salary_max_usd: (comp?.['max'] as number) ?? null,
      posted_at: job['publishedAt']
        ? new Date(job['publishedAt'] as string).getTime()
        : null,
    };
  });
}

export class AshbyAdapter implements SourceAdapter {
  type = 'ashby' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Ashby board slug');
    const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${identifier}?includeCompensation=true`;
    ctx.emitProgress(`Fetching ${display_name} (Ashby)…`);

    const json = await fetchJson(apiUrl, { allowedHosts: ASHBY_ALLOWED_HOSTS });
    const jobs = parseAshby(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
