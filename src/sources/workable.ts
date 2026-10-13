import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { HttpStatusError, assertValidSlug, fetchJson, fetchText } from '../core/fetch';
import { htmlToText } from './aggregator-util';

const WORKABLE_HOST = 'apply.workable.com';
// Large accounts get an "instructions" page back instead of a table (e.g.
// weekday-1, 718 openings): "> This company has 718 open positions. Use the
// search endpoint to filter results." Detected so the caller can retry with
// `?query=<keyword>` instead of silently surfacing zero jobs.
const SEARCH_INSTRUCTIONS_RX = /has\s+[\d,]+\s+open positions\.\s*use the search endpoint/i;
// Cap how many of the criteria's keywords we search per-account when the
// default feed is an instructions page — each is a separate fetch.
const MAX_SEARCH_KEYWORDS = 3;

/** True when `text` is the "too many openings, use the search endpoint"
 *  instructions page rather than a job table. */
export function isWorkableSearchInstructionsPage(text: string): boolean {
  return SEARCH_INSTRUCTIONS_RX.test(text);
}

interface WorkableSalary {
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  salary_currency: string | null;
}

/**
 * Parse a Salary column like "INR 4,000,000–7,500,000" into native-currency
 * min/max + ISO code. Only a clean "CUR N-M" range is accepted (the column
 * is an em dash "—" placeholder when no salary is listed) — anything else
 * yields nulls rather than a guess.
 */
function parseWorkableSalary(cell: string | undefined): WorkableSalary {
  const none: WorkableSalary = { salary_min_usd: null, salary_max_usd: null, salary_currency: null };
  const m = cell?.match(/^([A-Z]{3})\s+([\d,]+)\s*[-–—]\s*([\d,]+)$/);
  if (!m) return none;
  const min = Number(m[2].replace(/,/g, ''));
  const max = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(min) || !Number.isFinite(max)) return none;
  return { salary_min_usd: Math.round(min), salary_max_usd: Math.round(max), salary_currency: m[1] };
}

/**
 * Parse Workable's public markdown feed/search-results table. Workable's
 * JSON API needs an auth token; the `/<slug>/jobs.md` markdown table (and its
 * `?query=` search variant) is the only no-auth surface. Rows look like:
 *   | Title | Department | Location | Type | Salary | Posted | [View](url.md) |
 * The `[View]` link (`apply.workable.com/<slug>/jobs/view/<code>.md`) points
 * at a markdown *document*, not the apply page — the real apply URL is
 * `apply.workable.com/<slug>/j/<code>/`, built from the same slug + shortcode.
 * Rows with no on-host View link or no title are dropped.
 */
export function parseWorkableMarkdown(text: string, company: string): Job[] {
  if (typeof text !== 'string') return [];

  const jobs: Job[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('|') || !line.includes('[View]')) continue;
    const cols = line.split('|').map(c => c.trim());
    // ['', title, dept, location, type, salary, posted, '[View](url.md)', '']
    if (cols.length < 8) continue;
    const title = cols[1];
    if (!title || title === 'Title') continue;
    const location = cols[3] || '';

    const linkMatch = line.match(/\[View\]\(https:\/\/apply\.workable\.com\/([^/]+)\/jobs\/view\/([A-Za-z0-9]+)\.md\)/);
    if (!linkMatch) continue;
    const [, slug, code] = linkMatch;
    const url = `https://${WORKABLE_HOST}/${slug}/j/${code}/`;

    const posted = cols[6] ? Date.parse(cols[6]) : NaN;

    // jd_text is omitted: the markdown feed has only the row fields, enrich()
    // fetches the description.
    jobs.push({
      external_id: code,
      title,
      url,
      company,
      location,
      posted_at: Number.isNaN(posted) ? null : posted,
      ...parseWorkableSalary(cols[5]),
    });
  }
  return jobs;
}

const SHORTCODE_RX = /^[A-Za-z0-9]{1,32}$/;

