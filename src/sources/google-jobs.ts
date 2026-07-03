import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';
import { pickKeywords, pickLocation } from './gated-util';

// SerpAPI google_jobs: an honest keyed path to Google's deduplicated cross-board
// job index (LinkedIn, Greenhouse, Lever, Workday, and more in one response).
// Coverage is whatever Google for Jobs indexes; boards that don't participate in
// Google for Jobs won't appear. The user's SerpAPI key lives in the source's
// config_json.apiKey (read via ctx.config, like Workday's site/dc) — never
// hard-coded; an unconfigured source is inert.
const SERPAPI_ALLOWED_HOSTS = ['serpapi.com'];
const MAX_KEYWORDS = 3;

function buildUrl(keyword: string, location: string, apiKey: string): string {
  const params = new URLSearchParams({
    engine: 'google_jobs',
    q: keyword,
    hl: 'en',
    api_key: apiKey,
  });
  if (location) params.set('location', location);
  return `https://serpapi.com/search.json?${params.toString()}`;
}

/**
 * Parse a SerpAPI `google_jobs` response. Jobs live under `jobs_results`; the
 * canonical apply URL is the first `apply_options[].link` (a direct link to the
 * original board), and `description` is plain text. Salary
 * (`detected_extensions.salary`) and posted_at (relative "N days ago") are
 * free-text only in this feed, so they're left unmapped in v1 rather than
 * mis-parsed — L1's salary floor defers on unknown currency and the ghost scorer
 * treats null posted_at as no signal.
 */
export function parseGoogleJobs(json: unknown): Job[] {
  const items = (json as { jobs_results?: unknown[] })?.jobs_results;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = typeof j['title'] === 'string' ? j['title'] : '';
    const company = typeof j['company_name'] === 'string' ? (j['company_name'] as string).trim() : '';

    const applyOptions = j['apply_options'];
    const firstWithLink = Array.isArray(applyOptions)
      ? (applyOptions.find(
          o => typeof (o as Record<string, unknown>)?.['link'] === 'string',
        ) as Record<string, unknown> | undefined)
      : undefined;
    const url = firstWithLink ? (firstWithLink['link'] as string) : '';
    if (!title || !company || !url) continue;

    const description = typeof j['description'] === 'string' ? j['description'] : '';
    const location = typeof j['location'] === 'string' ? j['location'] : '';

    jobs.push({
      external_id: typeof j['job_id'] === 'string' ? j['job_id'] : undefined,
      title,
      url,
      company,
      location,
      remote: /\b(remote|anywhere|work from home)\b/i.test(`${location} ${title}`),
      jd_text: htmlToText(description),
    });
  }
  return jobs;
}

export class GoogleJobsAdapter implements SourceAdapter {
  type = 'google_jobs' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const apiKey =
      typeof ctx.config['apiKey'] === 'string' ? (ctx.config['apiKey'] as string).trim() : '';
    if (!apiKey) {
      ctx.emitProgress('Google Jobs: no SerpAPI key configured — skipping');
      return;
    }
    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('Google Jobs: no title keyword set — skipping');
      return;
    }
    const location = pickLocation(ctx);
    ctx.emitProgress(`Fetching Google Jobs (SerpAPI) for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    for (const keyword of keywords) {
      if (ctx.abortSignal.aborted) break;
      let json: unknown;
      try {
        json = await fetchJson(buildUrl(keyword, location, apiKey), {
          allowedHosts: SERPAPI_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        // A quota/HTTP error on one keyword shouldn't abort the others. Don't echo
        // the error (the request URL carries the api_key) — keep the note generic.
        ctx.emitProgress(`Google Jobs: "${keyword}" request failed (check SerpAPI key/quota)`);
        continue;
      }
      for (const job of parseGoogleJobs(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    ctx.emitProgress(`Google Jobs: ${total} jobs`, total);
  }
}
