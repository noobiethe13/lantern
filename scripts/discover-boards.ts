// Discover per-company ATS boards from Common Crawl's index, verify each one
// live through the real source adapter, and write src/config/discovered-sources.json.
//
//   bun scripts/discover-boards.ts                 # discover, verify, write
//   bun scripts/discover-boards.ts --types ashby,lever --crawls 3
//   bun scripts/discover-boards.ts --cdx-source index  # use the CDX server (often unavailable)
//   bun scripts/discover-boards.ts --types rippling --rediscover  # re-extract after a rule fix
//   bun scripts/discover-boards.ts --reverify-days 14  # re-probe results older than 14 days
//   bun scripts/discover-boards.ts --skip-cdx      # reuse cached candidates
//   bun scripts/discover-boards.ts --write-only    # just regenerate the file
//
// Not imported by the server. Resumable: every CDX page and every probe result is
// checkpointed under .discovery-cache/ (gitignored), so an interrupted run picks up
// where it stopped. See docs/sources.md "Discovered boards".
import {
  appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import yaml from 'js-yaml';
import { fetchJson, fetchText, HttpStatusError, ResponseTooLargeError } from '../src/core/fetch';
import { JobShape, type SourceAdapter, type SourceContext } from '../src/core/job';
import { DISCOVERABLE_TYPES, DISCOVERED_SOURCES_FILE, type DiscoverableType } from '../src/config/seeds';
import { GreenhouseAdapter } from '../src/sources/greenhouse';
import { AshbyAdapter } from '../src/sources/ashby';
import { LeverAdapter } from '../src/sources/lever';
import { WorkableAdapter } from '../src/sources/workable';
import { SmartRecruitersAdapter } from '../src/sources/smartrecruiters';
import { RecruiteeAdapter } from '../src/sources/recruitee';
import { PersonioAdapter } from '../src/sources/personio';
import { BreezyAdapter } from '../src/sources/breezy';
import { TeamtailorAdapter } from '../src/sources/teamtailor';
import { RipplingAdapter } from '../src/sources/rippling';
import {
  CDX_QUERIES,
  addUrl,
  buildCandidates,
  bulkSource,
  indexServerSource,
  prettifySlug,
  renderDiscoveredFile,
  seedKey,
  verifyCandidates,
  workableCompanyName,
  type Candidate,
  type CdxDeps,
  type CdxSource,
  type ProbeResult,
  type SlugCounts,
  type VerifiedBoard,
} from './discover-boards-lib';

// Imported individually: src/sources/index.ts also pulls in remotive-budget,
// which opens the app database.
const ADAPTERS: Record<DiscoverableType, SourceAdapter> = {
  greenhouse: new GreenhouseAdapter(),
  ashby: new AshbyAdapter(),
  lever: new LeverAdapter(),
  workable: new WorkableAdapter(),
  smartrecruiters: new SmartRecruitersAdapter(),
  recruitee: new RecruiteeAdapter(),
  personio: new PersonioAdapter(),
  breezy: new BreezyAdapter(),
  teamtailor: new TeamtailorAdapter(),
  rippling: new RipplingAdapter(),
};

const ROOT = join(import.meta.dir, '..');
const CACHE_DIR = join(ROOT, '.discovery-cache');
const STATE_FILE = join(CACHE_DIR, 'candidates.json');
const VERIFIED_FILE = join(CACHE_DIR, 'verified.jsonl');
const OUTPUT_FILE = join(ROOT, DISCOVERED_SOURCES_FILE);
const SEED_FILE = join(ROOT, 'src/config/seed-sources.yml');

const PAGE_DELAY_MS = 2000;
const BULK_PAGE_DELAY_MS = 250;
const PROBE_DELAY_MS = 150;
const GLOBAL_CONCURRENCY = 8;
const PER_TYPE_CONCURRENCY = 4;

interface CdxProgress {
  pages: number;
  next: number;
}

interface State {
  crawls: string[];
  cdx: Record<string, CdxProgress>;
  slugs: Partial<Record<DiscoverableType, SlugCounts>>;
}

interface VerifiedRecord {
  type: DiscoverableType;
  identifier: string;
  status: ProbeResult['status'];
  jobs: number;
  name?: string;
  at: string;
}

interface Args {
  types: DiscoverableType[];
  crawls: number;
  capPerType: number;
  maxPages: number;
  budgetMinutes: number;
  perType: number;
  probeDelayMs: number;
  reverifyDays: number;
  rediscover: boolean;
  cdxSource: 'index' | 'bulk';
  skipCdx: boolean;
  skipVerify: boolean;
  writeOnly: boolean;
}

function parseReverifyDays(raw: string | undefined): number {
  if (raw === undefined) return 30;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--reverify-days must be a number of days, 0 or more (got "${raw}")`);
  }
  return days;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const types = (get('--types')?.split(',') ?? [...DISCOVERABLE_TYPES]) as DiscoverableType[];
  for (const t of types) {
    if (!(DISCOVERABLE_TYPES as readonly string[]).includes(t)) throw new Error(`unknown type: ${t}`);
  }
  const writeOnly = argv.includes('--write-only');
  return {
    types,
    crawls: Number(get('--crawls') ?? 2),
    capPerType: Number(get('--cap-per-type') ?? 6000),
    maxPages: Number(get('--max-pages') ?? Infinity),
    budgetMinutes: Number(get('--budget-minutes') ?? 110),
    // Lower these for a provider that answers 429 (Workable does under 4 parallel requests).
    perType: Number(get('--per-type') ?? PER_TYPE_CONCURRENCY),
    probeDelayMs: Number(get('--probe-delay-ms') ?? PROBE_DELAY_MS),
    // Results older than this are probed again, so boards that closed or reopened are picked up.
    reverifyDays: parseReverifyDays(get('--reverify-days')),
    rediscover: argv.includes('--rediscover'),
    // The bulk files on data.commoncrawl.org are the dependable route. The CDX server
    // sheds load and has refused every connection for stretches of days.
    cdxSource: get('--cdx-source') === 'index' ? 'index' : 'bulk',
    skipCdx: writeOnly || argv.includes('--skip-cdx'),
    skipVerify: writeOnly || argv.includes('--skip-verify'),
    writeOnly,
  };
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const log = (msg: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { crawls: [], cdx: {}, slugs: {} };
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as State;
}

function saveState(state: State): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  // Write-then-rename so a kill mid-write never leaves a truncated checkpoint.
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, STATE_FILE);
}

function loadVerified(): Map<string, VerifiedRecord> {
  const latest = new Map<string, VerifiedRecord>();
  if (!existsSync(VERIFIED_FILE)) return latest;
  const lines = readFileSync(VERIFIED_FILE, 'utf-8').split('\n').filter(l => l.trim());
  lines.forEach((line, i) => {
    let rec: VerifiedRecord;
    try {
      rec = JSON.parse(line) as VerifiedRecord;
    } catch (err) {
      // A kill mid-append leaves a truncated final line. Anywhere else it is corruption.
      if (i === lines.length - 1) {
        log('ignoring a half-written last line in verified.jsonl');
        return;
      }
      throw err;
    }
    const key = seedKey(rec.type, rec.identifier);
    // A transient error while re-checking must not erase an earlier real result.
    const earlier = latest.get(key);
    if (rec.status === 'error' && earlier && earlier.status !== 'error') return;
    latest.set(key, rec);
  });
  return latest;
}

function loadSeedKeys(): Set<string> {
  const raw = yaml.load(readFileSync(SEED_FILE, 'utf-8')) as { sources?: { type: string; identifier: string }[] };
  return new Set((raw.sources ?? []).map(s => seedKey(s.type, s.identifier)));
}

const DATA_HOST = 'https://data.commoncrawl.org';

/** Newest crawls that published a bulk index, found by probing week numbers downward. */
async function bulkCrawlIds(deps: CdxDeps): Promise<string[]> {
  const found: string[] = [];
  const year = new Date().getFullYear();
  for (const y of [year, year - 1]) {
    for (let week = 53; week >= 1; week--) {
      const id = `CC-MAIN-${y}-${String(week).padStart(2, '0')}`;
      const res = await deps.fetchImpl(`${DATA_HOST}/cc-index/collections/${id}/indexes/cluster.idx`, {
        method: 'HEAD',
        redirect: 'error',
      });
      if (res.ok) found.push(id);
      if (found.length >= 4) return found;
    }
  }
  return found;
}

const clusterText = new Map<string, string>();

/** cluster.idx is ~100 MB and read once per crawl, so keep it on disk between runs. */
async function loadClusterIdx(crawl: string): Promise<string> {
  const cached = clusterText.get(crawl);
  if (cached) return cached;
  mkdirSync(CACHE_DIR, { recursive: true });
  const path = join(CACHE_DIR, `cluster-${crawl}.idx`);
  const url = `${DATA_HOST}/cc-index/collections/${crawl}/indexes/cluster.idx`;
  for (let attempt = 1; !existsSync(path); attempt++) {
    log(`downloading ${url} (attempt ${attempt})`);
    try {
      // A stalled transfer is cut at 4 minutes (the file normally lands in well under one).
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(4 * 60_000) });
      if (!res.ok) throw new Error(`cluster.idx HTTP ${res.status}`);
      const expected = Number(res.headers.get('content-length'));
      const tmp = `${path}.part`;
      // Streamed to disk: Bun.write(response) buffered the whole body and stalled here.
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
      if (expected && statSync(tmp).size !== expected) throw new Error('download was truncated');
      renameSync(tmp, path);
    } catch (err) {
      log(`cluster.idx download failed: ${(err as Error).message}`);
      if (attempt >= 3) throw err;
      await sleep(5000);
    }
  }
  const text = readFileSync(path, 'utf-8');
  clusterText.set(crawl, text);
  return text;
}

function cdxSource(args: Args): CdxSource {
  const deps: CdxDeps = { fetchImpl: fetch, sleep, log };
  if (args.cdxSource === 'index') return indexServerSource(deps);
  return bulkSource(deps, loadClusterIdx, data => gunzipSync(data).toString('utf-8'), () => bulkCrawlIds(deps));
}

async function discover(args: Args, state: State): Promise<void> {
  const source = cdxSource(args);
  // Re-listed on every run so a newer crawl is picked up; progress is keyed per crawl,
  // so crawls already walked are skipped and their slugs stay in the candidate pool.
  try {
    state.crawls = await source.crawls(args.crawls);
  } catch (err) {
    if (state.crawls.length === 0) throw err;
    log(`could not list crawls (${(err as Error).message}), continuing with ${state.crawls.join(', ')}`);
  }
  log(`crawls: ${state.crawls.join(', ')}`);

  // Slugs are extracted as pages stream in, so a changed extraction rule only takes
  // effect for a type once its cached counts and page progress are dropped.
  if (args.rediscover) {
    for (const type of args.types) delete state.slugs[type];
    const urls = new Set(CDX_QUERIES.filter(q => args.types.includes(q.type)).map(q => q.url));
    for (const key of Object.keys(state.cdx)) if (urls.has(key.split('|')[2])) delete state.cdx[key];
  }

  for (const crawl of state.crawls) {
    for (const query of CDX_QUERIES.filter(q => args.types.includes(q.type))) {
      // Page numbering differs between sources, so progress is keyed by source too.
      const key = `${args.cdxSource}|${crawl}|${query.url}`;
      try {
        let progress = state.cdx[key];
        if (!progress) {
          progress = { pages: await source.numPages(crawl, query.url), next: 0 };
          state.cdx[key] = progress;
          log(`${key}: ${progress.pages} pages`);
        }
        const last = Math.min(progress.pages, args.maxPages);
        const counts = (state.slugs[query.type] ??= {});
        while (progress.next < last) {
          const { urls, malformed } = await source.pageUrls(crawl, query.url, progress.next);
          let kept = 0;
          for (const url of urls) if (addUrl(counts, query.type, url)) kept++;
          progress.next++;
          saveState(state);
          log(`${key} page ${progress.next}/${progress.pages}: ${urls.length} urls, ${kept} tenant urls${malformed ? `, ${malformed} malformed` : ''}`);
          await sleep(args.cdxSource === 'index' ? PAGE_DELAY_MS : BULK_PAGE_DELAY_MS);
        }
      } catch (err) {
        // One failing query must not abandon the rest. Its progress is saved, so
        // a rerun resumes it.
        log(`ERROR ${key}: ${(err as Error).message} (rerun to resume)`);
      }
    }
  }
  saveState(state);
}

function probeContext(identifier: string): SourceContext {
  return {
    sourceId: 0,
    config: { identifier, display_name: prettifySlug(identifier) },
    // Big Workable accounts only answer a keyword search.
    keywords: ['engineer'],
    emitProgress: () => {},
    abortSignal: AbortSignal.timeout(120_000),
  };
}

/** Company name for a verified board where the ATS exposes one cheaply. */
async function fetchName(c: Candidate): Promise<string | undefined> {
  try {
    if (c.type === 'greenhouse') {
      const json = (await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${c.identifier}`, {
        allowedHosts: ['boards-api.greenhouse.io'],
        retries: 1,
      })) as { name?: unknown };
      return typeof json.name === 'string' && json.name.trim() ? json.name.trim() : undefined;
    }
    if (c.type === 'workable') {
      const text = await fetchText(`https://apply.workable.com/${c.identifier}/jobs.md`, {
        allowedHosts: ['apply.workable.com'],
        retries: 1,
      });
      return workableCompanyName(text);
    }
  } catch (err) {
    // The board is already verified live; a missing name only costs polish, and
    // the caller falls back to the slug-derived name.
    log(`name lookup failed for ${c.type}:${c.identifier}: ${(err as Error).message}`);
  }
  return undefined;
}

