import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, matchesAny, decodeEntities } from './aggregator-util';

const REMOTEOK_ALLOWED_HOSTS = ['remoteok.com'];
const REMOTEOK_URL = 'https://remoteok.com/api';
// RemoteOK 403s requests without a browser-ish User-Agent.
const REMOTEOK_HEADERS = { 'User-Agent': 'lantern-job-search/1.0 (+https://localhost)' };
// RemoteOK tags are single words; a multi-word keyword ("senior backend") can't
// map to one tag, so only single-word keywords get a scoped fetch on top of the
// main feed. `?tag=` is real server-side search (e.g. 23 tagged "flutter"
// postings vs. 1 substring match in the main feed's newest ~99 jobs).
const MAX_TAG_KEYWORDS = 5;

/**
 * Parse a RemoteOK `/api` array (either the unscoped main feed or a `?tag=`
 * scoped response — same shape), keeping only postings whose title or tags
 * match a keyword. `?tag=` is real server-side search, but it only takes one
 * single-word tag per request, so the client-side `matchesAny` filter still
 * runs on every payload (main feed and tag-scoped alike) as the single source
 * of truth for "does this posting match the search". The first array element
 * is a legal/metadata notice (no `position`) and is skipped. Every RemoteOK
 * posting is remote. Title/company go through `decodeEntities` — RemoteOK's
 * feed carries literal entities like "Transportation Partners &amp; Logistics".
 */
export function parseRemoteOk(json: unknown, keywords: string[]): Job[] {
  if (!Array.isArray(json)) return [];

  const jobs: Job[] = [];
  for (const it of json) {
    const j = it as Record<string, unknown>;
    const title = decodeEntities((j['position'] as string) ?? '');
    const url = (j['url'] as string) ?? '';
    const company = decodeEntities((j['company'] as string) ?? '').trim();
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
      jd_text: htmlToText(j['description'] as string) || undefined,
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

    const tagKeywords = keywords.filter(k => !/\s/.test(k)).slice(0, MAX_TAG_KEYWORDS);
    const requests: Array<{ label: string; url: string }> = [
      { label: 'main feed', url: REMOTEOK_URL },
      ...tagKeywords.map(kw => ({
        label: `tag "${kw}"`,
        url: `${REMOTEOK_URL}?tag=${encodeURIComponent(kw)}`,
      })),
    ];

    const merged = new Map<string, Job>();
    let failures = 0;
    for (const req of requests) {
      if (ctx.abortSignal.aborted) break;
      let json: unknown;
      try {
        json = await fetchJson(req.url, {
          allowedHosts: REMOTEOK_ALLOWED_HOSTS,
          headers: REMOTEOK_HEADERS,
          // One big payload (all jobs); give it room rather than aborting at the 10s default.
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        failures++;
        ctx.emitProgress(`RemoteOK: ${req.label} request failed`);
        continue;
      }
      for (const job of parseRemoteOk(json, keywords)) {
        merged.set(job.external_id || job.url, job);
      }
    }
    if (failures === requests.length) {
      throw new Error(`RemoteOK: all ${requests.length} requests failed`);
    }

    const jobs = [...merged.values()];
    for (const job of jobs) {
      if (ctx.abortSignal.aborted) break;
      yield job;
    }
    ctx.emitProgress(`RemoteOK: ${jobs.length} jobs`, jobs.length);
  }
}
