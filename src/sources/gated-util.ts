// Shared helpers for the gated/unofficial aggregator adapters (e.g. the LinkedIn
// guest endpoint). These hit undocumented public endpoints that rate-limit
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
 * Pick a single named location string for boards whose search takes one
 * `location`/`country` param. Criteria carries an allow-list; we use the first
 * entry. Returns '' when no place is named — deliberately NOT a "Remote"
 * fallback, since these APIs generally don't recognise that as a place (e.g.
 * SerpAPI's `locations.json?q=Remote` resolves to nothing, so every Google
 * Jobs request 404s/empties out). Callers that need to express "remote, no
 * specific place" use their own API's dedicated param instead (LinkedIn's
 * `f_WT=2`, Google Jobs's `ltype=1`).
 */
export function pickLocation(ctx: SourceContext): string {
  const first = (ctx.locations ?? []).find(l => l && l.trim());
  return first ? first.trim() : '';
}

/** True when `needle` occurs in `hay` as a whole word/phrase, not merely as a
 *  raw substring — mirrors `normalizeKeywords` in runner/scan.ts so "java"
 *  survives next to "javascript" (a raw `.includes()` would wrongly drop it,
 *  since "java" is a substring of "javascript"). */
function containsWords(hay: string, needle: string): boolean {
  return ` ${hay} `.includes(` ${needle} `);
}

/**
 * Bound the keyword fan-out. Gated adapters issue one search per keyword (like
 * himalayas) and dedupe results; capping keeps request volume — and 429 risk —
 * low on these fragile endpoints.
 *
 * Also cleans the raw criteria keywords first — trims, lowercases, drops
 * empties, dedupes, and drops any keyword that contains an already-kept
 * keyword as a WHOLE WORD (e.g. "flutter developer" after "flutter" — the
 * broader term is redundant since the narrower one already matches those
 * postings too) — so the capped slots aren't wasted on near-duplicates.
 */
export function pickKeywords(ctx: SourceContext, max: number): string[] {
  const kept: string[] = [];
  for (const raw of ctx.keywords ?? []) {
    const kw = raw.trim().toLowerCase();
    if (!kw) continue;
    if (kept.some(k => containsWords(kw, k))) continue;
    kept.push(kw);
  }
  return kept.slice(0, max);
}
