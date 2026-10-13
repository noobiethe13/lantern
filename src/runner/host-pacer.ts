import { HttpStatusError } from '../core/fetch';

// Per-host politeness shared by the scan's live pool and the background refresher. Thousands of
// boards share a handful of API hosts (every Workable board is apply.workable.com, every
// Recruitee tenant is a *.recruitee.com subdomain), so a pool that is only wide in total
// floods whichever vendor dominates the queue and gets 429'd. Boards are therefore grouped by
// vendor (see hostKey) and each group gets an in-flight cap, a jittered gap between starts, and
// a rest period after a 429 that grows while the host keeps refusing.

export interface HostLimit {
  /** Fetches of this host allowed in flight at once. */
  maxInFlight: number;
  /** Minimum gap between two fetches STARTING on this host. Each gap is jittered to 75-125%. */
  paceMs: number;
}

const DEFAULT_LIMIT: HostLimit = { maxInFlight: 2, paceMs: 300 };

// Only vendors that have shown rate limiting, or whose hosts are shared by many thousands of
// boards, deviate from the default. Workable is the strictest: one request at a time.
const HOST_LIMITS: Record<string, HostLimit> = {
  greenhouse: { maxInFlight: 4, paceMs: 200 },
  ashby: { maxInFlight: 4, paceMs: 200 },
  lever: { maxInFlight: 4, paceMs: 200 },
  smartrecruiters: { maxInFlight: 3, paceMs: 300 },
  rippling: { maxInFlight: 2, paceMs: 600 },
  recruitee: { maxInFlight: 2, paceMs: 600 },
  personio: { maxInFlight: 2, paceMs: 500 },
  workable: { maxInFlight: 1, paceMs: 1_500 },
};

export function hostLimit(key: string): HostLimit {
  return HOST_LIMITS[key] ?? DEFAULT_LIMIT;
}

/** After a 429 the whole host rests for BASE * 2^(strikes-1), capped. Any success clears it. */
export const HOST_BACKOFF_BASE_MS = 30_000;
export const HOST_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * The pacing group of a board: its vendor, so per-tenant subdomains (acme.recruitee.com,
 * acme.jobs.personio.de, ...) share one budget the way they share one rate limiter. Workday is the
 * exception: each tenant is its own host and its own limiter, so one 429 must not rest the rest.
 */
export function hostKey(source: { type: string; identifier: string; config_json: string | null }): string {
  if (source.type !== 'workday') return source.type;
  try {
    const cfg = (source.config_json ? JSON.parse(source.config_json) : {}) as { host?: string; dc?: string };
    return `workday:${cfg.host ?? `${source.identifier}.${cfg.dc ?? ''}`}`;
  } catch {
    // A malformed config fails in the adapter with a real message. Pacing just needs some key.
    return 'workday';
  }
}

export function isRateLimited(err: unknown): boolean {
  if (err instanceof HttpStatusError) return err.status === 429;
  return err instanceof Error && /\bHTTP 429\b/.test(err.message);
}

export interface HostPacerOptions {
  /** Limits for a key. Tests pass a zero-pace one. */
  limit?: (key: string) => HostLimit;
  now?: () => number;
  random?: () => number;
  /** First-strike rest. Tests shrink it. */
  backoffBaseMs?: number;
}

export class HostPacer {
  private readonly limit: (key: string) => HostLimit;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly inFlight = new Map<string, number>();
  private readonly nextStartAt = new Map<string, number>();
  private readonly resting = new Map<string, { until: number; strikes: number }>();

  constructor(opts: HostPacerOptions = {}) {
    this.limit = opts.limit ?? hostLimit;
    this.clock = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.backoffBaseMs = opts.backoffBaseMs ?? HOST_BACKOFF_BASE_MS;
  }

  now(): number {
    return this.clock();
  }

  restingUntil(key: string): number {
    return this.resting.get(key)?.until ?? 0;
  }

  isResting(key: string, now = this.clock()): boolean {
    return this.restingUntil(key) > now;
  }

  restingKeys(now = this.clock()): string[] {
    return [...this.resting].filter(([, r]) => r.until > now).map(([key]) => key);
  }

  private hasCapacity(key: string): boolean {
    return (this.inFlight.get(key) ?? 0) < this.limit(key).maxInFlight;
  }

  /** The next moment a fetch of this host may start, or Infinity while it is at its in-flight cap. */
  startableAt(key: string): number {
    if (!this.hasCapacity(key)) return Infinity;
    return Math.max(this.nextStartAt.get(key) ?? 0, this.restingUntil(key));
  }

  /** How long until the pace gap and any rest allow another start, ignoring the in-flight cap. */
  nextStartDelay(key: string, now = this.clock()): number {
    return Math.max(this.nextStartAt.get(key) ?? 0, this.restingUntil(key)) - now;
  }

  /** Spends a start slot without taking an in-flight one (for requests inside a fetch that holds one). */
  claimStart(key: string, now = this.clock()): void {
    const pace = this.limit(key).paceMs;
    if (pace > 0) this.nextStartAt.set(key, now + pace * (0.75 + this.random() * 0.5));
  }

  canStart(key: string, now = this.clock()): boolean {
    return this.startableAt(key) <= now;
  }

