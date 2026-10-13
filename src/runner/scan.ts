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
import { fillSalaryFromJd, hasSalary, type SalarySource } from './jd-salary';
import { applySemanticDedupPass } from './semantic-dedup';
import { applySemanticRescue } from './semantic-rescue';
import { prerankSurvivors } from './preranker';
import { criteriaToQueryText } from '../core/embed';
import { HostPacer, hostKey, hostPacer, isRateLimited, runHostPool, waitForTurn } from './host-pacer';
import { bus, type ScanEvent } from './progress';
import { isSourceFetchError } from '../server/errors';
import { AGGREGATOR_TYPES } from '../routes/sources';
import { seedDiscoveredSources } from './discovered-seed';
import { l2MaxJobs } from '../routes/l2-cap';
import { boardCacheTtlMs } from '../routes/board-cache';
import { evaluateCachedBoards, mergeL1, partitionByCache } from './board-cache';

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
  // Start of the last complete successful fetch, or null if never fetched.
  last_ok_fetch_at?: number | null;
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

// Absolute backstop, independent of pid liveness: a lock not refreshed for this
// long is stale no matter what process.kill(pid, 0) reports. A live run refreshes
// acquired_at on a heartbeat (startScanLockHeartbeat), so this only ever fires for
// a lock nobody is tending. Without this, a foreign OS pid the
// kernel happens to have reused for a live, unrelated process makes
// isProcessAlive() true forever and every future search 409s — this is the only
// thing that ever reclaims that case.
const SCAN_LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours

// The heartbeat keeps acquired_at fresh for as long as the process lives, so a run
// hung inside a live server would otherwise hold the lock until restart. Measured
// from started_at, which the heartbeat never touches, this reclaims it regardless.
// The hung run's token-scoped release then cannot free the lock that replaced it.
const SCAN_LOCK_ABSOLUTE_MAX_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  started_at: number | null;
}

function readScanLock(): ScanLockRow | null {
  return db
    .query<ScanLockRow, []>("SELECT acquired_at, pid, started_at FROM scan_locks WHERE key = 'scan'")
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
  if (row.started_at != null && Date.now() - row.started_at > SCAN_LOCK_ABSOLUTE_MAX_MS) return true;
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

/**
 * Take the single scan lock. Returns the acquisition token the caller must pass
 * to releaseScanLock / startScanLockHeartbeat, or null when a live scan holds it.
 */
export function tryAcquireScanLock(): string | null {
  const row = readScanLock();
  if (row && isLockStale(row)) {
    db.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
    // No live lock remains at this point — retire whatever run the stale lock's
    // owner left dangling before we claim the lock for the new scan below.
    markOrphanRunsInterrupted();
  }
  try {
    const token = crypto.randomUUID();
    db.run(
      'INSERT INTO scan_locks (key, acquired_at, pid, token, started_at) VALUES (?, ?, ?, ?, ?)',
      ['scan', Date.now(), typeof process !== 'undefined' ? process.pid ?? null : null, token, Date.now()],
    );
    return token;
  } catch (err) {
    // PRIMARY KEY conflict — another (live) scan holds the lock.
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return null;
    throw err;
  }
}

/**
 * Release the lock only if `token` still owns it. A run whose lock was reclaimed
 * as stale (and taken by a newer scan) must not delete the newer scan's lock when
 * it finally finishes.
 */
export function releaseScanLock(token: string): void {
  db.run("DELETE FROM scan_locks WHERE key = 'scan' AND token = ?", [token]);
}

const SCAN_LOCK_HEARTBEAT_MS = 60_000;

/**
 * Keep the lock's acquired_at fresh while the run is alive, so the 12h staleness
 * ceiling measures time since the last sign of life rather than run length.
 * Returns a stop function. Stops itself if the lock is no longer ours.
 */
export function startScanLockHeartbeat(token: string, intervalMs = SCAN_LOCK_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    const res = db.run("UPDATE scan_locks SET acquired_at = ? WHERE key = 'scan' AND token = ?", [Date.now(), token]);
    if (res.changes === 0) {
      console.warn('[scan] lost the scan lock, heartbeat stopping');
      clearInterval(timer);
    }
  }, intervalMs);
  // Never keep the process alive just to refresh a lock.
  timer.unref?.();
  return () => clearInterval(timer);
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

