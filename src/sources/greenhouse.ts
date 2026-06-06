import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';

const GREENHOUSE_ALLOWED_HOSTS = ['boards-api.greenhouse.io'];

export function parseGreenhouse(json: unknown, company: string): Job[] {
  const data = json as { jobs?: unknown[] };
  return (data.jobs ?? []).map((j: unknown) => {
    const job = j as Record<string, unknown>;
    // With `?content=true` greenhouse returns `content` as entity-encoded HTML
    // ("&lt;p&gt;…"). Decode entities first (pass 1) then strip tags (pass 2).
    const jd = htmlToText(htmlToText(job['content'] as string));
    return {
      external_id: String(job['id'] ?? ''),
      title: (job['title'] as string) ?? '',
      url: (job['absolute_url'] as string) ?? '',
      company,
      location: ((job['location'] as Record<string, unknown>)?.['name'] as string) ?? '',
      jd_text: jd || undefined,
      posted_at: job['updated_at']
        ? new Date(job['updated_at'] as string).getTime()
        : null,
    };
  });
}

export class GreenhouseAdapter implements SourceAdapter {
  type = 'greenhouse' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Greenhouse board slug');
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=true`;
    ctx.emitProgress(`Fetching ${display_name} (Greenhouse)…`);

    const json = await fetchJson(apiUrl, { allowedHosts: GREENHOUSE_ALLOWED_HOSTS });
    const jobs = parseGreenhouse(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