async function probe(c: Candidate): Promise<ProbeResult> {
  let jobs = 0;
  try {
    for await (const job of ADAPTERS[c.type].fetch(probeContext(c.identifier))) {
      if (JobShape.safeParse(job).success) jobs++;
    }
  } catch (err) {
    // Any non-429 4xx is the board refusing us for good (404/410 gone, 401/403 private).
    if (err instanceof HttpStatusError && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return { status: 'gone', jobs: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ResponseTooLargeError || message.includes('UnexpectedRedirect')) {
      return { status: 'unusable', jobs: 0, error: message };
    }
    return { status: 'error', jobs: 0, error: message };
  }
  if (jobs === 0) return { status: 'empty', jobs: 0 };
  return { status: 'ok', jobs, name: await fetchName(c) };
}

async function verify(args: Args, state: State): Promise<void> {
  const verified = loadVerified();
  const { candidates, found, capped } = buildCandidates(
    pickTypes(state.slugs, args.types),
    loadSeedKeys(),
    args.capPerType,
  );
  log(`candidates after seed dedupe: ${JSON.stringify(found)}`);
  if (Object.keys(capped).length) log(`capped (lowest-weight dropped): ${JSON.stringify(capped)}`);

  // 'error' results (timeouts, 5xx) are retried on the next run, never skipped:
  // they say nothing about whether the board exists.
  const cutoff = new Date(Date.now() - args.reverifyDays * 86_400_000).toISOString().slice(0, 10);
  const todo = candidates.filter(c => {
    const prior = verified.get(seedKey(c.type, c.identifier));
    return !prior || prior.status === 'error' || prior.at < cutoff;
  });
  log(`${todo.length} to probe (${candidates.length - todo.length} already have a result)`);

  mkdirSync(CACHE_DIR, { recursive: true });
  const started = Date.now();
  const deadline = started + args.budgetMinutes * 60_000;
  const tally: Record<string, number> = {};
  let done = 0;
  await verifyCandidates(
    todo,
    async c => probe(c),
    (c, r) => {
      const rec: VerifiedRecord = {
        type: c.type,
        identifier: c.identifier,
        status: r.status,
        jobs: r.jobs,
        name: r.name,
        at: new Date().toISOString().slice(0, 10),
      };
      appendFileSync(VERIFIED_FILE, `${JSON.stringify(rec)}\n`);
      tally[`${c.type}:${r.status}`] = (tally[`${c.type}:${r.status}`] ?? 0) + 1;
      if (r.status === 'error') log(`error ${c.type}:${c.identifier}: ${r.error}`);
      if (++done % 100 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        log(`probed ${done}/${todo.length} (${rate.toFixed(1)}/s, ~${Math.round((todo.length - done) / rate / 60)} min left)`);
      }
    },
    {
      concurrency: GLOBAL_CONCURRENCY,
      perType: args.perType,
      delayMs: args.probeDelayMs,
      sleep,
      shouldStop: () => Date.now() > deadline,
    },
  );
  log(`probe tally: ${JSON.stringify(tally)}`);
  if (done < todo.length) log(`stopped at the ${args.budgetMinutes} min budget with ${todo.length - done} unprobed, rerun to continue`);
}

function pickTypes(
  slugs: State['slugs'],
  types: DiscoverableType[],
): State['slugs'] {
  return Object.fromEntries(Object.entries(slugs).filter(([t]) => types.includes(t as DiscoverableType)));
}

function write(state: State): void {
  const seeded = loadSeedKeys();
  const boards: VerifiedBoard[] = [];
  const verifiedCount: Record<string, number> = {};
  for (const rec of loadVerified().values()) {
    // Only tenants the current extraction rules still produce: a rule fix (say, a new
    // locale pattern) must drop results recorded under the old, wrong slug.
    const current = state.slugs[rec.type]?.[rec.identifier.toLowerCase()] !== undefined;
    if (rec.status !== 'ok' || !current || seeded.has(seedKey(rec.type, rec.identifier))) continue;
    boards.push({
      type: rec.type,
      identifier: rec.identifier,
      display_name: rec.name ?? prettifySlug(rec.identifier),
      jobs: rec.jobs,
      verified_at: rec.at,
    });
    verifiedCount[rec.type] = (verifiedCount[rec.type] ?? 0) + 1;
  }
  const candidateCount: Record<string, number> = {};
  for (const [type, counts] of Object.entries(state.slugs)) candidateCount[type] = Object.keys(counts).length;

  const text = renderDiscoveredFile(
    {
      crawls: state.crawls,
      generated_at: new Date().toISOString().slice(0, 10),
      candidates: candidateCount,
      verified: verifiedCount,
    },
    boards,
  );
  writeFileSync(OUTPUT_FILE, text);
  log(`wrote ${boards.length} boards to ${DISCOVERED_SOURCES_FILE} (${(text.length / 1024).toFixed(0)} KB): ${JSON.stringify(verifiedCount)}`);
}

const args = parseArgs(process.argv.slice(2));
const state = loadState();
if (!args.skipCdx) await discover(args, state);
if (!args.skipVerify) await verify(args, state);
write(state);
