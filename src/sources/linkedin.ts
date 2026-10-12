import { load as cheerioLoad } from 'cheerio';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchText, HttpStatusError } from '../core/fetch';
import { placesIn } from '../core/geo';
import { htmlToText, toMillis } from './aggregator-util';
import { GATED_USER_AGENT, pickKeywords, pickLocation, sleep, stripUrlQuery } from './gated-util';

const LINKEDIN_ALLOWED_HOSTS = ['www.linkedin.com'];
// The guest job-search endpoint returns ~10 HTML cards per page (no auth).
const PAGE_SIZE = 10;
const MAX_PAGES = 8; // ≤80 postings per keyword — politeness cap
const MAX_KEYWORDS = 3; // bound total request volume across keywords
// LinkedIn 429s on bursty guest traffic; space requests and back off on 429.
const PAGE_DELAY_MS = 3_500;
const REQUEST_HEADERS = { 'User-Agent': GATED_USER_AGENT };
// Spacing before each enrich() detail fetch (see CONTRACT C9 in core/job.ts).
const DETAIL_DELAY_MS = 1_500;
// LinkedIn's guest detail endpoint sends no Retry-After, so a 429 (or a run of
// failures) means "back off for the rest of this run" rather than "retry" —
// see enrich()'s circuit breaker.
const MAX_CONSECUTIVE_ENRICH_FAILURES = 3;

