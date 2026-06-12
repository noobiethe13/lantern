import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { getAdapter } from '../sources/index';
import { l1Filter, type Criteria } from '../core/filter';
import { contentHash, normalizeCompany, rolesMatch } from '../core/dedup';
import { toDbRow } from '../core/normalize';
import type { Job } from '../core/job';
import { llm } from '../llm';
import { LlmError } from '../llm/provider';
import { BatchVerdictShape, BatchVerdictWithResumeShape } from '../llm/schemas';
import { batchVerdictPrompt } from '../llm/prompts';
import { activeResumeText } from '../routes/resume';
import { bus, type ScanEvent } from './progress';
import { isSourceFetchError } from '../server/errors';

interface SeedSource {
  type: string;
  identifier: string;
  display_name: string;
  enabled: boolean;
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
}

// Stale lock window — if a row in scan_locks is older than this, assume the
// previous scanner crashed and steal the lock rather than refusing to start.
const SCAN_LOCK_STALE_MS = 60 * 60 * 1000; // 1 hour

function tryAcquireScanLock(): boolean {
  // Clear stale locks first (a previous crash could have left one behind).
  db.run(
    'DELETE FROM scan_locks WHERE key = ? AND acquired_at < ?',
    ['scan', Date.now() - SCAN_LOCK_STALE_MS],
  );
  try {
    db.run(
      'INSERT INTO scan_locks (key, acquired_at, pid) VALUES (?, ?, ?)',
      ['scan', Date.now(), typeof process !== 'undefined' ? process.pid ?? null : null],
    );
    return true;
  } catch (err) {
    // PRIMARY KEY conflict — another scan holds the lock.
    if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return false;
    throw err;
  }
}

function releaseScanLock(): void {
  db.run('DELETE FROM scan_locks WHERE key = ?', ['scan']);
}

