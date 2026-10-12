import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';

const SR_ALLOWED_HOSTS = ['api.smartrecruiters.com'];
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50; // safety cap (5000 postings @ 100/page)

const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/** ISO 3166-1 alpha-2 → English display name ("in" → "India"), or null when
 *  `code` isn't a 2-letter region code. SR's `location.country` is lowercase. */
function regionName(code: unknown): string | null {
  if (typeof code !== 'string' || !/^[a-z]{2}$/i.test(code)) return null;
  try {
    return REGION_NAMES.of(code.toUpperCase()) ?? null;
  } catch {
    return null;
  }
}

function buildPostingsUrl(slug: string, offset: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
}

/**
 * Parse a SmartRecruiters `/postings` page. The public posting URL is
 * `jobs.smartrecruiters.com/<companyIdentifier>/<postingId>` — no
 * "/postings/" segment and no title slug (a previous version rewrote
 * `j.ref`'s `/v1/companies/<slug>/postings/<id>` path verbatim onto the
 * public host, keeping the "/postings/" segment, which 404s there).
 * `j.company.identifier` is the posting's own casing of the slug (e.g.
 * "BoschGroup"); `identifier` — the source's configured slug — is the
 * fallback when a posting omits it.
 */
export function parseSmartRecruiters(json: unknown, company: string, identifier: string): Job[] {
  const items = (json as { content?: unknown[] })?.content;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = (j['name'] as string) ?? '';
    const postingId = j['id'];
    if (!title || !postingId) continue;

    const jCompany = j['company'] as Record<string, unknown> | undefined;
    const srIdentifier =
      typeof jCompany?.['identifier'] === 'string' && jCompany['identifier'] ? (jCompany['identifier'] as string) : identifier;
    const url = `https://jobs.smartrecruiters.com/${srIdentifier}/${postingId}`;

    const loc = (j['location'] as Record<string, unknown>) || {};
    const fullLocation =
      (loc['fullLocation'] as string) ||
      [loc['city'], loc['region'], regionName(loc['country'])].filter(Boolean).join(', ');
    const remote = loc['remote'] ? 'Remote' : '';
    const location = [fullLocation, remote].filter(Boolean).join(', ');

    // TODO(jd_text deferred): the postings list endpoint has no description; the
    // full jobAd needs a per-posting fetch (`/postings/{id}`). Deferred to avoid
    // N extra requests per company — so SmartRecruiters jobs reach L2 without a
    // description. Revisit if SR boards become a meaningful share of results.
    jobs.push({
      external_id: String(postingId ?? ''),
      title,
      url,
      company,
      location,
      posted_at: j['releasedDate']
        ? new Date(j['releasedDate'] as string).getTime()
        : null,
    });
  }
  return jobs;
}

export class SmartRecruitersAdapter implements SourceAdapter {
  type = 'smartrecruiters' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'SmartRecruiters company slug');
    ctx.emitProgress(`Fetching ${display_name} (SmartRecruiters)…`);

    let total = 0;
    for (let page = 0; page < SR_MAX_PAGES; page++) {
      if (ctx.abortSignal.aborted) break;
      const apiUrl = buildPostingsUrl(identifier, page * SR_PAGE_SIZE);
      const json = await fetchJson(apiUrl, { allowedHosts: SR_ALLOWED_HOSTS, retries: 2 });
      const pageItems = (json as { content?: unknown[] })?.content;
      const jobs = parseSmartRecruiters(json, display_name, identifier);
      for (const job of jobs) {
        yield job;
      }
      total += jobs.length;
      // Stop on a short/empty page — that's the last one.
      if (!Array.isArray(pageItems) || pageItems.length < SR_PAGE_SIZE) break;
    }
    ctx.emitProgress(`${display_name}: ${total} jobs`, total);
  }
}
