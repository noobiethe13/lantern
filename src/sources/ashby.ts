import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';
import { normalizeEmploymentLabel } from '../core/employment-type';
import { annualizePay, periodFromLabel } from '../core/salary';

const ASHBY_ALLOWED_HOSTS = ['api.ashbyhq.com'];

interface AshbySalary {
  min: number | null;
  max: number | null;
  currency: string | null;
}

/**
 * Pull the annual base-salary range + its native currency out of an Ashby
 * `compensation` object (present with `includeCompensation=true`). Salary lives
 * in `summaryComponents[]` as `{compensationType, interval, currencyCode,
 * minValue, maxValue}`; we take the `Salary` component (preferring one billed per
 * year) and ignore equity/bonus. An hourly/monthly component is annualised
 * (core/salary.ts) so it can meet L1's annual floor. Returns nulls when there is
 * no usable salary component.
 */
function extractAshbySalary(compensation: unknown): AshbySalary {
  const none: AshbySalary = { min: null, max: null, currency: null };
  const comp = compensation as { summaryComponents?: unknown[] } | undefined;
  const components = Array.isArray(comp?.summaryComponents) ? comp!.summaryComponents! : [];
  const salaries = components
    .map((c) => c as Record<string, unknown>)
    .filter((c) => c['compensationType'] === 'Salary');
  const salary =
    salaries.find((c) => periodFromLabel(c['interval']) === 'year') ??
    salaries.find((c) => periodFromLabel(c['interval']) != null);
  if (!salary) return none;
  const minV = salary['minValue'];
  const maxV = salary['maxValue'];
  const currency = typeof salary['currencyCode'] === 'string' ? (salary['currencyCode'] as string) : null;
  const annual = annualizePay(
    typeof minV === 'number' ? minV : null,
    typeof maxV === 'number' ? maxV : null,
    salary['interval'],
    currency,
  );
  return annual ? { ...annual, currency } : none;
}

/**
 * Build the location string from the primary + every secondary location plus
 * the postal country, and derive `remote` from `workplaceType` (falling back
 * to `isRemote` only when `workplaceType` is absent). `isRemote` alone isn't
 * trustworthy — Linear's Hybrid London posting carries `isRemote:true`.
 * Hybrid/onsite postings get a "(Hybrid)"/"(On-site)" suffix so L1's onsite
 * regex can act on the location string too.
 */
function buildAshbyLocation(job: Record<string, unknown>): { location: string; remote: boolean } {
  const loc = job['location'];
  const primary = typeof loc === 'string' ? loc : ((loc as Record<string, unknown>)?.['name'] as string) ?? '';
  const secondary = Array.isArray(job['secondaryLocations'])
    ? (job['secondaryLocations'] as unknown[])
        .map(l => (l as Record<string, unknown> | undefined)?.['location'])
        .filter((l): l is string => typeof l === 'string' && l.trim() !== '')
    : [];
  let location = [...new Set([primary, ...secondary].filter(l => l.trim() !== ''))].join('; ');

  const address = job['address'] as Record<string, unknown> | undefined;
  const postal = address?.['postalAddress'] as Record<string, unknown> | undefined;
  const country = typeof postal?.['addressCountry'] === 'string' ? (postal['addressCountry'] as string) : '';
  if (country && !location.toLowerCase().includes(country.toLowerCase())) {
    location = location ? `${location}, ${country}` : country;
  }

  const workplaceType = typeof job['workplaceType'] === 'string' ? (job['workplaceType'] as string) : null;
  const remote = workplaceType === 'Remote' || (workplaceType == null && job['isRemote'] === true);
  const wtLower = workplaceType?.toLowerCase();
  // Only append when there's a base location to qualify — an empty location must
  // stay empty (L1 treats a blank location as lenient/pass-through; a bare
  // "(Hybrid)"/"(On-site)" string is not a real place and would defeat that).
  if (location && wtLower === 'hybrid') location = `${location} (Hybrid)`;
  else if (location && wtLower === 'onsite') location = `${location} (On-site)`;

  return { location, remote };
}

export function parseAshby(json: unknown, company: string): Job[] {
  const data = json as { jobs?: unknown[] };
  const jobs: Job[] = [];
  for (const j of data.jobs ?? []) {
    const job = j as Record<string, unknown>;
    const url = (job['jobUrl'] as string) ?? '';
    const title = (job['title'] as string) ?? '';
    // A posting missing url or title would otherwise collide with every
    // other empty-url job on the `WHERE url = ?` upsert lookup.
    if (!url || !title) continue;

    const salary = extractAshbySalary(job['compensation']);
    const { location, remote } = buildAshbyLocation(job);
    const jd = htmlToText((job['descriptionPlain'] as string) || (job['descriptionHtml'] as string));
    const employmentType = normalizeEmploymentLabel(job['employmentType']);
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
      jd_text: jd || undefined,
      posted_at: job['publishedAt']
        ? new Date(job['publishedAt'] as string).getTime()
        : null,
      ...(employmentType && { employment_type: employmentType }),
    });
  }
  return jobs;
}

export class AshbyAdapter implements SourceAdapter {
  type = 'ashby' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Ashby board slug');
    const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${identifier}?includeCompensation=true`;
    ctx.emitProgress(`Fetching ${display_name} (Ashby)…`);

    // Ashby's posting API routinely takes >10 s to respond cold and aborts at
    // the default timeout — give it 30 s and a couple of retries.
    const json = await fetchJson(apiUrl, {
      allowedHosts: ASHBY_ALLOWED_HOSTS,
      timeoutMs: 30_000,
      retries: 2,
      signal: ctx.abortSignal,
    });
    const jobs = parseAshby(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
