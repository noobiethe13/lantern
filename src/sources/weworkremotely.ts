import { load as cheerioLoad } from 'cheerio';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchText } from '../core/fetch';
import { htmlToText, toMillis, sleep, postingMatchesKeywords } from './aggregator-util';

// WWR has no search, and each category RSS carries only that category's newest
// ~5-100 postings. Rather than guess which category a keyword belongs to, fetch
// the whole (small, fixed) category set and filter client-side. Some other
// category slugs (e.g. remote-data-jobs) 301 and are deliberately not listed:
// the SSRF guard refuses redirects.
const WWR_ALLOWED_HOSTS = ['weworkremotely.com'];
const WWR_CATEGORIES = [
  'remote-programming-jobs',
  'remote-full-stack-programming-jobs',
  'remote-front-end-programming-jobs',
  'remote-back-end-programming-jobs',
  'remote-devops-sysadmin-jobs',
  'remote-product-jobs',
  'remote-design-jobs',
  'remote-customer-support-jobs',
  'remote-sales-and-marketing-jobs',
  'remote-management-and-finance-jobs',
  'all-other-remote-jobs',
];
const REQUEST_DELAY_MS = 500;

function categoryUrl(category: string): string {
  return `https://weworkremotely.com/categories/${category}.rss`;
}

// Country names arrive as "🇦🇩 Andorra, 🇦🇱 Albania, and 🇺🇦 Ukraine".
function cleanCountries(raw: string): string {
  return raw
    .replace(/\p{Regional_Indicator}{2}\s*/gu, '')
    // Only the Oxford ", and " — a bare " and " is inside names like "Bosnia and Herzegovina".
    .replace(/,\s+and\s+/g, ', ')
    .trim();
}

/**
 * Parse a WWR category RSS feed, keeping postings whose title or description
 * whole-word matches a keyword. Titles are "Company: Role", split on the first ": " (items without
 * one have no company and are dropped). `<description>` is entity-escaped HTML.
 * Every posting is remote; the restriction is honest to the feed: an explicit
 * `<country>` list wins (it narrows who can apply), else `<region>` ("Anywhere in
 * the World" becomes "Worldwide"). `<state>` is the company's HQ, not a work
 * location, so it is ignored. No salary field.
 */
export function parseWeWorkRemotely(xml: string, keywords: string[]): Job[] {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const $ = cheerioLoad(xml, { xmlMode: true });

  const jobs: Job[] = [];
  $('item').each((_i, el) => {
    const item = $(el);
    const rawTitle = item.children('title').first().text().trim();
    const sep = rawTitle.indexOf(': ');
    if (sep <= 0) return;
    const company = rawTitle.slice(0, sep).trim();
    const title = rawTitle.slice(sep + 2).trim();
    const url = (item.children('link').first().text() || item.children('guid').first().text()).trim();
    if (!company || !title || !url) return;
    const jd = htmlToText(item.children('description').first().text()) || undefined;
    if (!postingMatchesKeywords(keywords, title, jd)) return;

    const countries = cleanCountries(item.children('country').first().text());
    const region = item.children('region').first().text().trim();
    const location = countries || (/^anywhere/i.test(region) ? 'Worldwide' : region);

    jobs.push({
      external_id: url.split('/').pop() || undefined,
      title,
      url,
      company,
      location,
      remote: true,
      posted_at: toMillis(item.children('pubDate').first().text()),
      jd_text: jd,
    });
  });
  return jobs;
}

export class WeWorkRemotelyAdapter implements SourceAdapter {
  type = 'weworkremotely' as const;

  constructor(private readonly requestDelayMs: number = REQUEST_DELAY_MS) {}

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('We Work Remotely: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching We Work Remotely for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let failures = 0;
    for (const [i, category] of WWR_CATEGORIES.entries()) {
      if (ctx.abortSignal.aborted) break;
      if (i > 0) await sleep(this.requestDelayMs);
      let xml: string;
      try {
        xml = await fetchText(categoryUrl(category), {
          allowedHosts: WWR_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        failures++;
        ctx.emitProgress(`We Work Remotely: ${category} request failed`);
        continue;
      }
      for (const job of parseWeWorkRemotely(xml, keywords)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    if (failures === WWR_CATEGORIES.length) {
      throw new Error('We Work Remotely: all requests failed');
    }
    ctx.emitProgress(`We Work Remotely: ${total} jobs`, total);
  }
}
