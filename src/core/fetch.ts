export const FETCH_TIMEOUT_MS = 10_000;

// Backoff for retried attempts: base * 2^attempt + jitter, capped. A server's
// Retry-After (also capped) takes precedence when present.
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_AFTER_CAP_MS = 30_000;

export interface FetchOpts {
  /** Allowlist of permitted hostnames (lowercase). If omitted, only the
   *  private-host block applies. */
  allowedHosts?: string[];
  /** Extra request headers. Some aggregator APIs (e.g. RemoteOK) reject
   *  requests without a `User-Agent`. */
  headers?: Record<string, string>;
  /** Per-attempt timeout override. Defaults to {@link FETCH_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Extra attempts after the first, on retryable failures only (network
   *  errors, timeouts, HTTP 429/5xx). Default 0 — no retries. */
  retries?: number;
  /** Backoff base for retried attempts. Tests override this to keep retry
   *  suites fast; adapters should leave the default. */
  retryBaseDelayMs?: number;
  /** HTTP method. Defaults to GET. Workday's cxs job feed is a POST. */
  method?: 'GET' | 'POST';
  /** Request body, paired with `method: 'POST'`. A plain object is JSON-encoded
   *  (and a `Content-Type: application/json` header added unless one is set). */
  body?: unknown;
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

/** Non-2xx response, carrying the status so the retry loop can distinguish
 *  retryable (429/5xx) from permanent (other 4xx) failures. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) to a capped delay
 *  in ms, or null when absent/unparseable. */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) {
    return Math.min(secs * 1000, RETRY_AFTER_CAP_MS);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_CAP_MS);
  }
  return null;
}

/** First ~300 chars of the response body, whitespace-collapsed, for error
 *  messages — "HTTP 503" alone hides whether the board returned a captcha
 *  page, a JSON error, or an HTML maintenance notice. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) {
    return err.status === 429 || err.status >= 500;
  }
  // Anything else that escapes a fetch attempt is network-level (DNS failure,
  // connection reset, AbortError from our timeout) — worth retrying.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildRequestInit(opts: FetchOpts, signal: AbortSignal): RequestInit {
  // redirect: 'error' — refuse cross-origin redirects (e.g. a Greenhouse
  // response that 302s to 127.0.0.1 would otherwise bypass the host check).
  const init: RequestInit = { signal, redirect: 'error', headers: { ...opts.headers } };
  if (opts.method) init.method = opts.method;
  if (opts.body !== undefined) {
    const isString = typeof opts.body === 'string';
    init.body = isString ? (opts.body as string) : JSON.stringify(opts.body);
    if (!isString) {
      const h = init.headers as Record<string, string>;
      if (!Object.keys(h).some(k => k.toLowerCase() === 'content-type')) {
        h['Content-Type'] = 'application/json';
      }
    }
  }
  return init;
}

async function fetchOnce(url: string, opts: FetchOpts): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, buildRequestInit(opts, ctrl.signal));
    if (!res.ok) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const snippet = await bodySnippet(res);
      throw new HttpStatusError(
        res.status,
        retryAfterMs,
        snippet ? `HTTP ${res.status} — ${snippet}` : `HTTP ${res.status}`,
      );
    }
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch with the SSRF guard, per-attempt timeout, and optional retries
 * (exponential backoff + jitter; honors 429 Retry-After). The guard runs once
 * up front — a guard rejection is permanent and never retried. Backs
 * {@link fetchJson} / {@link fetchText}; not exported.
 */
async function fetchWithRetry(url: string, opts: FetchOpts): Promise<Response> {
  assertSafeHttpUrl(url, opts);
  const retries = opts.retries ?? 0;
  const base = opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, opts);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const retryAfter = err instanceof HttpStatusError ? err.retryAfterMs : null;
      const backoff = Math.min(base * 2 ** attempt, RETRY_MAX_DELAY_MS);
      await sleep((retryAfter ?? backoff) + Math.random() * base);
    }
  }
}

export async function fetchJson(url: string, opts: FetchOpts = {}): Promise<unknown> {
  const res = await fetchWithRetry(url, opts);
  return await res.json();
}

/**
 * Like {@link fetchJson} but returns the raw response body as text. Used by
 * board adapters whose public feed is markdown (Workable) or XML (Personio)
 * rather than JSON. Same SSRF guard and `redirect: 'error'` contract.
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return await res.text();
}
