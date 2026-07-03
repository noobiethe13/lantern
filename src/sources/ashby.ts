import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';

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
 * minValue, maxValue}`; we take the `Salary` component billed per year and
 * ignore equity/bonus/hourly so we never compare an hourly rate against an
 * annual floor. Returns nulls when no annual salary component is present.
 */
function extractAshbySalary(compensation: unknown): AshbySalary {
  const none: AshbySalary = { min: null, max: null, currency: null };
  const comp = compensation as { summaryComponents?: unknown[] } | undefined;
  const components = Array.isArray(comp?.summaryComponents) ? comp!.summaryComponents! : [];
  const salary = components
    .map((c) => c as Record<string, unknown>)
    .find((c) => c['compensationType'] === 'Salary' && c['interval'] === '1 YEAR');
  if (!salary) return none;
  const minV = salary['minValue'];
  const maxV = salary['maxValue'];
  return {
    min: typeof minV === 'number' ? Math.round(minV) : null,
    max: typeof maxV === 'number' ? Math.round(maxV) : null,
    currency: typeof salary['currencyCode'] === 'string' ? (salary['currencyCode'] as string) : null,
  };
}

export function parseAshby(json: unknown, company: string): Job[] {
  const data = json as { jobs?: unknown[] };
  return (data.jobs ?? []).map((j: unknown) => {
    const job = j as Record<string, unknown>;
    const salary = extractAshbySalary(job['compensation']);
    const loc = job['location'];
    const jd = htmlToText((job['descriptionPlain'] as string) || (job['descriptionHtml'] as string));
    return {
      external_id: String(job['id'] ?? ''),
      title: (job['title'] as string) ?? '',
      url: (job['jobUrl'] as string) ?? '',
      company,
      location:
        typeof loc === 'string'
          ? loc
          : ((loc as Record<string, unknown>)?.['name'] as string) ?? '',
      salary_min_usd: salary.min,
      salary_max_usd: salary.max,
      salary_currency: salary.currency,
      jd_text: jd || undefined,
      posted_at: job['publishedAt']
        ? new Date(job['publishedAt'] as string).getTime()
        : null,
    };
  });
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
    });
    const jobs = parseAshby(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
