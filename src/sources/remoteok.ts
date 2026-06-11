import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, matchesAny } from './aggregator-util';

const REMOTEOK_ALLOWED_HOSTS = ['remoteok.com'];
const REMOTEOK_URL = 'https://remoteok.com/api';
// RemoteOK 403s requests without a browser-ish User-Agent.
const REMOTEOK_HEADERS = { 'User-Agent': 'lantern-job-search/1.0 (+https://localhost)' };

/**
 * Parse the RemoteOK `/api` array, keeping only postings whose title or tags
 * match a keyword. RemoteOK has no server-side search, so filtering is
 * client-side. The first array element is a legal/metadata notice (no
 * `position`) and is skipped. Every RemoteOK posting is remote.
 */
export function parseRemoteOk(json: unknown, keywords: string[]): Job[] {
  if (!Array.isArray(json)) return [];

  const jobs: Job[] = [];
  for (const it of json) {
    const j = it as Record<string, unknown>;
    const title = (j['position'] as string) ?? '';
    const url = (j['url'] as string) ?? '';
    const company = (j['company'] as string)?.trim() ?? '';
    if (!title || !url || !company) continue; // skips the legal notice element

    const tags = Array.isArray(j['tags']) ? (j['tags'] as string[]) : [];
    if (!matchesAny(keywords, title, tags)) continue;

    const salaryMin = j['salary_min'];
    const salaryMax = j['salary_max'];
    jobs.push({
      external_id: String(j['id'] ?? ''),
      title,
      url,
      company,
      location: (j['location'] as string) ?? '',
      remote: true,
      salary_min_usd: typeof salaryMin === 'number' && salaryMin > 0 ? Math.round(salaryMin) : null,
      salary_max_usd: typeof salaryMax === 'number' && salaryMax > 0 ? Math.round(salaryMax) : null,
      salary_currency: 'USD', // RemoteOK lists compensation in USD

      posted_at: toMillis(j['epoch'] ?? j['date']),
      jd_text: htmlToText(j['description'] as string),
    });
  }
  return jobs;
}

export class RemoteOkAdapter implements SourceAdapter {
  type = 'remoteok' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('RemoteOK: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching RemoteOK for ${keywords.join(', ')}…`);

    const json = await fetchJson(REMOTEOK_URL, {
      allowedHosts: REMOTEOK_ALLOWED_HOSTS,
      headers: REMOTEOK_HEADERS,
    });
    const jobs = parseRemoteOk(json, keywords);
    for (const job of jobs) {
      if (ctx.abortSignal.aborted) break;
      yield job;
    }
    ctx.emitProgress(`RemoteOK: ${jobs.length} jobs`, jobs.length);
  }
}
