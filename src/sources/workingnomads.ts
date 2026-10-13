import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis, postingMatchesKeywords } from './aggregator-util';

// One keyless JSON array (a few dozen of the newest remote postings, description
// included). No server-side search, so keywords filter it client-side.
const WN_ALLOWED_HOSTS = ['www.workingnomads.com'];
const WN_URL = 'https://www.workingnomads.com/api/exposed_jobs/';

/**
 * Parse the Working Nomads `exposed_jobs` array, keeping postings whose title or
 * description whole-word matches a keyword. There is no id field: the trailing number of the
 * `/job/go/<id>/` URL is used. Every posting is remote; `location` is the
 * poster's free-text eligibility ("Global", "Anywhere in India", "Time zone: CET
 * (+/- 3 hours)") and is passed through for L1's remote-eligibility rule. No
 * salary field.
 */
export function parseWorkingNomads(json: unknown, keywords: string[]): Job[] {
  if (!Array.isArray(json)) return [];

  const jobs: Job[] = [];
  for (const it of json) {
    const j = it as Record<string, unknown>;
    const title = typeof j['title'] === 'string' ? j['title'].trim() : '';
    const url = typeof j['url'] === 'string' ? j['url'] : '';
    const company = typeof j['company_name'] === 'string' ? j['company_name'].trim() : '';
    if (!title || !url || !company) continue;
    const jd = htmlToText(j['description'] as string) || undefined;
    if (!postingMatchesKeywords(keywords, title, jd)) continue;

    jobs.push({
      external_id: url.match(/\/job\/go\/(\d+)/)?.[1],
      title,
      url,
      company,
      location: typeof j['location'] === 'string' ? j['location'].trim() : '',
      remote: true,
      posted_at: toMillis(j['pub_date']),
      jd_text: jd,
    });
  }
  return jobs;
}

export class WorkingNomadsAdapter implements SourceAdapter {
  type = 'workingnomads' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = ctx.keywords ?? [];
    if (keywords.length === 0) {
      ctx.emitProgress('Working Nomads: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching Working Nomads for ${keywords.join(', ')}…`);

    const json = await fetchJson(WN_URL, {
      allowedHosts: WN_ALLOWED_HOSTS,
      timeoutMs: 30_000,
      retries: 2,
    });

    const jobs = parseWorkingNomads(json, keywords);
    for (const job of jobs) {
      if (ctx.abortSignal.aborted) break;
      yield job;
    }
    ctx.emitProgress(`Working Nomads: ${jobs.length} jobs`, jobs.length);
  }
}
