import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { HttpStatusError } from '../core/fetch';
import type { Criteria } from '../core/filter';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import { REPO, memDb, scan, bus, insertSource, insertJob, resetDb, req, NL_OK } from '../test-harness';

const { adapterRegistry } = await import(`${REPO}/src/sources/index.ts`);
const { BoardRefresher, failureBackoffMs, refreshCutoffMs } = await import(`${REPO}/src/runner/board-refresher.ts`);
const registry = adapterRegistry as Record<string, SourceAdapter>;
const originals = { greenhouse: registry.greenhouse, ashby: registry.ashby, workable: registry.workable, remoteok: registry.remoteok, recruitee: registry.recruitee };

const HOUR = 3_600_000;

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  Object.assign(registry, originals);
});

afterAll(() => {
  resetDb();
});

type Fetch = (ctx: SourceContext) => AsyncIterable<Job>;

function install(type: 'greenhouse' | 'ashby' | 'workable' | 'remoteok' | 'recruitee', fetch: Fetch, extra: Partial<SourceAdapter> = {}) {
  registry[type] = { type, fetch, ...extra } as SourceAdapter;
}

const job = (n: string, extra: Partial<Job> = {}): Job => ({
  url: `https://boards.test/acme/jobs/${n}`,
  title: 'Software Engineer',
  company: `Acme ${n}`,
  ...extra,
});

async function* listing(jobs: Job[]): AsyncGenerator<Job> {
  for (const j of jobs) yield j;
}

/** A greenhouse adapter yielding `jobs` for every board, recording which boards it was asked for. */
function fakeBoards(jobs: Job[] = [job('1')]) {
  const fetched: string[] = [];
  install('greenhouse', ctx => {
    fetched.push(ctx.config['identifier'] as string);
    return listing(jobs);
  });
  return fetched;
}

// Pacing off so tests don't sleep, and one at a time so fetch order is the selection order.
const refresher = (opts: Record<string, unknown> = {}) =>
  new BoardRefresher({ concurrency: 1, paceMs: () => 0, ...opts });

type SourceRow = {
  id: number;
  last_ok_fetch_at: number | null;
  last_scan_at: number | null;
  last_status: string | null;
  last_error: string | null;
  refresh_failures: number;
  refresh_retry_at: number | null;
};
const sourceRow = (id: number) =>
  memDb
    .query('SELECT id, last_ok_fetch_at, last_scan_at, last_status, last_error, refresh_failures, refresh_retry_at FROM sources WHERE id = ?')
    .get(id) as SourceRow;

type JobRow = {
  id: number;
  url: string;
  title: string;
  last_run_id: number | null;
  last_seen: number;
  l1_pass: number;
  l1_reasons: string | null;
  l2_verdict_json: string | null;
  embedding: Uint8Array | null;
  status: string;
};
const jobRows = () => memDb.query('SELECT * FROM jobs ORDER BY url').all() as JobRow[];
const byUrl = (url: string) => jobRows().find(j => j.url === url)!;

const stale = (id: number, hoursAgo = 10) =>
  memDb.run('UPDATE sources SET last_ok_fetch_at = ? WHERE id = ?', [Date.now() - hoursAgo * HOUR, id]);

function lockScan(): void {
  memDb.run(
    "INSERT INTO scan_locks (key, acquired_at, pid, token, started_at) VALUES ('scan', ?, ?, 'test', ?)",
    [Date.now(), process.pid, Date.now()],
  );
}

