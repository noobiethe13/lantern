import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, sleep } from './aggregator-util';
import { pickKeywords } from './gated-util';

// Sweden's public employment service (Arbetsförmedlingen / JobTech Dev). Keyless
// and keyword-searchable via `q`. The API caps `limit` at 100 and `offset` at 2000.
const JOBTECH_ALLOWED_HOSTS = ['jobsearch.api.jobtechdev.se'];
const PAGE_LIMIT = 100;
const MAX_PAGES = 3;
const PAGE_DELAY_MS = 500;
const MAX_KEYWORDS = 5;
const MAX_LOCATIONS = 3;

interface JobTechPage {
  total?: { value?: number };
  hits?: unknown[];
}

function buildUrl(keyword: string, page: number): string {
  const params = new URLSearchParams({
    q: keyword,
    limit: String(PAGE_LIMIT),
    offset: String((page - 1) * PAGE_LIMIT),
    // Newest first: with a bounded page budget, recent postings beat the
    // relevance tail (the freshness gate would drop the stale ones anyway).
    sort: 'pubdate-desc',
  });
  return `https://jobsearch.api.jobtechdev.se/search?${params.toString()}`;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** Distinct municipalities (≤ {@link MAX_LOCATIONS}) plus the country, e.g.
 *  "Stockholm, Göteborg, Sweden". The API is Sweden-only, so a posting with no
 *  address at all is still "Sweden" rather than unknown. */
function locationOf(hit: Record<string, unknown>): string {
  const addrs = Array.isArray(hit['workplace_addresses']) && hit['workplace_addresses'].length > 0
    ? (hit['workplace_addresses'] as Record<string, unknown>[])
    : [hit['workplace_address'] as Record<string, unknown> | null | undefined];

  const places: string[] = [];
  let country = '';
  for (const a of addrs) {
    if (!a) continue;
    const place = str(a['municipality']) || str(a['city']);
    if (place && !places.includes(place)) places.push(place);
    country ||= str(a['country']);
  }
  const countryName = !country || country === 'Sverige' ? 'Sweden' : country;
  return [...places.slice(0, MAX_LOCATIONS), countryName].join(', ');
}

/** `workplace_model` is null for most postings (not stated), so only an explicit
 *  distance/on-site label sets the flag — unknown stays undefined. */
function remoteOf(hit: Record<string, unknown>): boolean | undefined {
  const label = str((hit['workplace_model'] as Record<string, unknown> | null)?.['label']).toLowerCase();
  if (label.includes('distans')) return true;
  if (label.includes('på plats')) return false;
  return undefined;
}

/** Publication timestamps carry no zone. They are Swedish local time, which is
 *  UTC+1/+2; reading them as UTC is off by at most 2h, which is harmless for
 *  freshness, and avoids depending on the host machine's timezone. */
function publishedAt(v: unknown): number | null {
  const s = str(v);
  if (!s) return null;
  return toMillis(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
}

/**
 * Parse a JobTech `/search` response. The public posting lives on
 * arbetsformedlingen.se (`webpage_url`, with an id-derived fallback). Many ads
 * are in Swedish and are passed through untranslated. Salary is deliberately
 * left null: `salary_description` is free text and `salary_type` only says
 * "fixed monthly pay", never an amount. Withdrawn ads (`removed`) are skipped.
 */
export function parseJobTech(json: unknown): Job[] {
  const hits = (json as JobTechPage)?.hits;
  if (!Array.isArray(hits)) return [];

  const jobs: Job[] = [];
  for (const it of hits) {
    const h = it as Record<string, unknown>;
    if (h['removed'] === true) continue;
    const id = str(h['id']);
    const title = str(h['headline']);
    const employer = (h['employer'] ?? {}) as Record<string, unknown>;
    const company = str(employer['name']) || str(employer['workplace']);
    const page = str(h['webpage_url']);
    // The URL is rendered as a link in the UI, so only an https one is trusted.
    const url = page.startsWith('https://') ? page : id ? `https://arbetsformedlingen.se/platsbanken/annonser/${id}` : '';
    if (!title || !company || !url) continue;

    const desc = (h['description'] ?? {}) as Record<string, unknown>;
    jobs.push({
      external_id: id || undefined,
      title,
      url,
      company,
      location: locationOf(h),
      remote: remoteOf(h),
      posted_at: publishedAt(h['publication_date']),
      jd_text: htmlToText((desc['text_formatted'] ?? desc['text']) as string) || undefined,
    });
  }
  return jobs;
}

export class JobTechAdapter implements SourceAdapter {
  type = 'jobtech' as const;

  constructor(private readonly requestDelayMs: number = PAGE_DELAY_MS) {}

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('JobTech: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching JobTech (Sweden) for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;

    for (const keyword of keywords) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        if (ctx.abortSignal.aborted) return;
        if (attempts > 0) await sleep(this.requestDelayMs);

        attempts++;
        let json: JobTechPage;
        try {
          json = (await fetchJson(buildUrl(keyword, page), {
            allowedHosts: JOBTECH_ALLOWED_HOSTS,
            timeoutMs: 30_000,
            retries: 2,
          })) as JobTechPage;
        } catch {
          failures++;
          ctx.emitProgress(`JobTech: "${keyword}" page ${page} request failed`);
          break;
        }

        for (const job of parseJobTech(json)) {
          // No title prefilter: `q` already scoped the results (title or description
          // match), and a generic title is exactly what semantic rescue recovers.
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          total++;
          yield job;
        }

        const rawLen = Array.isArray(json.hits) ? json.hits.length : 0;
        if (rawLen < PAGE_LIMIT || page * PAGE_LIMIT >= (json.total?.value ?? 0)) break;
      }
    }

    if (attempts > 0 && failures === attempts) {
      throw new Error('JobTech: all requests failed');
    }
    ctx.emitProgress(`JobTech: ${total} jobs`, total);
  }
}
