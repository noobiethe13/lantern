import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText, toMillis } from './aggregator-util';

// Jobicy: a keyless public remote-jobs API (v2), in the same honest fetch class as
// remoteok/arbeitnow/himalayas. The `tag` param drives a server-side search.
// Remote-only board. Left unscoped by location — `geo=india`-style params
// 400 rather than filter, unlike Himalayas's `country=`.
const JOBICY_ALLOWED_HOSTS = ['jobicy.com'];
const PER_KEYWORD_COUNT = 50;
const MAX_KEYWORDS = 5;

function buildUrl(keyword: string): string {
  return `https://jobicy.com/api/v2/remote-jobs?count=${PER_KEYWORD_COUNT}&tag=${encodeURIComponent(keyword)}`;
}

/**
 * Parse a Jobicy `/api/v2/remote-jobs` response. Jobs live under `jobs`; the apply
 * URL is `url`, the description is HTML (`jobDescription`), the stable id is `id`,
 * and `jobGeo` is a coarse region string. `pubDate` (ISO) maps to posted_at when
 * present. Salary (`salaryMin`/`salaryMax`/`salaryCurrency`) is only mapped when
 * `salaryPeriod` is yearly/annual — an hourly/monthly rate would otherwise be
 * mis-read as a yearly one.
 */
export function parseJobicy(json: unknown): Job[] {
  const items = (json as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = typeof j['jobTitle'] === 'string' ? j['jobTitle'] : '';
    const url = typeof j['url'] === 'string' ? j['url'] : '';
    const company = typeof j['companyName'] === 'string' ? (j['companyName'] as string).trim() : '';
    if (!title || !url || !company) continue;

    const geo = typeof j['jobGeo'] === 'string' ? j['jobGeo'] : '';
    const desc = typeof j['jobDescription'] === 'string' ? j['jobDescription'] : '';

    const period = typeof j['salaryPeriod'] === 'string' ? j['salaryPeriod'].toLowerCase() : '';
    const isAnnual = period === 'yearly' || period === 'annual';
    const salaryMin = j['salaryMin'];
    const salaryMax = j['salaryMax'];
    const salaryCurrency = typeof j['salaryCurrency'] === 'string' ? (j['salaryCurrency'] as string) : null;

    jobs.push({
      external_id: String(j['id'] ?? ''),
      title,
      url,
      company,
      location: geo,
      remote: true,
      salary_min_usd: isAnnual && typeof salaryMin === 'number' ? Math.round(salaryMin) : null,
      salary_max_usd: isAnnual && typeof salaryMax === 'number' ? Math.round(salaryMax) : null,
      salary_currency: isAnnual ? salaryCurrency : null,
      posted_at: toMillis(j['pubDate']),
      jd_text: htmlToText(desc) || undefined,
    });
  }
  return jobs;
}

export class JobicyAdapter implements SourceAdapter {
  type = 'jobicy' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const keywords = (ctx.keywords ?? []).slice(0, MAX_KEYWORDS);
    if (keywords.length === 0) {
      ctx.emitProgress('Jobicy: no title keyword set — skipping');
      return;
    }
    ctx.emitProgress(`Fetching Jobicy for ${keywords.join(', ')}…`);

    const seen = new Set<string>();
    let total = 0;
    let failures = 0;
    for (const keyword of keywords) {
      if (ctx.abortSignal.aborted) break;
      let json: unknown;
      try {
        json = await fetchJson(buildUrl(keyword), {
          allowedHosts: JOBICY_ALLOWED_HOSTS,
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch {
        failures++;
        ctx.emitProgress(`Jobicy: "${keyword}" request failed`);
        continue;
      }
      for (const job of parseJobicy(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        total++;
        yield job;
      }
    }
    if (failures === keywords.length) {
      throw new Error('Jobicy: all requests failed');
    }
    ctx.emitProgress(`Jobicy: ${total} jobs`, total);
  }
}
