import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { GATED_USER_AGENT } from './gated-util';

// Workday's customer-experience (cxs) job feed. Tenants live on per-datacenter
// hosts (`{tenant}.wd{N}.myworkdayjobs.com`); the feed is a POST to
// `/wday/cxs/{tenant}/{site}/jobs` with an offset/limit body and a `total` count.
// tenant/site/datacenter come from config_json (the single `identifier` slug
// can't hold a site name with underscores). Per-company board — ignores keyword.
const WORKDAY_HOST_RX = /^[a-z0-9][a-z0-9-]*\.wd\d+\.myworkdayjobs\.com$/;
const PAGE_SIZE = 20;
const MAX_PAGES = 50; // ≤1000 postings per tenant — safety cap
const REQUEST_HEADERS = { 'User-Agent': GATED_USER_AGENT, Accept: 'application/json' };

interface WorkdayConfig {
  identifier: string; // tenant (path segment)
  display_name: string;
  site: string; // career-site name, e.g. External_Career_Site
  dc?: string; // datacenter, e.g. wd5 — used to derive host when host absent
  host?: string; // explicit host override (when subdomain ≠ tenant)
}

/** Site names contain underscores and mixed case (External_Career_Site), which
 *  assertValidSlug rejects — validate separately, still blocking traversal. */
function assertSafeSite(site: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(site)) {
    throw new Error(`Workday site "${site}" must be alphanumerics, dashes, or underscores`);
  }
  return site;
}

export function resolveWorkdayHost(cfg: WorkdayConfig): string {
  const host = (cfg.host ?? `${cfg.identifier}.${cfg.dc}.myworkdayjobs.com`).toLowerCase();
  if (!WORKDAY_HOST_RX.test(host)) {
    throw new Error(`Workday host "${host}" is not a *.wd{N}.myworkdayjobs.com host`);
  }
  return host;
}

/** Parse Workday's relative `postedOn` text to an approximate epoch. Workday
 *  exposes no absolute date in the feed, so this is best-effort: "Posted Today",
 *  "Posted Yesterday", "Posted N Days Ago", "Posted 30+ Days Ago". Returns null
 *  when unrecognised. (upsertJob only stamps posted_at on insert, so the first
 *  scan's approximation sticks across re-scans — it won't drift later.) */
export function parseWorkdayPostedOn(text: unknown, now: number): number | null {
  if (typeof text !== 'string') return null;
  const t = text.toLowerCase();
  const DAY = 24 * 60 * 60 * 1000;
  if (t.includes('today')) return now;
  if (t.includes('yesterday')) return now - DAY;
  const m = t.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return now - Number(m[1]) * DAY;
  return null;
}

function externalId(posting: Record<string, unknown>, externalPath: string): string {
  const bullets = posting['bulletFields'];
  if (Array.isArray(bullets) && typeof bullets[0] === 'string' && bullets[0].trim()) {
    return bullets[0].trim();
  }
  return externalPath.split('/').filter(Boolean).pop() ?? '';
}

/**
 * Parse a Workday cxs `/jobs` page into Jobs. The public posting URL is
 * `https://{host}/{site}{externalPath}`. Listing carries no description or
 * salary — jd_text is deferred (omitted, null in DB) like SmartRecruiters, so a
 * per-job cxs detail fetch isn't forced on large tenants.
 */
export function parseWorkday(
  json: unknown,
  host: string,
  site: string,
  company: string,
  now: number,
): Job[] {
  const postings = (json as { jobPostings?: unknown[] })?.jobPostings;
  if (!Array.isArray(postings)) return [];

  const jobs: Job[] = [];
  for (const it of postings) {
    const j = it as Record<string, unknown>;
    const title = (j['title'] as string)?.trim() ?? '';
    const externalPath = typeof j['externalPath'] === 'string' ? (j['externalPath'] as string) : '';
    if (!title || !externalPath.startsWith('/')) continue;

    const locationsText = (j['locationsText'] as string)?.trim() ?? '';
    jobs.push({
      external_id: externalId(j, externalPath),
      title,
      url: `https://${host}/${site}${externalPath}`,
      company,
      location: locationsText,
      remote: /remote/i.test(`${title} ${locationsText}`),
      posted_at: parseWorkdayPostedOn(j['postedOn'], now),
    });
  }
  return jobs;
}

export class WorkdayAdapter implements SourceAdapter {
  type = 'workday' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const cfg = ctx.config as unknown as WorkdayConfig;
    assertValidSlug(cfg.identifier, 'Workday tenant slug');
    if (!cfg.site) throw new Error(`Workday source "${cfg.display_name}" is missing config.site`);
    const site = assertSafeSite(cfg.site);
    const host = resolveWorkdayHost(cfg);
    const allowedHosts = [host];
    const apiUrl = `https://${host}/wday/cxs/${cfg.identifier}/${site}/jobs`;
    ctx.emitProgress(`Fetching ${cfg.display_name} (Workday)…`);

    let total = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.abortSignal.aborted) break;
      const offset = page * PAGE_SIZE;
      const json = (await fetchJson(apiUrl, {
        allowedHosts,
        headers: REQUEST_HEADERS,
        method: 'POST',
        body: { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' },
        retries: 1,
      })) as { total?: number };

      const jobs = parseWorkday(json, host, site, cfg.display_name, Date.now());
      for (const job of jobs) yield job;
      total += jobs.length;

      const reported = typeof json.total === 'number' ? json.total : 0;
      if (jobs.length === 0 || offset + PAGE_SIZE >= reported) break;
    }

    ctx.emitProgress(`${cfg.display_name}: ${total} jobs`, total);
  }
}