test('refreshes stale boards oldest first, never-fetched before any, and skips what it must', async () => {
  const fetched = fakeBoards();
  install('remoteok', () => listing([]));
  const mk = (identifier: string, extra: Record<string, unknown> = {}) =>
    insertSource({ type: 'greenhouse', identifier, enabled: 1, ...extra });
  mk('older', { last_ok_fetch_at: Date.now() - 12 * HOUR });
  mk('newer', { last_ok_fetch_at: Date.now() - 8 * HOUR });
  mk('never');
  mk('fresh', { last_ok_fetch_at: Date.now() - 1 * HOUR });
  mk('disabled', { enabled: 0 });
  mk('backedoff', { refresh_retry_at: Date.now() + HOUR });
  insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });

  const res = await refresher().tick();

  expect(fetched).toEqual(['never', 'older', 'newer']);
  expect(res).toMatchObject({ attempted: 3, ok: 3, failed: 0 });
  const rows = memDb.query("SELECT identifier, last_ok_fetch_at FROM sources WHERE type = 'greenhouse'").all() as {
    identifier: string;
    last_ok_fetch_at: number | null;
  }[];
  const at = Object.fromEntries(rows.map(r => [r.identifier, r.last_ok_fetch_at]));
  expect(Date.now() - at['never']!).toBeLessThan(5_000);
  expect(at['disabled']).toBeNull();
  expect(at['backedoff']).toBeNull();
});

test('the refresh window is TTL minus a margin, and the per-tick batch is bounded', async () => {
  expect(refreshCutoffMs(6 * HOUR)).toBe(5 * HOUR);
  expect(refreshCutoffMs(HOUR)).toBe(HOUR - 12 * 60_000);

  const fetched = fakeBoards();
  const a = insertSource({ type: 'greenhouse', identifier: 'a', enabled: 1 });
  insertSource({ type: 'greenhouse', identifier: 'b', enabled: 1 });
  insertSource({ type: 'greenhouse', identifier: 'c', enabled: 1 });
  memDb.run('UPDATE sources SET last_ok_fetch_at = ? WHERE id = ?', [Date.now() - 5.5 * HOUR, a]); // inside the margin

  const res = await refresher({ batchSize: 2 }).tick();
  expect(fetched.length).toBe(2);
  expect(fetched).not.toContain('a'); // 'a' is oldest-fetched but NULLs go first, so the batch cap leaves it
  expect(res.waitMs).toBeLessThan(5_000); // a full batch means more work, so the next tick comes soon
});

