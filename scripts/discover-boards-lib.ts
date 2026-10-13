// Pure pieces of scripts/discover-boards.ts (slug extraction, the Common Crawl
// CDX client, the verifier pool, the output renderer). Kept free of file and
// process state, and with fetch/sleep injected, so they are unit-testable
// without touching the network.
import { assertSafeHttpUrl, assertValidSlug, HttpStatusError } from '../src/core/fetch';
import type { DiscoverableType } from '../src/config/seeds';

export type { DiscoverableType };

export interface CdxQuery {
  type: DiscoverableType;
  /** CDX `url` parameter: a `host/*` prefix match or a `*.domain` wildcard. */
  url: string;
}

export const CDX_QUERIES: CdxQuery[] = [
  { type: 'greenhouse', url: 'boards.greenhouse.io/*' },
  { type: 'greenhouse', url: 'job-boards.greenhouse.io/*' },
  { type: 'greenhouse', url: 'job-boards.eu.greenhouse.io/*' },
  { type: 'ashby', url: 'jobs.ashbyhq.com/*' },
  { type: 'lever', url: 'jobs.lever.co/*' },
  { type: 'workable', url: 'apply.workable.com/*' },
  { type: 'smartrecruiters', url: 'jobs.smartrecruiters.com/*' },
  { type: 'smartrecruiters', url: 'careers.smartrecruiters.com/*' },
  { type: 'recruitee', url: '*.recruitee.com' },
  { type: 'personio', url: '*.jobs.personio.de' },
  { type: 'personio', url: '*.jobs.personio.com' },
  { type: 'breezy', url: '*.breezy.hr' },
  { type: 'teamtailor', url: '*.teamtailor.com' },
  { type: 'rippling', url: 'ats.rippling.com/*' },
];

/** Boards whose tenant is the first URL path segment, by exact host. */
const PATH_HOSTS: Partial<Record<DiscoverableType, string[]>> = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'],
  ashby: ['jobs.ashbyhq.com'],
  lever: ['jobs.lever.co'],
  workable: ['apply.workable.com'],
  smartrecruiters: ['jobs.smartrecruiters.com', 'careers.smartrecruiters.com'],
  rippling: ['ats.rippling.com'],
};

/** Boards whose tenant is a single DNS label directly under one of these suffixes. */
const SUBDOMAIN_SUFFIXES: Partial<Record<DiscoverableType, string[]>> = {
  recruitee: ['.recruitee.com'],
  personio: ['.jobs.personio.de', '.jobs.personio.com'],
  breezy: ['.breezy.hr'],
  teamtailor: ['.teamtailor.com'],
};

// Path segments and subdomain labels that are product infrastructure, not a
// tenant. Shared across types: a false drop here only costs one board that the
// verifier could not have confirmed under that name anyway.
const RESERVED = new Set([
  'www', 'api', 'app', 'apps', 'admin', 'auth', 'oauth', 'login', 'logout', 'signin', 'sign-in',
  'signup', 'sign-up', 'register', 'sso', 'account', 'accounts', 'billing', 'dashboard', 'console',
  'portal', 'my', 'secure', 'support', 'help', 'docs', 'doc', 'blog', 'status', 'mail', 'email',
  'smtp', 'ftp', 'cdn', 'static', 'assets', 'media', 'img', 'images', 'public', 'dev', 'developer',
  'developers', 'staging', 'stage', 'test', 'demo', 'sandbox', 'beta', 'preview', 'partners',
  'partner', 'careers', 'career', 'jobs', 'job', 'go', 'info', 'marketing', 'community', 'embed',
  'webhooks', 'hooks', 'connect', 'integrations', 'scim', 'learn', 'academy', 'pages', 'cloud',
  'web', 'm', 'mobile', 'error', 'errors', 'health', 'healthcheck', 'search', 'about', 'apply',
  'privacy', 'terms', 'legal', 'security', 'v0', 'v1', 'v2', 'oneclick-ui', 'oneclick', 'ci',
  'j', 'na', 'eu', 'us', 'tt', 'favicon.ico', 'robots.txt', 'sitemap.xml', 'null', 'undefined',
]);

const FILE_EXTENSION_RX = /\.(js|mjs|css|json|xml|png|jpe?g|gif|svg|ico|txt|map|woff2?|ttf|eot|html?|php|pdf|webmanifest|rss|atom)$/i;
// Rippling prefixes some board URLs with a locale ("/en-GB/acme/jobs").
const LOCALE_RX = /^[a-z]{2}(-([a-z]{2}|\d{3}))?$/i;

