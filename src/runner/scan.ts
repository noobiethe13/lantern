import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { getAdapter } from '../sources/index';
import { l1Filter, type Criteria } from '../core/filter';
import { freshnessMaxAgeDays } from '../routes/freshness';
import { contentHash, normalizeCompany, shouldFold } from '../core/dedup';
import { toDbRow } from '../core/normalize';
import { JobShape, type Job, type SourceAdapter, type SourceContext } from '../core/job';
import { llm } from '../llm';
import { LlmError } from '../llm/provider';
import { BatchVerdictShape, BatchVerdictWithResumeShape } from '../llm/schemas';
import { batchVerdictPrompt } from '../llm/prompts';
import { activeResumeText } from '../routes/resume';
import { applyLegitimacyPass } from './legitimacy';
import { applySemanticDedupPass } from './semantic-dedup';
import { prerankSurvivors } from './preranker';
import { criteriaToQueryText } from '../core/embed';
import { runPool } from '../core/pool';
import { bus, type ScanEvent } from './progress';
import { isSourceFetchError } from '../server/errors';
import { AGGREGATOR_TYPES } from '../routes/sources';

interface SeedSource {
  type: string;
  identifier: string;
  display_name: string;
  enabled: boolean;
  // Per-source config (Workday needs site/dc/host). Serialized to config_json.
  config?: Record<string, unknown>;
}

interface DbSource {
  id: number;
  type: string;
  identifier: string;
  display_name: string;
  enabled: number;
  config_json: string | null;
}

export interface L2JobRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  jd_text: string | null;
  // Cached sentence embedding (raw Float32 BLOB) when present, for the L1.5
  // pre-ranker. bun:sqlite returns a BLOB as a Uint8Array.
  embedding: Uint8Array | null;
}

// Fallback staleness window, used only when a lock row has no recorded pid (e.g.
// written by a non-Bun runtime). When a pid IS recorded, staleness is decided by
// whether that process is still alive (isLockStale below) regardless of age — a
// live long-running scan must never be stolen out from under it just because it's
// been over an hour.
const SCAN_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour

// Absolute backstop, independent of pid liveness: a lock held this long is stale
// no matter what process.kill(pid, 0) reports. Without this, a foreign OS pid the
// kernel happens to have reused for a live, unrelated process makes
// isProcessAlive() true forever and every future search 409s — this is the only
// thing that ever reclaims that case.
const SCAN_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 sends nothing — it only probes whether the process exists and is
    // signalable. Verified on Bun/Windows: throws ESRCH ("no such process") for a
    // dead pid, does not throw for a live one. Anything other than a confirmed
    // ESRCH (including EPERM — exists but unsignalable) is treated as alive, so we
    // never steal a lock out from under a scan that's actually still running.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ESRCH';
  }
}

interface ScanLockRow {
  acquired_at: number;
  pid: number | null;
}

function readScanLock(): ScanLockRow | null {
  return db
    .query<ScanLockRow, []>("SELECT acquired_at, pid FROM scan_locks WHERE key = 'scan'")
    .get();
}

// One staleness rule shared by tryAcquireScanLock and getScanningState. Before
// this fix getScanningState had NO staleness check at all (only tryAcquireScanLock
// did), so a crash mid-scan made every future POST /scan 409 forever — the API
// route only ever calls getScanningState, never tryAcquireScanLock — and
// runLivenessCheck (which also gates on getScanningState) skipped forever too.
// `atBoot` is true only when called from recoverInterruptedScans (process
// startup) — at boot, no scan started by THIS process can possibly still be
// running, so a lock row whose recorded pid happens to equal our own freshly
// assigned pid (OS pid reuse, most visible under Bun's --watch reload) is stale,
// not "our own still-running scan". Runtime callers (tryAcquireScanLock,
// getScanningState) never pass it — there, a matching own-pid really is us.
function isLockStale(row: ScanLockRow, atBoot = false): boolean {
  if (Date.now() - row.acquired_at > SCAN_LOCK_MAX_AGE_MS) return true;
  if (row.pid != null) {
    if (row.pid === process.pid) return atBoot;
    return !isProcessAlive(row.pid);
  }
  return row.acquired_at < Date.now() - SCAN_LOCK_STALE_MS;
}

// Runs with finished_at still NULL left behind by whatever crashed/held the lock
// we just cleared. Shared by recoverInterruptedScans (boot) and
// tryAcquireScanLock (mid-run reclaim) — either path can find a stale lock, and
// both must retire the orphaned run(s) it left rather than leaving them stuck on
// "Scanning" forever.
function markOrphanRunsInterrupted(): void {
  const orphans = db
    .query<{ id: number; errors_json: string | null }, []>(
      'SELECT id, errors_json FROM runs WHERE finished_at IS NULL'
    )
    .all();
  if (orphans.length === 0) return;

  const now = Date.now();
  for (const run of orphans) {
    const errors: { source: string; error: string }[] = run.errors_json ? JSON.parse(run.errors_json) : [];
    errors.push({ source: 'server', error: 'interrupted (server stopped mid-scan)' });
    db.run('UPDATE runs SET finished_at = ?, errors_json = ? WHERE id = ?', [now, JSON.stringify(errors), run.id]);
  }
  console.log(`[recovery] marked ${orphans.length} interrupted run(s) as finished`);
}