test('a refresh stores the board but takes no part in any search', async () => {
  fakeBoards([job('1'), job('2')]);
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  // A job a previous search already graded and stamped.
  const existing = insertJob(id, {
    url: 'https://boards.test/acme/jobs/1',
    title: 'Software Engineer',
    company: 'Acme 1',
    company_norm: 'acme 1',
    last_run_id: 5,
    l1_pass: 1,
    l1_rescued: 1,
    last_seen: 1,
  });
  const emit = spyOn(bus, 'emit');
  const runsBefore = (memDb.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n;

  await refresher().tick();

  expect(emit).not.toHaveBeenCalled();
  emit.mockRestore();
  expect((memDb.query('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(runsBefore);

  const seen = byUrl('https://boards.test/acme/jobs/1');
  expect(seen).toMatchObject({ id: existing, last_run_id: 5, l1_pass: 1 });
  expect(seen.last_seen).toBeGreaterThan(1);
  expect(memDb.query('SELECT l1_rescued FROM jobs WHERE id = ?').get(existing)).toEqual({ l1_rescued: 1 });
  // A new posting arrives unevaluated and in no run until a scan grades it.
  expect(byUrl('https://boards.test/acme/jobs/2')).toMatchObject({ last_run_id: null, l1_pass: 0, l1_reasons: null });
  expect(memDb.query('SELECT COUNT(*) AS n FROM board_sightings WHERE source_id = ?').get(id)).toEqual({ n: 2 });
  expect(sourceRow(id)).toMatchObject({ last_status: 'ok', last_error: null, refresh_failures: 0 });
  expect(sourceRow(id).last_ok_fetch_at).not.toBeNull();
});

test('a scan after a refresh serves the board from cache and grades what the refresh stored', async () => {
  const fetched = fakeBoards([job('1'), job('2', { title: 'Account Executive' })]);
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  await refresher().tick();
  expect(fetched.length).toBe(1);

  const runId = (memDb.query('INSERT INTO runs (started_at, sources_total) VALUES (0, 1) RETURNING id').get() as { id: number }).id;
  const source = memDb
    .query('SELECT id, type, identifier, display_name, enabled, config_json, last_ok_fetch_at FROM sources WHERE id = ?')
    .get(id) as never;
  await scan.runScan(runId, [source], NL_OK as Criteria);

  expect(fetched.length).toBe(1); // cache hit, no second fetch
  expect(byUrl('https://boards.test/acme/jobs/1')).toMatchObject({ last_run_id: runId, l1_pass: 1 });
  expect(byUrl('https://boards.test/acme/jobs/2')).toMatchObject({ last_run_id: runId, l1_pass: 0 });
});

test('a real edit seen by a refresh clears the verdict and embedding like a live fetch, an unchanged one keeps them', async () => {
  let title = 'Software Engineer';
  install('greenhouse', () => listing([job('1', { title })]));
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();
  await r.tick();

  const url = 'https://boards.test/acme/jobs/1';
  memDb.run(
    `UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1, embedding = x'00', status = 'shortlist' WHERE url = ?`,
    [url],
  );
  stale(id);
  await r.tick(); // same content
  expect(byUrl(url).l2_verdict_json).not.toBeNull();
  expect(byUrl(url).embedding).not.toBeNull();

  title = 'Staff Software Engineer';
  stale(id);
  await r.tick();
  const edited = byUrl(url);
  expect(edited).toMatchObject({ title: 'Staff Software Engineer', status: 'shortlist', l2_verdict_json: null, embedding: null });
});

test('a job dropped from the board stops being open once the refresh completes', async () => {
  let jobs = [job('1'), job('2')];
  install('greenhouse', () => listing(jobs));
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();
  await r.tick();
  const open = () =>
    (memDb.query('SELECT COUNT(*) AS n FROM board_sightings WHERE source_id = ? AND seen_at >= ?').get(id, sourceRow(id).last_ok_fetch_at) as { n: number }).n;
  expect(open()).toBe(2);

  jobs = [job('1')];
  await new Promise(r => setTimeout(r, 5));
  stale(id);
  await r.tick();
  expect(open()).toBe(1);
});

test('does nothing while a scan holds the lock', async () => {
  const fetched = fakeBoards();
  insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  lockScan();

  const res = await refresher().tick();

  expect(res).toMatchObject({ attempted: 0, idleReason: 'scan-running' });
  expect(fetched).toEqual([]);
});

test('a scan starting mid-board aborts the refresh: nothing is written, the board stays stale, no failure is recorded', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let reachedGate!: () => void;
  const atGate = new Promise<void>(resolve => (reachedGate = resolve));
  install('greenhouse', async function* () {
    yield job('1');
    reachedGate();
    await gate;
    yield job('2');
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const before = Date.now() - 10 * HOUR;
  stale(id, 10);

  const ticking = refresher().tick();
  await atGate;
  const token = scan.tryAcquireScanLock(); // the user searches while the board is in flight
  expect(token).not.toBeNull();
  release();
  const res = await ticking;

  expect(res).toMatchObject({ attempted: 1, ok: 0, failed: 0, aborted: 1 });
  expect(jobRows()).toEqual([]);
  expect(sourceRow(id)).toMatchObject({ last_status: null, refresh_failures: 0, refresh_retry_at: null });
  expect(sourceRow(id).last_ok_fetch_at).toBeLessThan(before + HOUR);
  scan.releaseScanLock(token!);
});

test('an aborted large board keeps what whole chunks it already wrote but is not marked fresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let reachedGate!: () => void;
  const atGate = new Promise<void>(resolve => (reachedGate = resolve));
  install('greenhouse', async function* () {
    for (let i = 0; i < 250; i++) {
      if (i === 220) {
        reachedGate();
        await gate;
      }
      yield job(`n${i}`, { title: `Engineer ${i}`, company: `Company${i} Labs` });
    }
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'big', enabled: 1 });

  const ticking = refresher().tick();
  await atGate;
  lockScan();
  release();
  await ticking;

  expect(jobRows().length).toBe(200); // the first full chunk committed, the rest never started
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
});

test('cancelInFlight (clear-jobs, toggle off) aborts without recording a failure', async () => {
  let cancelled!: () => void;
  const waiting = new Promise<void>(resolve => (cancelled = resolve));
  let started!: () => void;
  const running = new Promise<void>(resolve => (started = resolve));
  install('greenhouse', async function* (this: unknown) {
    started();
    await waiting;
    yield job('1');
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();

  const ticking = r.tick();
  await running;
  expect(r.getStatus().refreshing).toEqual(['Acme']);
  r.cancelInFlight();
  cancelled();
  const res = await ticking;

  expect(res.aborted).toBe(1);
  expect(sourceRow(id)).toMatchObject({ last_ok_fetch_at: null, last_status: null, refresh_failures: 0 });
});

test('a failing board records the error like a scan, stays stale, and backs off exponentially', async () => {
  let calls = 0;
  install('greenhouse', () => {
    calls++;
    throw new Error('HTTP 503');
  });
  const old = Date.now() - 9 * HOUR;
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1, last_ok_fetch_at: old });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const r = refresher();

  const first = await r.tick();
  expect(first).toMatchObject({ attempted: 1, failed: 1 });
  let row = sourceRow(id);
  expect(row).toMatchObject({ last_status: 'http-error', last_error: 'HTTP 503', refresh_failures: 1, last_ok_fetch_at: old });
  expect(row.refresh_retry_at! - Date.now()).toBeGreaterThan(failureBackoffMs(1) - 5_000);
  expect(row.refresh_retry_at! - Date.now()).toBeLessThanOrEqual(failureBackoffMs(1));

  await r.tick(); // still backed off
  expect(calls).toBe(1);

  memDb.run('UPDATE sources SET refresh_retry_at = ? WHERE id = ?', [Date.now() - 1, id]);
  await r.tick();
  expect(calls).toBe(2);
  row = sourceRow(id);
  expect(row.refresh_failures).toBe(2);
  expect(row.refresh_retry_at! - Date.now()).toBeGreaterThan(failureBackoffMs(2) - 5_000);

  expect(failureBackoffMs(1)).toBe(15 * 60_000);
  expect(failureBackoffMs(3)).toBe(60 * 60_000);
  expect(failureBackoffMs(40)).toBe(24 * HOUR);

  // One line per failure class, not per board.
  expect(errors.mock.calls.filter(c => String(c[0]).includes('[refresh:http-error]')).length).toBe(2);
  errors.mockRestore();
});

test('a later success resets the failure count', async () => {
  let fail = true;
  install('greenhouse', () => {
    if (fail) throw new Error('boom');
    return listing([job('1')]);
  });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();
  await r.tick();
  expect(sourceRow(id).refresh_failures).toBe(1);

  fail = false;
  memDb.run('UPDATE sources SET refresh_retry_at = NULL WHERE id = ?', [id]);
  await r.tick();
  expect(sourceRow(id)).toMatchObject({ refresh_failures: 0, refresh_retry_at: null, last_status: 'ok' });
  errors.mockRestore();
});

test('a timeout is recorded as such and does not advance freshness', async () => {
  install('greenhouse', async function* () {
    await new Promise(r => setTimeout(r, 200));
    yield job('1');
  });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });

  const res = await refresher({ sourceDeadlineMs: 30 }).tick();
  await new Promise(r => setTimeout(r, 250)); // let the late adapter finish and hit the abort check

  expect(res.failed).toBe(1);
  expect(sourceRow(id)).toMatchObject({ last_status: 'timeout', last_ok_fetch_at: null, refresh_failures: 1 });
  expect(jobRows()).toEqual([]);
  errors.mockRestore();
});

test('a 429 rests the whole host without counting against the board, other hosts carry on', async () => {
  const fetched: string[] = [];
  install('greenhouse', ctx => {
    fetched.push(ctx.config['identifier'] as string);
    throw new HttpStatusError(429, null, 'HTTP 429');
  });
  install('ashby', ctx => {
    fetched.push(`ashby:${ctx.config['identifier']}`);
    return listing([]);
  });
  insertSource({ type: 'greenhouse', identifier: 'g1', enabled: 1 });
  insertSource({ type: 'greenhouse', identifier: 'g2', enabled: 1 });
  insertSource({ type: 'ashby', identifier: 'a1', enabled: 1 });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const r = refresher();

  const first = await r.tick();
  // One greenhouse board got the 429; the other was dropped from the batch rather than hammering the host.
  expect(fetched.filter(f => f.startsWith('g')).length).toBe(1);
  expect(fetched).toContain('ashby:a1');
  expect(first.failed).toBe(1);
  const limited = memDb.query("SELECT id FROM sources WHERE last_status = 'rate-limited'").all() as { id: number }[];
  expect(limited.length).toBe(1);
  expect(sourceRow(limited[0]!.id)).toMatchObject({ refresh_failures: 0 });

  // The rested host is left out of later ticks entirely.
  await r.tick();
  expect(fetched.filter(f => f.startsWith('g')).length).toBe(1);
  errors.mockRestore();
});

test('a board that needs search keywords is skipped quietly and retried at most daily', async () => {
  install('workable', ctx => {
    ctx.markQueryDependent?.();
    throw new Error('requires a search keyword');
  });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const id = insertSource({ type: 'workable', identifier: 'bigco', enabled: 1, last_status: 'ok' });
  const r = refresher();

  await r.tick();

  const row = sourceRow(id);
  expect(row).toMatchObject({ last_ok_fetch_at: null, last_status: 'ok', last_error: null, refresh_failures: 0 });
  expect(row.refresh_retry_at! - Date.now()).toBeGreaterThan(23 * HOUR);
  expect(r.getStatus().lastError).toBeNull();
  errors.mockRestore();
});

test('a fetch that marked itself query-dependent does not make the board fresh, and is not retried every tick', async () => {
  let fetches = 0;
  install('greenhouse', ctx => {
    fetches++;
    ctx.markQueryDependent?.();
    return listing([job('1')]);
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();
  await r.tick();
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
  expect(sourceRow(id).refresh_retry_at! - Date.now()).toBeGreaterThan(23 * HOUR);
  await r.tick();
  expect(fetches).toBe(1);
});

test('does not start new work when switched off or when the board cache is off', async () => {
  const fetched = fakeBoards();
  insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });
  const r = refresher();

  memDb.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('board_refresh', '{"enabled":false}', 0)`);
  expect(await r.tick()).toMatchObject({ attempted: 0, idleReason: 'off' });

  memDb.run(`DELETE FROM settings WHERE key = 'board_refresh'`);
  memDb.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('board_cache', '{"ttlHours":0}', 0)`);
  expect(await r.tick()).toMatchObject({ attempted: 0, idleReason: 'cache-off' });

  expect(fetched).toEqual([]);
});

test('respects the concurrency cap and the per-host pacing gap', async () => {
  let active = 0;
  let peak = 0;
  const starts: number[] = [];
  install('greenhouse', async function* () {
    starts.push(Date.now());
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 30));
    active--;
    yield job(`${starts.length}`);
  });
  for (const id of ['a', 'b', 'c', 'd']) insertSource({ type: 'greenhouse', identifier: id, enabled: 1 });

  await new BoardRefresher({ concurrency: 2, paceMs: () => 60 }).tick();

  expect(peak).toBeLessThanOrEqual(2);
  expect(starts.length).toBe(4);
  for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(30); // 60ms minus its 25% jitter, minus timer slop
});

