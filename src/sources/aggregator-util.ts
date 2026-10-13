// Shared helpers for the keyword-global aggregator adapters (remoteok,
// arbeitnow, himalayas). These sources take the role/keyword from
// `SourceContext.keywords` instead of a per-company slug.

import { termMatches } from '../core/filter';

const JD_MAX_CHARS = 8_000;

// Named entities aggregator feeds actually use, beyond the basic five. Keyed by
// the entity name (lowercase, no & or ;) so lookup is case-insensitive.
const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
};

const ENTITY_RX = /&(#x?[0-9a-f]+|[a-z]+\d*);/gi;
// Broad on purpose (matches the strip-tags regex below) — used only to decide
// whether a second strip pass is needed after entity decoding.
const TAG_RX = /<[^>]+>/;

/**
 * Decode HTML entities: named (from {@link NAMED_ENTITIES}) and numeric, both
 * decimal (`&#8212;`) and hex (`&#x26;`), via `String.fromCodePoint`. Unknown
 * named entities are left as-is rather than dropped.
 */
export function decodeEntities(text: string): string {
  return text.replace(ENTITY_RX, (m, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const decoded = NAMED_ENTITIES[body.toLowerCase()];
    return decoded ?? m;
  });
}

function stripTags(text: string): string {
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Strip HTML to readable plain text for storage in `jd_text`. Aggregator feeds
 * return HTML descriptions; we keep the DB lean and avoid feeding raw markup to
 * the L2 LLM (which only previews the first 4KB anyway). Not a security
 * boundary — the LLM-prompt cap/sanitise lives in `verdictPrompt`.
 *
 * Entity-escaped HTML (a description whose HTML markup is itself HTML-entity
 * encoded, e.g. Greenhouse's `content`) hides its tags from a single strip
 * pass until entities are decoded — so this strips, decodes entities, and
 * strips again only if that decoding revealed literal tags. The length cap
 * applies once, to the final text, not to a still-encoded intermediate pass.
 * Idempotent on already-clean text, so calling it twice (as greenhouse.ts
 * does, to fully unwind double-encoded content) is safe.
 */
export function htmlToText(html: string | undefined | null, cap = JD_MAX_CHARS): string {
  if (!html) return '';
  let text = decodeEntities(stripTags(html));
  if (TAG_RX.test(text)) text = decodeEntities(stripTags(text));
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > cap ? text.slice(0, cap) : text;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Normalise a posted-at value to epoch milliseconds. Accepts a unix timestamp
 * in seconds or ms (number), or an ISO date string. Returns null when absent or
 * unparseable.
 */
export function toMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: values below ~year 2286 in ms are actually seconds.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/**
 * Case-insensitive match: true if any keyword appears as a substring in any of
 * the given haystack parts (title, tags, …). Used by the client-side-filtering
 * aggregators (remoteok, arbeitnow) whose APIs offer no server-side search.
 * Empty `keywords` matches nothing — the title-driven model means no keyword
 * yields no aggregator results.
 */
export function matchesAny(keywords: string[], ...parts: (string | string[] | undefined)[]): boolean {
  if (keywords.length === 0) return false;
  const hay = parts
    .flat()
    .filter((p): p is string => typeof p === 'string')
    .join(' ')
    .toLowerCase();
  return keywords.some(k => hay.includes(k.toLowerCase()));
}

/**
 * Whole-word title prefilter for aggregators with no server-side search
 * (workingnomads, weworkremotely, themuse). Uses the same matcher as L1's title
 * rule, so it only drops postings L1 would drop anyway — and unlike
 * {@link matchesAny}'s substring test, "java" does not match "JavaScript".
 * Empty `keywords` matches nothing.
 */
export function titleMatchesKeywords(keywords: string[], title: string): boolean {
  return keywords.some(k => termMatches(title, k));
}

/**
 * Admission test for the full-feed aggregators: a posting is kept when a keyword
 * is a whole word in its title OR in its description. A title-only match would
 * drop "Software Engineer II" on a backend search before L1 (and semantic rescue,
 * runner/semantic-rescue.ts) ever saw it. L1 still applies the title rule, so this
 * widens what is stored, not what passes. Empty `keywords` matches nothing.
 */
export function postingMatchesKeywords(keywords: string[], title: string, body: string | undefined): boolean {
  return titleMatchesKeywords(keywords, title) || (!!body && keywords.some(k => termMatches(body, k)));
}