export function tryAcquireScanLock(): boolean {
  const row = readScanLock();
  if (row && isLockStale(row)) {
    db.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
    // No live lock remains at this point — retire whatever run the stale lock's
    // owner left dangling before we claim the lock for the new scan below.
    markOrphanRunsInterrupted();
  }
  try {
    db.run(
      'INSERT INTO scan_locks (key, acquired_at, pid) VALUES (?, ?, ?)',
      ['scan', Date.now(), typeof process !== 'undefined' ? process.pid ?? null : null],
    );
    return true;
  } catch (err) {
    // PRIMARY KEY conflict — another (live) scan holds the lock.
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return false;
    throw err;
  }
}

export function releaseScanLock(): void {
  db.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
}

export function getScanningState(): boolean {
  const row = readScanLock();
  if (!row) return false;
  return !isLockStale(row);
}

// Startup recovery: a process killed mid-scan (crash, Ctrl+C, a `bun --watch`
// reload) leaves behind a scan_locks row and a run with finished_at still NULL.
// Left alone, every future search 409s forever (getScanningState/tryAcquireScanLock
// both key off the same stale row) and the Search page — which reconnects to any
// run with finished_at NULL — shows "Scanning" forever. Called once from
// server.ts at process startup; safe to call unconditionally since it only clears
// state a dead process left behind, never a lock this process itself just took.
export function recoverInterruptedScans(): void {
  const lockRow = readScanLock();
  if (lockRow && isLockStale(lockRow, true)) {
    db.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
  }

  // A live lock (a legitimately fresh one written by a concurrent process — this
  // process itself cannot have one yet, since isLockStale(.., true) above already
  // treats a matching own-pid as stale) means a run really is in flight — leave
  // its row alone rather than marking it finished out from under it.
  if (getScanningState()) return;

  markOrphanRunsInterrupted();
}

export function loadCriteriaRaw(): string {
  try {
    const criteriaRow = db
      .query<{ yaml: string }, []>('SELECT yaml FROM criteria WHERE id = 1')
      .get();
    if (criteriaRow) return criteriaRow.yaml;
  } catch {
    // fall through to file
  }
  const searchYml = join(process.cwd(), 'src/config/search.yml');
  return readFileSync(searchYml, 'utf-8');
}

/** The search sentence the current criteria was derived from, if any. */
function loadCriteriaSourceText(): string | undefined {
  const row = db
    .query<{ source_text: string | null }, []>('SELECT source_text FROM criteria WHERE id = 1')
    .get();
  return row?.source_text || undefined;
}

export function loadCriteria(): Criteria {
  return yaml.load(loadCriteriaRaw()) as Criteria;
}