function cleanSlug(raw: string | undefined, lowercase: boolean): string | null {
  if (!raw) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (lowercase) slug = slug.toLowerCase();
  if (RESERVED.has(slug.toLowerCase()) || FILE_EXTENSION_RX.test(slug)) return null;
  // A trailing dot/dash is a typo or an artifact of a URL pattern, not a tenant.
  if (/[.\-]$/.test(slug)) return null;
  try {
    assertValidSlug(slug);
  } catch {
    return null;
  }
  return slug;
}

/** Tenant segment of a path-style board URL, applying the per-type special cases. */
function pathSlug(type: DiscoverableType, url: URL): string | null {
  const segs = url.pathname.split('/').filter(Boolean);
  if (segs.length === 0) return null;

  // Greenhouse's embed widget carries the board in `?for=`.
  if ((type === 'greenhouse') && segs[0].toLowerCase() === 'embed') {
    return segs[1]?.toLowerCase() === 'job_board' ? cleanSlug(url.searchParams.get('for') ?? undefined, false) : null;
  }
  // SmartRecruiters' legacy UI route: /oneclick-ui/company/{slug}.
  if (type === 'smartrecruiters' && segs[0].toLowerCase() === 'oneclick-ui') {
    return segs[1]?.toLowerCase() === 'company' ? cleanSlug(segs[2], false) : null;
  }
  if (type === 'rippling' && LOCALE_RX.test(segs[0])) {
    if (segs.length > 1 && segs[1].toLowerCase() !== 'jobs') return cleanSlug(segs[1], false);
    // A bare "en-GB" is a locale landing page, never a tenant.
    if (segs.length === 1 && segs[0].includes('-')) return null;
  }
  return cleanSlug(segs[0], false);
}

/**
 * The tenant slug a crawled URL belongs to, or null when the URL is not a board
 * page of this type (wrong host, nested subdomain, reserved or junk segment).
 * Path-style tenants keep their case (Ashby and SmartRecruiters slugs can be
 * case-sensitive) and are folded case-insensitively later by the caller.
 */
export function extractSlug(type: DiscoverableType, rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');

  if (PATH_HOSTS[type]?.includes(host)) return pathSlug(type, url);

  for (const suffix of SUBDOMAIN_SUFFIXES[type] ?? []) {
    if (!host.endsWith(suffix)) continue;
    const label = host.slice(0, -suffix.length);
    if (label.includes('.')) return null; // a nested label is not a tenant
    return cleanSlug(label, true);
  }
  return null;
}

/** lowercase slug -> original-case variant -> number of crawled URLs. */
export type SlugCounts = Record<string, Record<string, number>>;

export function addUrl(counts: SlugCounts, type: DiscoverableType, rawUrl: string): boolean {
  const slug = extractSlug(type, rawUrl);
  if (!slug) return false;
  const key = slug.toLowerCase();
  const variants = (counts[key] ??= {});
  variants[slug] = (variants[slug] ?? 0) + 1;
  return true;
}

export interface Candidate {
  type: DiscoverableType;
  identifier: string;
  /** Crawled URLs seen for this tenant, used to rank before the per-type cap. */
  weight: number;
}

/**
 * Flatten per-type slug counts into candidates, dropping those already in the
 * seed list and keeping the most-crawled case variant of each. Highest-weight
 * first (a board with many crawled pages is more likely live and sizeable), ties
 * alphabetical so the cut at `cap` is stable between runs.
 */
export function buildCandidates(
  slugs: Partial<Record<DiscoverableType, SlugCounts>>,
  seeded: ReadonlySet<string>,
  cap: number,
): { candidates: Candidate[]; found: Record<string, number>; capped: Record<string, number> } {
  const candidates: Candidate[] = [];
  const found: Record<string, number> = {};
  const capped: Record<string, number> = {};
  for (const [type, counts] of Object.entries(slugs) as [DiscoverableType, SlugCounts][]) {
    const all: Candidate[] = [];
    for (const [key, variants] of Object.entries(counts)) {
      if (seeded.has(seedKey(type, key))) continue;
      const ranked = Object.entries(variants).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const weight = ranked.reduce((n, [, c]) => n + c, 0);
      all.push({ type, identifier: ranked[0][0], weight });
    }
    all.sort((a, b) => b.weight - a.weight || a.identifier.toLowerCase().localeCompare(b.identifier.toLowerCase()));
    found[type] = all.length;
    if (all.length > cap) capped[type] = all.length - cap;
    candidates.push(...all.slice(0, cap));
  }
  return { candidates, found, capped };
}

