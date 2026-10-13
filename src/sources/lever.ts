import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';
import { normalizeEmploymentLabel } from '../core/employment-type';
import { annualizePay } from '../core/salary';

const LEVER_ALLOWED_HOSTS = ['api.lever.co'];

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/** ISO 3166-1 alpha-2 → English display name ("IN" → "India"), or null when
 *  `code` isn't a 2-letter region code. */
function regionName(code: unknown): string | null {
  if (typeof code !== 'string' || !/^[a-z]{2}$/i.test(code)) return null;
  try {
    return REGION_NAMES.of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Build the location string from every posted location plus the country —
 * `categories.location` alone drops secondary sites on a multi-location
 * posting, and the raw ISO country code L1 never sees on its own. Also
 * encodes `workplaceType` into the string (L1's location rule only exempts a
 * job from the allowed-list via the structured `remote` field or an
 * "onsite"/"hybrid" keyword in the string — see filter.ts).
 */
function buildLeverLocation(job: Record<string, unknown>): { location: string; remote: boolean } {
  const cats = (job['categories'] as Record<string, unknown> | undefined) ?? {};
  const allLocations = Array.isArray(cats['allLocations'])
    ? (cats['allLocations'] as unknown[]).filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    : [];
  let location = allLocations.length > 0 ? [...new Set(allLocations)].join('; ') : ((cats['location'] as string) ?? '');

  const country = regionName(job['country']);
  if (country && !location.toLowerCase().includes(country.toLowerCase())) {
    location = location ? `${location}, ${country}` : country;
  }

  const workplaceType = job['workplaceType'];
  const remote = workplaceType === 'remote';
  // Only append when there's a base location to qualify — an empty location must
  // stay empty (L1 treats a blank location as lenient/pass-through; a bare
  // "(Hybrid)"/"(On-site)" string is not a real place and would defeat that).
  if (location && workplaceType === 'hybrid') location = `${location} (Hybrid)`;
  else if (location && workplaceType === 'onsite') location = `${location} (On-site)`;

  return { location, remote };
}

/**
 * Build jd_text from every text-bearing field Lever exposes, not just
 * `descriptionPlain` — live data shows postings where the "Who You Are"
 * requirements live entirely in `lists[]`, absent from descriptionPlain.
 * Each fragment is already plain (or converted via htmlToText); the final
 * htmlToText pass just collapses whitespace and re-applies the 8KB cap.
 */
function buildLeverJdText(job: Record<string, unknown>): string | undefined {
  const base = (job['descriptionPlain'] as string) || (job['description'] as string) || '';
  const lists = Array.isArray(job['lists']) ? (job['lists'] as unknown[]) : [];
  const listText = lists
    .map(l => {
      const item = (l as Record<string, unknown>) ?? {};
      const heading = typeof item['text'] === 'string' ? item['text'] : '';
      const body = htmlToText(item['content'] as string);
      return [heading, body].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  const additional = (job['additionalPlain'] as string) || '';

  const combined = [base, listText, additional].filter(Boolean).join('\n\n');
  return htmlToText(combined) || undefined;
}

interface LeverSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
}

/**
 * Map a Lever `salaryRange` (`{min, max, currency, interval}`) to native-
 * currency ANNUAL amounts: an hourly or monthly interval is annualised
 * (core/salary.ts) so it can meet L1's annual floor, and an unrecognised one is
 * dropped. Lever intervals are strings like `per-year-salary`; absent interval is
 * treated as annual (the common case for posted ranges).
 */
function extractLeverSalary(salaryRange: unknown): LeverSalary {
  const none: LeverSalary = { min: null, max: null, currency: null };
  if (!salaryRange || typeof salaryRange !== 'object') return none;
  const sr = salaryRange as Record<string, unknown>;
  const minV = sr['min'];
  const maxV = sr['max'];
  if (typeof minV !== 'number' && typeof maxV !== 'number') return none;
  const currency = typeof sr['currency'] === 'string' ? (sr['currency'] as string).toUpperCase() : null;
  const annual = annualizePay(
    typeof minV === 'number' ? minV : null,
    typeof maxV === 'number' ? maxV : null,
    typeof sr['interval'] === 'string' ? sr['interval'] : 'per-year-salary',
    currency,
  );
  return annual ? { ...annual, currency } : none;
}

export function parseLever(json: unknown, company: string): Job[] {
  if (!Array.isArray(json)) return [];
  const jobs: Job[] = [];
  for (const j of json) {
    const job = j as Record<string, unknown>;
    const url = (job['hostedUrl'] as string) ?? '';
    const title = (job['text'] as string) ?? '';
    // A posting missing url or title would otherwise collide with every
    // other empty-url job on the `WHERE url = ?` upsert lookup.
    if (!url || !title) continue;

    const { location, remote } = buildLeverLocation(job);
    const salary = extractLeverSalary(job['salaryRange']);
    const employmentType = normalizeEmploymentLabel(
      (job['categories'] as Record<string, unknown> | undefined)?.['commitment'],
    );
    jobs.push({
      external_id: String(job['id'] ?? ''),
      title,
      url,
      company,
      location,
      remote,
      salary_min_usd: salary.min,
      salary_max_usd: salary.max,
      salary_currency: salary.currency,
      jd_text: buildLeverJdText(job),
      posted_at: (job['createdAt'] as number) ?? null,
      ...(employmentType && { employment_type: employmentType }),
    });
  }
  return jobs;
}

export class LeverAdapter implements SourceAdapter {
  type = 'lever' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Lever board slug');
    const apiUrl = `https://api.lever.co/v0/postings/${identifier}`;
    ctx.emitProgress(`Fetching ${display_name} (Lever)…`);

    const json = await fetchJson(apiUrl, { allowedHosts: LEVER_ALLOWED_HOSTS, retries: 2, signal: ctx.abortSignal });
    const jobs = parseLever(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