function seedSources(): void {
  const seedPath = join(process.cwd(), 'src/config/seed-sources.yml');
  const raw = yaml.load(readFileSync(seedPath, 'utf-8')) as {
    sources: SeedSource[];
  };

  const insert = db.prepare<unknown, [string, string, string, number, string | null, number]>(
    `INSERT OR IGNORE INTO sources (type, identifier, display_name, enabled, config_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  // One-directional sync for per-company boards the maintainer has turned off in
  // the seed list (dead slugs — the board left that ATS). INSERT OR IGNORE alone
  // would leave an already-seeded row enabled forever, 404ing every scan. Never
  // enables anything, and skips keyword-global aggregators: for those
  // `enabled: false` means "opt-in, off by default" (e.g. LinkedIn), a toggle the
  // user owns, not a retirement.
  const disable = db.prepare<unknown, [string, string]>(
    'UPDATE sources SET enabled = 0 WHERE type = ? AND identifier = ? AND enabled = 1'
  );

  const now = Date.now();
  for (const s of raw.sources) {
    const configJson = s.config ? JSON.stringify(s.config) : null;
    insert.run(s.type, s.identifier, s.display_name, s.enabled ? 1 : 0, configJson, now);
    if (!s.enabled && !AGGREGATOR_TYPES.has(s.type)) disable.run(s.type, s.identifier);
  }
}

interface FuzzyCandidateRow {
  id: number;
  title: string;
  company: string;
  location: string | null;
  url: string;
  duplicate_urls: string | null;
  l1_pass: number;
  l1_reasons: string | null;
  last_run_id: number | null;
}

function findFuzzyDuplicate(job: Job): FuzzyCandidateRow | null {
  const normCo = normalizeCompany(job.company);
  if (!normCo) return null;

  // Prefilter on the indexed company_norm column (written by upsertJob with the
  // same normalizeCompany) so we only load rows from the same normalized
  // company instead of the whole jobs table — the difference between O(n) and
  // O(matches) per insert, which matters once the seed list is hundreds of
  // boards. The same-role-same-place check stays in JS over that small set.
  const candidates = db
    .query<FuzzyCandidateRow, [string]>(
      `SELECT id, title, company, location, url, duplicate_urls, l1_pass, l1_reasons, last_run_id
       FROM jobs WHERE company_norm = ?`
    )
    .all(normCo);

  for (const c of candidates) {
    if (shouldFold({ title: c.title, location: c.location }, { title: job.title, location: job.location })) return c;
  }
  return null;
}

interface ExistingUrlRow {
  id: number;
  source_id: number;
  content_hash: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  salary_currency: string | null;
  jd_text: string | null;
  l1_pass: number;
  l1_reasons: string | null;
  last_run_id: number | null;
}

/**
 * Merge an incoming L1 verdict into a row this run may already have claimed.
 * When the row was already stamped by THIS run (a fold or an earlier yield of the
 * same posting), a pass wins over a fail so an L1-passing posting never vanishes
 * into a failing row. When the row's verdict is from an earlier run, it was graded
 * under that run's criteria and is stale — the incoming verdict replaces it (a
 * plain MAX would let an old pass smuggle a now-failing job into this run's L2).
 */
function mergeL1(
  row: { l1_pass: number; l1_reasons: string | null; last_run_id: number | null },
  runId: number,
  l1Pass: boolean,
  reasonsJson: string | null,
): { pass: number; reasons: string | null } {
  if (row.last_run_id === runId && row.l1_pass === 1 && !l1Pass) {
    return { pass: 1, reasons: row.l1_reasons };
  }
  return { pass: l1Pass ? 1 : 0, reasons: reasonsJson };
}

function upsertJob(
  job: Job,
  sourceId: number,
  runId: number,
  l1Pass: boolean,
  l1Reasons: string[]
): 'new' | 'seen' {
  const now = Date.now();
  const reasonsJson = l1Reasons.length > 0 ? JSON.stringify(l1Reasons) : null;

  const existing = db
    .query<ExistingUrlRow, [string]>(
      `SELECT id, source_id, content_hash, title, company, location, remote,
              salary_min_usd, salary_max_usd, salary_currency, jd_text, l1_pass, l1_reasons, last_run_id
       FROM jobs WHERE url = ?`
    )
    .get(job.url);

  if (existing) {
    const l1 = mergeL1(existing, runId, l1Pass, reasonsJson);
    // A JD the adapter didn't fetch this time (e.g. LinkedIn past its enrich
    // budget) is not a content change — hash over the JD the row would keep.
    const effective: Job = { ...job, jd_text: job.jd_text ?? existing.jd_text ?? undefined };
    const hash = contentHash(effective);
    const row = toDbRow(effective, sourceId, hash);

    // Content may only be refreshed by the source that originally owns this row.
    // Two sources can legitimately report the same canonical URL (a company
    // board mirrored by a keyword aggregator) with different JD extraction
    // quality; letting either one "win" on every scan would flip title/JD (and
    // wipe the L2 verdict/embedding derived from them) back and forth forever.
    const sameSource = sourceId === existing.source_id;

    // A raw content_hash comparison is too sensitive to jd_text: an htmlToText
    // change (entity decoding, whitespace collapsing) alone changes the hash of
    // nearly every stored JD with the posting itself unchanged, wiping every
    // verdict/embedding on the next scan for a reason that has nothing to do
    // with the job. Only the fields a real repost would actually change (or a JD
    // that showed up where none existed before) count as "changed" — never a JD
    // that merely re-renders differently from the same underlying text.
    const changed =
      sameSource &&
      (row.title !== existing.title ||
        row.company !== existing.company ||
        row.location !== existing.location ||
        row.remote !== existing.remote ||
        row.salary_min_usd !== existing.salary_min_usd ||
        row.salary_max_usd !== existing.salary_max_usd ||
        row.salary_currency !== existing.salary_currency ||
        (existing.jd_text == null && row.jd_text != null));

    if (!changed) {
      db.run(
        'UPDATE jobs SET last_seen = ?, last_run_id = ?, l1_pass = ?, l1_reasons = ?, content_hash = ? WHERE id = ?',
        [now, runId, l1.pass, l1.reasons, hash, existing.id]
      );
      return 'seen';
    }

    // The posting was edited since we stored it (retitled, relocated, JD
    // rewritten): refresh the content and drop what was derived from the old
    // content — the L2 verdict and the embedding. posted_at, first_seen and the
    // user's triage fields (status, notes, applied_at) are deliberately kept.
    db.run(
      `UPDATE jobs SET last_seen = ?, last_run_id = ?, l1_pass = ?, l1_reasons = ?,
         title = ?, company = ?, company_norm = ?, location = ?, remote = ?,
         salary_min_usd = ?, salary_max_usd = ?, salary_currency = ?, jd_text = ?, content_hash = ?,
         l2_verdict_json = NULL, l2_score = NULL, l2_fit = NULL, embedding = NULL
       WHERE id = ?`,
      [
        now, runId, l1.pass, l1.reasons,
        row.title, row.company, normalizeCompany(job.company), row.location, row.remote,
        row.salary_min_usd, row.salary_max_usd, row.salary_currency, row.jd_text, row.content_hash,
        existing.id,
      ]
    );
    return 'seen';
  }

  // Fuzzy dedup: same normalized company + same role in a compatible location
  // (shouldFold). The canonical row keeps its original URL; the new URL is
  // appended to duplicate_urls so we don't lose the link from the second board.
  // The current run claims the row so a job surfaced again this scan stays in
  // scope, and the L1 verdicts merge (mergeL1).
  const fuzzy = findFuzzyDuplicate(job);
  if (fuzzy) {
    const dupes: string[] = fuzzy.duplicate_urls ? JSON.parse(fuzzy.duplicate_urls) : [];
    if (job.url !== fuzzy.url && !dupes.includes(job.url)) dupes.push(job.url);
    const l1 = mergeL1(fuzzy, runId, l1Pass, reasonsJson);
    db.run(
      'UPDATE jobs SET last_seen = ?, last_run_id = ?, duplicate_urls = ?, l1_pass = ?, l1_reasons = ? WHERE id = ?',
      [now, runId, dupes.length > 0 ? JSON.stringify(dupes) : null, l1.pass, l1.reasons, fuzzy.id]
    );
    return 'seen';
  }

  const hash = contentHash(job);
  const row = toDbRow(job, sourceId, hash);

  db.run(
    `INSERT INTO jobs (
      source_id, external_id, url, title, company, company_norm, location, remote,
      salary_min_usd, salary_max_usd, salary_currency, posted_at, jd_text, content_hash,
      first_seen, last_seen, last_run_id, l1_pass, l1_reasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.source_id,
      row.external_id,
      row.url,
      row.title,
      row.company,
      normalizeCompany(job.company),
      row.location,
      row.remote,
      row.salary_min_usd,
      row.salary_max_usd,
      row.salary_currency,
      row.posted_at,
      row.jd_text,
      row.content_hash,
      now,
      now,
      runId,
      l1Pass ? 1 : 0,
      reasonsJson,
    ]
  );
  return 'new';
}