test('the loop refreshes in the background, idles when nothing is stale, and stops cleanly', async () => {
  const fetched = fakeBoards();
  insertSource({ type: 'greenhouse', identifier: 'a', enabled: 1 });
  insertSource({ type: 'greenhouse', identifier: 'b', enabled: 1 });
  const r = refresher({ startDelayMs: 0, idleMs: 20, busyGapMs: 5 });

  r.start();
  const deadline = Date.now() + 3_000;
  while (fetched.length < 2 && Date.now() < deadline) await new Promise(res => setTimeout(res, 10));
  expect(fetched.sort()).toEqual(['a', 'b']);
  expect(r.getStatus()).toMatchObject({ running: true });

  await new Promise(res => setTimeout(res, 100)); // several idle ticks
  expect(fetched.length).toBe(2); // fresh boards are not refetched
  await r.stop();
  expect(r.getStatus().running).toBe(false);
  expect(r.getStatus().refreshing).toEqual([]);
});

test('status counts fresh, stale and backed-off boards and reports the last tick and error', async () => {
  fakeBoards();
  insertSource({ type: 'greenhouse', identifier: 'fresh', enabled: 1, last_ok_fetch_at: Date.now() - HOUR });
  insertSource({ type: 'greenhouse', identifier: 'stale', enabled: 1, last_ok_fetch_at: Date.now() - 20 * HOUR });
  insertSource({ type: 'greenhouse', identifier: 'backedoff', enabled: 1, refresh_retry_at: Date.now() + HOUR });
  insertSource({ type: 'greenhouse', identifier: 'off', enabled: 0 });
  insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });
  const r = refresher();

  expect(r.getStatus()).toMatchObject({
    enabled: true,
    boards: { total: 3, fresh: 1, stale: 2, backedOff: 1 },
    lastTickAt: null,
    lastError: null,
  });
  await r.tick();
  const status = r.getStatus();
  expect(status.lastTick).toEqual({ attempted: 1, ok: 1, failed: 0, aborted: 0 });
  expect(status.lastTickAt).not.toBeNull();
  expect(status.boards).toMatchObject({ fresh: 2, stale: 1 });
});

