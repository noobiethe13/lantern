import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, matchesAny, sleep } from './aggregator-util';

const ARBEITNOW_ALLOWED_HOSTS = ['www.arbeitnow.com'];
const ARBEITNOW_URL = 'https://www.arbeitnow.com/api/job-board-api';
// Page 1 alone is ~250 jobs / ~28h of postings; links.next chains forward from
// there. Bounded politeness cap, not "fetch the whole history".
const MAX_PAGES = 6;
const PAGE_DELAY_MS = 1_000;

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
      jd_text: htmlToText(j['description'] as string) || undefined,
    });
  }
  return jobs;
}

/** The full `links`/`meta` envelope around `data`, for pagination. */
interface ArbeitnowPage {
  data?: unknown[];
  links?: { next?: string | null };
}

function nextPageUrl(json: unknown): string | null {
  const next = (json as ArbeitnowPage)?.links?.next;
  return typeof next === 'string' ? next : null;
}

/** Oldest `created_at` (ms) among a page's raw items, or null if none parse. */
function oldestCreatedAtMs(json: unknown): number | null {
  const items = (json as ArbeitnowPage)?.data;
  if (!Array.isArray(items)) return null;
  let oldest: number | null = null;
  for (const it of items) {
    const ms = toMillis((it as Record<string, unknown>)['created_at']);
    if (ms !== null && (oldest === null || ms < oldest)) oldest = ms;
  }
  return oldest;
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

    const cutoffMs = ctx.maxAgeDays ? Date.now() - ctx.maxAgeDays * 86_400_000 : null;
    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;
    let url: string | null = ARBEITNOW_URL;

    for (let page = 0; page < MAX_PAGES && url; page++) {
      if (ctx.abortSignal.aborted) break;
      if (page > 0) await sleep(PAGE_DELAY_MS);

      attempts++;
      let json: unknown;
      try {
        json = await fetchJson(url, {
          allowedHosts: ARBEITNOW_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        failures++;
        ctx.emitProgress(`Arbeitnow: page ${page + 1} request failed`);
        break; // links.next chains forward from the response we don't have
      }

      for (const job of parseArbeitnow(json, keywords)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }

      const oldest = oldestCreatedAtMs(json);
      if (cutoffMs !== null && oldest !== null && oldest < cutoffMs) break; // page is past the freshness window
      url = nextPageUrl(json);
    }

    if (attempts > 0 && failures === attempts) {
      throw new Error('Arbeitnow: all page requests failed');
    }
    ctx.emitProgress(`Arbeitnow: ${total} jobs`, total);
  }
}
