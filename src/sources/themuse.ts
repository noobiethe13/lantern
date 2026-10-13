import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, sleep, postingMatchesKeywords } from './aggregator-util';

// The Muse public API has no free-text search, only category / location / level
// filters, and its ordering is neither recency nor relevance (`descending=true`
// reshuffles the pages but does not sort by date — live-checked). So keywords are
// mapped to Muse categories, results are scoped by location, and the pages are
// keyword-filtered client-side. Unmapped keywords yield nothing rather than paging
// a ~400k-job firehose.
const MUSE_ALLOWED_HOSTS = ['www.themuse.com'];
const MUSE_URL = 'https://www.themuse.com/api/public/jobs';
// CloudFront in front of the API 403s some default client User-Agents.
const MUSE_HEADERS = { 'User-Agent': 'lantern-job-search/1.0 (+https://localhost)' };
const REMOTE_LOCATION = 'Flexible / Remote';
const MAX_CATEGORIES = 3;
const MAX_NAMED_LOCATIONS = 2;
// 20 jobs per page, 0-based. Politeness bound, not "fetch everything": a big
// category like remote Software Engineering spans ~40 pages.
const MAX_PAGES = 15;
const PAGE_DELAY_MS = 600;

// Category names are Muse's own (live-probed). A keyword can hit several rows;
// categoriesForKeywords ranks categories by how many keywords hit them.
const CATEGORY_RULES: Array<[RegExp, string[]]> = [
  [/\b(software|developer|programmer|engineer|backend|back.?end|frontend|front.?end|full.?stack|devops|sre|mobile|ios|android|web|api|platform|react|node|python|java|golang|rust|flutter|qa|sdet)\b/, ['Software Engineering']],
  [/\b(it|sysadmin|network|security|infrastructure|cloud|helpdesk|support engineer)\b/, ['Computer and IT']],
  [/\b(data|analytics|analyst|bi|machine learning|ml|ai|scientist)\b/, ['Data and Analytics']],
  [/\b(design|designer|ux|ui)\b/, ['Design and UX']],
  [/\bproduct\b/, ['Product Management']],
  [/\b(project|program|scrum|delivery)\b/, ['Project Management']],
  [/\b(sales|account executive|business development|sdr|bdr)\b/, ['Sales']],
  [/\baccount manager\b/, ['Account Management']],
  [/\b(customer|support|success)\b/, ['Customer Service']],
  [/\b(marketing|seo|growth|brand)\b/, ['Advertising and Marketing']],
  [/\b(writer|copywriter|editor|content)\b/, ['Writing and Editing']],
  [/\b(recruiter|hr|talent|people)\b/, ['Human Resources and Recruitment']],
  [/\b(finance|financial|accountant|accounting|controller)\b/, ['Accounting and Finance']],
  [/\b(legal|counsel|paralegal|compliance)\b/, ['Legal Services']],
  [/\b(operations|ops)\b/, ['Business Operations']],
  [/\b(mechanical|electrical|civil|hardware|embedded|firmware)\b/, ['Science and Engineering']],
];

/** Muse categories to query for these keywords, most-matched first, capped. */
export function categoriesForKeywords(keywords: string[]): string[] {
  const hits = new Map<string, number>();
  for (const kw of keywords) {
    const text = kw.toLowerCase();
    for (const [rx, cats] of CATEGORY_RULES) {
      if (!rx.test(text)) continue;
      for (const c of cats) hits.set(c, (hits.get(c) ?? 0) + 1);
    }
  }
  return [...hits.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, MAX_CATEGORIES);
}

// Muse location names are exact "City, Country" / "City, ST" strings
// ("Bangalore, India", "London, United Kingdom", "New York, NY"). There is no
// country- or region-level location: an unrecognised value ("India", "Bangalore")
// is silently ignored and the query falls back to remote-only. And a recognised
// city query also returns the remote jobs. So only criteria locations already in
// that two-part shape can be passed through; mapping "India" -> Muse's city
// spellings would need a Muse-specific city table.
const MUSE_PLACE_RX = /^[^,]+,\s*[^,]+$/;

/** Locations to query: always remote, plus up to two named places in Muse's
 *  "City, Country" format when the search doesn't require remote. */