export function seedSources(): void {
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

  // A maintainer promoting a discovered board into the curated seed list means
  // "on by default": adopt the row out of the bulk-toggled discovered pool.
  const adopt = db.prepare<unknown, [string, string]>(
    `UPDATE sources SET origin = NULL, enabled = 1
     WHERE id = (SELECT id FROM sources WHERE type = ? AND lower(identifier) = lower(?) AND origin = 'discovered'
                 ORDER BY id LIMIT 1)`
  );

  // One transaction: hundreds of single-statement commits otherwise, each an fsync.
  db.transaction(() => {
    const now = Date.now();
    for (const s of raw.sources) {
      const configJson = s.config ? JSON.stringify(s.config) : null;
      // Adopt first and skip the insert when it matched: a case-variant seed slug
      // would otherwise insert a second, enabled row next to the adopted one.
      const adopted = s.enabled ? adopt.run(s.type, s.identifier).changes > 0 : false;
      if (!adopted) insert.run(s.type, s.identifier, s.display_name, s.enabled ? 1 : 0, configJson, now);
      if (!s.enabled && !AGGREGATOR_TYPES.has(s.type)) disable.run(s.type, s.identifier);
    }
    seedDiscoveredSources(now);
  })();
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
  salary_source: string | null;
  employment_type: string | null;
  jd_text: string | null;
  l1_pass: number;
  l1_reasons: string | null;
  last_run_id: number | null;
}

/**
 * Insert or refresh one fetched job. `runId` null is the background refresher's mode: it
 * stores what the board shows (content, salary, posted date, sighting, last_seen, the
 * verdict/embedding wipe on a real edit) but takes no part in any search, so it never stamps
 * last_run_id and leaves l1_pass/l1_reasons/l1_rescued exactly as they are (a new row starts
 * unevaluated). The next scan's cache phase grades the stored job under ITS criteria.
 */