export function seedKey(type: string, identifier: string): string {
  return `${type.toLowerCase()}::${identifier.toLowerCase()}`;
}

/** "acme-corp" -> "Acme Corp". Only a fallback: most ATS list payloads carry no company name. */
export function prettifySlug(slug: string): string {
  return slug
    .split(/[-._]+/)
    .filter(Boolean)
    .map(w => (/^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export interface CdxDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  baseUrl?: string;
  userAgent?: string;
  /** Attempts before giving up on one request. CC's index server sheds load with 503s. */
  maxAttempts?: number;
  /** Backoff base in ms, doubled per attempt up to 2 minutes. */
  backoffMs?: number;
  log?: (msg: string) => void;
}

const CDX_BASE = 'https://index.commoncrawl.org';
const DATA_BASE = 'https://data.commoncrawl.org';

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  const secs = header === null ? NaN : Number(header);
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 120_000) : null;
}

/**
 * GET with SSRF guard (host pinned to the base URL's), no redirects, and retry
 * on network errors, 429 and 5xx. Returns the OK response with its body unread.
 */
async function getWithRetry(
  deps: CdxDeps,
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const url = `${base}${path}`;
  assertSafeHttpUrl(url, { allowedHosts: [new URL(base).hostname] });
  const attempts = deps.maxAttempts ?? 8;
  const backoff = deps.backoffMs ?? 3000;

  for (let attempt = 0; ; attempt++) {
    let wait: number | null = null;
    try {
      const res = await deps.fetchImpl(url, {
        redirect: 'error',
        headers: { 'User-Agent': deps.userAgent ?? 'lantern-discover/1.0 (personal job-search tool)', ...headers },
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) {
        throw new HttpStatusError(res.status, null, `Common Crawl HTTP ${res.status} for ${path}`);
      }
      wait = retryAfterMs(res);
      deps.log?.(`Common Crawl HTTP ${res.status}, backing off (attempt ${attempt + 1}/${attempts})`);
    } catch (err) {
      if (err instanceof HttpStatusError) throw err;
      deps.log?.(`Common Crawl network error (${(err as Error).message}), attempt ${attempt + 1}/${attempts}`);
    }
    if (attempt + 1 >= attempts) throw new Error(`Common Crawl request failed after ${attempts} attempts: ${path}`);
    await deps.sleep(wait ?? Math.min(backoff * 2 ** attempt, 120_000));
  }
}

const cdxGet = async (deps: CdxDeps, path: string): Promise<string> =>
  (await getWithRetry(deps, deps.baseUrl ?? CDX_BASE, path)).text();

/** Crawl ids, newest first (collinfo.json lists them that way). */
export async function listCrawls(deps: CdxDeps): Promise<string[]> {
  const body = JSON.parse(await cdxGet(deps, '/collinfo.json')) as { id?: unknown }[];
  return body.map(c => c.id).filter((id): id is string => typeof id === 'string' && /^CC-MAIN-\d{4}-\d{2}$/.test(id));
}

function cdxPath(crawl: string, url: string, extra: string): string {
  return `/${crawl}-index?url=${encodeURIComponent(url)}&output=json${extra}`;
}

/** Number of result pages for a query (0 when the crawl has no captures). */
export async function cdxNumPages(deps: CdxDeps, crawl: string, url: string): Promise<number> {
  const text = await cdxGet(deps, cdxPath(crawl, url, '&showNumPages=true'));
  const parsed = JSON.parse(text.trim().split('\n')[0] || '0') as number | { pages?: number };
  const pages = typeof parsed === 'number' ? parsed : parsed.pages;
  if (typeof pages !== 'number' || !Number.isFinite(pages) || pages < 0) {
    throw new Error(`unexpected showNumPages response for ${url}: ${text.slice(0, 120)}`);
  }
  return pages;
}

/** URLs from newline-delimited CDX JSON records. Malformed lines are counted, not silently dropped. */
function recordsToUrls(text: string, jsonOf: (line: string) => string): { urls: string[]; malformed: number } {
  const urls: string[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(jsonOf(line)) as { url?: unknown };
      if (typeof rec.url === 'string') urls.push(rec.url);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { urls, malformed };
}

export async function cdxPageUrls(
  deps: CdxDeps,
  crawl: string,
  url: string,
  page: number,
): Promise<{ urls: string[]; malformed: number }> {
  return recordsToUrls(await cdxGet(deps, cdxPath(crawl, url, `&fl=url&page=${page}`)), l => l);
}

/** A way to enumerate a crawl's captured URLs for a query, page by page. */
export interface CdxSource {
  crawls(count: number): Promise<string[]>;
  numPages(crawl: string, url: string): Promise<number>;
  pageUrls(crawl: string, url: string, page: number): Promise<{ urls: string[]; malformed: number }>;
}

export function indexServerSource(deps: CdxDeps): CdxSource {
  return {
    crawls: async count => (await listCrawls(deps)).slice(0, count),
    numPages: (crawl, url) => cdxNumPages(deps, crawl, url),
    pageUrls: (crawl, url, page) => cdxPageUrls(deps, crawl, url, page),
  };
}

/**
 * SURT key prefix for a CDX query: `jobs.ashbyhq.com/*` -> `com,ashbyhq,jobs)/`,
 * `*.recruitee.com` -> `com,recruitee,` (every subdomain). The bulk index files
 * are sorted by SURT key, so a prefix is a contiguous range.
 */
export function surtPrefix(query: string): string {
  if (query.startsWith('*.')) return `${query.slice(2).split('.').reverse().join(',')},`;
  const host = query.replace(/\/\*$/, '');
  return `${host.split('.').reverse().join(',')})/`;
}

export interface ClusterBlock {
  file: string;
  offset: number;
  length: number;
}

/**
 * The gzip blocks of a crawl's cluster.idx that can hold keys with `prefix`.
 * cluster.idx has one line per ~3000-record block (`surt timestamp\tfile\toffset
 * \tlength\tseq`) sorted by key, so the block starting at the last key below the
 * prefix may already contain the range's first records, and every line whose key
 * matches starts a block that does.
 */
export function blocksForPrefix(cluster: string, prefix: string): ClusterBlock[] {
  const blocks: ClusterBlock[] = [];
  let before: ClusterBlock | null = null;
  const toBlock = (parts: string[]): ClusterBlock => ({
    file: parts[1],
    offset: Number(parts[2]),
    length: Number(parts[3]),
  });
  for (const line of cluster.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const key = parts[0].split(' ')[0];
    if (key.startsWith(prefix)) {
      if (blocks.length === 0 && before) blocks.push(before);
      blocks.push(toBlock(parts));
    } else if (key < prefix) {
      before = toBlock(parts);
    } else {
      break;
    }
  }
  if (blocks.length === 0 && before) blocks.push(before);
  return blocks;
}

/** URLs in one decompressed cdx block (`surt timestamp {json}` lines). */
export function parseCdxBlock(text: string): { urls: string[]; malformed: number } {
  return recordsToUrls(text, line => line.slice(line.indexOf('{')));
}

/**
 * The same enumeration read straight from Common Crawl's public bulk index files
 * on data.commoncrawl.org instead of the rate-limited index server: the crawl's
 * cluster.idx picks the blocks for a query's SURT prefix, and each block is one
 * ranged GET. `loadCluster` supplies the (large, cached) cluster.idx text.
 */
export function bulkSource(
  deps: CdxDeps,
  loadCluster: (crawl: string) => Promise<string>,
  gunzip: (data: Uint8Array) => string,
  crawlIds: () => Promise<string[]>,
): CdxSource {
  const blockCache = new Map<string, ClusterBlock[]>();
  const blocksFor = async (crawl: string, url: string): Promise<ClusterBlock[]> => {
    const key = `${crawl}|${url}`;
    let blocks = blockCache.get(key);
    if (!blocks) {
      blocks = blocksForPrefix(await loadCluster(crawl), surtPrefix(url));
      blockCache.set(key, blocks);
    }
    return blocks;
  };
  return {
    crawls: async count => (await crawlIds()).slice(0, count),
    numPages: async (crawl, url) => (await blocksFor(crawl, url)).length,
    pageUrls: async (crawl, url, page) => {
      const block = (await blocksFor(crawl, url))[page];
      const res = await getWithRetry(
        deps,
        deps.baseUrl ?? DATA_BASE,
        `/cc-index/collections/${crawl}/indexes/${block.file}`,
        { Range: `bytes=${block.offset}-${block.offset + block.length - 1}` },
      );
      return parseCdxBlock(gunzip(new Uint8Array(await res.arrayBuffer())));
    },
  };
}

/** Counting semaphore for the verifier's per-provider in-flight cap. */
class Semaphore {
  private waiters: (() => void)[] = [];
  private free: number;
  constructor(n: number) {
    this.free = n;
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

/**
 * ok: open jobs. empty: reachable, none open. gone: a permanent 4xx such as 404. unusable: reachable but
 * the adapter can never read it (redirects to a custom domain, body past the size
 * cap), a permanent property like gone. error: transient, retried next run.
 */
export type ProbeStatus = 'ok' | 'empty' | 'gone' | 'unusable' | 'error';

export interface ProbeResult {
  status: ProbeStatus;
  jobs: number;
  name?: string;
  error?: string;
}

export interface VerifyOpts {
  concurrency: number;
  perType: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Checked before each probe starts, so a budget stop lets in-flight probes finish. */
  shouldStop?: () => boolean;
}

/**
 * Probe candidates with a global in-flight cap, a per-type cap, and a small
 * delay before each request. The candidate list is interleaved round-robin
 * across types first, so a long run of one provider never starves the pool
 * behind its per-type cap.
 */
export async function verifyCandidates(
  candidates: Candidate[],
  probe: (c: Candidate) => Promise<ProbeResult>,
  onResult: (c: Candidate, r: ProbeResult) => void,
  opts: VerifyOpts,
): Promise<void> {
  const queues = new Map<string, Candidate[]>();
  for (const c of candidates) (queues.get(c.type) ?? queues.set(c.type, []).get(c.type)!).push(c);
  const ordered: Candidate[] = [];
  for (let i = 0; ; i++) {
    let any = false;
    for (const q of queues.values()) {
      if (i < q.length) {
        ordered.push(q[i]);
        any = true;
      }
    }
    if (!any) break;
  }

  const perType = new Map<string, Semaphore>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < ordered.length) {
      if (opts.shouldStop?.()) return;
      const c = ordered[cursor++];
      const sem = perType.get(c.type) ?? perType.set(c.type, new Semaphore(opts.perType)).get(c.type)!;
      await sem.acquire();
      try {
        await opts.sleep(opts.delayMs);
        let result: ProbeResult;
        try {
          result = await probe(c);
        } catch (err) {
          result = { status: 'error', jobs: 0, error: err instanceof Error ? err.message : String(err) };
        }
        onResult(c, result);
      } finally {
        sem.release();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
}

/** A verified board. Only type, identifier and display_name reach the output file. */
export interface VerifiedBoard {
  type: DiscoverableType;
  identifier: string;
  display_name: string;
  jobs: number;
  verified_at: string;
}

export interface OutputMeta {
  crawls: string[];
  generated_at: string;
  candidates: Record<string, number>;
  verified: Record<string, number>;
}

/**
 * Deterministic file body: sorted by (type, lowercase identifier), one entry per
 * line, so regenerating diffs cleanly. JSON has no comments, so provenance lives
 * in a `generated` object; entry order and layout are fixed here, not by a
 * serializer.
 */
export function renderDiscoveredFile(meta: OutputMeta, boards: VerifiedBoard[]): string {
  const sorted = [...boards].sort(
    (a, b) => a.type.localeCompare(b.type) || a.identifier.toLowerCase().localeCompare(b.identifier.toLowerCase()),
  );
  const header = {
    note: 'Generated by scripts/discover-boards.ts from Common Crawl. Do not edit by hand. Rerun the script to refresh.',
    ...meta,
  };
  // Job counts and verification dates stay in the cache: they change on every run and
  // would make each regeneration rewrite every line.
  const lines = sorted.map(b => `    ${JSON.stringify({ type: b.type, identifier: b.identifier, display_name: b.display_name })}`);
  return `{\n  "generated": ${JSON.stringify(header)},\n  "sources": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** Company name from a Workable `jobs.md` heading ("# Hugging Face — All Open Positions"). */
export function workableCompanyName(feed: string): string | undefined {
  const m = /^#\s+(.+?)\s+[—–-]+\s+All Open Positions\s*$/im.exec(feed);
  return m?.[1]?.trim() || undefined;
}