// Max source adapters fetched at once, via a sliding-window pool (runPool). Kept
// at 10 deliberately: Greenhouse/Ashby/Lever boards each share one API host, so a
// higher global width raises per-host request rate (and rate-limit risk) more than
// it buys — the real speedup is the pool itself (no idle gaps waiting on a batch's
// slowest member), not a bigger number.
const CONCURRENCY = 10;

// L2 grades jobs in batches of this size per `claude` call to amortize the large
// FIXED per-spawn cost (minimal system prompt + JSON schema + CLI scaffolding,
// re-sent every subprocess and uncacheable across processes). Bigger batches =
// fewer spawns = less of that overhead AND less total usage (so a Claude session
// limit is hit later or not at all) — with no change to per-job grading, since each
// job is still graded independently on its own title/company/location/JD. This is
// the one L2 cost lever that trades away neither recall nor model quality. 20 is a
// conservative step up from the original 10; raise it further if verdict quality
// holds. Sequential.
const L2_BATCH_SIZE = 20;
// Kill-timeout scales with batch size (~24s/job, matching the original 240s for 10)
// — a bigger batch does proportionally more inference before returning.
const L2_BATCH_TIMEOUT_MS = L2_BATCH_SIZE * 24_000;

// Wall-clock cap on one source's whole scan (fetch + enrich). Generous because
// Workday and LinkedIn paginate slowly with politeness delays, but finite so one
// hung board can never stall runScan (the pool would otherwise wait on it forever).
const SOURCE_DEADLINE_MS = 8 * 60_000;

// Max adapter.enrich() calls per source per run. Enrichment costs one extra
// request per job (LinkedIn also sleeps before each), so it is capped rather than
// applied to every L1 survivor.
const ENRICH_BUDGET_PER_SOURCE = 40;

export interface RunSetup {
  runId: number;
  sources: DbSource[];
  criteria: Criteria;
  // Raw YAML alongside the parsed form — runFull hands both to runL2Pass without
  // re-reading the criteria row, so a second search's nl-filter racing this run
  // can't change the rubric partway through (see L3 in review notes).
  criteriaYaml: string;
  // The user's original search sentence the criteria was derived from (criteria
  // row source_text), snapshotted with it. Handed to L2 so the verdict can weigh
  // intent the structured criteria lost. Undefined when never set.
  criteriaSourceText?: string;
}

/** Test seams for runScan; production callers pass nothing. */
export interface ScanOptions {
  sourceDeadlineMs?: number;
}

/**
 * Normalize criteria title keywords into the query terms keyword-driven
 * aggregators search with: trim, lowercase, drop empties and duplicates, and drop
 * any keyword that contains another kept keyword as whole words ("flutter
 * developer" is redundant next to "flutter" — the broader term already finds
 * those postings). Whole-word, not substring, so "javascript" survives next to
 * "java". Order-preserving.
 */
export function normalizeKeywords(raw: readonly string[]): string[] {
  const unique: string[] = [];
  for (const r of raw) {
    const kw = r.trim().toLowerCase().replace(/\s+/g, ' ');
    if (kw && !unique.includes(kw)) unique.push(kw);
  }
  const containsWords = (hay: string, needle: string): boolean =>
    ` ${hay} `.includes(` ${needle} `);
  return unique.filter(kw => !unique.some(other => other !== kw && containsWords(kw, other)));
}