  /** Registers a fetch as started: takes an in-flight slot and sets the jittered earliest next start. */
  begin(key: string, now = this.clock()): void {
    this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    this.claimStart(key, now);
  }

  end(key: string): void {
    const n = (this.inFlight.get(key) ?? 0) - 1;
    if (n > 0) this.inFlight.set(key, n);
    else this.inFlight.delete(key);
  }

  /** Rests the whole host after a 429. Returns when it may be tried again. */
  rateLimited(key: string, now = this.clock()): number {
    const prev = this.resting.get(key);
    // A burst of in-flight fetches all report the same 429: only the first one counts as a strike.
    if (prev && prev.until > now) return prev.until;
    const strikes = (prev?.strikes ?? 0) + 1;
    const rest = Math.min(this.backoffBaseMs * 2 ** (strikes - 1), HOST_BACKOFF_MAX_MS) * (0.9 + this.random() * 0.2);
    this.resting.set(key, { until: now + rest, strikes });
    return now + rest;
  }

  /**
   * A fetch got through: the host is healthy again. Ignored while the rest is still running,
   * because a fetch that was already in flight when the 429 landed says nothing about the limiter.
   */
  succeeded(key: string, now = this.clock()): void {
    if (!this.isResting(key, now)) this.resting.delete(key);
  }
}

/** One pacer for the whole process, so a rest started by a scan holds for the refresher and the next scan. */
export const hostPacer = new HostPacer();

/** A rest at most this long is waited out. A longer one (repeated strikes) is not worth stalling for. */
export const MAX_REST_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Takes the next start slot on a host for a request made by a fetch that already holds an
 * in-flight slot (enrich calls). Returns false, without waiting, when the host rests longer than
 * `maxWaitMs`, or when `signal` aborts while waiting: the caller should stop making requests.
 */
export async function waitForTurn(
  pacer: HostPacer,
  key: string,
  signal?: AbortSignal,
  maxWaitMs = MAX_REST_WAIT_MS,
): Promise<boolean> {
  for (;;) {
    if (signal?.aborted) return false;
    const now = pacer.now();
    const rest = pacer.restingUntil(key) - now;
    if (rest > maxWaitMs) return false;
    if (pacer.nextStartDelay(key, now) <= 0) break;
    await sleep(Math.max(5, pacer.nextStartDelay(key, now)));
  }
  pacer.claimStart(key);
  return true;
}

export interface HostPoolOptions<T> {
  pacer: HostPacer;
  keyOf: (item: T) => string;
  /** Called for each queued item whose host rests longer than MAX_REST_WAIT_MS, instead of running it. */
  onSkip: (item: T, key: string) => void;
}

/**
 * runPool with per-host politeness: `limit` items in flight overall, but never more than the
 * pacer allows per host, picking the next item from whichever host is ready so one busy vendor
 * cannot idle the other slots. A host that rests briefly after a 429 is waited out; one resting
 * longer than MAX_REST_WAIT_MS has its queued items skipped. Hosts are served round-robin, FIFO within a host. A worker must call
 * pacer.rateLimited itself when it sees a 429.
 */
export async function runHostPool<T>(
  items: T[],
  limit: number,
  opts: HostPoolOptions<T>,
  worker: (item: T) => Promise<void>,
  onError: (item: T, err: unknown) => void,
): Promise<void> {
  const { pacer, keyOf, onSkip } = opts;
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const keys = [...buckets.keys()];
  const width = Math.max(1, Math.floor(limit) || 1);
  const running = new Set<Promise<void>>();
  let remaining = items.length;
  let rr = 0;

  while (remaining > 0 || running.size > 0) {
    const now = pacer.now();
    for (const key of keys) {
      const bucket = buckets.get(key)!;
      if (bucket.length > 0 && pacer.restingUntil(key) - now > MAX_REST_WAIT_MS) {
        for (const item of bucket.splice(0)) {
          remaining--;
          onSkip(item, key);
        }
      }
    }

    while (running.size < width) {
      let picked: string | null = null;
      for (let i = 0; i < keys.length; i++) {
        const key = keys[(rr + i) % keys.length]!;
        if (buckets.get(key)!.length > 0 && pacer.canStart(key, now)) {
          picked = key;
          rr = (rr + i + 1) % keys.length;
          break;
        }
      }
      if (picked === null) break;
      const item = buckets.get(picked)!.shift()!;
      remaining--;
      pacer.begin(picked, now);
      const p: Promise<void> = worker(item)
        .catch(err => onError(item, err))
        .finally(() => {
          pacer.end(picked!);
          running.delete(p);
        });
      running.add(p);
    }

    if (remaining === 0 && running.size === 0) break;
    const waits: Promise<unknown>[] = [...running];
    if (running.size < width && remaining > 0) {
      // A host at its in-flight cap wakes on a completion above. One only held back by pacing
      // needs a timer.
      const soonest = Math.min(
        ...keys.filter(k => buckets.get(k)!.length > 0).map(k => pacer.startableAt(k)),
      );
      if (Number.isFinite(soonest)) waits.push(sleep(Math.max(5, soonest - pacer.now())));
    }
    await Promise.race(waits);
  }
}
