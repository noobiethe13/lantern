import { z } from 'zod';
import { db } from '../db/client';
import { getAdapter } from '../sources/index';
import { AGGREGATOR_TYPES } from '../routes/sources';
import { boardCacheTtlMs } from '../routes/board-cache';
import { isSourceFetchError } from '../server/errors';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { registerRefreshCancel } from './refresh-control';
import { HostPacer, hostKey, hostLimit, hostPacer, isRateLimited } from './host-pacer';
import { fillSalaryFromJd, hasSalary, type SalarySource } from './jd-salary';
import {
  SOURCE_DEADLINE_MS,
  SourceDeadlineError,
  earliestPosted,
  getScanningState,
  parseListingJob,
  storedPostedAt,
  upsertJob,
} from './scan';

// Background board refresher. Boards only become cache-fresh when something fetches them, so
// with thousands of boards enabled the first search would otherwise fetch them all and they
// would go stale between searches. This loop re-fetches stale per-company boards on its own,
// a few at a time, so searches are served from the board cache (board-cache.ts).
//
// A refresh is a live fetch minus everything search-specific: it upserts jobs, sightings and
// last_ok_fetch_at through the same upsertJob a scan uses (so a real edit still wipes the L2
// verdict and embedding), but passes no run: no last_run_id, no progress events, no L1.
// L1 is left alone on purpose. It depends on the criteria, which change with every search,
// and the scan's cache phase re-grades every open stored job under the current criteria
// anyway, so computing it here would be wasted writes that the next search overwrites.
//
// A search always wins. The loop never takes the scan lock: it pauses while one is held,
// aborts its in-flight fetches the moment one appears, and writes a board in whole
// transactions that re-check the lock first, so no refresher write can land between a
// scan's lock acquisition and its cache phase.

const SETTINGS_KEY = 'board_refresh';
const SettingsSchema = z.object({ enabled: z.boolean() });
export type BoardRefreshSettings = z.infer<typeof SettingsSchema>;
const DEFAULT_SETTINGS: BoardRefreshSettings = { enabled: true };

