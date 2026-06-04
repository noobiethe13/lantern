import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { assertValidSlug, fetchJson } from '../core/fetch';

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

    const city = (offer['city'] as string) || '';
    const country = (offer['country'] as string) || '';
    const remote = offer['remote'] ? 'Remote' : '';
    const location =
      (offer['location'] as string) || [city, country, remote].filter(Boolean).join(', ');

    jobs.push({
      external_id: String(offer['id'] ?? ''),
      title,
      url,
      company,
      location,
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

    const json = await fetchJson(apiUrl, { allowedHosts: [host] });
    const jobs = parseRecruitee(json, display_name, host);
    ctx.emitProgress(`${display_name}: ${jobs.length} jobs`, jobs.length);

    for (const job of jobs) {
      yield job;
    }
  }
}