export function museLocations(ctx: Pick<SourceContext, 'locations' | 'remoteRequired'>): string[] {
  if (ctx.remoteRequired) return [REMOTE_LOCATION];
  const named = (ctx.locations ?? [])
    .map(l => l.trim())
    .filter(l => MUSE_PLACE_RX.test(l));
  return [REMOTE_LOCATION, ...new Set(named)].slice(0, 1 + MAX_NAMED_LOCATIONS);
}

function buildUrl(category: string, location: string, page: number): string {
  const params = new URLSearchParams({ category, location, page: String(page) });
  return `${MUSE_URL}?${params.toString()}`;
}

interface MusePage {
  page?: number;
  page_count?: number;
  results?: unknown[];
}

function namesOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map(x => (x as { name?: unknown })?.name)
    .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    .map(n => n.trim());
}

/**
 * Parse a Muse `/api/public/jobs` page, keeping postings whose title or description
 * whole-word matches a keyword. The apply URL is `refs.landing_page`, the body is HTML `contents`,
 * and `publication_date` is ISO. A `Flexible / Remote` entry in `locations`
 * marks the job remote and is rendered as plain "Remote"; any other entries are
 * the posting's listed offices, kept so L1's remote-eligibility rule can see a
 * regional restriction. Muse publishes no salary.
 */
export function parseMuse(json: unknown, keywords: string[]): Job[] {
  const items = (json as MusePage)?.results;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = typeof j['name'] === 'string' ? j['name'].trim() : '';
    const refs = j['refs'] as Record<string, unknown> | undefined;
    const url = typeof refs?.['landing_page'] === 'string' ? refs['landing_page'] : '';
    const company = (j['company'] as { name?: unknown } | undefined)?.name;
    const companyName = typeof company === 'string' ? company.trim() : '';
    if (!title || !url || !companyName) continue;
    const jd = htmlToText(j['contents'] as string) || undefined;
    if (!postingMatchesKeywords(keywords, title, jd)) continue;

    const names = namesOf(j['locations']);
    const remote = names.some(n => n.toLowerCase() === REMOTE_LOCATION.toLowerCase());
    const location = names.map(n => (n.toLowerCase() === REMOTE_LOCATION.toLowerCase() ? 'Remote' : n)).join(', ');

    jobs.push({
      external_id: String(j['id'] ?? ''),
      title,
      url,
      company: companyName,
      location,
      remote,
      posted_at: toMillis(j['publication_date']),
      jd_text: jd,
    });
  }
  return jobs;
}

export class TheMuseAdapter implements SourceAdapter {
  type = 'themuse' as const;

  constructor(private readonly requestDelayMs: number = PAGE_DELAY_MS) {}

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('The Muse: no title keyword set — skipping');
      return;
    }
    const categories = categoriesForKeywords(keywords);
    if (categories.length === 0) {
      ctx.emitProgress('The Muse: no matching job category for these keywords — skipping');
      return;
    }
    const locations = museLocations(ctx);
    ctx.emitProgress(`Fetching The Muse (${categories.join(', ')})…`);

    const seen = new Set<string>();
    let total = 0;
    let attempts = 0;
    let failures = 0;

    for (const category of categories) {
      for (const location of locations) {
        for (let page = 0; page < MAX_PAGES; page++) {
          if (ctx.abortSignal.aborted) return;
          // Every request after the first, including a new category's first page.
          if (attempts > 0) await sleep(this.requestDelayMs);

          attempts++;
          let json: MusePage;
          try {
            json = (await fetchJson(buildUrl(category, location, page), {
              allowedHosts: MUSE_ALLOWED_HOSTS,
              headers: MUSE_HEADERS,
              timeoutMs: 30_000,
              retries: 2,
            })) as MusePage;
          } catch {
            failures++;
            ctx.emitProgress(`The Muse: "${category}" (${location}) page ${page} request failed`);
            break;
          }

          for (const job of parseMuse(json, keywords)) {
            if (seen.has(job.url)) continue;
            seen.add(job.url);
            total++;
            yield job;
          }

          const rawLen = json.results?.length ?? 0;
          if (rawLen === 0 || page + 1 >= (json.page_count ?? 0)) break;
        }
      }
    }

    if (attempts > 0 && failures === attempts) {
      throw new Error('The Muse: all requests failed');
    }
    ctx.emitProgress(`The Muse: ${total} jobs`, total);
  }
}
