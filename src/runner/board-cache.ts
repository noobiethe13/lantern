import { db } from '../db/client';
import { l1Filter, type Criteria, type L1Options } from '../core/filter';
import type { Job } from '../core/job';
import type { EmploymentType } from '../core/employment-type';
import { AGGREGATOR_TYPES } from '../routes/sources';

// Board cache. A per-company board returns its whole listing whatever the query, so a
// board fetched recently enough has nothing new to tell this scan except the current
// criteria. Instead of re-fetching it, the scan re-runs L1 over the jobs stored from its
// last successful fetch. Aggregators are keyword-driven (the query changes what they
// return), so they are never cached.
//
// Known parity gap: a posting a board shares with another source's row (same URL, or a
// fuzzy fold) is evaluated from that row's stored, owning-source data, where a live fetch
// would grade the board's own copy of it.

export interface CacheableSource {
  id: number;
  type: string;
  last_ok_fetch_at?: number | null;
}

/** True when `source` is a per-company board whose last complete fetch is within the TTL. */
export function isCacheFresh(source: CacheableSource, now: number, ttlMs: number): boolean {
  if (ttlMs <= 0 || AGGREGATOR_TYPES.has(source.type)) return false;
  return source.last_ok_fetch_at != null && now - source.last_ok_fetch_at < ttlMs;
}

export function partitionByCache<S extends CacheableSource>(
  sources: S[],
  now: number,
  ttlMs: number,
): { cached: S[]; live: S[] } {
  const cached: S[] = [];
  const live: S[] = [];
  for (const s of sources) (isCacheFresh(s, now, ttlMs) ? cached : live).push(s);
  return { cached, live };
}

/**
 * Merge an incoming L1 verdict into a row this run may already have claimed.
 * When the row was already stamped by THIS run (a fold or an earlier yield of the
 * same posting), a pass wins over a fail so an L1-passing posting never vanishes
 * into a failing row. When the row's verdict is from an earlier run, it was graded
 * under that run's criteria and is stale — the incoming verdict replaces it (a
 * plain MAX would let an old pass smuggle a now-failing job into this run's L2).
 */