export function upsertJob(
  job: Job,
  sourceId: number,
  runId: number | null,
  l1Pass: boolean,
  l1Reasons: string[],
  keepStoredSalary = false,
  salarySource: SalarySource | null = null,
  // False for a cached board's job pushed back through here for enrich(): nothing was
  // fetched, so last_seen and the board sighting must not move.
  fetched = true,
): 'new' | 'seen' {
  const now = Date.now();
  const reasonsJson = l1Reasons.length > 0 ? JSON.stringify(l1Reasons) : null;
  // 0 clears a stale rescue flag along with the verdict it belonged to. A refresh keeps both.
  const rescueKeep = runId === null ? 1 : 0;
  // Which board showed this row, whoever owns it: the board cache reads this to know what
  // a board lists now (a row can be owned by another source, via the same URL or a fold).
  const sighted = (jobId: number) =>
    fetched &&
    db.query<unknown, [number, number, number]>(
      `INSERT INTO board_sightings (source_id, job_id, seen_at) VALUES (?, ?, ?)
       ON CONFLICT (source_id, job_id) DO UPDATE SET seen_at = excluded.seen_at`
    ).run(sourceId, jobId, now);

  const existing = db
    .query<ExistingUrlRow, [string]>(
      `SELECT id, source_id, content_hash, title, company, location, remote,
              salary_min_usd, salary_max_usd, salary_currency, salary_source, employment_type, jd_text, l1_pass, l1_reasons, last_run_id
       FROM jobs WHERE url = ?`
    )
    .get(job.url);

  if (existing) {
    const l1 = runId === null
      ? { pass: existing.l1_pass, reasons: existing.l1_reasons }
      : mergeL1(existing, runId, l1Pass, reasonsJson);
    const stampRun = runId ?? existing.last_run_id;
    // A JD the adapter didn't fetch this time (e.g. LinkedIn past its enrich
    // budget) is not a content change — hash over the JD the row would keep.
    // Salary is treated the same way, but only when the caller says it is
    // enrich-sourced (Rippling's pay range) and this sighting is listing-only.
    // For listing-salary adapters a missing salary IS an edit (employer removed
    // it) and must null the row and clear the verdict.
    // A JD-derived salary is a function of the JD, so a sighting that carries no JD
    // of its own (LinkedIn past its enrich budget) keeps it too: the stored JD
    // still says the same thing.
    const keepStored =
      !hasSalary(job) && (keepStoredSalary || (job.jd_text == null && existing.salary_source === 'jd'));
    const effective: Job = {
      ...job,
      jd_text: job.jd_text ?? existing.jd_text ?? undefined,
      ...(keepStored
        ? {
            salary_min_usd: existing.salary_min_usd,
            salary_max_usd: existing.salary_max_usd,
            salary_currency: existing.salary_currency,
          }
        : {}),
    };
    const hash = contentHash(effective);
    const row = toDbRow(effective, sourceId, hash);
    const rowSalarySource = keepStored ? existing.salary_source : salarySource;

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
    const salaryDiffers =
      row.salary_min_usd !== existing.salary_min_usd ||
      row.salary_max_usd !== existing.salary_max_usd ||
      row.salary_currency !== existing.salary_currency;
    // A salary read from the JD where the row had none is a backfill, not an edit:
    // it is derived from text already hashed, so after an upgrade the first
    // re-scan must not wipe every salaryless job's verdict and embedding. Any
    // later movement of a stored salary (JD edit, employer change) still counts.
    const salaryBackfill =
      salaryDiffers &&
      salarySource === 'jd' &&
      existing.salary_min_usd == null &&
      existing.salary_max_usd == null &&
      existing.salary_currency == null;
    const changed =
      sameSource &&
      (row.title !== existing.title ||
        row.company !== existing.company ||
        row.location !== existing.location ||
        row.remote !== existing.remote ||
        (salaryDiffers && !salaryBackfill) ||
        (existing.jd_text == null && row.jd_text != null));

    // employment_type feeds L1 only (it is not in content_hash or `changed`), so a flip
    // is not an edit and never clears the verdict. It follows every sighting by the
    // owning source so the board cache re-runs L1 on what a live fetch would have seen.
    const employmentType = sameSource ? row.employment_type : existing.employment_type;
    // The earlier-date rule is per owning source: another source's date for the same URL
    // (an aggregator's, an employer repost) must not pin the job stale.
    const postedAt = sameSource ? row.posted_at : null;
    const seenAt = fetched ? now : null;

    if (!changed) {
      db.run(
        'UPDATE jobs SET last_seen = COALESCE(?, last_seen), last_run_id = ?, l1_pass = ?, l1_reasons = ?, l1_rescued = l1_rescued * ?, content_hash = ?, employment_type = ?, posted_at = COALESCE(MIN(posted_at, ?), posted_at, ?) WHERE id = ?',
        [seenAt, stampRun, l1.pass, l1.reasons, rescueKeep, hash, employmentType, postedAt, postedAt, existing.id]
      );
      if (sameSource && salaryBackfill) {
        db.run(
          'UPDATE jobs SET salary_min_usd = ?, salary_max_usd = ?, salary_currency = ?, salary_source = ? WHERE id = ?',
          [row.salary_min_usd, row.salary_max_usd, row.salary_currency, rowSalarySource, existing.id]
        );
      }
      sighted(existing.id);
      return 'seen';
    }

    // The posting was edited since we stored it (retitled, relocated, JD
    // rewritten): refresh the content and drop what was derived from the old
    // content — the L2 verdict and the embedding. posted_at, first_seen and the
    // user's triage fields (status, notes, applied_at) are deliberately kept.
    db.run(
      `UPDATE jobs SET last_seen = COALESCE(?, last_seen), last_run_id = ?, l1_pass = ?, l1_reasons = ?, l1_rescued = l1_rescued * ?,
         title = ?, company = ?, company_norm = ?, location = ?, remote = ?,
         salary_min_usd = ?, salary_max_usd = ?, salary_currency = ?, salary_source = ?, employment_type = ?, jd_text = ?, content_hash = ?,
         posted_at = COALESCE(MIN(posted_at, ?), posted_at, ?),
         l2_verdict_json = NULL, l2_score = NULL, l2_fit = NULL, embedding = NULL
       WHERE id = ?`,
      [
        seenAt, stampRun, l1.pass, l1.reasons, rescueKeep,
        row.title, row.company, normalizeCompany(job.company), row.location, row.remote,
        row.salary_min_usd, row.salary_max_usd, row.salary_currency, rowSalarySource, employmentType, row.jd_text, row.content_hash,
        postedAt, postedAt,
        existing.id,
      ]
    );
    sighted(existing.id);
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
    const l1 = runId === null
      ? { pass: fuzzy.l1_pass, reasons: fuzzy.l1_reasons }
      : mergeL1(fuzzy, runId, l1Pass, reasonsJson);
    db.run(
      'UPDATE jobs SET last_seen = ?, last_run_id = ?, duplicate_urls = ?, l1_pass = ?, l1_reasons = ?, l1_rescued = l1_rescued * ? WHERE id = ?',
      [now, runId ?? fuzzy.last_run_id, dupes.length > 0 ? JSON.stringify(dupes) : null, l1.pass, l1.reasons, rescueKeep, fuzzy.id]
    );
    sighted(fuzzy.id);
    return 'seen';
  }

  const hash = contentHash(job);
  const row = toDbRow(job, sourceId, hash);

  const inserted = db.run(
    `INSERT INTO jobs (
      source_id, external_id, url, title, company, company_norm, location, remote,
      salary_min_usd, salary_max_usd, salary_currency, salary_source, posted_at, employment_type, jd_text, content_hash,
      first_seen, last_seen, last_run_id, l1_pass, l1_reasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      salarySource,
      row.posted_at,
      row.employment_type,
      row.jd_text,
      row.content_hash,
      now,
      now,
      runId,
      l1Pass ? 1 : 0,
      reasonsJson,
    ]
  );
  sighted(Number(inserted.lastInsertRowid));
  return 'new';
}

// Max source adapters fetched at once, via a sliding-window pool (runHostPool). The
// total width only buys parallelism ACROSS vendors: per-host in-flight caps, start
// gaps and 429 rests (host-pacer.ts) decide how hard any one vendor is hit, because
// thousands of boards share a few API hosts and a plain wide pool floods them.
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
export const SOURCE_DEADLINE_MS = 8 * 60_000;

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
  pacer?: HostPacer;
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
      'SELECT id, type, identifier, display_name, enabled, config_json, last_ok_fetch_at FROM sources WHERE enabled = 1'
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

/**
 * Validates one adapter-yielded job against the contract, or null when it is malformed. A
 * malformed date string parses to NaN in several adapters, so that is treated as undated
 * rather than rejecting an otherwise valid job.
 */
export function parseListingJob(raw: Job): Job | null {
  const candidate =
    typeof raw.posted_at === 'number' && !Number.isFinite(raw.posted_at) ? { ...raw, posted_at: null } : raw;
  const parsed = JobShape.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The posted_at `sourceId` itself stored for `url`: null when undated, undefined when it doesn't own a row. */
export function storedPostedAt(url: string, sourceId: number): number | null | undefined {
  return db
    .query<{ posted_at: number | null }, [string, number]>('SELECT posted_at FROM jobs WHERE url = ? AND source_id = ?')
    .get(url, sourceId)?.posted_at;
}

/**
 * The earlier of the stored and fetched posted dates. upsertJob keeps the first-sighting
 * date, but a fetch can re-derive a later one (Workday's "Posted 30+ Days Ago" is recomputed
 * from today, Rippling's date arrives only via enrich). L1's freshness gate uses this on both
 * the live and the cached path, so they agree and a relative date can't drift a job newer.
 */
export function earliestPosted(stored: number | null | undefined, fetched: number | null | undefined): number | null {
  if (stored == null) return fetched ?? null;
  return fetched == null ? stored : Math.min(stored, fetched);
}

export class SourceDeadlineError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'SourceDeadlineError';
  }
}

interface StoredEnrichedRow {
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  salary_currency: string | null;
  salary_source: string | null;
  jd_text: string;
}

/** The salary and JD of a URL already stored with a description, or null when it
 * isn't stored that way. Re-enriching such a URL would spend budget (and a request)
 * on a JD upsertJob keeps anyway (COALESCE). */
function storedEnrichedRow(url: string): StoredEnrichedRow | null {
  return db
    .query<StoredEnrichedRow, [string]>(
      `SELECT salary_min_usd, salary_max_usd, salary_currency, salary_source, jd_text
       FROM jobs WHERE url = ? AND jd_text IS NOT NULL`
    )
    .get(url);
}

/**
 * Run adapter.enrich and merge its patch into the job. Returns the merged job, or
 * null when there was nothing to merge. enrich() must not throw per its contract,
 * but a buggy adapter must not fail the whole source over one optional detail
 * fetch, so a throw is logged and treated as "no patch".
 */
async function enrichJob(
  adapter: SourceAdapter,
  job: Job,
  ctx: SourceContext,
  sourceName: string,
  onRateLimited: () => void,
): Promise<Job | null> {
  let patch: Partial<Job> | null;
  try {
    patch = (await adapter.enrich?.(job, ctx)) ?? null;
  } catch (err) {
    if (isRateLimited(err)) onRateLimited();
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
  const pacer = opts.pacer ?? hostPacer;
  // Boards a vendor refused with 429 (or that were skipped while it rested), per host group.
  // Reported as one aggregated line instead of one error each. Those with a stored fetch are
  // then served from it, however old: stale results beat a board vanishing from the search.
  const rateLimited = new Map<string, { boards: number; stale: number }>();
  const staleFallback: DbSource[] = [];
  const markRateLimited = (source: DbSource, msg: string): void => {
    const key = hostKey(source);
    const entry = rateLimited.get(key) ?? { boards: 0, stale: 0 };
    entry.boards++;
    if (source.last_ok_fetch_at != null) {
      entry.stale++;
      staleFallback.push(source);
    }
    rateLimited.set(key, entry);
    // refresh_retry_at lets the background refresher pick the board up as soon as the host's
    // rest is over. last_ok_fetch_at and refresh_failures stay as they were: this is not the board's fault.
    db.run(
      `UPDATE sources SET last_scan_at = ?, last_status = 'rate-limited', last_error = ?, refresh_retry_at = ? WHERE id = ?`,
      [Date.now(), msg, pacer.restingUntil(key), source.id]
    );
  };

  // Per-source scan. Owns its own error handling (a failed or hung board marks
  // itself and is recorded in runErrors, never aborts the run). Run via a
  // sliding-window pool so the next source starts the instant one finishes — no
  // batch waits on its slowest member.
  // `fromCache` is set for a cached board's L1 survivors that still need enrich(): they run
  // the live pipeline from the stored row instead of a fetch, and the board's fetch
  // bookkeeping (last_scan_at, last_status, last_ok_fetch_at) is left alone.
  const scanOne = async (source: DbSource, fromCache?: Job[]): Promise<void> => {
    const adapter = getAdapter(source.type);
    if (!adapter) {
      console.log(`  [skip] no adapter for type: ${source.type}`);
      return;
    }

    bus.emit({ runId, type: 'source_start', msg: `Scanning ${source.display_name}${fromCache ? ' (cached)' : ''}`, data: { source: source.display_name } });
    // Taken before the fetch: every job it sees is stamped last_seen >= this, which is how
    // the board cache tells the jobs on the board from ones that have since dropped off.
    const fetchStartedAt = Date.now();

    const config: Record<string, unknown> = {
      identifier: source.identifier,
      display_name: source.display_name,
      ...(source.config_json ? JSON.parse(source.config_json) : {}),
    };

    // Per-source controller: the deadline below aborts THIS source only.
    const sourceAbort = new AbortController();
    let queryDependent = false;
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
      markQueryDependent: () => { queryDependent = true; },
    };

    // Aggregators whose jd_text spans several roles (HN threads) opt out of reading
    // pay from text: a neighbouring role's salary would become this job's.
    const fillJd = (j: Job, text?: string): Job | null =>
      adapter.jdSalaryUnreliable ? null : fillSalaryFromJd(j, text);

    let sourceJobCount = 0;
    let invalidCount = 0;
    let enrichCalls = 0;

    const consume = async (): Promise<void> => {
      for await (const raw of fromCache ?? adapter.fetch(ctx)) {
        if (sourceAbort.signal.aborted) break;
        const listing = parseListingJob(raw);
        if (!listing) {
          invalidCount++;
          continue;
        }
        const priorPosted = storedPostedAt(listing.url, source.id);
        const withEarliestPosted = (j: Job): Job => {
          const posted = earliestPosted(priorPosted, j.posted_at);
          return posted === (j.posted_at ?? null) ? j : { ...j, posted_at: posted };
        };
        let job = withEarliestPosted(listing);
        // Fill a missing salary from the description BEFORE L1 so the floor can act
        // on it (greenhouse, recruitee, personio and most aggregators publish pay
        // only as text). Never overrides what the adapter supplied.
        let salarySource: SalarySource | null = hasSalary(job) ? 'ats' : null;
        const listingFill = fillJd(job);
        if (listingFill) {
          job = listingFill;
          salarySource = 'jd';
        }
        let { pass, reasons } = l1Filter(job, criteria, l1Opts);

        // Enrichment (e.g. LinkedIn's per-job JD request) only for L1 survivors,
        // sequentially, within this source's budget — never over the full stream.
        const stored = pass && adapter.enrich && !job.jd_text ? storedEnrichedRow(job.url) : null;
        if (stored) {
          // Already enriched on an earlier run: for enrich-sourced salary the listing
          // carries none, so re-apply the stored one before L1 or a below-floor job
          // would pass it. Listing-salary adapters (Workable) are left alone: an
          // absent listing salary there means the employer removed it.
          // A JD-derived stored salary is re-applied for any adapter: it comes from the
          // stored JD, not from a listing field the employer could have removed.
          const storedHasSalary = stored.salary_min_usd != null || stored.salary_max_usd != null;
          if (!hasSalary(job) && storedHasSalary && (adapter.salaryFromEnrich || stored.salary_source === 'jd')) {
            job = {
              ...job,
              salary_min_usd: stored.salary_min_usd,
              salary_max_usd: stored.salary_max_usd,
              salary_currency: stored.salary_currency,
            };
            salarySource = stored.salary_source === 'jd' ? 'jd' : 'ats';
            ({ pass, reasons } = l1Filter(job, criteria, l1Opts));
          } else if (!hasSalary(job)) {
            // Rows stored before text extraction existed, or a listing salary the
            // employer removed: read what the stored JD says now, in this run.
            const fill = fillJd(job, stored.jd_text);
            if (fill) {
              job = fill;
              salarySource = 'jd';
              ({ pass, reasons } = l1Filter(job, criteria, l1Opts));
            }
          }
        // Enrich calls hit the same vendor as the listing: take a paced turn first. No turn (the
        // vendor rests longer than is worth waiting for, or the source was aborted) leaves the job unenriched.
        } else if (
          pass && adapter.enrich && !job.jd_text && enrichCalls < ENRICH_BUDGET_PER_SOURCE
          && await waitForTurn(pacer, hostKey(source), sourceAbort.signal)
        ) {
          enrichCalls++;
          const enriched = await enrichJob(adapter, job, ctx, source.display_name, () => pacer.rateLimited(hostKey(source)));
          if (enriched) {
            const hadSalary = hasSalary(job);
            job = withEarliestPosted(enriched);
            if (!hadSalary) {
              // Structured pay from the detail endpoint wins over the JD text.
              const fill = hasSalary(job) ? null : fillJd(job);
              if (fill) job = fill;
              salarySource = fill ? 'jd' : hasSalary(job) ? 'ats' : null;
            }
            ({ pass, reasons } = l1Filter(job, criteria, l1Opts));
          }
          if (sourceAbort.signal.aborted) break;
        }

        const status = upsertJob(job, source.id, runId, pass, reasons, adapter.salaryFromEnrich === true && !job.jd_text, salarySource, !fromCache);
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

      // Only a fetch that ran to the end advances last_ok_fetch_at: the error path below
      // never reaches this, so a failed, partial or timed-out fetch leaves the board stale.
      // A fetch that depended on the search keywords is not the whole board, so it clears it.
      if (!fromCache) {
        db.run(
          `UPDATE sources SET last_scan_at = ?, last_status = 'ok', last_error = NULL, last_ok_fetch_at = ?,
             refresh_failures = 0, refresh_retry_at = NULL WHERE id = ?`,
          [Date.now(), queryDependent ? null : fetchStartedAt, source.id]
        );
        pacer.succeeded(hostKey(source));
      }

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
      if (!timedOut && !fromCache && !AGGREGATOR_TYPES.has(source.type) && isRateLimited(err)) {
        pacer.rateLimited(hostKey(source));
        markRateLimited(source, err instanceof Error ? err.message : String(err));
        return;
      }
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
      if (!fromCache) {
        db.run(
          `UPDATE sources SET last_scan_at = ?, last_status = ?, last_error = ? WHERE id = ?`,
          [Date.now(), status, msg, source.id]
        );
      }
      bus.emit({ runId, type: 'source_error', msg: `${source.display_name}: ${msg}`, data: { source: source.display_name, error: msg } });
    } finally {
      clearTimeout(timer);
    }
  };

  // Boards fetched within the TTL are served from their stored jobs (board-cache.ts).
  // This runs before the live pool, not beside it: it finishes in seconds and keeping
  // the two apart means no live upsert ever races a cache stamp on the same row.
  // Re-runs L1 over each board's stored open jobs and stamps them into this run. Returns the jobs
  // stamped. Survivors still needing a JD are handed back as tasks when `deferred` is given.
  const stampStored = async (
    boards: DbSource[],
    canEnrich: (type: string) => boolean,
    deferred?: { source: DbSource; stored?: Job[] }[],
  ): Promise<number> => {
    let stamped = 0;
    for await (const res of evaluateCachedBoards(boards, {
      runId,
      criteria,
      l1Opts,
      canEnrich,
      isFreshnessOnly: reasons => reasons.every(isFreshnessReason),
    })) {
      jobsFound += res.found;
      jobsL1Pass += res.passed;
      freshnessDropped += res.freshnessDropped;
      stamped += res.found;
      if (res.error) runErrors.push({ source: res.source.display_name, error: res.error });
      if (res.deferred.length > 0) deferred?.push({ source: res.source, stored: res.deferred });
    }
    return stamped;
  };

  const { cached, live } = partitionByCache(sources, scanNow, boardCacheTtlMs());
  const tasks: { source: DbSource; stored?: Job[] }[] = live.map(source => ({ source }));
  let cachedJobs = 0;
  if (cached.length > 0) {
    bus.emit({
      runId,
      type: 'source_start',
      msg: `${cached.length.toLocaleString()} boards from cache, ${live.length.toLocaleString()} fetched live`,
      data: { cachedBoards: cached.length, liveBoards: live.length },
    });
    const enrichable = new Set(cached.filter(s => getAdapter(s.type)?.enrich).map(s => s.type));
    const deferredTasks: typeof tasks = [];
    cachedJobs += await stampStored(cached, type => enrichable.has(type), deferredTasks);
    // Survivors still needing a JD go first so their enrich budget isn't starved by a long live queue.
    tasks.unshift(...deferredTasks);
    bus.emit({
      runId,
      type: 'source_done',
      msg: `${cached.length.toLocaleString()} cached boards: ${cachedJobs.toLocaleString()} stored jobs re-checked`,
      data: { cachedBoards: cached.length, count: cachedJobs },
    });
  }

  // onError is the safety net for anything scanOne itself didn't catch
  // (e.g. a malformed config_json before the try) — it should be rare.
  await runHostPool(
    tasks,
    CONCURRENCY,
    {
      pacer,
      keyOf: t => hostKey(t.source),
      // A cache-backed task only wants an enrich pass: its board was already stamped from
      // storage, so skipping it loses nothing but the JD. Its deferred jobs are stamped below.
      onSkip: t => {
        if (t.stored) staleFallback.push(t.source);
        else markRateLimited(t.source, 'HTTP 429: host was rate-limiting this run, skipped');
      },
    },
    t => scanOne(t.source, t.stored),
    (t, err) => {
      runErrors.push({ source: t.source.display_name, error: String(err) });
    },
  );

  // Rate-limited boards keep their last known jobs in this search, however old: better stale than missing.
  // A board skipped for its enrich pass is re-stamped too (harmless, it is already in this run).
  if (staleFallback.length > 0) await stampStored(staleFallback, () => false);

  let rateLimitedTotal = 0;
  for (const [host, { boards, stale }] of rateLimited) {
    rateLimitedTotal += boards;
    const served = stale > 0 ? ` (${stale.toLocaleString()} served from older cache)` : '';
    const msg = `${boards.toLocaleString()} ${boards === 1 ? 'board' : 'boards'} rate-limited by ${host}${served} — will retry in the background`;
    console.warn(`  [rate-limited] ${msg}`);
    // Kept in the run's errors so history shows it, as one entry per host rather than one per board.
    runErrors.push({ source: host, error: msg });
    bus.emit({ runId, type: 'source_warning', msg, data: { host, rateLimited: boards, servedFromCache: stale } });
  }

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
  if (cached.length > 0) summary += ` · ${cached.length.toLocaleString()} boards from cache, ${live.length.toLocaleString()} fetched live`;
  if (rateLimitedTotal > 0) summary += ` · ${rateLimitedTotal.toLocaleString()} boards rate-limited (retrying in the background)`;
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
  bus.emit({ runId, type: 'scan_done', msg: summary, data: { jobsFound, jobsNew, jobsL1Pass, freshnessDropped, rateLimited: rateLimitedTotal, errors: runErrors.length, cachedBoards: cached.length, liveBoards: live.length } });
}

function markRunFinished(runId: number): void {
  db.run('UPDATE runs SET finished_at = ? WHERE id = ?', [Date.now(), runId]);
}

/** L1 survivors of a run that still have no L2 verdict (deferred by the cap, or failed). */
export function countUngraded(runId: number): number {
  return db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE l1_pass = 1 AND l2_verdict_json IS NULL AND duplicate_of IS NULL AND status != 'hidden' AND last_run_id = ?`
    )
    .get(runId)!.n;
}

