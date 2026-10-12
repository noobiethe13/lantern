export const FETCH_TIMEOUT_MS = 10_000;

// Backoff for retried attempts: base * 2^attempt + jitter, capped. A server's
// Retry-After (also capped) takes precedence when present.
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 10_000;
const RETRY_AFTER_CAP_MS = 30_000;
// A stalled or misbehaving board must not let a response body grow
// unbounded in memory — cap it and throw a clear error past this size.
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

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
  /^0\./, // 0.0.0.0/8 — "this network" / unspecified
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // 100.64.0.0/10 — CGNAT / shared address space
  /^::$/, // IPv6 unspecified address
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
  // `URL.hostname` returns IPv6 addresses wrapped in brackets and may carry a
  // trailing dot (a valid DNS root-label separator — `localhost.` is the same
  // host as `localhost` but would slip past the `^localhost$` anchor) —
  // normalize both before matching.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (isPrivateHost(host)) {
    throw new Error(`refusing to fetch private/loopback host: ${host}`);
  }
  if (opts.allowedHosts && !opts.allowedHosts.includes(host)) {
    throw new Error(`host ${host} not in allowlist (${opts.allowedHosts.join(', ')})`);
  }
  return parsed;
}

/** True when `host` (already bracket/trailing-dot stripped) is a private,
 *  loopback, or link-local address — directly, or via an IPv4 address
 *  embedded in an IPv6 literal (IPv4-mapped `::ffff:a.b.c.d`, or NAT64
 *  `64:ff9b::a.b.c.d` per RFC 6052) that the flat regex table can't see on
 *  its own. */
function isPrivateHost(host: string): boolean {
  if (PRIVATE_HOST_RX.some(rx => rx.test(host))) return true;
  const embedded = extractEmbeddedIPv4(host);
  return embedded !== null && PRIVATE_HOST_RX.some(rx => rx.test(embedded));
}

/** Unwrap an IPv4 address embedded in an IPv6 literal (IPv4-mapped or
 *  NAT64), or null when `host` isn't one of those forms. */
function extractEmbeddedIPv4(host: string): string | null {
  const groups = parseIPv6Groups(host);
  if (!groups) return null;
  const isV4Mapped = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff;
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(g => g === 0);
  if (!isV4Mapped && !isNat64) return null;
  const [hi, lo] = groups.slice(6);
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Expand a (possibly `::`-compressed) IPv6 literal into 8 16-bit groups, or
 *  null when `host` isn't one. `host` has already been through `new
 *  URL()`'s IPv6 parser/serializer, so any colon-containing hostname
 *  reaching here is guaranteed well-formed canonical IPv6 — this just
 *  re-expands it for the embedded-IPv4 check above. */
function parseIPv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const parseSide = (s: string): number[] => (s === '' ? [] : s.split(':').map(g => parseInt(g, 16)));
  const head = parseSide(halves[0]);
  const tail = halves.length === 2 ? parseSide(halves[1]) : [];
  if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...head, ...Array(halves.length === 2 ? missing : 0).fill(0), ...tail];
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

/** A response body exceeded {@link MAX_RESPONSE_BYTES}. Not retryable — a
 *  huge body is a property of the resource, not a transient failure. */
export class ResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`response body exceeded ${maxBytes}-byte cap`);
    this.name = 'ResponseTooLargeError';
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

/**
 * Read a response body to text, aborting with {@link ResponseTooLargeError}
 * once `maxBytes` is exceeded so a huge or endlessly-streamed body can't be
 * buffered into memory unbounded. Reads via the stream reader (not
 * `res.text()`) so the cap can apply mid-stream rather than after the fact.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseTooLargeError(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
}

/** First ~300 chars of the response body, whitespace-collapsed, for error
 *  messages — "HTTP 503" alone hides whether the board returned a captcha
 *  page, a JSON error, or an HTML maintenance notice. */
async function bodySnippet(res: Response): Promise<string> {
  try {
    const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof ResponseTooLargeError) return false;
  if (err instanceof HttpStatusError) {
    return err.status === 429 || err.status >= 500;
  }
  // JSON.parse only runs after readBodyCapped's reader signals `done` with no
  // exception — i.e. the body read to completion. A SyntaxError here is
  // therefore a malformed/unexpected response BODY, not a truncated one (a
  // connection reset mid-read throws its own network-level error out of
  // reader.read() before JSON.parse ever runs) — the same bytes come back on
  // retry, so retrying just wastes an attempt.
  if (err instanceof SyntaxError) return false;
  // fetch's own redirect:'error' contract (buildRequestInit) throws when the
  // server issues a redirect — Bun surfaces this as a plain Error whose message
  // starts with "UnexpectedRedirect". Deterministic (the same URL redirects the
  // same way every time), not a transient network condition.
  if (err instanceof Error && err.message.includes('UnexpectedRedirect')) return false;
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

async function fetchOnce(url: string, opts: FetchOpts, kind: 'json' | 'text'): Promise<unknown> {
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
    // Read (and for JSON, parse) the body here, inside the same try/finally
    // as the request — the abort timer is still armed, so a server that
    // sends headers then stalls the body gets aborted instead of hanging
    // fetchJson/fetchText forever. A body-read/parse failure throws from
    // inside this attempt too, so it's covered by fetchWithRetry's loop.
    const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
    return kind === 'json' ? JSON.parse(text) : text;
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
async function fetchWithRetry(url: string, opts: FetchOpts, kind: 'json' | 'text'): Promise<unknown> {
  assertSafeHttpUrl(url, opts);
  const retries = opts.retries ?? 0;
  const base = opts.retryBaseDelayMs ?? RETRY_BASE_DELAY_MS;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, opts, kind);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const retryAfter = err instanceof HttpStatusError ? err.retryAfterMs : null;
      const backoff = Math.min(base * 2 ** attempt, RETRY_MAX_DELAY_MS);
      await sleep((retryAfter ?? backoff) + Math.random() * base);
    }
  }
}

export async function fetchJson(url: string, opts: FetchOpts = {}): Promise<unknown> {
  return fetchWithRetry(url, opts, 'json');
}

/**
 * Like {@link fetchJson} but returns the raw response body as text. Used by
 * board adapters whose public feed is markdown (Workable) or XML (Personio)
 * rather than JSON. Same SSRF guard and `redirect: 'error'` contract.
 */
export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  return fetchWithRetry(url, opts, 'text') as Promise<string>;
}
