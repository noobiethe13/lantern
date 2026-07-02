import { load as cheerioLoad } from 'cheerio';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchText } from '../core/fetch';
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
// JD enrichment: guest cards carry no description, so we fetch each posting's
// keyless detail fragment for jd_text. That adds a request per posting to a host
// that rate-limits aggressively, so it's capped per run and spaced; past the cap
// jobs yield with null jd_text (an adapter gap, not a ghost flag).
const MAX_ENRICH = 50;
const DETAIL_DELAY_MS = 1_500;

function buildUrl(keyword: string, location: string, start: number): string {
  const params = new URLSearchParams({ keywords: keyword, start: String(start) });
  if (location) params.set('location', location);
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
 * The guest cards carry NO description or salary — those need a per-posting
 * fetch. jd_text is deliberately omitted here (left null) rather than set to ''
 * so the legitimacy scorer treats it as an adapter gap, not a "no description"
 * ghost flag (see core/legitimacy.ts). The JD is filled in separately by the
 * adapter via `parseLinkedInDetail` + the capped per-posting fetch in `fetch`,
 * using the keyless guest detail endpoint.
 */
export function parseLinkedIn(html: string): Job[] {
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
    const location = clean($li.find('span.job-search-card__location').first().text());
    const datetime = $li.find('time[datetime]').first().attr('datetime');

    if (!title || !url || !company) return;

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

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = pickKeywords(ctx, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('LinkedIn: no title keyword set — skipping');
      return;
    }
    const location = pickLocation(ctx);
    ctx.emitProgress(`Fetching LinkedIn (guest) for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let enriched = 0;
    let detailFails = 0;

    for (const keyword of keywords) {
      for (let page = 0; page < MAX_PAGES; page++) {
        if (ctx.abortSignal.aborted) return;
        if (total > 0 || page > 0) await sleep(PAGE_DELAY_MS);

        const url = buildUrl(keyword, location, page * PAGE_SIZE);
        // retries cover the 429s LinkedIn throws on bursts (Retry-After aware).
        const html = await fetchText(url, {
          allowedHosts: LINKEDIN_ALLOWED_HOSTS,
          headers: REQUEST_HEADERS,
          retries: 2,
        });

        const jobs = parseLinkedIn(html);
        if (jobs.length === 0) break; // empty page = end of results for this keyword

        for (const job of jobs) {
          if (seen.has(job.url)) continue;
          seen.add(job.url);
          total++;

          // Enrich with the posting's JD via the keyless detail endpoint, capped
          // per run to bound request volume on a rate-limiting host.
          if (enriched < MAX_ENRICH && job.external_id) {
            enriched++;
            await sleep(DETAIL_DELAY_MS);
            try {
              const detailHtml = await fetchText(detailUrl(job.external_id), {
                allowedHosts: LINKEDIN_ALLOWED_HOSTS,
                headers: REQUEST_HEADERS,
                retries: 2,
              });
              const jd = parseLinkedInDetail(detailHtml);
              if (jd) job.jd_text = jd;
            } catch {
              detailFails++; // recoverable: yield with jd_text null (adapter gap)
            }
          }

          yield job;
        }
      }
    }

    const jdNote = enriched ? `, ${enriched - detailFails}/${enriched} JDs` : '';
    ctx.emitProgress(`LinkedIn: ${total} jobs${jdNote}`, total);
  }
}