export async function runL2Pass(
  runId: number,
  criteriaYaml: string,
  userQuery?: string,
  prerank: typeof prerankSurvivors = prerankSurvivors,
): Promise<void> {
  // Scope to jobs this run surfaced (upsertJob stamped last_run_id = runId on
  // every job it touched). Keeps L2 from re-scoring out-of-scope jobs from
  // earlier searches and aligns with the scope-to-current-search model.
  const survivors = db
    .query<L2JobRow, [number]>(
      `SELECT id, title, company, location, jd_text, embedding
       FROM jobs
       WHERE l1_pass = 1 AND l2_verdict_json IS NULL AND duplicate_of IS NULL AND status != 'hidden' AND last_run_id = ?`
    )
    .all(runId);

  // L1.5: order survivors most-relevant-first so the sequential L2 pass scores
  // the best jobs earliest (results stream best-first). Reorder only, never drops;
  // no-ops when the embedding feature is off.
  const queryText = criteriaToQueryText(yaml.load(criteriaYaml) as Criteria);
  const ranked = await prerank(survivors, queryText);
  // Bound the pass: grade only the best-ranked N. The rest keep NULL verdicts, so
  // an identical re-search (which reuses the criteria) continues with the next N.
  const cap = l2MaxJobs();
  const jobs = ranked.slice(0, cap);

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

  const l2Start = `L2 — scoring ${jobs.length}${ranked.length > jobs.length ? ` of ${ranked.length}` : ''} jobs via ${llm.providerName}${resumeText ? ' (resume-aware)' : ''}...`;
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

  const ungraded = countUngraded(runId);
  const ungradedNote = ungraded > 0
    ? ` — ${ungraded.toLocaleString()} more not yet graded${ranked.length > cap ? ` (limit ${cap} per search, search again to continue)` : ''}`
    : '';
  const doneMsg = (aborted
    ? `L2 aborted — fit: ${l2Pass}, errors: ${errors.length}`
    : `L2 complete — fit: ${l2Pass}, errors: ${errors.length}`) + ungradedNote;
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
    data: { l2Pass, errors: errors.length, aborted, error: abortError, ungraded },
  });
}

/**
 * Runs a scan to completion given a setup already created by createRun(). The
 * caller (POST /api/runs/scan) acquires the scan lock BEFORE the multi-second
 * nl-filter call and before calling createRun — not here — so two overlapping
 * searches can't both start a run (see L3 in review notes). This function takes
 * ownership of that already-held lock and is solely responsible for releasing it.
 */
export async function runFull(setup: RunSetup, lockToken?: string): Promise<number> {
  const { runId, sources, criteria, criteriaYaml, criteriaSourceText } = setup;
  const stopHeartbeat = lockToken ? startScanLockHeartbeat(lockToken) : () => {};
  try {
    await runScan(runId, sources, criteria);
    // Semantic rescue (L1.5) promotes title-only L1 misses that read like the query.
    // Must run before legitimacy/dedup/L2 so the promoted jobs go through them too.
    await applySemanticRescue(runId, criteria);
    // Deterministic legitimacy (ghost-job) pass — zero LLM cost, so it runs
    // before L2 and the badges are visible while L2 is still scoring.
    const scored = await applyLegitimacyPass(runId);
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
    stopHeartbeat();
    if (lockToken) releaseScanLock(lockToken);
  }
}

