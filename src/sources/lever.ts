import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';

const LEVER_ALLOWED_HOSTS = ['api.lever.co'];

interface LeverSalary {
  min: number | null;
  max: number | null;
  currency: string | null;
}

/**
 * Map a Lever `salaryRange` (`{min, max, currency, interval}`) to native-
 * currency amounts. Only annual intervals are mapped — an hourly or monthly
 * figure must never be compared against L1's annual salary floor. Lever
 * intervals are strings like `per-year-salary`; absent interval is treated as
 * annual (the common case for posted ranges).
 */
function extractLeverSalary(salaryRange: unknown): LeverSalary {
  const none: LeverSalary = { min: null, max: null, currency: null };
  if (!salaryRange || typeof salaryRange !== 'object') return none;
  const sr = salaryRange as Record<string, unknown>;
  const interval = sr['interval'];
  if (typeof interval === 'string' && !/year|annual/i.test(interval)) return none;
  const minV = sr['min'];
  const maxV = sr['max'];
  if (typeof minV !== 'number' && typeof maxV !== 'number') return none;
  return {
    min: typeof minV === 'number' ? Math.round(minV) : null,
    max: typeof maxV === 'number' ? Math.round(maxV) : null,
    currency: typeof sr['currency'] === 'string' ? (sr['currency'] as string).toUpperCase() : null,
  };
}

export function parseLever(json: unknown, company: string): Job[] {
  if (!Array.isArray(json)) return [];
  return json.map((j: unknown) => {
    const job = j as Record<string, unknown>;
    const cats = job['categories'] as Record<string, unknown> | undefined;
    const jd = htmlToText((job['descriptionPlain'] as string) || (job['description'] as string));
    const salary = extractLeverSalary(job['salaryRange']);
    return {
      external_id: String(job['id'] ?? ''),
      title: (job['text'] as string) ?? '',
      url: (job['hostedUrl'] as string) ?? '',
      company,
      location: (cats?.['location'] as string) ?? '',
      salary_min_usd: salary.min,
      salary_max_usd: salary.max,
      salary_currency: salary.currency,
      jd_text: jd || undefined,
      posted_at: (job['createdAt'] as number) ?? null,
    };
  });
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

    const json = await fetchJson(apiUrl, { allowedHosts: LEVER_ALLOWED_HOSTS });
    const jobs = parseLever(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