function isFreshnessReason(reason: string): boolean {
  // Mirrors the reason string l1Filter emits for the freshness gate.
  return reason.includes('freshness window');
}

/**
 * Synchronous half of starting a run: seeds sources, snapshots criteria ONCE, and
 * creates the run row. Split out from runScan so the route can learn the runId
 * immediately (C1) instead of waiting for the whole L1 pass — POST /api/runs/scan
 * must return runId in its response, not make the client poll for it.
 */
export function createRun(query?: string): RunSetup {
  console.log('lantern — starting scan');

  seedSources();

  const sources = db
    .query<DbSource, []>(
      'SELECT id, type, identifier, display_name, enabled, config_json FROM sources WHERE enabled = 1'
    )
    .all();

  const criteriaYaml = loadCriteriaRaw();
  const criteria = yaml.load(criteriaYaml) as Criteria;
  const criteriaSourceText = loadCriteriaSourceText();
  console.log(`Sources enabled: ${sources.length}`);

  const runId = db
    .query<{ id: number }, [number, number, string | null]>(
      'INSERT INTO runs (started_at, sources_total, query) VALUES (?, ?, ?) RETURNING id'
    )
    .get(Date.now(), sources.length, query ?? null)!.id;

  // Emit start once with the actual runId so subscribers can attach.
  // Pre-INSERT progress lines stay as console logs only — there's no real
  // subscriber for runId=0 anyway.
  bus.emit({
    runId,
    type: 'start',
    msg: `Run #${runId} started — sources enabled: ${sources.length}`,
    data: { runId, sourcesTotal: sources.length },
  });

  return { runId, sources, criteria, criteriaYaml, criteriaSourceText };
}

class SourceDeadlineError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'SourceDeadlineError';
  }
}

/** True when this URL is already stored with a description — re-enriching it would
 * spend budget (and a request) on a JD upsertJob keeps anyway (COALESCE). */
function hasStoredJd(url: string): boolean {
  return (
    db.query<{ x: number }, [string]>('SELECT 1 AS x FROM jobs WHERE url = ? AND jd_text IS NOT NULL').get(url) != null
  );
}

/**
 * Run adapter.enrich and merge its patch into the job. Returns the merged job, or
 * null when there was nothing to merge. enrich() must not throw per its contract,
 * but a buggy adapter must not fail the whole source over one optional detail
 * fetch, so a throw is logged and treated as "no patch".
 */
