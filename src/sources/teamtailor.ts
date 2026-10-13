import { load as cheerioLoad } from 'cheerio';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchText } from '../core/fetch';
import { htmlToText } from './aggregator-util';

/**
 * Parse a Teamtailor `jobs.rss` feed. Each tenant publishes its open roles at
 * `https://<slug>.teamtailor.com/jobs.rss` — RSS 2.0 with a `tt:` namespace for
 * structured locations/department, and the full HTML description entity-encoded
 * in `<description>`. `remoteStatus` is `none | hybrid | temporary | fully`;
 * only `fully` is remote. The channel title is the company name, but the
 * configured display name is used so the roster stays consistent. Items with no
 * title or no usable link are dropped.
 */
export function parseTeamtailorRss(xml: string, company: string, host: string): Job[] {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const $ = cheerioLoad(xml, { xmlMode: true });

  const jobs: Job[] = [];
  $('item').each((_i, el) => {
    const item = $(el);
    const title = item.children('title').first().text().trim();
    const guid = item.children('guid').first().text().trim();
    const url = onHostUrl(item.children('link').first().text().trim(), host);
    if (!title || !url) return;

    const places: string[] = [];
    item.find('tt\\:location').each((_j, loc) => {
      const l = $(loc);
      const city = l.children('tt\\:city').first().text().trim() || l.children('tt\\:name').first().text().trim();
      const country = l.children('tt\\:country').first().text().trim();
      const place = [city, country].filter(Boolean).join(', ');
      if (place) places.push(place);
    });
    const location = [...new Set(places)].join('; ');

    const remoteStatus = item.children('remoteStatus').first().text().trim().toLowerCase();
    const remote = remoteStatus === 'fully';

    const pub = item.children('pubDate').first().text().trim();
    const posted = pub ? Date.parse(pub) : NaN;

    const jd = htmlToText(item.children('description').first().text());

    jobs.push({
      external_id: guid || url,
      title,
      url,
      company,
      location,
      remote,
      jd_text: jd || undefined,
      posted_at: Number.isNaN(posted) ? null : posted,
    });
  });
  return jobs;
}

/** Keep the posting link only when it points at this tenant's own host. A tenant
 *  on a custom domain publishes off-host links, which are rewritten onto the
 *  tenant host (the numeric id prefix is what Teamtailor routes on) so the
 *  stored link stays on the allowlisted host. */
function onHostUrl(link: string, host: string): string {
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'https:') return '';
    if (parsed.hostname === host) return parsed.href;
    const m = parsed.pathname.match(/\/jobs\/(\d+[^/]*)/);
    return m ? `https://${host}/jobs/${m[1]}` : '';
  } catch {
    return '';
  }
}

export class TeamtailorAdapter implements SourceAdapter {
  type = 'teamtailor' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Teamtailor tenant slug');
    const host = `${identifier}.teamtailor.com`;
    ctx.emitProgress(`Fetching ${display_name} (Teamtailor)…`);

    const xml = await fetchText(`https://${host}/jobs.rss`, { allowedHosts: [host], retries: 2, signal: ctx.abortSignal });
    const jobs = parseTeamtailorRss(xml, display_name, host);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