/**
 * Description from a `/api/v2/accounts/{slug}/jobs/{shortcode}` payload. The
 * list feed is markdown, but this per-job JSON endpoint is keyless and carries
 * the HTML body as three fields. Requirements come before benefits so the text
 * cap trims perks, not the role. Returns null when all three are empty.
 */
export function parseWorkableDetail(json: unknown): Partial<Job> | null {
  const d = json as Record<string, unknown> | null;
  const html = ['description', 'requirements', 'benefits']
    .map(k => d?.[k])
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join('\n\n');
  const jd = htmlToText(html);
  return jd ? { jd_text: jd } : null;
}

export class WorkableAdapter implements SourceAdapter {
  type = 'workable' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Workable account slug');
    const feedUrl = `https://${WORKABLE_HOST}/${identifier}/jobs.md`;
    ctx.emitProgress(`Fetching ${display_name} (Workable)…`);

    const text = await fetchText(feedUrl, { allowedHosts: [WORKABLE_HOST], retries: 2, signal: ctx.abortSignal });
    let jobs = parseWorkableMarkdown(text, display_name);

    if (jobs.length === 0 && isWorkableSearchInstructionsPage(text)) {
      // What the keyword searches return is not the whole board, so a later search with
      // other keywords must not be answered from these stored jobs.
      ctx.markQueryDependent?.();
      const keywords = (ctx.keywords ?? []).filter(k => k.trim()).slice(0, MAX_SEARCH_KEYWORDS);
      if (keywords.length === 0) {
        throw new Error(
          `Workable account "${display_name}" is too large for the default feed and requires ` +
          `a search keyword (?query=…) — no criteria keywords available to search with`,
        );
      }
      const seen = new Set<string>();
      const merged: Job[] = [];
      // A failed keyword search must not abort the remaining keywords (matches
      // himalayas/jobicy's per-keyword isolation) — only throw once every
      // keyword's request has failed and there is nothing to show for this source.
      let failures = 0;
      let lastError: unknown;
      for (const kw of keywords) {
        const kwUrl = `${feedUrl}?query=${encodeURIComponent(kw)}`;
        let kwText: string;
        try {
          kwText = await fetchText(kwUrl, { allowedHosts: [WORKABLE_HOST], retries: 2, signal: ctx.abortSignal });
        } catch (err) {
          failures++;
          lastError = err;
          ctx.emitProgress(`${display_name}: search for "${kw}" failed`);
          continue;
        }
        for (const job of parseWorkableMarkdown(kwText, display_name)) {
          if (job.external_id && seen.has(job.external_id)) continue;
          if (job.external_id) seen.add(job.external_id);
          merged.push(job);
        }
      }
      if (failures === keywords.length) {
        // A 429 must surface as one so the runner rests the host instead of logging a hard failure.
        if (lastError instanceof HttpStatusError && lastError.status === 429) throw lastError;
        throw new Error(`Workable account "${display_name}": all search requests failed`);
      }
      jobs = merged;
    }

    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);
    for (const job of jobs) {
      yield job;
    }
  }

  /** Fetches the JD for one job the runner kept past L1. A fetch failure is
   *  recoverable here (the job simply stays without a JD). */
  async enrich(job: Job, ctx: SourceContext): Promise<Partial<Job> | null> {
    const { identifier } = ctx.config as { identifier: string };
    const code = job.external_id;
    if (!code || !SHORTCODE_RX.test(code)) return null;
    try {
      assertValidSlug(identifier, 'Workable account slug');
      const url = `https://${WORKABLE_HOST}/api/v2/accounts/${identifier}/jobs/${code}`;
      return parseWorkableDetail(await fetchJson(url, { allowedHosts: [WORKABLE_HOST], retries: 1 }));
    } catch (err) {
      // Surfaced so the runner rests the vendor instead of hammering a host that is refusing us.
      if (err instanceof HttpStatusError && err.status === 429) throw err;
      ctx.emitProgress(`Workable: JD enrich failed for ${code} (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  }
}
