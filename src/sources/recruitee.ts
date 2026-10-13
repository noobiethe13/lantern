import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';
import { htmlToText } from './aggregator-util';

/**
 * Build the location string from every `locations[]` entry (city, state,
 * country — same shape Recruitee's own single-location fields use), not just
 * the first — `offer.location` is a preformatted string covering only
 * `locations[0]`, silently dropping the rest on a multi-location posting.
 * Falls back to the single-location fields for older payloads without
 * `locations[]`.
 */
function buildRecruiteeLocation(offer: Record<string, unknown>): string {
  const locs = Array.isArray(offer['locations']) ? (offer['locations'] as unknown[]) : [];
  const formatted = locs
    .map(l => {
      const loc = (l as Record<string, unknown>) ?? {};
      const city = (loc['city'] as string) || (loc['name'] as string) || '';
      const state = (loc['state'] as string) || '';
      const country = (loc['country'] as string) || '';
      return [city, state, country].filter(Boolean).join(', ');
    })
    .filter(Boolean);
  if (formatted.length > 0) return [...new Set(formatted)].join('; ');

  const city = (offer['city'] as string) || '';
  const country = (offer['country'] as string) || '';
  return (offer['location'] as string) || [city, country].filter(Boolean).join(', ');
}

/**
 * Recruitee exposes a public per-tenant offers API at
 * `https://<slug>.recruitee.com/api/offers/`. The tenant subdomain is the
 * variable part; we build the exact host from the validated slug and pin it as
 * the fetch allowlist so the SSRF guard rejects anything off that host.
 */
export function parseRecruitee(json: unknown, company: string, host: string): Job[] {
  const offers = (json as { offers?: unknown[] })?.offers;
  if (!Array.isArray(offers)) return [];

  const jobs: Job[] = [];
  for (const o of offers) {
    const offer = o as Record<string, unknown>;
    const title = (offer['title'] as string) ?? '';

    // Offer URL must resolve to https://<this tenant>.recruitee.com/… so the
    // link stays on the allowlisted host. Many tenants set `careers_url` to a
    // branded custom domain (e.g. vacatures.acme.nl) — in that case we fall
    // back to the canonical on-host offer page synthesised from the slug, which
    // recruitee always serves. An off-host link with no usable slug is dropped.
    let url = '';
    const rawUrl = (offer['careers_url'] as string) || (offer['url'] as string) || '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'https:' && parsed.hostname === host) url = parsed.href;
      } catch {
        // malformed URL → fall through to slug synthesis
      }
    }
    if (!url) {
      const slug = offer['slug'] as string | undefined;
      if (slug) url = `https://${host}/o/${encodeURIComponent(slug)}`;
    }
    if (!title || !url) continue;

    const remote = offer['remote'] === true;
    let location = buildRecruiteeLocation(offer);
    // `hybrid`/`on_site` aren't mutually exclusive with each other or with
    // `remote` (they're independent "which work modes are offered" flags) —
    // only suffix when the posting isn't itself remote, so L1's onsite regex
    // can still act on a non-remote posting without mislabeling a remote one.
    // Only append when there's a base location to qualify — an empty location
    // must stay empty (L1 treats a blank location as lenient/pass-through; a bare
    // "(Hybrid)"/"(On-site)" string is not a real place and would defeat that).
    if (!remote && location) {
      if (offer['on_site'] === true) location = `${location} (On-site)`;
      else if (offer['hybrid'] === true) location = `${location} (Hybrid)`;
    }

    const jd = htmlToText(
      [offer['description'] as string, offer['requirements'] as string]
        .filter(Boolean)
        .join('\n\n')
    );

    jobs.push({
      external_id: String(offer['id'] ?? ''),
      title,
      url,
      company,
      location,
      remote,
      jd_text: jd || undefined,
      posted_at: offer['published_at']
        ? new Date(offer['published_at'] as string).getTime()
        : null,
    });
  }
  return jobs;
}

export class RecruiteeAdapter implements SourceAdapter {
  type = 'recruitee' as const;

  async *fetch(ctx: SourceContext): AsyncIterable<Job> {
    const { identifier, display_name } = ctx.config as {
      identifier: string;
      display_name: string;
    };
    assertValidSlug(identifier, 'Recruitee tenant slug');
    const host = `${identifier}.recruitee.com`;
    const apiUrl = `https://${host}/api/offers/`;
    ctx.emitProgress(`Fetching ${display_name} (Recruitee)…`);

    const json = await fetchJson(apiUrl, { allowedHosts: [host], retries: 2, signal: ctx.abortSignal });
    const jobs = parseRecruitee(json, display_name, host);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