async function enrichJob(adapter: SourceAdapter, job: Job, ctx: SourceContext, sourceName: string): Promise<Job | null> {
  let patch: Partial<Job> | null;
  try {
    patch = (await adapter.enrich?.(job, ctx)) ?? null;
  } catch (err) {
    console.error(`  [enrich] ${sourceName}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!patch) return null;
  // url is the row identity — a patch may add detail, never re-key the job.
  const merged = JobShape.safeParse({ ...job, ...patch, url: job.url });
  if (!merged.success) {
    console.error(`  [enrich] ${sourceName}: ignoring invalid patch for ${job.url}`);
    return null;
  }
  return merged.data;
}

export async function runScan(
  runId: number,
  sources: DbSource[],
  criteria: Criteria,
  opts: ScanOptions = {},
): Promise<void> {
  const runErrors: { source: string; error: string }[] = [];
  let jobsFound = 0;
  let jobsNew = 0;
  let jobsL1Pass = 0;
  // Jobs whose ONLY L1 failure was the freshness gate — surfaced in scan_done so
  // a too-narrow window doesn't silently hide matches.
  let freshnessDropped = 0;

  // Freshness gate inputs, read once for the whole scan (a single reference time
  // keeps the cutoff consistent across the minutes a scan runs). 0 = disabled.
  const freshMaxAge = freshnessMaxAgeDays();
  const scanNow = Date.now();
  const l1Opts = { now: scanNow, maxAgeDays: freshMaxAge };
  const keywords = normalizeKeywords(criteria.title?.positive ?? []);
  const deadlineMs = opts.sourceDeadlineMs ?? SOURCE_DEADLINE_MS;

  // Per-source scan. Owns its own error handling (a failed or hung board marks
  // itself and is recorded in runErrors, never aborts the run). Run via a
  // sliding-window pool so the next source starts the instant one finishes — no
  // batch waits on its slowest member.
  const scanOne = async (source: DbSource): Promise<void> => {
    const adapter = getAdapter(source.type);
    if (!adapter) {
      console.log(`  [skip] no adapter for type: ${source.type}`);
      return;
    }

    bus.emit({ runId, type: 'source_start', msg: `Scanning ${source.display_name}`, data: { source: source.display_name } });

    const config: Record<string, unknown> = {
      identifier: source.identifier,
      display_name: source.display_name,
      ...(source.config_json ? JSON.parse(source.config_json) : {}),
    };

    // Per-source controller: the deadline below aborts THIS source only.
    const sourceAbort = new AbortController();
    const ctx: SourceContext = {
      sourceId: source.id,
      config,
      keywords,
      locations: criteria.location?.allowed ?? [],
      remoteRequired: criteria.location?.remote_required ?? false,
      maxAgeDays: freshMaxAge > 0 ? freshMaxAge : undefined,
      emitProgress: (msg: string, _n?: number) => {
        console.log(`  ${msg}`);
        bus.emit({ runId, type: 'job_found', msg, data: { source: source.display_name } });
      },
      abortSignal: sourceAbort.signal,
    };

    let sourceJobCount = 0;
    let invalidCount = 0;
    let enrichCalls = 0;

    const consume = async (): Promise<void> => {
      for await (const raw of adapter.fetch(ctx)) {
        if (sourceAbort.signal.aborted) break;
        // A malformed date string parses to NaN in several adapters — treat the
        // posting as undated rather than rejecting an otherwise valid job.
        const candidate =
          typeof raw.posted_at === 'number' && !Number.isFinite(raw.posted_at) ? { ...raw, posted_at: null } : raw;
        const parsed = JobShape.safeParse(candidate);
        if (!parsed.success) {
          invalidCount++;
          continue;
        }
        let job = parsed.data;
        let { pass, reasons } = l1Filter(job, criteria, l1Opts);

        // Enrichment (e.g. LinkedIn's per-job JD request) only for L1 survivors,
        // sequentially, within this source's budget — never over the full stream.
        if (
          pass &&
          adapter.enrich &&
          !job.jd_text &&
          enrichCalls < ENRICH_BUDGET_PER_SOURCE &&
          !hasStoredJd(job.url)
        ) {
          enrichCalls++;
          const enriched = await enrichJob(adapter, job, ctx, source.display_name);
          if (enriched) {
            job = enriched;
            ({ pass, reasons } = l1Filter(job, criteria, l1Opts));
          }
          if (sourceAbort.signal.aborted) break;
        }

        const status = upsertJob(job, source.id, runId, pass, reasons);
        jobsFound++;
        sourceJobCount++;
        if (status === 'new') jobsNew++;
        if (pass) jobsL1Pass++;
        else if (reasons.length > 0 && reasons.every(isFreshnessReason)) freshnessDropped++;
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        sourceAbort.abort();
        reject(new SourceDeadlineError(deadlineMs));
      }, deadlineMs);
    });
    const work = consume();

    try {
      await Promise.race([work, deadline]);

      db.run(
        `UPDATE sources SET last_scan_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?`,
        [Date.now(), source.id]
      );

      const skipped = invalidCount > 0 ? ` (${invalidCount} malformed skipped)` : '';
      const doneMsg = `${source.display_name}: ${sourceJobCount} jobs${skipped}`;
      bus.emit({
        runId,
        type: 'source_done',
        msg: doneMsg,
        data: { source: source.display_name, count: sourceJobCount, invalid: invalidCount },
      });
    } catch (err) {
      const timedOut = err instanceof SourceDeadlineError;
      if (timedOut) {
        // The adapter may still be parked in an await that ignores abortSignal.
        // Its loop stops writing once it resumes (the aborted checks above); a
        // late rejection is logged here rather than left unhandled.
        work.catch(late => {
          console.error(
            `  [late] ${source.display_name} after timeout: ${late instanceof Error ? late.message : String(late)}`
          );
        });
      }
      const msg = timedOut
        ? `${(err as Error).message} (${sourceJobCount} jobs saved)`
        : err instanceof Error ? err.message : String(err);
      const status = timedOut ? 'timeout' : isSourceFetchError(err) ? err.kind : 'http-error';
      console.error(`  [error:${status}] ${source.display_name}: ${msg}`);
      runErrors.push({ source: source.display_name, error: msg });
      db.run(
        `UPDATE sources SET last_scan_at = ?, last_status = ?, last_error = ? WHERE id = ?`,
        [Date.now(), status, msg, source.id]
      );
      bus.emit({ runId, type: 'source_error', msg: `${source.display_name}: ${msg}`, data: { source: source.display_name, error: msg } });
    } finally {
      clearTimeout(timer);
    }
  };

  // runPool's onError is the safety net for anything scanOne itself didn't catch
  // (e.g. a malformed config_json before the try) — it should be rare.
  await runPool(sources, CONCURRENCY, scanOne, (source, err) => {
    runErrors.push({ source: source.display_name, error: String(err) });
  });

  // NOTE: finished_at is intentionally NOT set here. The run isn't done until L2
  // finishes (runL2Pass sets finished_at itself, right before its terminal l2_done
  // event — see C2). Setting it at L1-end made the run look complete while L2 was
  // still scoring.
  db.run(
    `UPDATE runs SET jobs_found = ?, jobs_new = ?, jobs_l1_pass = ?, errors_json = ?
     WHERE id = ?`,
    [
      jobsFound,
      jobsNew,
      jobsL1Pass,
      runErrors.length > 0 ? JSON.stringify(runErrors) : null,
      runId,
    ]
  );

  let summary = `Scan complete — found: ${jobsFound}, new: ${jobsNew}, L1 pass: ${jobsL1Pass}`;
  if (freshnessDropped > 0) {
    summary += ` · ${freshnessDropped} more matched but were older than ${freshMaxAge}d (widen in Settings)`;
  }
  console.log('\n── Scan complete ─────────────────────────');
  console.log(`  Jobs found:    ${jobsFound}`);
  console.log(`  Jobs new:      ${jobsNew}`);
  console.log(`  L1 passed:     ${jobsL1Pass}`);
  if (runErrors.length > 0) {
    console.log(`  Errors:        ${runErrors.length}`);
    for (const e of runErrors) console.log(`    ${e.source}: ${e.error}`);
  }
  console.log('─────────────────────────────────────────\n');

  // Phase event, NOT terminal — the SSE stream stays open so the L2 events that
  // follow reach the client. The terminal event is 'l2_done' (from runL2Pass).
  bus.emit({ runId, type: 'scan_done', msg: summary, data: { jobsFound, jobsNew, jobsL1Pass, freshnessDropped, errors: runErrors.length } });
}

function markRunFinished(runId: number): void {
  db.run('UPDATE runs SET finished_at = ? WHERE id = ?', [Date.now(), runId]);
}

export async function runL2Pass(runId: number, criteriaYaml: string, userQuery?: string): Promise<void> {
  // Scope to jobs this run surfaced (upsertJob stamped last_run_id = runId on
  // every job it touched). Keeps L2 from re-scoring out-of-scope jobs from
  // earlier searches and aligns with the scope-to-current-search model.
  const survivors = db
    .query<L2JobRow, [number]>(
      `SELECT id, title, company, location, jd_text, embedding
       FROM jobs
       WHERE l1_pass = 1 AND l2_verdict_json IS NULL AND duplicate_of IS NULL AND last_run_id = ?`
    )
    .all(runId);

  // L1.5: order survivors most-relevant-first so the sequential L2 pass scores
  // the best jobs earliest (results stream best-first). Reorder only, never drops;
  // no-ops when the embedding feature is off.
  const queryText = criteriaToQueryText(yaml.load(criteriaYaml) as Criteria);
  const jobs = await prerankSurvivors(survivors, queryText);

  if (jobs.length === 0) {
    console.log('L2: no pending jobs');
    // finished_at must be written before the terminal l2_done event — the SSE
    // route and the Search page's "reconnect to any run with finished_at NULL"
    // logic both key off it (C2).
    markRunFinished(runId);
    bus.emit({ runId, type: 'l2_done', msg: 'L2: no pending jobs', data: { l2Pass: 0, errors: 0, aborted: false } });
    return;
  }

  // Opt-in resume-aware grading: when a master resume is saved + enabled, every
  // verdict carries background_fit/gaps (stricter shape). Resolved once per pass
  // so all batches in a run grade against the same text.
  const resumeText = activeResumeText();
  const verdictShape = resumeText ? BatchVerdictWithResumeShape : BatchVerdictShape;

  const l2Start = `L2 — scoring ${jobs.length} jobs via ${llm.providerName}${resumeText ? ' (resume-aware)' : ''}...`;
  console.log(`\n${l2Start}`);
  bus.emit({ runId, type: 'l2_start', msg: l2Start, data: { total: jobs.length } });

  let l2Pass = 0;
  const errors: { id: number; error: string }[] = [];
  // Fatal LlmError (auth, missing CLI, banned model) aborts immediately.
  // Otherwise count consecutive transient batch failures and bail after
  // MAX_CONSECUTIVE_FAILURES to avoid blasting through hundreds of jobs while the
  // provider is wedged. A batch call that succeeds AND matches at least one
  // requested job_id resets the counter — a call that "succeeds" but matches none
  // of the ids we asked about (e.g. a provider stuck returning `{"verdicts":[]}`)
  // is treated the same as a failed call, or it would burn every remaining batch
  // and still report "L2 complete" (see L5 in review notes).
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  let aborted = false;
  // First error message of the current failure streak (cleared on real progress),
  // surfaced in l2_done so the UI can show what actually wedged the pass rather
  // than just the last (often a generic timeout) — or the fatal error, if that's
  // what caused the abort.
  let streakFirstError: string | undefined;
  let abortError: string | undefined;

  // Grade jobs in batches so one `claude` subprocess scores L2_BATCH_SIZE jobs,
  // amortizing the per-spawn fixed cost (system prompt + schema + CLI startup)
  // across the batch instead of paying it per job. Each batch gets a larger timeout (N jobs ≫ 1).
  for (let i = 0; i < jobs.length; i += L2_BATCH_SIZE) {
    const batch = jobs.slice(i, i + L2_BATCH_SIZE);
    const prompt = batchVerdictPrompt(
      criteriaYaml,
      batch.map((j) => ({
        id: j.id,
        title: j.title,
        company: j.company,
        location: j.location ?? '',
        jdText: j.jd_text ?? '',
      })),
      resumeText ?? undefined,
      userQuery,
    );

    try {
      const { verdicts } = await llm.call(
        { task: 'verdict', prompt, timeoutMs: L2_BATCH_TIMEOUT_MS },
        verdictShape,
      );
      const byId = new Map(verdicts.map((v) => [v.job_id, v]));

      if (!batch.some((job) => byId.has(job.id))) {
        const msg = 'batch response matched no requested job_ids';
        for (const job of batch) errors.push({ id: job.id, error: msg });
        process.stdout.write('!');
        streakFirstError ??= msg;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`\n[l2] ${MAX_CONSECUTIVE_FAILURES} consecutive failed/zero-match batches — aborting`);
          aborted = true;
          abortError = streakFirstError;
          break;
        }
        continue;
      }

      consecutiveFailures = 0;
      streakFirstError = undefined;

      for (const job of batch) {
        const v = byId.get(job.id);
        if (!v) {
          // The model dropped this job from the array. Don't write a verdict;
          // record it so the run summary reflects the gap (no abort — the call
          // itself succeeded).
          errors.push({ id: job.id, error: 'missing from batch response' });
          process.stdout.write('?');
          continue;
        }
        const { job_id: _drop, ...verdict } = v;
        db.run('UPDATE jobs SET l2_verdict_json = ?, l2_score = ?, l2_fit = ? WHERE id = ?', [
          JSON.stringify(verdict),
          verdict.score,
          verdict.fit ? 1 : 0,
          job.id,
        ]);
        if (verdict.fit) l2Pass++;
        process.stdout.write('.');
        bus.emit({
          runId,
          type: 'l2_progress',
          msg: `L2: scored "${job.title}" at ${job.company}`,
          data: { jobId: job.id, fit: verdict.fit, score: verdict.score },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const job of batch) errors.push({ id: job.id, error: msg });
      process.stdout.write('!');

      if (err instanceof LlmError && err.kind === 'fatal') {
        console.error(`\n[l2] fatal provider error — aborting: ${msg}`);
        aborted = true;
        abortError = msg;
        break;
      }

      streakFirstError ??= msg;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`\n[l2] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting (last: ${msg})`);
        aborted = true;
        abortError = streakFirstError;
        break;
      }
    }
  }

  process.stdout.write('\n');

  db.run('UPDATE runs SET jobs_l2_pass = ? WHERE id = ?', [l2Pass, runId]);

  const doneMsg = aborted
    ? `L2 aborted — fit: ${l2Pass}, errors: ${errors.length}`
    : `L2 complete — fit: ${l2Pass}, errors: ${errors.length}`;
  console.log(doneMsg);
  if (errors.length > 0) {
    for (const e of errors.slice(0, 5)) {
      console.error(`  [l2 error] job ${e.id}: ${e.error}`);
    }
  }
  // finished_at before the terminal l2_done event, same invariant as the
  // no-pending-jobs early return above (C2).
  markRunFinished(runId);
  bus.emit({
    runId,
    type: 'l2_done',
    msg: doneMsg,
    data: { l2Pass, errors: errors.length, aborted, error: abortError },
  });
}

/**
 * Runs a scan to completion given a setup already created by createRun(). The
 * caller (POST /api/runs/scan) acquires the scan lock BEFORE the multi-second
 * nl-filter call and before calling createRun — not here — so two overlapping
 * searches can't both start a run (see L3 in review notes). This function takes
 * ownership of that already-held lock and is solely responsible for releasing it.
 */
export async function runFull(setup: RunSetup): Promise<number> {
  const { runId, sources, criteria, criteriaYaml, criteriaSourceText } = setup;
  try {
    await runScan(runId, sources, criteria);
    // Deterministic legitimacy (ghost-job) pass — zero LLM cost, so it runs
    // before L2 and the badges are visible while L2 is still scoring.
    const scored = applyLegitimacyPass(runId);
    console.log(`Legitimacy: scored ${scored} jobs`);
    // Semantic dedup runs before L2 so near-duplicate reposts are skipped by the
    // expensive scoring pass (and hidden from the default list). Best-effort.
    const deduped = await applySemanticDedupPass(runId);
    console.log(`Semantic dedup: folded ${deduped} duplicate postings`);
    // Same criteria snapshot createRun took for L1 — never re-read here, so a
    // second search's nl-filter racing this run can't change the rubric partway
    // through a single run.
    await runL2Pass(runId, criteriaYaml, criteriaSourceText);
    // runL2Pass writes finished_at itself, right before its terminal l2_done
    // event (C2) — covers all its exit paths (normal, no-pending-jobs, abort).
    return runId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const row = db
      .query<{ errors_json: string | null }, [number]>('SELECT errors_json FROM runs WHERE id = ?')
      .get(runId);
    const errors: { source: string; error: string }[] = row?.errors_json ? JSON.parse(row.errors_json) : [];
    errors.push({ source: 'run', error: msg });
    // finished_at before the terminal 'error' event, same invariant as the
    // success path (C2) — otherwise the run looks perpetually in-progress and the
    // Search page (which reconnects to any run with finished_at NULL) hangs.
    db.run('UPDATE runs SET finished_at = ?, errors_json = ? WHERE id = ?', [
      Date.now(),
      JSON.stringify(errors),
      runId,
    ]);
    bus.emit({ runId, type: 'error', msg });
    throw err; // let the route's .catch log it — runFull itself is fire-and-forget
  } finally {
    releaseScanLock();
  }
}

