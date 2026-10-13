import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { toMillis, sleep } from './aggregator-util';
import { pickKeywords } from './gated-util';
import { enrichSmartRecruiters } from './smartrecruiters-detail';

// SmartRecruiters' cross-tenant careers search, as opposed to the per-company
// `smartrecruiters` type (api.smartrecruiters.com, needs a tenant slug). Live
// findings: the endpoint returns only the newest 100 matches — `offset`/`page`
// are ignored — and an unquoted multi-word keyword silently matches everything,
// so the keyword is sent as a quoted phrase. `locationType=remote` is honoured;
// `country`/`remote` params are not.
const SR_SEARCH_ALLOWED_HOSTS = ['jobs.smartrecruiters.com'];
const SR_SEARCH_URL = 'https://jobs.smartrecruiters.com/sr-jobs/search';
const MAX_KEYWORDS = 5;
const REQUEST_DELAY_MS = 500;

function buildUrl(keyword: string, remoteOnly: boolean): string {
  const params = new URLSearchParams({ keyword: `"${keyword.replace(/"/g, '')}"` });
  if (remoteOnly) params.set('locationType', 'remote');
  return `${SR_SEARCH_URL}?${params.toString()}`;
}

/**
 * Parse a `/sr-jobs/search` response. The posting URL matches the per-company
 * adapter's (`jobs.smartrecruiters.com/{company.identifier}/{id}`, no title slug,
 * no "/postings/") so a posting seen through both folds on URL. The list payload
 * carries no description, so `jd_text` is omitted (never `''`) and filled in by
 * enrich(). Remote and hybrid flags are surfaced in `location` text because L1
 * reads them from there.
 */
export function parseSmartRecruitersSearch(json: unknown): Job[] {
  const items = (json as { content?: unknown[] })?.content;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = typeof j['name'] === 'string' ? j['name'].trim() : '';
    const id = j['id'];
    const co = j['company'] as Record<string, unknown> | undefined;
    const identifier = typeof co?.['identifier'] === 'string' ? co['identifier'] : '';
    const company = typeof co?.['name'] === 'string' ? co['name'].trim() : '';
    if (!title || !id || !identifier || !company) continue;

    const loc = (j['location'] as Record<string, unknown> | undefined) ?? {};
    const isRemote = loc['remote'] === true;
    const isHybrid = loc['hybrid'] === true;
    // SR fills the city with "Employees can work remotely" for location-less remote roles.
    const place = (typeof j['shortLocation'] === 'string' ? j['shortLocation'] : '')
      .replace(/^employees can work remotely,?\s*/i, '')
      .trim();
    const location = [isRemote ? 'Remote' : '', isHybrid && !isRemote ? 'Hybrid' : '', place]
      .filter(Boolean)
      .join(', ');

    jobs.push({
      external_id: String(id),
      title,
      url: `https://jobs.smartrecruiters.com/${identifier}/${id}`,
      company,
      location,
      remote: isRemote,
      posted_at: toMillis(j['releasedDate']),
    });
  }
  return jobs;
}

export class SmartRecruitersSearchAdapter implements SourceAdapter {
  type = 'smartrecruiters_search' as const;
  salaryFromEnrich = true;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('SmartRecruiters search: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching SmartRecruiters search for ${keywords.join(', ')}…`);

    const remoteOnly = ctx.remoteRequired === true;
    const seen = new Set<string>();
    let total = 0;
    let failures = 0;
    for (const [i, keyword] of keywords.entries()) {
      if (ctx.abortSignal.aborted) break;
      if (i > 0) await sleep(REQUEST_DELAY_MS);
      let json: unknown;
      try {
        json = await fetchJson(buildUrl(keyword, remoteOnly), {
          allowedHosts: SR_SEARCH_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        failures++;
        ctx.emitProgress(`SmartRecruiters search: "${keyword}" request failed`);
        continue;
      }
      for (const job of parseSmartRecruitersSearch(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    if (failures === keywords.length) {
      throw new Error('SmartRecruiters search: all requests failed');
    }
    ctx.emitProgress(`SmartRecruiters search: ${total} jobs`, total);
  }

  enrich(job: Job, ctx: SourceContext): Promise<Partial<Job> | null> {
    return enrichSmartRecruiters(job, ctx);
  }
}