export function getScanningState(): boolean {
  const row = db.query<{ key: string }, []>("SELECT key FROM scan_locks WHERE key = 'scan'").get();
  return row !== null;
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

export function loadCriteria(): Criteria {
  return yaml.load(loadCriteriaRaw()) as Criteria;
}

function seedSources(): void {
  const seedPath = join(process.cwd(), 'src/config/seed-sources.yml');
  const raw = yaml.load(readFileSync(seedPath, 'utf-8')) as {
    sources: SeedSource[];
  };

  const insert = db.prepare<unknown, [string, string, string, number, number]>(
    `INSERT OR IGNORE INTO sources (type, identifier, display_name, enabled, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );

  const now = Date.now();
  for (const s of raw.sources) {
    insert.run(s.type, s.identifier, s.display_name, s.enabled ? 1 : 0, now);
  }
}

interface FuzzyCandidateRow {
  id: number;
  title: string;
  company: string;
  url: string;
  duplicate_urls: string | null;
}

function findFuzzyDuplicate(job: Job): FuzzyCandidateRow | null {
  const normCo = normalizeCompany(job.company);
  if (!normCo) return null;

  // Prefilter on the indexed company_norm column (written by upsertJob with the
  // same normalizeCompany) so we only load rows from the same normalized
  // company instead of the whole jobs table — the difference between O(n) and
  // O(matches) per insert, which matters once the seed list is hundreds of
  // boards. The role-similarity check stays in JS over that small candidate set.
  const candidates = db
    .query<FuzzyCandidateRow, [string]>(
      'SELECT id, title, company, url, duplicate_urls FROM jobs WHERE company_norm = ?'
    )
    .all(normCo);

  for (const c of candidates) {
    if (!rolesMatch(c.title, job.title)) continue;
    return c;
  }
  return null;
}

function upsertJob(
  job: Job,
  sourceId: number,
  runId: number,
  l1Pass: boolean,
  l1Reasons: string[]
): 'new' | 'seen' {
  const hash = contentHash(job);
  const row = toDbRow(job, sourceId, hash);
  const now = Date.now();

  const existing = db
    .query<{ id: number }, [string]>('SELECT id FROM jobs WHERE url = ?')
    .get(job.url);

  if (existing) {
    db.run(
      'UPDATE jobs SET last_seen = ?, last_run_id = ?, l1_pass = ?, l1_reasons = ? WHERE url = ?',
      [now, runId, l1Pass ? 1 : 0, l1Reasons.length > 0 ? JSON.stringify(l1Reasons) : null, job.url]
    );
    return 'seen';
  }

  // Fuzzy dedup: same normalized company + matching role tokens. The canonical
  // row keeps its original URL; the new URL is appended to duplicate_urls so we
  // don't lose the link from the second board. The current run claims the row so
  // a job surfaced again this scan stays in scope.
  const fuzzy = findFuzzyDuplicate(job);
  if (fuzzy) {
    const dupes: string[] = fuzzy.duplicate_urls ? JSON.parse(fuzzy.duplicate_urls) : [];
    if (job.url !== fuzzy.url && !dupes.includes(job.url)) {
      dupes.push(job.url);
      db.run(
        'UPDATE jobs SET last_seen = ?, last_run_id = ?, duplicate_urls = ? WHERE id = ?',
        [now, runId, JSON.stringify(dupes), fuzzy.id]
      );
    } else {
      db.run('UPDATE jobs SET last_seen = ?, last_run_id = ? WHERE id = ?', [now, runId, fuzzy.id]);
    }
    return 'seen';
  }

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
      l1Reasons.length > 0 ? JSON.stringify(l1Reasons) : null,
    ]
  );
  return 'new';
}

const CONCURRENCY = 10;

// L2 grades jobs in batches of this size per `claude` call to amortize the
// per-subprocess cold-start overhead (~15K uncacheable tokens). Sequential for
// now; timeout scales with batch size (10 jobs ≫ 1, so the default 120s is tight).
const L2_BATCH_SIZE = 10;
const L2_BATCH_TIMEOUT_MS = 240_000;

export async function runScan(query?: string): Promise<number> {
  console.log('lantern — starting scan');

  seedSources();

  const sources = db
    .query<DbSource, []>(
      'SELECT id, type, identifier, display_name, enabled, config_json FROM sources WHERE enabled = 1'
    )
    .all();

  const criteria = loadCriteria();
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

  const runErrors: { source: string; error: string }[] = [];
  let jobsFound = 0;
  let jobsNew = 0;
  let jobsL1Pass = 0;

  const abort = new AbortController();

  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async source => {
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

        const ctx = {
          sourceId: source.id,
          config,
          keywords: criteria.title?.positive ?? [],
          locations: criteria.location?.allowed ?? [],
          remoteRequired: criteria.location?.remote_required ?? false,
          emitProgress: (msg: string, _n?: number) => {
            console.log(`  ${msg}`);
            bus.emit({ runId, type: 'job_found', msg, data: { source: source.display_name } });
          },
          abortSignal: abort.signal,
        };

        let sourceJobCount = 0;
        try {
          for await (const job of adapter.fetch(ctx)) {
            if (abort.signal.aborted) break;
            const { pass, reasons } = l1Filter(job, criteria);
            const status = upsertJob(job, source.id, runId, pass, reasons);
            jobsFound++;
            sourceJobCount++;
            if (status === 'new') jobsNew++;
            if (pass) jobsL1Pass++;
          }

          db.run(
            `UPDATE sources SET last_scan_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?`,
            [Date.now(), source.id]
          );

          const doneMsg = `${source.display_name}: ${sourceJobCount} jobs`;
          bus.emit({ runId, type: 'source_done', msg: doneMsg, data: { source: source.display_name, count: sourceJobCount } });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = isSourceFetchError(err) ? err.kind : 'http-error';
          console.error(`  [error:${status}] ${source.display_name}: ${msg}`);
          runErrors.push({ source: source.display_name, error: msg });
          db.run(
            `UPDATE sources SET last_scan_at = ?, last_status = ?, last_error = ? WHERE id = ?`,
            [Date.now(), status, msg, source.id]
          );
          bus.emit({ runId, type: 'source_error', msg: `${source.display_name}: ${msg}`, data: { source: source.display_name, error: msg } });
        }

        return sourceJobCount;
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        runErrors.push({ source: 'unknown', error: String(result.reason) });
      }
    }
  }

  // NOTE: finished_at is intentionally NOT set here. The run isn't done until L2
  // finishes (runFull sets finished_at after runL2Pass). Setting it at L1-end made
  // the run look complete while L2 was still scoring.
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

  const summary = `Scan complete — found: ${jobsFound}, new: ${jobsNew}, L1 pass: ${jobsL1Pass}`;
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
  bus.emit({ runId, type: 'scan_done', msg: summary, data: { jobsFound, jobsNew, jobsL1Pass, errors: runErrors.length } });

  return runId;
}

export async function runL2Pass(runId: number, criteriaYaml: string): Promise<void> {
  // Scope to jobs this run surfaced (upsertJob stamped last_run_id = runId on
  // every job it touched). Keeps L2 from re-scoring out-of-scope jobs from
  // earlier searches and aligns with the scope-to-current-search model.
  const jobs = db
    .query<L2JobRow, [number]>(
      `SELECT id, title, company, location, jd_text
       FROM jobs
       WHERE l1_pass = 1 AND l2_verdict_json IS NULL AND last_run_id = ?`
    )
    .all(runId);

  if (jobs.length === 0) {
    console.log('L2: no pending jobs');
    bus.emit({ runId, type: 'l2_done', msg: 'L2: no pending jobs', data: { l2Pass: 0, errors: 0 } });
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
  // provider is wedged. A batch call that succeeds (even with some job_ids
  // missing) resets the counter — the provider is clearly responding.
  const MAX_CONSECUTIVE_FAILURES = 3;
  let consecutiveFailures = 0;
  let aborted = false;

  // Grade jobs in batches so one `claude` subprocess scores L2_BATCH_SIZE jobs,
  // amortizing the ~15K cold-start overhead across the batch instead of paying it
  // per job. Each batch gets a larger timeout (N jobs ≫ 1).
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
    );

    try {
      const { verdicts } = await llm.call(
        { task: 'verdict', prompt, timeoutMs: L2_BATCH_TIMEOUT_MS },
        verdictShape,
      );
      const byId = new Map(verdicts.map((v) => [v.job_id, v]));
      consecutiveFailures = 0;

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
        break;
      }

      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`\n[l2] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting (last: ${msg})`);
        aborted = true;
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
  bus.emit({ runId, type: 'l2_done', msg: doneMsg, data: { l2Pass, errors: errors.length } });
}

export async function runFull(query?: string): Promise<number> {
  if (!tryAcquireScanLock()) {
    throw new Error('A scan is already running');
  }
  try {
    const runId = await runScan(query);
    const criteriaYaml = loadCriteriaRaw();
    await runL2Pass(runId, criteriaYaml);
    // The run is complete only now (after L2). Covers all runL2Pass exit paths
    // (normal, no-pending-jobs early return, abort).
    db.run('UPDATE runs SET finished_at = ? WHERE id = ?', [Date.now(), runId]);
    return runId;
  } finally {
    releaseScanLock();
  }
}

