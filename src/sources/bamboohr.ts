import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText, toMillis } from './aggregator-util';
import { GATED_USER_AGENT } from './gated-util';

// BambooHR's public careers JSON. `{sub}.bamboohr.com/careers/list` enumerates
// open roles (id + title only); `{sub}.bamboohr.com/careers/{id}/detail` carries
// the description, posted date, full location, and share URL. No auth.
const BAMBOO_HOST_SUFFIX = '.bamboohr.com';
const PER_TENANT_DETAIL_CAP = 80; // bound per-job detail fetches on large tenants
const REQUEST_HEADERS = { 'User-Agent': GATED_USER_AGENT, Accept: 'application/json' };

function host(slug: string): string {
  return `${slug}${BAMBOO_HOST_SUFFIX}`;
}

function listUrl(slug: string): string {
  return `https://${host(slug)}/careers/list`;
}

function detailUrl(slug: string, id: string): string {
  return `https://${host(slug)}/careers/${encodeURIComponent(id)}/detail`;
}

function joinLocation(loc: Record<string, unknown> | undefined, remote: boolean): string {
  const parts = [loc?.['city'], loc?.['state'], loc?.['addressCountry'] ?? loc?.['country']]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (remote && !parts.some(p => /remote/i.test(p))) parts.push('Remote');
  return parts.join(', ');
}

export interface BambooListItem {
  id: string;
  title: string;
  isRemote: boolean;
}

/** Enumerate open roles from a `/careers/list` response. Drops entries missing
 *  an id or title. The list carries no description/date — those come from detail. */
export function parseBambooList(json: unknown): BambooListItem[] {
  const items = (json as { result?: unknown[] })?.result;
  if (!Array.isArray(items)) return [];

  const out: BambooListItem[] = [];
  for (const it of items) {
    const j = it as Record<string, unknown>;
    const id = j['id'] != null ? String(j['id']) : '';
    const title = (j['jobOpeningName'] as string)?.trim() ?? '';
    if (!id || !title) continue;
    out.push({ id, title, isRemote: j['isRemote'] === true });
  }
  return out;
}

/**
 * Build a Job from a `/careers/{id}/detail` response. Reads title, full location,
 * posted date, share URL, and HTML description (→ jd_text). `compensation` is an
 * unstructured free-text string on BambooHR, so salary is left unmapped (no
 * reliable min/max). Returns null when the payload lacks a usable title.
 */
export function bambooDetailToJob(
  json: unknown,
  company: string,
  slug: string,
  id: string,
): Job | null {
  const opening = (json as { result?: { jobOpening?: Record<string, unknown> } })?.result?.jobOpening;
  if (!opening) return null;

  const title = (opening['jobOpeningName'] as string)?.trim() ?? '';
  if (!title) return null;

  const shareUrl = typeof opening['jobOpeningShareUrl'] === 'string' ? (opening['jobOpeningShareUrl'] as string) : '';
  const url = shareUrl || `https://${host(slug)}/careers/${id}`;
  const remote = opening['isRemote'] === true;
  const jd = htmlToText(opening['description'] as string);

  return {
    external_id: id,
    title,
    url,
    company,
    location: joinLocation(opening['location'] as Record<string, unknown> | undefined, remote),
    remote,
    posted_at: toMillis(opening['datePosted']),
    jd_text: jd || undefined,
  };
}

/** Fallback Job from a list item alone (used past the per-tenant detail cap). No
 *  description — jd_text is omitted (null in DB) so it isn't ghost-flagged. */
export function bambooListItemToJob(item: BambooListItem, company: string, slug: string): Job {
  return {
    external_id: item.id,
    title: item.title,
    url: `https://${host(slug)}/careers/${item.id}`,
    company,
    remote: item.isRemote,
  };
}

export class BambooHrAdapter implements SourceAdapter {
  type = 'bamboohr' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as { identifier: string; display_name: string };
    assertValidSlug(identifier, 'BambooHR subdomain slug');
    const allowedHosts = [host(identifier)];
    ctx.emitProgress(`Fetching ${display_name} (BambooHR)…`);

    const list = parseBambooList(
      await fetchJson(listUrl(identifier), { allowedHosts, headers: REQUEST_HEADERS, retries: 1 }),
    );

    let total = 0;
    for (let i = 0; i < list.length; i++) {
      if (ctx.abortSignal.aborted) break;
      const item = list[i];

      let job: Job | null = null;
      if (i < PER_TENANT_DETAIL_CAP) {
        try {
          const detail = await fetchJson(detailUrl(identifier, item.id), {
            allowedHosts,
            headers: REQUEST_HEADERS,
            retries: 1,
          });
          job = bambooDetailToJob(detail, display_name, identifier, item.id);
        } catch {
          // detail fetch failed → fall back to the list item (no jd_text)
        }
      }
      job ??= bambooListItemToJob(item, display_name, identifier);

      total++;
      yield job;
    }

    ctx.emitProgress(`${display_name}: ${total} jobs`, total);
  }
}
