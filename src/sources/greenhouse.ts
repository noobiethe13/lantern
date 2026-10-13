import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';

const GREENHOUSE_ALLOWED_HOSTS = ['boards-api.greenhouse.io'];

/** The trailing "country" segment of a Greenhouse office's `.location`
 *  string (its last comma-separated part), or null when empty/absent.
 *  `offices[].location` is the fuller per-office string ("New York, New
 *  York, United States"); `location.name` is often a shorter admin-set
 *  label with no country at all ("New York City, NY"). */
function officeCountry(office: unknown): string | null {
  const loc = (office as Record<string, unknown> | undefined)?.['location'];
  if (typeof loc !== 'string' || !loc.trim()) return null;
  const parts = loc.split(',').map(p => p.trim()).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/** Append any office country missing from `location.name`, deduped. */
function buildGreenhouseLocation(job: Record<string, unknown>): string {
  const name = ((job['location'] as Record<string, unknown>)?.['name'] as string) ?? '';
  const offices = Array.isArray(job['offices']) ? (job['offices'] as unknown[]) : [];
  const missing = [...new Set(offices.map(officeCountry).filter((c): c is string => c !== null))].filter(
    c => !name.toLowerCase().includes(c.toLowerCase()),
  );
  return missing.length > 0 ? [name, ...missing].filter(Boolean).join(', ') : name;
}

export function parseGreenhouse(json: unknown, company: string): Job[] {
  const data = json as { jobs?: unknown[] };
  const jobs: Job[] = [];
  for (const j of data.jobs ?? []) {
    const job = j as Record<string, unknown>;
    const url = (job['absolute_url'] as string) ?? '';
    const title = (job['title'] as string) ?? '';
    // A posting missing url or title would otherwise collide with every
    // other empty-url job on the `WHERE url = ?` upsert lookup.
    if (!url || !title) continue;

    // With `?content=true` greenhouse returns `content` as entity-encoded HTML
    // ("&lt;p&gt;…"). Decode entities first (pass 1) then strip tags (pass 2).
    const jd = htmlToText(htmlToText(job['content'] as string));
    // `first_published` is the true post date; `updated_at` bumps on any
    // edit (471/623 Anthropic postings updated >1 day after first publish,
    // max gap 885 days) and would otherwise make an old, edited role look new.
    const postedRaw = job['first_published'] ?? job['updated_at'];
    jobs.push({
      external_id: String(job['id'] ?? ''),
      title,
      url,
      company,
      location: buildGreenhouseLocation(job),
      jd_text: jd || undefined,
      posted_at: postedRaw ? new Date(postedRaw as string).getTime() : null,
    });
  }
  return jobs;
}

export class GreenhouseAdapter implements SourceAdapter {
  type = 'greenhouse' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Greenhouse board slug');
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${identifier}/jobs?content=true`;
    ctx.emitProgress(`Fetching ${display_name} (Greenhouse)…`);

    const json = await fetchJson(apiUrl, { allowedHosts: GREENHOUSE_ALLOWED_HOSTS, retries: 2, signal: ctx.abortSignal });
    const jobs = parseGreenhouse(json, display_name);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
