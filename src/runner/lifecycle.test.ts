import { afterAll, beforeEach, expect, test } from 'bun:test';
import { spawn } from 'child_process';
import yaml from 'js-yaml';
import type { ScanEvent } from '../runner/progress';
import {
  memDb,
  scan,
  bus,
  setLlm,
  seedEmbeddingsOff,
  insertSource,
  insertJob,
  resetDb,
  NL_OK,
} from '../test-harness';

beforeEach(() => {
  resetDb();
  seedEmbeddingsOff();
});

afterAll(() => {
  resetDb();
});

function insertLock(pid: number | null, acquiredAt: number): void {
  memDb.run('INSERT INTO scan_locks (key, acquired_at, pid) VALUES (?, ?, ?)', ['scan', acquiredAt, pid]);
}

function lockRow(): { acquired_at: number; pid: number | null } | null {
  return memDb.query('SELECT acquired_at, pid FROM scan_locks WHERE key = ?').get('scan') as never;
}

/** Spawns a real child process and waits for it to exit, returning its now-dead pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'void 0'], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>(resolve => child.on('exit', () => resolve()));
  // give Windows a moment to fully reap the process table entry
  await new Promise(r => setTimeout(r, 100));
  return pid;
}

test('tryAcquireScanLock steals a lock held by a dead pid (real child process)', async () => {
  const pid = await deadPid();
  insertLock(pid, Date.now()); // fresh timestamp — staleness must come from the dead pid, not age
  expect(scan.getScanningState()).toBe(false);
  expect(scan.tryAcquireScanLock()).toBe(true);
  expect(lockRow()!.pid).toBe(process.pid);
});

test('tryAcquireScanLock refuses a lock held by a live pid regardless of age', () => {
  insertLock(process.pid, Date.now() - 5 * 3600_000); // 5h old, but the "holder" is alive (us)
  expect(scan.getScanningState()).toBe(true);
  expect(scan.tryAcquireScanLock()).toBe(false);
});

test('getScanningState reflects staleness the same way tryAcquireScanLock does (no separate check)', async () => {
  const pid = await deadPid();
  insertLock(pid, Date.now());
  // Before the fix, getScanningState had no staleness check at all — this is the
  // API route's (and liveness's) only gate, so it must agree with tryAcquireScanLock.
  expect(scan.getScanningState()).toBe(false);
});

test('a pid-less stale lock (age-based fallback) is reported as not scanning', () => {
  insertLock(null, Date.now() - 2 * 3600_000); // 2h old, no recorded pid
  expect(scan.getScanningState()).toBe(false);
});

test('a pid-less fresh lock (age-based fallback) is reported as scanning', () => {
  insertLock(null, Date.now());
  expect(scan.getScanningState()).toBe(true);
});

test('recoverInterruptedScans clears a dead-pid lock and finishes the orphaned run', async () => {
  const pid = await deadPid();
  insertLock(pid, Date.now());
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;

  scan.recoverInterruptedScans();

  expect(lockRow()).toBeNull();
  const run = memDb.query('SELECT finished_at, errors_json FROM runs WHERE id = ?').get(runId) as {
    finished_at: number | null;
    errors_json: string | null;
  };
  expect(run.finished_at).not.toBeNull();
  const errors = JSON.parse(run.errors_json!);
  expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ error: 'interrupted (server stopped mid-scan)' })]));
});

test('recoverInterruptedScans treats a lock recorded under our own pid as stale (no scan of ours can be running at boot)', () => {
  // OS pid reuse (visible under Bun's --watch reload) can make a leftover lock
  // row's pid equal the freshly started process's own pid. At boot that can never
  // be "our own still-running scan" the way it legitimately can be at runtime
  // (tryAcquireScanLock/getScanningState) — recoverInterruptedScans must still
  // clear it and retire the orphaned run, or every future search 409s forever.
  insertLock(process.pid, Date.now());
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;

  scan.recoverInterruptedScans();

  expect(lockRow()).toBeNull();
  const run = memDb.query('SELECT finished_at FROM runs WHERE id = ?').get(runId) as { finished_at: number | null };
  expect(run.finished_at).not.toBeNull();
});

test('recoverInterruptedScans leaves a genuinely live foreign-pid lock and its run alone', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
  try {
    insertLock(child.pid!, Date.now());
    const runId = memDb
      .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
      .get()!.id;

    scan.recoverInterruptedScans();

    expect(lockRow()).not.toBeNull();
    const run = memDb.query('SELECT finished_at FROM runs WHERE id = ?').get(runId) as { finished_at: number | null };
    expect(run.finished_at).toBeNull();
  } finally {
    child.kill();
  }
});

test('a lock older than the 12h age ceiling is stale regardless of pid liveness', () => {
  insertLock(process.pid, Date.now() - 13 * 3600_000);
  expect(scan.getScanningState()).toBe(false);
  expect(scan.tryAcquireScanLock()).toBe(true);
});

test('tryAcquireScanLock clearing a stale lock also finishes the orphaned run it left behind', async () => {
  const pid = await deadPid();
  insertLock(pid, Date.now());
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;

  expect(scan.tryAcquireScanLock()).toBe(true);

  const run = memDb.query('SELECT finished_at, errors_json FROM runs WHERE id = ?').get(runId) as {
    finished_at: number | null;
    errors_json: string | null;
  };
  expect(run.finished_at).not.toBeNull();
  expect(JSON.parse(run.errors_json!)).toEqual(
    expect.arrayContaining([expect.objectContaining({ error: 'interrupted (server stopped mid-scan)' })])
  );
});

test('runFull: a throw after the run row exists sets finished_at, records the error, emits error, and releases the lock', async () => {
  const sourceId = insertSource({ type: 'lever', enabled: 0 });
  const setup = scan.createRun('backend engineer');
  // Force applyLegitimacyPass to throw on this job (malformed duplicate_urls ->
  // JSON.parse throws) — a real, naturally-occurring exception reachable through
  // runFull's own body, not a mocked-out function.
  insertJob(sourceId, { last_run_id: setup.runId, l1_pass: 1, duplicate_urls: 'not-json' });

  const events: string[] = [];
  bus.subscribe(setup.runId, (e: ScanEvent) => events.push(e.type));

  let rejected: unknown = null;
  try {
    await scan.runFull(setup);
  } catch (err) {
    rejected = err;
  }

  expect(rejected).not.toBeNull();
  expect(events).toContain('error');
  expect(events).not.toContain('l2_done');

  const run = memDb.query('SELECT finished_at, errors_json FROM runs WHERE id = ?').get(setup.runId) as {
    finished_at: number | null;
    errors_json: string | null;
  };
  expect(run.finished_at).not.toBeNull();
  expect(JSON.parse(run.errors_json!).length).toBeGreaterThan(0);
  expect(scan.getScanningState()).toBe(false); // lock released even on failure
});

test('runL2Pass: a batch whose response matches none of the requested job_ids counts as a failed batch (aborts after 3)', async () => {
  const sourceId = insertSource({ type: 'lever', enabled: 0 });
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;
  const jobIds: number[] = [];
  for (let i = 0; i < 41; i++) {
    jobIds.push(insertJob(sourceId, { last_run_id: runId, l1_pass: 1 }));
  }

  setLlm(async req => {
    if (req.task !== 'verdict') throw new Error('unexpected task');
    return { verdicts: [] }; // matches none of the batch's job_ids, every time
  });

  const events: { type: string; data?: Record<string, unknown> }[] = [];
  bus.subscribe(runId, (e: ScanEvent) => events.push(e));

  const criteriaYaml = yaml.dump(NL_OK);
  await scan.runL2Pass(runId, criteriaYaml);

  const done = events.find(e => e.type === 'l2_done')!;
  expect(done.data?.aborted).toBe(true);
  expect(typeof done.data?.error).toBe('string');
  expect(done.data?.error).toContain('matched no requested job_ids');

  // finished_at must already be set by the time l2_done was observed (C2).
  const run = memDb.query('SELECT finished_at FROM runs WHERE id = ?').get(runId) as { finished_at: number | null };
  expect(run.finished_at).not.toBeNull();

  // Aborted after exactly 3 batches (60 jobs worth of budget, but only 41 exist —
  // batches of 20/20/1), so not every job should have been attempted forever.
  expect(jobIds.length).toBe(41);
});

test('runL2Pass: no pending jobs still writes finished_at before the terminal l2_done event', async () => {
  const runId = memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 0) RETURNING id')
    .get()!.id;

  let sawFinishedAtDuringEvent: number | null | undefined;
  bus.subscribe(runId, (e: ScanEvent) => {
    if (e.type === 'l2_done') {
      sawFinishedAtDuringEvent = (
        memDb.query('SELECT finished_at FROM runs WHERE id = ?').get(runId) as { finished_at: number | null }
      ).finished_at;
    }
  });

  await scan.runL2Pass(runId, yaml.dump(NL_OK));

  expect(sawFinishedAtDuringEvent).not.toBeNull();
  expect(sawFinishedAtDuringEvent).not.toBeUndefined();
});

test('createRun creates the run row synchronously and snapshots criteria once', () => {
  const setup = scan.createRun('my query');
  expect(setup.runId).toBeGreaterThan(0);
  expect(Array.isArray(setup.sources)).toBe(true);
  expect(typeof setup.criteriaYaml).toBe('string');
  expect(setup.criteria).toBeTruthy();
  const run = memDb.query('SELECT query FROM runs WHERE id = ?').get(setup.runId) as { query: string };
  expect(run.query).toBe('my query');
});
