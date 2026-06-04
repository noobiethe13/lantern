export const FETCH_TIMEOUT_MS = 10_000;

export interface FetchOpts {
  /** Allowlist of permitted hostnames (lowercase). If omitted, only the
   *  private-host block applies. */
  allowedHosts?: string[];
}

const PRIVATE_HOST_RX = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

/**
 * Reject URLs that target private/loopback hosts or non-http(s) schemes, and
 * optionally constrain to a hostname allowlist. Throws on rejection.
 * Returns the parsed URL on success.
 *
 * This is the SSRF guard. It runs before every outbound fetch lantern makes
 * on behalf of a user-configured source.
 */
export function assertSafeHttpUrl(url: string, opts: FetchOpts = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`unsupported scheme: ${parsed.protocol}`);
  }
  // `URL.hostname` returns IPv6 addresses wrapped in brackets — strip them
  // so the regex table can match both v4 and v6 forms uniformly.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOST_RX.some(rx => rx.test(host))) {
    throw new Error(`refusing to fetch private/loopback host: ${host}`);
  }
  if (opts.allowedHosts && !opts.allowedHosts.includes(host)) {
    throw new Error(`host ${host} not in allowlist (${opts.allowedHosts.join(', ')})`);
  }
  return parsed;
}

/**
 * Validate that a user-supplied board-slug (Greenhouse / Ashby / Lever
 * identifier) is URL-path-safe. Allowed: alphanumerics, dashes, single dots
 * (Ashby uses them in tenant slugs like `lakera.ai`). Banned: `..`, leading
 * dots/dashes, slashes, URL-encoded segments, anything > 64 chars. Prevents
 * `../admin`-style escapes when interpolated into a fixed API URL template.
 */
export function assertValidSlug(slug: string, label = 'identifier'): string {
  if (!/^[a-z0-9][a-z0-9.\-]{0,63}$/i.test(slug) || slug.includes('..')) {
    throw new Error(
      `${label} "${slug}" is not a valid slug — must be alphanumerics, dashes, ` +
      `or single dots; starting with an alphanumeric; 1-64 chars; no "..".`,
    );
  }
  return slug;
}

export async function fetchJson(url: string, opts: FetchOpts = {}): Promise<unknown> {
  assertSafeHttpUrl(url, opts);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    // redirect: 'error' — refuse cross-origin redirects (e.g. a Greenhouse
    // response that 302s to 127.0.0.1 would otherwise bypass the host check).
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Like {@link fetchJson} but returns the raw response body as text. Used by
 * board adapters whose public feed is markdown (Workable) or XML (Personio)
 * rather than JSON. Same SSRF guard and `redirect: 'error'` contract.
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  assertSafeHttpUrl(url, opts);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}
