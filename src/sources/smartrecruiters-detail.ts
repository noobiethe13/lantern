import type { Job, SourceContext } from '../core/job';
import { fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';
import { annualizePay } from '../core/salary';

// Shared by `smartrecruiters` and `smartrecruiters_search`: neither list payload
// carries a description, but `/v1/companies/{company}/postings/{id}` does (plus
// the pay range when the employer publishes one). Called from enrich(), so the
// runner pays one request per L1 survivor rather than one per listed posting.
const SR_API_HOST = 'api.smartrecruiters.com';
const SR_PUBLIC_HOST = 'jobs.smartrecruiters.com';
// Same character set as per-company assertValidSlug, but SR identifiers keep
// their own casing and may carry underscores, which that helper rejects.
const COMPANY_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POSTING_ID_RX = /^[A-Za-z0-9-]{1,64}$/;

// Role first so the 8KB text cap trims the company boilerplate, not the
// requirements.
const SECTION_ORDER = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription'] as const;

/**
 * Recover `{ company, postingId }` from a stored SR job. The public URL
 * (`jobs.smartrecruiters.com/{company}/{postingId}`) carries the posting's own
 * identifier casing, which is the only company identifier a cross-tenant search
 * job has. Returns null unless both parts pass a strict character check, so a
 * malformed row can never steer the request off the fixed API path.
 */
export function smartRecruitersRefs(job: Job): { company: string; postingId: string } | null {
  let parts: string[];
  try {
    const u = new URL(job.url);
    if (u.protocol !== 'https:' || u.hostname !== SR_PUBLIC_HOST) return null;
    parts = u.pathname.split('/').filter(Boolean);
  } catch {
    return null;
  }
  if (parts.length !== 2) return null;
  const [company, postingId] = parts;
  if (!COMPANY_RX.test(company) || company.includes('..') || !POSTING_ID_RX.test(postingId)) return null;
  if (job.external_id && job.external_id !== postingId) return null;
  return { company, postingId };
}

/**
 * Map a `/postings/{id}` payload to the description and, when published, an
 * annual pay range (an hourly/monthly period is annualised by core/salary.ts).
 * Returns null when no section has text. Unknown-period or implausible
 * compensation is left unmapped rather than guessed at.
 */
export function parseSmartRecruitersDetail(json: unknown): Partial<Job> | null {
  const d = json as Record<string, unknown> | null;
  const sections = (d?.['jobAd'] as Record<string, unknown> | undefined)?.['sections'] as
    | Record<string, { text?: unknown } | undefined>
    | undefined;
  const html = SECTION_ORDER.map(k => sections?.[k]?.text)
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .join('\n\n');
  const jd = htmlToText(html);
  if (!jd) return null;

  const patch: Partial<Job> = { jd_text: jd };
  const comp = d?.['compensation'] as Record<string, unknown> | null | undefined;
  const min = comp?.['min'];
  const max = comp?.['max'];
  if (typeof comp?.['currency'] === 'string' && typeof min === 'number' && typeof max === 'number' && min > 0 && max >= min) {
    const annual = annualizePay(min, max, comp['period'], comp['currency']);
    if (annual) {
      patch.salary_min_usd = annual.min;
      patch.salary_max_usd = annual.max;
      patch.salary_currency = comp['currency'];
    }
  }
  return patch;
}

/** Fetch one posting's detail. A failure is recoverable (the job just stays
 *  without a JD), so it is reported as progress and returned as null. */
export async function enrichSmartRecruiters(job: Job, ctx: SourceContext): Promise<Partial<Job> | null> {
  const refs = smartRecruitersRefs(job);
  if (!refs) return null;
  try {
    const url = `https://${SR_API_HOST}/v1/companies/${refs.company}/postings/${refs.postingId}`;
    return parseSmartRecruitersDetail(await fetchJson(url, { allowedHosts: [SR_API_HOST], retries: 1 }));
  } catch (err) {
    ctx.emitProgress(
      `SmartRecruiters: JD enrich failed for ${refs.postingId} (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}
