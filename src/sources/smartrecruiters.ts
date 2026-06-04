import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';

const SR_ALLOWED_HOSTS = ['api.smartrecruiters.com'];
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50; // safety cap (5000 postings @ 100/page)

function buildPostingsUrl(slug: string, offset: number): string {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a SmartRecruiters `/postings` page. The public posting URL is derived
 * from `j.ref` (an `api.smartrecruiters.com/v1/companies/<slug>/postings/<id>`
 * link) rewritten to the public `jobs.smartrecruiters.com/<slug>/postings/<id>`
 * host. If `ref` is missing or off-host we synthesise one from the company slug
 * + posting id; entries with no resolvable URL are dropped.
 */
export function parseSmartRecruiters(json: unknown, company: string): Job[] {
  const items = (json as { content?: unknown[] })?.content;
  if (!Array.isArray(items)) return [];

  const jobs: Job[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const title = (j['name'] as string) ?? '';

    const loc = (j['location'] as Record<string, unknown>) || {};
    const fullLocation =
      (loc['fullLocation'] as string) ||
      [loc['city'], loc['region'], loc['country']].filter(Boolean).join(', ');
    const remote = loc['remote'] ? 'Remote' : '';
    const location = [fullLocation, remote].filter(Boolean).join(', ');

    let url = '';
    if (typeof j['ref'] === 'string') {
      try {
        const ref = new URL(j['ref'] as string);
        if (
          ref.protocol === 'https:' &&
          ref.hostname === 'api.smartrecruiters.com' &&
          ref.pathname.startsWith('/v1/companies/')
        ) {
          url = `https://jobs.smartrecruiters.com/${ref.pathname.slice('/v1/companies/'.length)}`;
        }
      } catch {
        // malformed ref → fall through to synthesis
      }
    }
    if (!url && j['id']) {
      const companySlug = slugify(company);
      if (companySlug) url = `https://jobs.smartrecruiters.com/${companySlug}/${j['id']}-${slugify(title)}`;
    }
    if (!title || !url) continue;

    jobs.push({
      external_id: String(j['id'] ?? ''),
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
      const json = await fetchJson(apiUrl, { allowedHosts: SR_ALLOWED_HOSTS });
      const pageItems = (json as { content?: unknown[] })?.content;
      const jobs = parseSmartRecruiters(json, display_name);
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
