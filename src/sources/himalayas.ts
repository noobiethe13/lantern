import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, sleep } from './aggregator-util';
import { pickLocation } from './gated-util';
import { annualizePay } from '../core/salary';

const HIMALAYAS_ALLOWED_HOSTS = ['himalayas.app'];
// The API silently caps `limit` at 20 regardless of what's requested, so
// pagination (not a bigger limit) is how we get past the first 20 of a
// keyword's results (e.g. 188 total for "flutter", only 18-20 per page).
const MAX_PAGES = 5;
const PAGE_DELAY_MS = 500;
const MAX_KEYWORDS = 5;

interface HimalayasPage {
  offset?: number;
  limit?: number;
  totalCount?: number;
  jobs?: unknown[];
}

function buildUrl(keyword: string, page: number, country?: string): string {
  const params = new URLSearchParams({ q: keyword });
  if (page > 1) params.set('page', String(page));
  if (country) params.set('country', country);
  return `https://himalayas.app/jobs/api/search?${params.toString()}`;
}

/**
 * Parse a Himalayas `/jobs/api/search` response page. Jobs live under `jobs`;
 * the apply URL is `applicationLink` and the stable id is `guid`. Himalayas is
 * a remote-only board, but `locationRestrictions` still narrows WHO can be
 * hired: an empty array means hire-anywhere ("Worldwide"), not "unknown".
 * Salary is annualised from `salaryPeriod` (core/salary.ts), so an hourly or
 * weekly rate is never mis-read as a yearly one; an unknown period is dropped.
 */
export function parseHimalayas(json: unknown): Job[] {
  const items = (json as HimalayasPage)?.jobs;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = (j['title'] as string) ?? '';
    const url = (j['applicationLink'] as string) ?? '';
    const company = (j['companyName'] as string)?.trim() ?? '';
    if (!title || !url || !company) continue;

    const currency = typeof j['currency'] === 'string' ? (j['currency'] as string) : null;
    const minSalary = j['minSalary'];
    const maxSalary = j['maxSalary'];
    const pay = annualizePay(
      typeof minSalary === 'number' ? minSalary : null,
      typeof maxSalary === 'number' ? maxSalary : null,
      j['salaryPeriod'],
      currency,
    );
    const locations = j['locationRestrictions'];

    jobs.push({
      external_id: String(j['guid'] ?? ''),
      title,
      url,
      company,
      location: Array.isArray(locations) ? (locations.length > 0 ? locations.join(', ') : 'Worldwide') : '',
      remote: true,
      // Keep the native amount + its currency tag rather than dropping non-USD
      // pay (L1 only compares like-for-like currencies; the rest defers to L2).
      salary_min_usd: pay?.min ?? null,
      salary_max_usd: pay?.max ?? null,
      salary_currency: pay ? currency : null,
      posted_at: toMillis(j['pubDate']),
      jd_text: htmlToText(j['description'] as string) || undefined,
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
    // A named place (e.g. "India") scopes results to who's eligible there,
    // instead of a global firehose mostly restricted to other countries.
    const namedLocation = pickLocation(ctx);
    ctx.emitProgress(`Fetching Himalayas for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;

    for (const keyword of keywords) {
      if (ctx.abortSignal.aborted) break;
      let country = namedLocation || undefined;

      for (let page = 1; page <= MAX_PAGES; page++) {
        if (ctx.abortSignal.aborted) break;
        if (page > 1) await sleep(PAGE_DELAY_MS);

        attempts++;
        let json: HimalayasPage;
        try {
          json = (await fetchJson(buildUrl(keyword, page, country), {
            allowedHosts: HIMALAYAS_ALLOWED_HOSTS,
            // Aggregators can be slow; without this they hit the 10s default and abort.
            timeoutMs: 30_000,
            retries: 2,
          })) as HimalayasPage;
        } catch {
          failures++;
          // The named location may be a city Himalayas doesn't recognise as a
          // country — retry this same page once unscoped before giving up on it.
          if (country) {
            country = undefined;
            page--;
            continue;
          }
          ctx.emitProgress(`Himalayas: "${keyword}" page ${page} request failed`);
          break;
        }

        if (country && (json.totalCount ?? 0) === 0) {
          country = undefined;
          page--;
          continue;
        }

        for (const job of parseHimalayas(json)) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          total++;
          yield job;
        }

        // Pages intermittently come back short of `limit` mid-list (e.g. 18/20 at
        // totalCount 188) without that meaning the list is exhausted — stop on an
        // actually-empty page or once offset+limit reaches totalCount, not on a
        // merely-short one (that used to end pagination early, before the last
        // page's worth of results).
        const rawLen = json.jobs?.length ?? 0;
        const limit = json.limit ?? 20;
        const offset = json.offset ?? 0;
        const totalCount = json.totalCount ?? 0;
        if (rawLen === 0 || offset + limit >= totalCount) break;
      }
    }

    if (attempts > 0 && failures === attempts) {
      throw new Error('Himalayas: all requests failed');
    }
    ctx.emitProgress(`Himalayas: ${total} jobs`, total);
  }
}
