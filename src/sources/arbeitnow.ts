import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, matchesAny } from './aggregator-util';

const ARBEITNOW_ALLOWED_HOSTS = ['www.arbeitnow.com'];
const ARBEITNOW_URL = 'https://www.arbeitnow.com/api/job-board-api';

/**
 * Parse an Arbeitnow `/job-board-api` page, keeping only postings whose title
 * or tags match a keyword (the API has no server-side search). Jobs live under
 * `data`; `created_at` is a unix timestamp in seconds and `remote` is a boolean.
 */
export function parseArbeitnow(json: unknown, keywords: string[]): Job[] {
  const items = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = (j['title'] as string) ?? '';
    const url = (j['url'] as string) ?? '';
    const company = (j['company_name'] as string)?.trim() ?? '';
    if (!title || !url || !company) continue;

    const tags = Array.isArray(j['tags']) ? (j['tags'] as string[]) : [];
    if (!matchesAny(keywords, title, tags)) continue;

    jobs.push({
      external_id: (j['slug'] as string) ?? '',
      title,
      url,
      company,
      location: (j['location'] as string) ?? '',
      remote: j['remote'] === true,
      posted_at: toMillis(j['created_at']),
      jd_text: htmlToText(j['description'] as string),
    });
  }
  return jobs;
}

export class ArbeitnowAdapter implements SourceAdapter {
  type = 'arbeitnow' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('Arbeitnow: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching Arbeitnow for ${keywords.join(', ')}…`);

    const json = await fetchJson(ARBEITNOW_URL, {
      allowedHosts: ARBEITNOW_ALLOWED_HOSTS,
      timeoutMs: 30_000,
      retries: 2,
    });
    const jobs = parseArbeitnow(json, keywords);
    for (const job of jobs) {
      if (ctx.abortSignal.aborted) break;
      yield job;
    }
    ctx.emitProgress(`Arbeitnow: ${jobs.length} jobs`, jobs.length);
  }
}