export function readBoardRefreshSettings(): BoardRefreshSettings {
  const row = db
    .query<{ value_json: string }, [string]>('SELECT value_json FROM settings WHERE key = ?')
    .get(SETTINGS_KEY);
  if (!row) return DEFAULT_SETTINGS;
  const parsed = SettingsSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export function writeBoardRefreshSettings(settings: BoardRefreshSettings): void {
  db.run(
    `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    [SETTINGS_KEY, JSON.stringify(settings), Date.now()],
  );
}

const CONCURRENCY = 3;
const BATCH_SIZE = 100;
const START_DELAY_MS = 20_000;
const BUSY_GAP_MS = 2_000;
const IDLE_MS = 60_000;
const SCAN_POLL_MS = 15_000;
/** Jobs written per transaction. Bounds both memory and how long one write holds the thread. */
const WRITE_CHUNK = 200;
const ABORT_POLL_MS = 1_000;

/** A board that keeps failing is retried after BASE * 2^(failures-1), capped. */
const FAILURE_BACKOFF_BASE_MS = 15 * 60_000;
const FAILURE_BACKOFF_MAX_MS = 24 * 3_600_000;

export function failureBackoffMs(failures: number): number {
  return Math.min(FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1), FAILURE_BACKOFF_MAX_MS);
}

/** Boards older than this are refreshed: early enough that a scan still finds them fresh. */
export function refreshCutoffMs(ttlMs: number): number {
  return ttlMs - Math.min(60 * 60_000, Math.floor(ttlMs * 0.2));
}

interface Candidate {
  id: number;
  type: string;
  identifier: string;
  display_name: string;
  config_json: string | null;
  last_ok_fetch_at: number | null;
  refresh_failures: number;
}

type Outcome = 'ok' | 'failed' | 'aborted' | 'skipped';

export interface TickResult {
  attempted: number;
  ok: number;
  failed: number;
  aborted: number;
  /** Why nothing was attempted, when that is the case. */
  idleReason: 'off' | 'cache-off' | 'scan-running' | 'nothing-stale' | 'busy' | null;
  /** How long the loop should wait before the next tick. */
  waitMs: number;
}

export interface RefreshStatus {
  enabled: boolean;
  /** The loop is running in this process. */
  running: boolean;
  idleReason: TickResult['idleReason'];
  boards: { total: number; fresh: number; stale: number; backedOff: number };
  refreshing: string[];
  /** Shared API hosts (by board type) currently resting after a 429. */
  restingHosts: string[];
  lastTickAt: number | null;
  lastTick: { attempted: number; ok: number; failed: number; aborted: number } | null;
  nextTickAt: number | null;
  lastError: { board: string; error: string; at: number } | null;
}

/** A scan took the lock (or refresh was turned off) while a board was being written. */
class RefreshAbortedError extends Error {
  constructor() {
    super('refresh aborted');
    this.name = 'RefreshAbortedError';
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface RefresherOptions {
  concurrency?: number;
  batchSize?: number;
  startDelayMs?: number;
  busyGapMs?: number;
  idleMs?: number;
  sourceDeadlineMs?: number;
  /** Per-host-group minimum start gap, 0 for none. Tests pass () => 0. */
  paceMs?: (key: string) => number;
  pacer?: HostPacer;
}

export class BoardRefresher {
  private readonly concurrency: number;
  private readonly batchSize: number;
  private readonly startDelayMs: number;
  private readonly busyGapMs: number;
  private readonly idleMs: number;
  private readonly deadlineMs: number;
  private readonly pacer: HostPacer;

  private running = false;
  private stopping = false;
  private loopDone: Promise<void> | null = null;
  private ticking = false;
  private wakeSleep: (() => void) | null = null;

  private readonly inflight = new Map<AbortController, { sourceId: number; name: string }>();

  private idleReason: TickResult['idleReason'] = null;
  private lastTickAt: number | null = null;
  private lastTick: RefreshStatus['lastTick'] = null;
  private nextTickAt: number | null = null;
  private lastError: RefreshStatus['lastError'] = null;
  private failureClasses = new Map<string, { n: number; example: string }>();

  constructor(opts: RefresherOptions = {}) {
    this.concurrency = opts.concurrency ?? CONCURRENCY;
    this.batchSize = opts.batchSize ?? BATCH_SIZE;
    this.startDelayMs = opts.startDelayMs ?? START_DELAY_MS;
    this.busyGapMs = opts.busyGapMs ?? BUSY_GAP_MS;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.deadlineMs = opts.sourceDeadlineMs ?? SOURCE_DEADLINE_MS;
    const paceMs = opts.paceMs;
    // The process-wide pacer, so a rest started by a scan holds here too and vice versa. Tests that
    // override the pace get a private one instead.
    this.pacer = paceMs
      ? new HostPacer({ limit: key => ({ ...hostLimit(key), paceMs: paceMs(key) }) })
      : opts.pacer ?? hostPacer;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.loopDone = this.loop().catch(err => {
      console.error('[refresh] loop crashed:', err);
    });
  }

  /** Stops the loop and aborts in-flight fetches. Resolves once the loop has exited. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelInFlight();
    this.wake();
    await this.loopDone;
    this.loopDone = null;
    this.running = false;
    this.nextTickAt = null;
  }

  /**
   * Aborts in-flight board fetches (one source's, or all) without recording anything against
   * the boards. The caller is about to invalidate what they would write.
   */
  cancelInFlight(sourceId?: number): void {
    for (const [ctrl, info] of this.inflight) {
      if (sourceId === undefined || info.sourceId === sourceId) ctrl.abort();
    }
  }

  /** Cuts the loop's current wait short so it re-evaluates now. */
  wake(): void {
    this.wakeSleep?.();
  }

  /** Called after the toggle changes: turning it off must stop work already in flight. */
  notifySettingsChanged(): void {
    if (!readBoardRefreshSettings().enabled) this.cancelInFlight();
    this.wake();
  }

  private async loop(): Promise<void> {
    await this.waitFor(this.startDelayMs);
    while (!this.stopping) {
      let waitMs = this.idleMs;
      try {
        waitMs = (await this.tick()).waitMs;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[refresh] tick failed: ${msg}`);
        this.lastError = { board: '(tick)', error: msg, at: Date.now() };
      }
      if (this.stopping) break;
      this.nextTickAt = Date.now() + waitMs;
      await this.waitFor(waitMs);
    }
  }

  /** An interruptible, unref'd sleep: wake() or stop() ends it early. */
  private waitFor(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.wakeSleep = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.wakeSleep = done;
    });
  }

  /** True when no board should be started: shutting down, switched off, or a search is running. */
  private paused(): boolean {
    return this.stopping || !readBoardRefreshSettings().enabled || getScanningState();
  }

  /**
   * One pass: select a bounded batch of stale boards, oldest first, and refresh them with
   * limited concurrency. Public so tests (and nothing else) can drive it without the loop.
   */
  async tick(): Promise<TickResult> {
    const result: TickResult = { attempted: 0, ok: 0, failed: 0, aborted: 0, idleReason: null, waitMs: this.idleMs };
    if (this.ticking) return { ...result, idleReason: 'busy' };

    const finish = (reason: TickResult['idleReason'], waitMs: number): TickResult => {
      this.idleReason = reason;
      result.idleReason = reason;
      result.waitMs = waitMs;
      return result;
    };

    if (!readBoardRefreshSettings().enabled) return finish('off', this.idleMs);
    const ttlMs = boardCacheTtlMs();
    if (ttlMs <= 0) return finish('cache-off', this.idleMs);
    if (getScanningState()) return finish('scan-running', SCAN_POLL_MS);

    this.ticking = true;
    this.failureClasses.clear();
    const poll = setInterval(() => {
      if (this.paused()) this.cancelInFlight();
    }, ABORT_POLL_MS);
    poll.unref?.();
    try {
      const candidates = this.selectCandidates(ttlMs);
      if (candidates.length === 0) {
        const blocked = this.pacer.restingKeys().map(k => this.pacer.restingUntil(k));
        const untilUnblock = blocked.length > 0 ? Math.min(...blocked) - Date.now() : this.idleMs;
        return finish('nothing-stale', Math.max(1_000, Math.min(this.idleMs, untilUnblock)));
      }
      await this.runBatch(candidates, result);
      this.idleReason = this.stopping ? null : !readBoardRefreshSettings().enabled ? 'off' : getScanningState() ? 'scan-running' : null;
      this.lastTickAt = Date.now();
      this.lastTick = {
        attempted: result.attempted,
        ok: result.ok,
        failed: result.failed,
        aborted: result.aborted,
      };
      this.logTick(result);
      // A full batch means there is probably more; a short one means the backlog is drained.
      const more = candidates.length >= this.batchSize && result.aborted === 0;
      result.waitMs = more ? this.busyGapMs : result.aborted > 0 ? SCAN_POLL_MS : this.idleMs;
      return result;
    } finally {
      clearInterval(poll);
      this.ticking = false;
    }
  }

  private selectCandidates(ttlMs: number): Candidate[] {
    const now = Date.now();
    // Resting keys that are plain types are cheapest to leave out in SQL. A resting Workday tenant
    // (key 'workday:host') is filtered below.
    const blockedTypes = this.pacer.restingKeys(now).filter(k => !k.includes(':'));
    const excluded = [...AGGREGATOR_TYPES, ...blockedTypes];
    return db
      .query<Candidate, (string | number)[]>(
        `SELECT id, type, identifier, display_name, config_json, last_ok_fetch_at, refresh_failures
         FROM sources
         WHERE enabled = 1
           AND type NOT IN (${excluded.map(() => '?').join(',')})
           AND (last_ok_fetch_at IS NULL OR last_ok_fetch_at < ?)
           AND (refresh_retry_at IS NULL OR refresh_retry_at <= ?)
         ORDER BY last_ok_fetch_at IS NOT NULL, last_ok_fetch_at, random()
         LIMIT ?`,
      )
      .all(...excluded, now - refreshCutoffMs(ttlMs), now, this.batchSize)
      .filter(c => getAdapter(c.type) !== null && !this.pacer.isResting(hostKey(c), now));
  }

  private async runBatch(candidates: Candidate[], result: TickResult): Promise<void> {
    let queue = candidates.slice();
    const running = new Set<Promise<void>>();

    while (queue.length > 0 || running.size > 0) {
      if (this.paused()) {
        this.cancelInFlight();
        result.aborted += queue.length;
        queue = [];
      }
      const now = Date.now();
      // A host that started resting meanwhile keeps its boards for a later tick rather than
      // holding a concurrency slot idle for minutes.
      queue = queue.filter(c => !this.pacer.isResting(hostKey(c), now));

      while (running.size < this.concurrency) {
        const i = queue.findIndex(c => this.pacer.canStart(hostKey(c), now));
        if (i < 0) break;
        const [c] = queue.splice(i, 1) as [Candidate];
        const key = hostKey(c);
        this.pacer.begin(key, now);
        result.attempted++;
        const p: Promise<void> = this.refreshBoard(c)
          .catch((err): Outcome => {
            console.error(`[refresh] ${c.type}/${c.identifier}: unexpected ${err instanceof Error ? err.message : String(err)}`);
            return 'failed';
          })
          .then(outcome => {
            if (outcome === 'ok') result.ok++;
            else if (outcome === 'failed') result.failed++;
            else if (outcome === 'aborted') result.aborted++;
          })
          .finally(() => {
            this.pacer.end(key);
            running.delete(p);
          });
        running.add(p);
      }

      if (queue.length === 0 && running.size === 0) break;
      const waits: Promise<unknown>[] = [...running];
      if (running.size < this.concurrency && queue.length > 0) {
        // Infinity for hosts at their in-flight cap: those wake on a completion instead.
        const soonest = Math.min(...queue.map(c => this.pacer.startableAt(hostKey(c))));
        if (Number.isFinite(soonest)) waits.push(sleep(Math.max(10, soonest - Date.now())));
      }
      await Promise.race(waits);
    }
  }

  /** Fetches one board and writes it. Never throws: every failure is recorded on the board. */
  private async refreshBoard(source: Candidate): Promise<Outcome> {
    const adapter = getAdapter(source.type);
    if (!adapter) return 'skipped';

    const abort = new AbortController();
    this.inflight.set(abort, { sourceId: source.id, name: source.display_name });
    // Taken before the fetch, like a scan: every sighting is stamped >= this, which is how the
    // cache tells jobs still on the board from ones that dropped off.
    const fetchStartedAt = Date.now();
    let queryDependent = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const config: Record<string, unknown> = {
        identifier: source.identifier,
        display_name: source.display_name,
        ...(source.config_json ? JSON.parse(source.config_json) : {}),
      };
      // No keywords: a per-company board ignores them. One that needs them (Workable's
      // oversized accounts) fails or calls markQueryDependent and is never refreshed here.
      const ctx: SourceContext = {
        sourceId: source.id,
        config,
        keywords: [],
        locations: [],
        remoteRequired: false,
        emitProgress: () => {},
        abortSignal: abort.signal,
        markQueryDependent: () => { queryDependent = true; },
      };

      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          abort.abort();
          reject(new SourceDeadlineError(this.deadlineMs));
        }, this.deadlineMs);
      });
      const work = this.fetchAndWrite(source, adapter, ctx, fetchStartedAt, () => queryDependent);
      // The adapter may still be parked in an await that ignores the signal: once the race has
      // settled, its late rejection has no other handler, so a real one is logged here. Before
      // that, the race itself reports it.
      work.catch(late => {
        if (settled && !(late instanceof RefreshAbortedError)) {
          console.error(`[refresh] ${source.display_name}: late error after settle: ${late instanceof Error ? late.message : String(late)}`);
        }
      });
      await Promise.race([work, deadline]);

      this.pacer.succeeded(hostKey(source));
      return 'ok';
    } catch (err) {
      if (!timedOut && (abort.signal.aborted || err instanceof RefreshAbortedError)) return 'aborted';
      return this.recordFailure(source, err, timedOut, queryDependent);
    } finally {
      settled = true;
      clearTimeout(timer);
      this.inflight.delete(abort);
    }
  }

  /**
   * Streams the board into the DB in transactions of WRITE_CHUNK jobs. Each transaction first
   * re-checks that no scan holds the lock and the refresher is still wanted, so the check and the
   * writes are one uninterrupted synchronous step. The last one also advances last_ok_fetch_at:
   * only a fetch that ran to the end, and wasn't aborted, makes a board fresh.
   */
  private async fetchAndWrite(
    source: Candidate,
    adapter: SourceAdapter,
    ctx: SourceContext,
    fetchStartedAt: number,
    isQueryDependent: () => boolean,
  ): Promise<void> {
    let chunk: Job[] = [];
    const flush = (final: boolean) => {
      db.transaction(() => {
        if (ctx.abortSignal.aborted || this.paused()) throw new RefreshAbortedError();
        for (const listing of chunk) this.writeJob(source, adapter, listing);
        if (final) {
          // A fetch that depended on keywords is not the whole board, so it stays uncached, and
          // is not asked again for a day or every tick would refetch it.
          const queryDependent = isQueryDependent();
          const now = Date.now();
          // Guarded on what was selected: an edit to the board's config or name while this fetch
          // was in flight points it somewhere else, and stamping it fresh would serve the old
          // config's jobs from cache. No row matched rolls the whole chunk back.
          const stamped = db.run(
            `UPDATE sources SET last_scan_at = ?, last_status = 'ok', last_error = NULL, last_ok_fetch_at = ?,
               refresh_failures = 0, refresh_retry_at = ?
             WHERE id = ? AND config_json IS ? AND display_name = ? AND last_ok_fetch_at IS ?`,
            [
              now,
              queryDependent ? null : fetchStartedAt,
              queryDependent ? now + FAILURE_BACKOFF_MAX_MS : null,
              source.id,
              source.config_json,
              source.display_name,
              source.last_ok_fetch_at,
            ],
          );
          if (stamped.changes === 0) throw new RefreshAbortedError();
        }
      })();
      chunk = [];
    };

    for await (const raw of adapter.fetch(ctx)) {
      if (ctx.abortSignal.aborted) throw new RefreshAbortedError();
      const listing = parseListingJob(raw);
      if (!listing) continue;
      chunk.push(listing);
      if (chunk.length >= WRITE_CHUNK) flush(false);
    }
    flush(true);
  }

  /** The listing-side half of scanOne (earliest posted date, JD-derived salary) and the upsert. */
  private writeJob(source: Candidate, adapter: SourceAdapter, listing: Job): void {
    const posted = earliestPosted(storedPostedAt(listing.url, source.id), listing.posted_at);
    let job = posted === (listing.posted_at ?? null) ? listing : { ...listing, posted_at: posted };
    let salarySource: SalarySource | null = hasSalary(job) ? 'ats' : null;
    const fill = adapter.jdSalaryUnreliable ? null : fillSalaryFromJd(job);
    if (fill) {
      job = fill;
      salarySource = 'jd';
    }
    upsertJob(job, source.id, null, false, [], adapter.salaryFromEnrich === true && !job.jd_text, salarySource);
  }

  private recordFailure(source: Candidate, err: unknown, timedOut: boolean, queryDependent: boolean): Outcome {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Date.now();
    if (queryDependent) {
      // Only a keyword search returns this board (Workable's oversized accounts), which a
      // refresh has no keywords for. Not a fault: leave its status to the searches that do fetch
      // it and just don't ask again for a day.
      db.run('UPDATE sources SET refresh_retry_at = ? WHERE id = ?', [now + FAILURE_BACKOFF_MAX_MS, source.id]);
      this.noteFailureClass('query-only', `${source.display_name}: ${msg}`);
      return 'skipped';
    }
    let status: string;
    let failures = source.refresh_failures;
    let retryAt: number | null;

    if (isRateLimited(err)) {
      // The vendor's host is the problem, not this board: rest the whole host group, and don't
      // count it against the board.
      status = 'rate-limited';
      retryAt = this.pacer.rateLimited(hostKey(source), now);
    } else {
      status = timedOut ? 'timeout' : isSourceFetchError(err) ? err.kind : 'http-error';
      failures += 1;
      retryAt = now + failureBackoffMs(failures);
    }

    db.run(
      `UPDATE sources SET last_scan_at = ?, last_status = ?, last_error = ?, refresh_failures = ?, refresh_retry_at = ? WHERE id = ?`,
      [now, status, msg, failures, retryAt, source.id],
    );
    this.lastError = { board: source.display_name, error: msg, at: now };
    this.noteFailureClass(status, `${source.display_name}: ${msg}`);
    return 'failed';
  }

  private noteFailureClass(status: string, example: string): void {
    const cls = this.failureClasses.get(status);
    if (cls) cls.n++;
    else this.failureClasses.set(status, { n: 1, example });
  }

  /** One line for the tick plus one per failure class, never one per board. */
  private logTick(r: TickResult): void {
    if (r.attempted === 0) return;
    console.log(`[refresh] ${r.ok} ok, ${r.failed} failed, ${r.aborted} aborted of ${r.attempted}`);
    for (const [status, c] of this.failureClasses) {
      console.error(`  [refresh:${status}] x${c.n}, e.g. ${c.example.slice(0, 200)}`);
    }
  }

  getStatus(): RefreshStatus {
    const now = Date.now();
    const ttlMs = boardCacheTtlMs();
    const excluded = [...AGGREGATOR_TYPES];
    const row = db
      .query<{ total: number; fresh: number | null; backed_off: number | null }, (string | number)[]>(
        `SELECT COUNT(*) AS total,
                SUM(last_ok_fetch_at IS NOT NULL AND last_ok_fetch_at >= ?) AS fresh,
                SUM(refresh_retry_at IS NOT NULL AND refresh_retry_at > ?) AS backed_off
         FROM sources WHERE enabled = 1 AND type NOT IN (${excluded.map(() => '?').join(',')})`,
      )
      .get(ttlMs > 0 ? now - ttlMs : Number.MAX_SAFE_INTEGER, now, ...excluded)!;
    const fresh = row.fresh ?? 0;
    return {
      enabled: readBoardRefreshSettings().enabled,
      running: this.running,
      idleReason: this.idleReason,
      boards: { total: row.total, fresh, stale: row.total - fresh, backedOff: row.backed_off ?? 0 },
      refreshing: [...this.inflight.values()].map(i => i.name),
      restingHosts: this.pacer.restingKeys(now),
      lastTickAt: this.lastTickAt,
      lastTick: this.lastTick,
      nextTickAt: this.nextTickAt,
      lastError: this.lastError,
    };
  }
}

export const boardRefresher = new BoardRefresher();
registerRefreshCancel(id => boardRefresher.cancelInFlight(id));

/** Starts the process-wide loop once. Timers are unref'd, so it never keeps the process alive. */
export function startBoardRefresher(): void {
  boardRefresher.start();
  process.once('exit', () => {
    void boardRefresher.stop();
  });
}
