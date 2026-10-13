import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';
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

/** Decode a Workday `externalPath`'s primary location segment
 *  (`/job/California---Irvine/…` -> "California, Irvine") — used for the "N
 *  Locations" case, where `locationsText` is just a count with no location
 *  detail. `---` separates location components; a remaining `-` within a
 *  component is a space. */
function decodeExternalPathLocation(externalPath: string): string | null {
  const m = externalPath.match(/^\/job\/([^/]+)\//);
  if (!m) return null;
  const decoded = m[1].replace(/---/g, ', ').replace(/-/g, ' ').trim();
  return decoded || null;
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
 * salary — jd_text is omitted (null in DB) and filled by enrich() from the
 * per-job cxs detail, so large tenants don't pay a request per listed posting.
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
    // "N Locations" (11/20 postings on a sampled page) is a bare count with no
    // location detail — stored verbatim it's unmatchable against any allowed
    // location, so every such posting was dropped by L1. Decode the primary
    // location from the path instead and flag how many more there are;
    // `remote` is left undefined since a count alone can't say whether any
    // (or all) of the N locations are remote.
    const nLocations = locationsText.match(/^(\d+)\s*Locations?$/i);
    let location = locationsText;
    let remote: boolean | undefined = /remote/i.test(`${title} ${locationsText}`);
    if (nLocations) {
      const count = Number(nLocations[1]);
      const primary = decodeExternalPathLocation(externalPath);
      location = primary ? `${primary} (+${count - 1} more)` : locationsText;
      remote = undefined;
    }

    jobs.push({
      external_id: externalId(j, externalPath),
      title,
      url: `https://${host}/${site}${externalPath}`,
      company,
      location,
      remote,
      posted_at: parseWorkdayPostedOn(j['postedOn'], now),
    });
  }
  return jobs;
}

// A cxs externalPath tail: `/job/<location>/<title>_<reqId>` — plain URL-path
// segments only, never `.`/`..` or an encoded slash/dot that could climb out.
const EXTERNAL_PATH_RX = /^\/job(?:\/[A-Za-z0-9._~()!,'*+=:@%-]+)+$/;

/**
 * Recover the externalPath from a stored job's URL (`https://{host}/{site}{externalPath}`),
 * or null when the URL isn't on the expected host/site or the path is unsafe.
 * The path originated in the listing payload, so it is treated as untrusted.
 */
export function workdayExternalPath(jobUrl: string, host: string, site: string): string | null {
  let u: URL;
  try {
    u = new URL(jobUrl);
  } catch {
    return null;
  }
  const prefix = `/${site}`;
  if (u.protocol !== 'https:' || u.hostname !== host || !u.pathname.startsWith(`${prefix}/job/`)) return null;
  const path = u.pathname.slice(prefix.length);
  if (!EXTERNAL_PATH_RX.test(path)) return null;
  // Escapes that could climb out or change meaning once decoded: `.` `/` `\`, `?` `#`,
  // a double-encoding `%25`, NUL and the rest of the control range.
  if (path.split('/').some(seg => seg === '.' || seg === '..') || /%(?:[01][0-9a-f]|7f|2[35ef]|3f|5c)/i.test(path)) {
    return null;
  }
  return path;
}

/** Description from a cxs `/job/...` detail payload (`jobPostingInfo.jobDescription`
 *  HTML). The remaining fields (startDate is a hire date, not a posting date)
 *  don't map cleanly, so only jd_text is returned. Null when the body is empty. */
export function parseWorkdayDetail(json: unknown): Partial<Job> | null {
  const info = (json as { jobPostingInfo?: Record<string, unknown> } | null)?.jobPostingInfo;
  const jd = htmlToText(typeof info?.['jobDescription'] === 'string' ? info['jobDescription'] : '');
  return jd ? { jd_text: jd } : null;
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
    // Workday only reports `total` on page 0 — later pages report 0, which
    // previously ended the loop right after page 1 (40 of 1,527 postings on a
    // live Salesforce board). Capture it once, from page 0, and otherwise
    // stop on a short raw page (the reliable end-of-results signal).
    let reportedTotal: number | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (ctx.abortSignal.aborted) break;
      const offset = page * PAGE_SIZE;
      const json = (await fetchJson(apiUrl, {
        allowedHosts,
        headers: REQUEST_HEADERS,
        method: 'POST',
        body: { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: '' },
        retries: 1,
        signal: ctx.abortSignal,
      })) as { total?: number; jobPostings?: unknown[] };

      if (page === 0 && typeof json.total === 'number') reportedTotal = json.total;

      const jobs = parseWorkday(json, host, site, cfg.display_name, Date.now());
      for (const job of jobs) yield job;
      total += jobs.length;

      const rawPageLength = Array.isArray(json.jobPostings) ? json.jobPostings.length : 0;
      const reachedReportedTotal = reportedTotal !== null && offset + PAGE_SIZE >= reportedTotal;
      if (rawPageLength === 0 || rawPageLength < PAGE_SIZE || reachedReportedTotal) break;
    }

    ctx.emitProgress(`${cfg.display_name}: ${total} jobs`, total);
  }

  /** Fetches the JD for one job the runner kept past L1. A bad config, unsafe
   *  path or fetch failure is recoverable here (the job stays without a JD). */
  async enrich(job: Job, ctx: SourceContext): Promise<Partial<Job> | null> {
    const cfg = ctx.config as unknown as WorkdayConfig;
    try {
      assertValidSlug(cfg.identifier, 'Workday tenant slug');
      const site = assertSafeSite(cfg.site ?? '');
      const host = resolveWorkdayHost(cfg);
      const path = workdayExternalPath(job.url, host, site);
      if (!path) return null;
      const url = `https://${host}/wday/cxs/${cfg.identifier}/${site}${path}`;
      return parseWorkdayDetail(
        await fetchJson(url, { allowedHosts: [host], headers: REQUEST_HEADERS, retries: 1 }),
      );
    } catch (err) {
      ctx.emitProgress(`Workday: JD enrich failed for ${job.external_id ?? job.url} (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  }
}
