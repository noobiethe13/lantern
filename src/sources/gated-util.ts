// Shared helpers for the gated/unofficial aggregator adapters (linkedin,
// ziprecruiter, naukri). These hit undocumented public endpoints that rate-limit
// aggressively, so they share politeness primitives and keyword/location picking
// from the criteria-derived SourceContext. Default-disabled; see routes/sources.ts
// GATED_TYPES and the Settings "gated/unofficial" badge.

import type { SourceContext } from '../core/job';

// A realistic desktop-Chrome User-Agent. Several gated endpoints 403/return JS
// challenges for requests without a browser-ish UA (the SSRF guard + redirect
// rules still apply via core/fetch). This is identification, not evasion.
export const GATED_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drop the query string and fragment from a posting URL so the stored canonical
 * URL is stable across scans (gated boards append per-request tracking params
 * like `?refId=…&trackingId=…` that would otherwise defeat URL-keyed dedup).
 * Returns null if the href is absent or unparseable.
 */
export function stripUrlQuery(href: string | undefined | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Pick a single location string for boards whose search takes one `location`
 * param. Criteria carries an allow-list; we use the first entry, falling back to
 * "Remote" when the search requires remote and named no place. Empty string when
 * neither applies (the board then returns unscoped results, still L1-filtered).
 */
export function pickLocation(ctx: SourceContext): string {
  const first = (ctx.locations ?? []).find(l => l && l.trim());
  if (first) return first.trim();
  if (ctx.remoteRequired) return 'Remote';
  return '';
}

/**
 * Bound the keyword fan-out. Gated adapters issue one search per keyword (like
 * himalayas) and dedupe results; capping keeps request volume — and 429 risk —
 * low on these fragile endpoints.
 */
export function pickKeywords(ctx: SourceContext, max: number): string[] {
  return (ctx.keywords ?? []).map(k => k.trim()).filter(Boolean).slice(0, max);
}