test('GET and PUT /api/settings/board-refresh read and toggle the setting, defaulting to on', async () => {
  const initial = await (await req('/api/settings/board-refresh')).json() as { settings: { enabled: boolean }; status: { enabled: boolean; boards: unknown } };
  expect(initial.settings).toEqual({ enabled: true });
  expect(initial.status.boards).toMatchObject({ total: 0 });

  const off = await req('/api/settings/board-refresh', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  expect(off.status).toBe(200);
  const after = await (await req('/api/settings/board-refresh')).json() as { settings: { enabled: boolean }; status: { enabled: boolean } };
  expect(after.settings.enabled).toBe(false);
  expect(after.status.enabled).toBe(false);

  const bad = await req('/api/settings/board-refresh', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' }),
  });
  expect(bad.status).toBe(400);
});

test('editing a board while it is being refreshed aborts the refresh instead of stamping it fresh', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  let reachedGate!: () => void;
  const atGate = new Promise<void>(resolve => (reachedGate = resolve));
  install('greenhouse', async function* () {
    yield job('1');
    reachedGate();
    await gate;
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', enabled: 1 });

  const ticking = refresher().tick();
  await atGate;
  // What PATCH /api/sources/:id does for a new display name or config.
  memDb.run("UPDATE sources SET display_name = 'Renamed', last_ok_fetch_at = NULL WHERE id = ?", [id]);
  release();
  const res = await ticking;

  expect(res).toMatchObject({ ok: 0, failed: 0, aborted: 1 });
  expect(sourceRow(id)).toMatchObject({ last_ok_fetch_at: null, last_status: null, refresh_failures: 0 });
  expect(jobRows()).toEqual([]); // the final chunk rolled back with the refused stamp
});

test('cancelInFlight(sourceId) aborts only that board', async () => {
  let started!: () => void;
  const running = new Promise<void>(resolve => (started = resolve));
  const signals = new Map<string, AbortSignal>();
  install('greenhouse', async function* (ctx) {
    signals.set(ctx.config['identifier'] as string, ctx.abortSignal);
    if (signals.size === 2) started();
    await new Promise(r => setTimeout(r, 300));
    yield job('x');
  });
  const a = insertSource({ type: 'greenhouse', identifier: 'a', display_name: 'A', enabled: 1 });
  insertSource({ type: 'greenhouse', identifier: 'b', display_name: 'B', enabled: 1 });
  const r = refresher({ concurrency: 2 });

  const ticking = r.tick();
  await running;
  r.cancelInFlight(a);
  expect(signals.get('a')!.aborted).toBe(true);
  expect(signals.get('b')!.aborted).toBe(false);
  await ticking;
});

test('status reports hosts resting after a 429', async () => {
  install('greenhouse', () => {
    throw new HttpStatusError(429, null, 'HTTP 429');
  });
  insertSource({ type: 'greenhouse', identifier: 'g', enabled: 1 });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const r = refresher();
  await r.tick();
  expect(r.getStatus().restingHosts).toEqual(['greenhouse']);
  errors.mockRestore();
});

test('a 429 on a per-tenant vendor (recruitee) rests the whole vendor, not just that tenant', async () => {
  const fetched: string[] = [];
  install('recruitee', ctx => {
    fetched.push(ctx.config['identifier'] as string);
    throw new HttpStatusError(429, null, 'HTTP 429');
  });
  insertSource({ type: 'recruitee', identifier: 'r1', enabled: 1 });
  insertSource({ type: 'recruitee', identifier: 'r2', enabled: 1 });
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const r = refresher();
  await r.tick();
  expect(fetched.length).toBe(1);
  expect(r.getStatus().restingHosts).toEqual(['recruitee']);
  errors.mockRestore();
});

test('the real greenhouse adapter forwards the abort signal to fetch', async () => {
  registry.greenhouse = originals.greenhouse;
  const realFetch = globalThis.fetch;
  let seen: AbortSignal | undefined;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = init.signal ?? undefined;
    return new Response(JSON.stringify({ jobs: [] }));
  }) as unknown as typeof fetch;
  try {
    const ctrl = new AbortController();
    const ctx = {
      sourceId: 1,
      config: { identifier: 'acme', display_name: 'Acme' },
      emitProgress: () => {},
      abortSignal: ctrl.signal,
    } as SourceContext;
    for await (const _ of registry.greenhouse!.fetch(ctx)) void _;
    expect(seen).toBeDefined();
    ctrl.abort();
    expect(seen!.aborted).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('PATCH /api/sources/:id cancels that board in-flight refresh on the shared refresher', async () => {
  const { boardRefresher } = await import(`${REPO}/src/runner/board-refresher.ts`);
  let started!: () => void;
  const running = new Promise<void>(resolve => (started = resolve));
  let signal: AbortSignal | undefined;
  install('greenhouse', async function* (ctx) {
    signal = ctx.abortSignal;
    started();
    await new Promise(r => setTimeout(r, 100));
    yield job('1');
  });
  const id = insertSource({ type: 'greenhouse', identifier: 'acme', display_name: 'Acme', enabled: 1 });

  const ticking = boardRefresher.tick();
  await running;
  const res = await req(`/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'Acme Corp' }),
  });
  expect(res.status).toBe(200);
  expect(signal!.aborted).toBe(true);
  await ticking;
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
});