function buildUrl(keyword: string, location: string, start: number, ctx: SourceContext): string {
  const params = new URLSearchParams({ keywords: keyword, start: String(start) });
  if (location) {
    params.set('location', location);
  } else if (ctx.remoteRequired) {
    // LinkedIn's `location` text field doesn't recognise "Remote" as a place;
    // `f_WT=2` is its own remote-work-type filter, used when no specific place
    // was named in the criteria.
    params.set('f_WT', '2');
  }
  if (ctx.maxAgeDays) {
    params.set('f_TPR', `r${ctx.maxAgeDays * 86_400}`);
  }
  return `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;
}

function detailUrl(id: string): string {
  return `https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${encodeURIComponent(id)}`;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a LinkedIn guest job-search HTML fragment (`seeMoreJobPostings/search`).
 * Each posting is a `li > div.base-card.base-search-card` with the job id in
 * `data-entity-urn`, the apply link in `a.base-card__full-link`, and title /
 * company / location / posted-date in their `base-search-card__*` children.
 *
 * `searchedLocation` (the place actually sent to the search, if any) augments
 * ambiguous card locations: LinkedIn's metro-area labels ("Mumbai Metropolitan
 * Region", "Greater Lucknow Area", "Greater Ahmedabad Area") name no country,
 * so L1's location allow-list would otherwise drop them even when they're
 * within the searched place. It's appended as `"${card}, ${searched}"` only
 * when the gazetteer (src/core/geo.ts placesIn) resolves NO place at all in the
 * card location — a card that already names a real place (however different in
 * spelling from the searched term) is never appended to.
 *
 * The guest cards carry NO description or salary — those need a per-posting
 * fetch. jd_text is deliberately omitted here (left undefined) rather than set
 * to '' so the legitimacy scorer treats it as an adapter gap, not a "no
 * description" ghost flag (see core/legitimacy.ts). The JD is filled in
 * separately via `enrich()` + `parseLinkedInDetail`, called by the runner only
 * for L1 survivors (CONTRACT C9 in core/job.ts) — not for every card here.
 */
export function parseLinkedIn(html: string, searchedLocation?: string): Job[] {
  const $ = cheerioLoad(html);
  const jobs: Job[] = [];

  $('li').each((_, li) => {
    const $li = $(li);
    const card = $li.find('div.base-card').first();

    const urn = card.attr('data-entity-urn') ?? '';
    const id = urn.split(':').pop() ?? '';

    const url = stripUrlQuery($li.find('a.base-card__full-link').attr('href'));
    const title = clean($li.find('h3.base-search-card__title').first().text());
    const company = clean($li.find('h4.base-search-card__subtitle a').first().text())
      || clean($li.find('h4.base-search-card__subtitle').first().text());
    const cardLocation = clean($li.find('span.job-search-card__location').first().text());
    const datetime = $li.find('time[datetime]').first().attr('datetime');

    if (!title || !url || !company) return;

    const location =
      searchedLocation && cardLocation && placesIn(cardLocation).size === 0
        ? `${cardLocation}, ${searchedLocation}`
        : cardLocation;

    jobs.push({
      external_id: id,
      title,
      url,
      company,
      location,
      remote: /\bremote\b/i.test(`${title} ${location}`),
      posted_at: toMillis(datetime),
    });
  });

  return jobs;
}

/**
 * Extract the job description from a guest `jobPosting/{id}` detail fragment.
 * The JD lives in `.show-more-less-html__markup` (fallback `.description__text`).
 * Returns null when absent so the caller leaves jd_text null (not '') — the
 * legitimacy scorer reads null as an adapter gap, '' as a "no JD" ghost flag.
 */
export function parseLinkedInDetail(html: string): string | null {
  const $ = cheerioLoad(html);
  const markup =
    $('.show-more-less-html__markup').first().html() ??
    $('.description__text').first().html();
  const text = htmlToText(markup);
  return text || null;
}

export class LinkedInAdapter implements SourceAdapter {
  type = 'linkedin' as const;

  // Per-run enrichment circuit breaker (see MAX_CONSECUTIVE_ENRICH_FAILURES).
  // Reset at the top of fetch(), which the runner calls once per run; the
  // adapter itself is a long-lived singleton (src/sources/index.ts), so this
  // state must not leak into the next run.
  private enrichDisabled = false;
  private consecutiveEnrichFailures = 0;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    this.enrichDisabled = false;
    this.consecutiveEnrichFailures = 0;

    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('LinkedIn: no title keyword set — skipping');
      return;
    }
    const location = pickLocation(ctx);
    ctx.emitProgress(`Fetching LinkedIn (guest) for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;

    for (const keyword of keywords) {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (ctx.abortSignal.aborted) return;
        if (total > 0 || page > 0) await sleep(PAGE_DELAY_MS);

        const url = buildUrl(keyword, location, page * PAGE_SIZE, ctx);
        attempts++;
        let html: string;
        try {
          // retries cover the 429s LinkedIn throws on bursts (Retry-After aware).
          html = await fetchText(url, {
            allowedHosts: LINKEDIN_ALLOWED_HOSTS,
            headers: REQUEST_HEADERS,
            retries: 2,
          });
        } catch {
          failures++;
          // A failed page must not abort the remaining keywords — move on to the
          // next keyword instead (matches himalayas/jobicy's per-keyword isolation).
          ctx.emitProgress(`LinkedIn: "${keyword}" page ${page + 1} request failed`);
          break;
        }

        const jobs = parseLinkedIn(html, location);
        if (jobs.length === 0) break; // empty page = end of results for this keyword

        for (const job of jobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          total++;
          yield job;
        }
      }
    }

    if (attempts > 0 && failures === attempts) {
      throw new Error('LinkedIn: all requests failed');
    }
    ctx.emitProgress(`LinkedIn: ${total} jobs`, total);
  }

  /**
   * Fetch a posting's JD via the keyless guest detail endpoint. Per CONTRACT
   * C9 (core/job.ts), the runner calls this only for jobs that passed L1 —
   * not for every card `fetch()` yields, most of which L1 drops. Self-disables
   * for the rest of the run after a 429 or three consecutive failures, since
   * LinkedIn sends no Retry-After and retrying every remaining job individually
   * would burn dozens more requests into a host that's already rate-limiting
   * us (each call here costs exactly one request — no internal retry).
   */
  async enrich(job: Job, _ctx: SourceContext): Promise<Partial<Job> | null> {
    if (this.enrichDisabled || !job.external_id) return null;
    await sleep(DETAIL_DELAY_MS);
    try {
      const html = await fetchText(detailUrl(job.external_id), {
        allowedHosts: LINKEDIN_ALLOWED_HOSTS,
        headers: REQUEST_HEADERS,
        // A failed attempt counts toward the circuit breaker below, not a retry.
        retries: 0,
      });
      this.consecutiveEnrichFailures = 0;
      const jd = parseLinkedInDetail(html);
      return jd ? { jd_text: jd } : null;
    } catch (err) {
      if (err instanceof HttpStatusError && err.status === 429) {
        this.enrichDisabled = true;
      } else if (++this.consecutiveEnrichFailures >= MAX_CONSECUTIVE_ENRICH_FAILURES) {
        this.enrichDisabled = true;
      }
      return null;
    }
  }
}
