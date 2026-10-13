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

/**
 * Both `location` and `atsLocation` can appear on the same payload — `location`
 * is frequently all-null (`{city:null,state:null}`) while `atsLocation`
 * ({city,state/province,country}) carries the real value. Fall back
 * field-by-field so a partially-null `location` still picks up what
 * `atsLocation` has. An empty result previously passed every L1 location
 * rule (a US-only role reaching L2 on an India search).
 */
function joinLocation(
  loc: Record<string, unknown> | undefined,
  atsLoc: Record<string, unknown> | undefined,
  remote: boolean,
): string {
  const city = loc?.['city'] ?? atsLoc?.['city'];
  const state = loc?.['state'] ?? atsLoc?.['state'] ?? atsLoc?.['province'];
  const country = loc?.['addressCountry'] ?? loc?.['country'] ?? atsLoc?.['country'];
  const parts = [city, state, country].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
  if (remote && !parts.some(p => /remote/i.test(p))) parts.push('Remote');
  return parts.join(', ');
}

/** BambooHR's `isRemote` is often null/undefined even on a posting with no
 *  fixed office; `locationType` is a more reliable signal (seen as `"1"` or
 *  the number `1`, depending on endpoint, on remote postings in live data). */
function isBambooRemote(j: Record<string, unknown>): boolean {
  const locationType = j['locationType'];
  return j['isRemote'] === true || locationType === '1' || locationType === 1;
}

export interface BambooListItem {
  id: string;
  title: string;
  isRemote: boolean;
  location: string;
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
    const remote = isBambooRemote(j);
    const location = joinLocation(
      j['location'] as Record<string, unknown> | undefined,
      j['atsLocation'] as Record<string, unknown> | undefined,
      remote,
    );
    out.push({ id, title, isRemote: remote, location });
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
  const remote = isBambooRemote(opening);
  const jd = htmlToText(opening['description'] as string);

  return {
    external_id: id,
    title,
    url,
    company,
    location: joinLocation(
      opening['location'] as Record<string, unknown> | undefined,
      opening['atsLocation'] as Record<string, unknown> | undefined,
      remote,
    ),
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
    location: item.location,
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
      await fetchJson(listUrl(identifier), { allowedHosts, headers: REQUEST_HEADERS, retries: 1, signal: ctx.abortSignal }),
    );

    let total = 0;
    let detailAttempts = 0;
    let detailFailures = 0;
    for (let i = 0; i < list.length; i++) {
      if (ctx.abortSignal.aborted) break;
      const item = list[i];

      let job: Job | null = null;
      if (i < PER_TENANT_DETAIL_CAP) {
        detailAttempts++;
        try {
          const detail = await fetchJson(detailUrl(identifier, item.id), {
            allowedHosts,
            headers: REQUEST_HEADERS,
            retries: 1,
            signal: ctx.abortSignal,
          });
          job = bambooDetailToJob(detail, display_name, identifier, item.id);
        } catch (err) {
          // Falls back to the list item (no jd_text/rich location) — but
          // count it and say so instead of swallowing it silently.
          detailFailures++;
          ctx.emitProgress(
            `${display_name}: detail fetch failed for job ${item.id}, falling back to list data (${err instanceof Error ? err.message : String(err)})`,
          );
        }
      }
      job ??= bambooListItemToJob(item, display_name, identifier);

      total++;
      yield job;
    }

    if (detailAttempts > 0 && detailFailures === detailAttempts) {
      throw new Error(
        `BambooHR "${display_name}": all ${detailFailures} detail fetches failed — every job fell back to list-only data (no description/rich location)`,
      );
    }

    ctx.emitProgress(`${display_name}: ${total} jobs`, total);
  }
}
