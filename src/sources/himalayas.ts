import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis } from './aggregator-util';

const HIMALAYAS_ALLOWED_HOSTS = ['himalayas.app'];
const PER_KEYWORD_LIMIT = 100;
const MAX_KEYWORDS = 8;

function buildUrl(keyword: string): string {
  return `https://himalayas.app/jobs/api/search?q=${encodeURIComponent(keyword)}&limit=${PER_KEYWORD_LIMIT}`;
}

/**
 * Parse a Himalayas `/jobs/api/search` response. Jobs live under `jobs`; the
 * apply URL is `applicationLink` and the stable id is `guid`. Himalayas is a
 * remote-only board. Salary is only mapped when the currency is USD.
 */
export function parseHimalayas(json: unknown): Job[] {
  const items = (json as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = (j['title'] as string) ?? '';
    const url = (j['applicationLink'] as string) ?? '';
    const company = (j['companyName'] as string)?.trim() ?? '';
    if (!title || !url || !company) continue;

    const usd = j['currency'] === 'USD';
    const minSalary = j['minSalary'];
    const maxSalary = j['maxSalary'];
    const locations = j['locationRestrictions'];

    jobs.push({
      external_id: String(j['guid'] ?? ''),
      title,
      url,
      company,
      location: Array.isArray(locations) ? locations.join(', ') : '',
      remote: true,
      salary_min_usd: usd && typeof minSalary === 'number' ? Math.round(minSalary) : null,
      salary_max_usd: usd && typeof maxSalary === 'number' ? Math.round(maxSalary) : null,
      posted_at: toMillis(j['pubDate']),
      jd_text: htmlToText(j['description'] as string),
    });
  }
  return jobs;
}

export class HimalayasAdapter implements SourceAdapter {
  type = 'himalayas' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = (ctx.keywords ?? []).slice(0, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('Himalayas: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching Himalayas for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    for (const keyword of keywords) {
      if (ctx.abortSignal.aborted) break;
      const json = await fetchJson(buildUrl(keyword), { allowedHosts: HIMALAYAS_ALLOWED_HOSTS });
      for (const job of parseHimalayas(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    ctx.emitProgress(`Himalayas: ${total} jobs`, total);
  }
}