export function mergeL1(
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

/** The columns l1Filter reads (see core/filter.ts) plus the run-stamp state mergeL1 needs.
 *  Every L1 input must be a persisted jobs column, or cached evaluation drifts from a live
 *  fetch: add the column first when l1Filter starts reading a new Job field. */
export interface StoredRow {
  id: number;
  url: string;
  title: string;
  company: string;
  location: string | null;
  remote: number | null;
  salary_min_usd: number | null;
  salary_max_usd: number | null;
  salary_currency: string | null;
  posted_at: number | null;
  employment_type: string | null;
  jd_text: string | null;
  no_jd: number;
  last_run_id: number | null;
  l1_pass: number;
  l1_reasons: string | null;
}

const BASE_COLUMNS = `j.id, j.url, j.title, j.company, j.location, j.remote, j.salary_min_usd, j.salary_max_usd,
  j.salary_currency, j.posted_at, j.employment_type, j.jd_text IS NULL AS no_jd, j.last_run_id, j.l1_pass, j.l1_reasons`;

// A job is on the board right now iff THIS board's latest successful fetch saw it:
// upsertJob records a board_sightings row per source on every sighting, and
// last_ok_fetch_at is the START of that fetch, so a job that dropped off has an older
// seen_at. Sightings, not jobs.source_id: the row may belong to another source that
// inserted the posting first (same URL, or a fuzzy fold), and another source's sighting
// must not keep a job the board removed open. Reading the JD text is skipped unless an L1
// rule needs it: it is the widest column by far.
const openJobsSql = (withJd: boolean) =>
  `SELECT ${BASE_COLUMNS}${withJd ? ', j.jd_text' : ', NULL AS jd_text'}
   FROM board_sightings b JOIN jobs j ON j.id = b.job_id
   WHERE b.source_id = ? AND b.seen_at >= ?`;

/** Rebuilds the Job a live fetch would have produced from a stored row. */
export function storedRowToJob(row: StoredRow): Job {
  return {
    url: row.url,
    title: row.title,
    company: row.company,
    ...(row.location != null ? { location: row.location } : {}),
    ...(row.remote != null ? { remote: row.remote === 1 } : {}),
    salary_min_usd: row.salary_min_usd,
    salary_max_usd: row.salary_max_usd,
    salary_currency: row.salary_currency,
    posted_at: row.posted_at,
    ...(row.jd_text != null ? { jd_text: row.jd_text } : {}),
    ...(row.employment_type != null ? { employment_type: row.employment_type as EmploymentType } : {}),
  };
}

export interface CachedEvalOptions {
  runId: number;
  criteria: Criteria;
  l1Opts: L1Options;
  /** True when the source type's adapter can enrich() a missing JD. */
  canEnrich: (type: string) => boolean;
  isFreshnessOnly: (reasons: string[]) => boolean;
}

export interface CachedBoardResult<S extends CacheableSource> {
  source: S;
  /** Jobs evaluated and stamped, not counting `deferred`. */
  found: number;
  passed: number;
  freshnessDropped: number;
  /** L1 survivors that still need enrich() for a JD. Left untouched here, for the runner to
   *  push through the live pipeline (budget, re-L1, upsert) exactly as a fetched job. */
  deferred: Job[];
  error?: string;
}

const SLICE_MS = 40;

const yieldToEventLoop = () => new Promise<void>(resolve => setImmediate(resolve));

/**
 * Evaluate each cached board: run L1 over its open stored jobs under the CURRENT criteria
 * and stamp last_run_id + the verdict on every one, as upsertJob does for a fetched job.
 * last_seen is left alone: it records when the board last actually showed the job, which is
 * what the open-job test and the ghost-job signal read.
 *
 * Streams rows and commits in short slices, yielding to the event loop between them so the
 * scan-lock heartbeat and SSE keep running through hundreds of thousands of rows.
 */
export async function* evaluateCachedBoards<S extends CacheableSource>(
  sources: S[],
  opts: CachedEvalOptions,
): AsyncGenerator<CachedBoardResult<S>> {
  const { runId, criteria, l1Opts } = opts;
  const needsJd = !!criteria.visa_sponsorship_required;
  const open = db.query<StoredRow, [number, number]>(openJobsSql(needsJd));
  const stamp = db.prepare<unknown, [number, number, string | null, number]>(
    'UPDATE jobs SET last_run_id = ?, l1_pass = ?, l1_reasons = ?, l1_rescued = 0 WHERE id = ?',
  );

  // Its own savepoint inside the slice transaction: a failure rolls back only this board.
  const evaluate = db.transaction((source: S): CachedBoardResult<S> => {
    const res: CachedBoardResult<S> = { source, found: 0, passed: 0, freshnessDropped: 0, deferred: [] };
    const enrichable = opts.canEnrich(source.type);
    for (const row of open.iterate(source.id, source.last_ok_fetch_at!)) {
      const job = storedRowToJob(row);
      const { pass, reasons } = l1Filter(job, criteria, l1Opts);
      if (pass && enrichable && row.no_jd === 1) {
        res.deferred.push(job);
        continue;
      }
      const merged = mergeL1(row, runId, pass, reasons.length > 0 ? JSON.stringify(reasons) : null);
      stamp.run(runId, merged.pass, merged.reasons, row.id);
      res.found++;
      if (pass) res.passed++;
      else if (reasons.length > 0 && opts.isFreshnessOnly(reasons)) res.freshnessDropped++;
    }
    return res;
  });

  let i = 0;
  while (i < sources.length) {
    const results: CachedBoardResult<S>[] = [];
    db.transaction(() => {
      const started = performance.now();
      while (i < sources.length && performance.now() - started < SLICE_MS) {
        const source = sources[i++]!;
        try {
          results.push(evaluate(source));
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          console.error(`  [cache] ${source.type}/${source.id}: ${error}`);
          results.push({ source, found: 0, passed: 0, freshnessDropped: 0, deferred: [], error });
        }
      }
    })();
    yield* results;
    await yieldToEventLoop();
  }
}
