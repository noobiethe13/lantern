import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText, toMillis } from './aggregator-util';
import { annualizePay } from '../core/salary';

// Rippling ATS public board API. `GET /api/v2/board/{slug}/jobs` is paginated
// (0-indexed `page`, `pageSize` honoured up to at least 500) and lists one entry
// per job-location, so a multi-location job repeats under the same id. The list
// carries no description or pay, so those come from
// `GET /api/v2/board/{slug}/jobs/{id}` — one request per job. fetch() yields
// listing-only jobs and enrich() makes that call, which the runner issues only
// for L1 survivors (capped per source per run) instead of for every listed job.
const RIPPLING_HOST = 'ats.rippling.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 20; // 2000 listing entries; a bound, not an expected size

function listUrl(slug: string, page: number): string {
  return `https://${RIPPLING_HOST}/api/v2/board/${slug}/jobs?page=${page}&pageSize=${PAGE_SIZE}`;
}

function detailUrl(slug: string, id: string): string {
  return `https://${RIPPLING_HOST}/api/v2/board/${slug}/jobs/${encodeURIComponent(id)}`;
}

export interface RipplingListPage {
  items: Job[];
  totalPages: number;
}

/**
 * Parse one page of the board listing into description-less Jobs. Repeated ids
 * (one entry per location) are merged within the page into a single job with
 * every location joined; `remote` is true when any location is `REMOTE`. The
 * posting URL must sit on the Rippling host or it is rebuilt from slug + id.
 * Entries with no id or name are dropped.
 */
export function parseRipplingList(json: unknown, company: string, slug: string): RipplingListPage {
  const root = json as { items?: unknown[]; totalPages?: unknown };
  const totalPages = typeof root?.totalPages === 'number' ? root.totalPages : 1;
  if (!Array.isArray(root?.items)) return { items: [], totalPages };

  const byId = new Map<string, { job: Job; places: Set<string> }>();
  for (const raw of root.items) {
    const it = raw as Record<string, unknown>;
    const id = typeof it['id'] === 'string' ? it['id'] : '';
    const title = typeof it['name'] === 'string' ? it['name'].trim() : '';
    if (!id || !title) continue;

    let entry = byId.get(id);
    if (!entry) {
      entry = {
        job: { external_id: id, title, url: onHostUrl(it['url'], slug, id), company, location: '', remote: false },
        places: new Set(),
      };
      byId.set(id, entry);
    }
    for (const l of Array.isArray(it['locations']) ? (it['locations'] as Record<string, unknown>[]) : []) {
      const name = typeof l?.['name'] === 'string' ? l['name'].trim() : '';
      if (name) entry.places.add(name);
      if (l?.['workplaceType'] === 'REMOTE') entry.job.remote = true;
    }
  }

  const items = [...byId.values()].map(({ job, places }) => ({ ...job, location: [...places].join('; ') }));
  return { items, totalPages };
}

function onHostUrl(raw: unknown, slug: string, id: string): string {
  if (typeof raw === 'string') {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && parsed.hostname === RIPPLING_HOST) return parsed.href;
    } catch {
      // malformed → rebuilt below
    }
  }
  return `https://${RIPPLING_HOST}/${slug}/jobs/${encodeURIComponent(id)}`;
}

/**
 * Fields a per-job detail response adds to a listed job: the description
 * (`description.role` + `description.company` HTML, role first so the 8KB text
 * cap trims the boilerplate rather than the requirements), `createdOn`, and an
 * annual salary range. Salary is taken only when every `payRangeDetails` entry
 * is a range in one currency; each is annualised by its `frequency`
 * (core/salary.ts) and mixed-currency pay is left unmapped. Returns null when
 * the payload has no description.
 */
export function ripplingDetailPatch(json: unknown): Partial<Job> | null {
  const d = json as Record<string, unknown> | null;
  const desc = d?.['description'] as Record<string, unknown> | undefined;
  const html = [desc?.['role'], desc?.['company']].filter((p): p is string => typeof p === 'string').join('\n\n');
  const jd = htmlToText(html);
  if (!jd) return null;

  const patch: Partial<Job> = { jd_text: jd, posted_at: toMillis(d?.['createdOn']) };
  const salary = annualSalary(d?.['payRangeDetails']);
  if (salary) Object.assign(patch, salary);
  return patch;
}

function annualSalary(
  raw: unknown,
): { salary_min_usd: number; salary_max_usd: number; salary_currency: string } | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const mins: number[] = [];
  const maxs: number[] = [];
  const currencies = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const start = r?.['rangeStart'];
    const end = r?.['rangeEnd'];
    if (typeof r?.['currency'] !== 'string') return null;
    if (typeof start !== 'number' || typeof end !== 'number' || start <= 0 || end < start) return null;
    const annual = annualizePay(start, end, r['frequency'], r['currency']);
    if (!annual) return null;
    currencies.add(r['currency']);
    mins.push(annual.min!);
    maxs.push(annual.max!);
  }
  if (currencies.size !== 1) return null;
  return {
    salary_min_usd: Math.round(Math.min(...mins)),
    salary_max_usd: Math.round(Math.max(...maxs)),
    salary_currency: [...currencies][0],
  };
}

/** Fold a repeat of the same job id (another location entry, possibly on a later
 *  page) into the first-seen job. */
function mergeRepeat(into: Job, repeat: Job): void {
  const places = new Set([...(into.location ?? '').split('; '), ...(repeat.location ?? '').split('; ')].filter(Boolean));
  into.location = [...places].join('; ');
  into.remote = into.remote || repeat.remote;
}

export class RipplingAdapter implements SourceAdapter {
  type = 'rippling' as const;
  salaryFromEnrich = true;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as { identifier: string; display_name: string };
    assertValidSlug(identifier, 'Rippling board slug');
    const allowedHosts = [RIPPLING_HOST];
    ctx.emitProgress(`Fetching ${display_name} (Rippling)…`);

    const listed = new Map<string, Job>();
    let totalPages = 1;
    for (let page = 0; page < Math.min(totalPages, MAX_PAGES); page++) {
      if (ctx.abortSignal.aborted) break;
      const parsed = parseRipplingList(
        await fetchJson(listUrl(identifier, page), { allowedHosts, retries: 2, signal: ctx.abortSignal }),
        display_name,
        identifier,
      );
      totalPages = parsed.totalPages;
      for (const job of parsed.items) {
        const first = listed.get(job.external_id!);
        if (first) mergeRepeat(first, job);
        else listed.set(job.external_id!, job);
      }
    }

    ctx.emitProgress(`${display_name}: ${listed.size} jobs`, listed.size);
    for (const job of listed.values()) {
      yield job;
    }
  }

  /** Fetches the JD and pay range for one job the runner kept past L1. A fetch
   *  failure is recoverable here (the job simply stays without a JD). */
  async enrich(job: Job, ctx: SourceContext): Promise<Partial<Job> | null> {
    const { identifier } = ctx.config as { identifier: string };
    if (!job.external_id) return null;
    try {
      assertValidSlug(identifier, 'Rippling board slug');
      return ripplingDetailPatch(
        await fetchJson(detailUrl(identifier, job.external_id), { allowedHosts: [RIPPLING_HOST], retries: 1 }),
      );
    } catch (err) {
      ctx.emitProgress(`Rippling: JD enrich failed for job ${job.external_id} (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }
  }
}
