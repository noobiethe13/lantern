// Shared helpers for the keyword-global aggregator adapters (remoteok,
// arbeitnow, himalayas). These sources take the role/keyword from
// `SourceContext.keywords` instead of a per-company slug.

const JD_MAX_CHARS = 8_000;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

/**
 * Strip HTML to readable plain text for storage in `jd_text`. Aggregator feeds
 * return HTML descriptions; we keep the DB lean and avoid feeding raw markup to
 * the L2 LLM (which only previews the first 4KB anyway). Not a security
 * boundary — the LLM-prompt cap/sanitise lives in `verdictPrompt`.
 */
export function htmlToText(html: string | undefined | null, cap = JD_MAX_CHARS): string {
  if (!html) return '';
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#?\w+;/g, m => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > cap ? text.slice(0, cap) : text;
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
