import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import type { Criteria } from '../core/filter';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import type { ScanEvent } from './progress';
import { REPO, memDb, scan, bus, insertSource, resetDb, req, NL_OK } from '../test-harness';

const { adapterRegistry } = await import(`${REPO}/src/sources/index.ts`);
const registry = adapterRegistry as Record<string, SourceAdapter>;
const originalGreenhouse = registry.greenhouse;
const originalRemoteok = registry.remoteok;

const DAY = 86_400_000;
const HOUR = 3_600_000;

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  registry.greenhouse = originalGreenhouse;
  registry.remoteok = originalRemoteok;
});

afterAll(() => {
  resetDb();
});

type SourceRow = {
  id: number;
  type: string;
  identifier: string;
  display_name: string;
  enabled: number;
  config_json: string | null;
  last_ok_fetch_at: number | null;
};

function newRun(): number {
  return memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 1) RETURNING id')
    .get()!.id;
}

/** Re-read from the DB on every call, as createRun does, so freshness reflects the last scan. */
function sourceRow(id: number): SourceRow {
  return memDb
    .query('SELECT id, type, identifier, display_name, enabled, config_json, last_ok_fetch_at FROM sources WHERE id = ?')
    .get(id) as SourceRow;
}

function install(type: 'greenhouse' | 'remoteok', adapter: Partial<SourceAdapter> & { fetch: SourceAdapter['fetch'] }) {
  registry[type] = { type, ...adapter } as SourceAdapter;
}

/** A greenhouse adapter yielding `jobs`, counting fetches. */
function fakeBoard(jobs: Job[], extra: Partial<SourceAdapter> = {}) {
  const state = { fetches: 0 };
  install('greenhouse', {
    fetch() {
      state.fetches++;
      return (async function* () {
        for (const j of jobs) yield j;
      })();
    },
    ...extra,
  });
  return state;
}

async function runWith(sourceId: number, criteria: Criteria = NL_OK as Criteria) {
  const runId = newRun();
  const events: ScanEvent[] = [];
  const unsub = bus.subscribe(runId, (e: ScanEvent) => events.push(e));
  await scan.runScan(runId, [sourceRow(sourceId)], criteria);
  unsub();
  return { runId, events };
}

type JobRow = {
  id: number;
  url: string;
  last_run_id: number | null;
  last_seen: number;
  l1_pass: number;
  l1_reasons: string | null;
  employment_type: string | null;
  l2_verdict_json: string | null;
  jd_text: string | null;
};
const jobRows = () => memDb.query('SELECT * FROM jobs ORDER BY url').all() as JobRow[];
const byUrl = (url: string) => jobRows().find(j => j.url === url)!;
const runRow = (id: number) =>
  memDb.query('SELECT jobs_found, jobs_new, jobs_l1_pass, errors_json FROM runs WHERE id = ?').get(id) as {
    jobs_found: number;
    jobs_new: number;
    jobs_l1_pass: number;
    errors_json: string | null;
  };

const makeStale = (id: number) =>
  memDb.run('UPDATE sources SET last_ok_fetch_at = ? WHERE id = ?', [Date.now() - 7 * HOUR, id]);

// A distinct company per job keeps fuzzy dedup (same company and role) from folding fixtures together.
const job = (n: string, extra: Partial<Job> = {}): Job => ({
  url: `https://boards.test/acme/jobs/${n}`,
  title: 'Software Engineer',
  company: `Acme ${n}`,
  ...extra,
});

test('a fresh board is evaluated from stored jobs without a fetch, and stamped like a live one', async () => {
  const board = fakeBoard([job('1'), job('2', { title: 'Account Executive' })]);
  const id = insertSource({ type: 'greenhouse', enabled: 1 });

  const first = await runWith(id);
  expect(board.fetches).toBe(1);
  expect(sourceRow(id).last_ok_fetch_at).not.toBeNull();

  const second = await runWith(id);
  expect(board.fetches).toBe(1); // served from cache
  expect(byUrl('https://boards.test/acme/jobs/1')).toMatchObject({ last_run_id: second.runId, l1_pass: 1 });
  expect(byUrl('https://boards.test/acme/jobs/2')).toMatchObject({ last_run_id: second.runId, l1_pass: 0 });
  expect(JSON.parse(byUrl('https://boards.test/acme/jobs/2').l1_reasons!)).toEqual(['title missing positive keyword']);

  // Counters match what the live run reported for the same board, except nothing is new.
  expect(runRow(second.runId)).toMatchObject({ jobs_found: 2, jobs_new: 0, jobs_l1_pass: 1 });
  expect(runRow(first.runId)).toMatchObject({ jobs_found: 2, jobs_new: 2, jobs_l1_pass: 1 });

  const note = second.events.find(e => e.msg.includes('from cache'));
  expect(note?.msg).toBe('1 boards from cache, 0 fetched live');
  const done = second.events.find(e => e.type === 'scan_done');
  expect(done?.msg).toContain('1 boards from cache, 0 fetched live');
  expect(first.events.some(e => e.msg.includes('from cache'))).toBe(false);
});

test('a board older than the TTL is fetched live, and the TTL is a setting', async () => {
  const board = fakeBoard([job('1')]);
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);

  makeStale(id); // 7h > the 6h default
  await runWith(id);
  expect(board.fetches).toBe(2);

  await runWith(id); // freshly fetched, cached again
  expect(board.fetches).toBe(2);

  memDb.run(`INSERT INTO settings (key, value_json, updated_at) VALUES ('board_cache', '{"ttlHours":0}', 0)`);
  await runWith(id); // cache off
  expect(board.fetches).toBe(3);

  memDb.run(`UPDATE settings SET value_json = '{"ttlHours":24}' WHERE key = 'board_cache'`);
  makeStale(id); // 7h < 24h
  await runWith(id);
  expect(board.fetches).toBe(3);
});

test('a failed, partial or timed-out fetch never advances last_ok_fetch_at', async () => {
  const id = insertSource({ type: 'greenhouse', enabled: 1 });

  install('greenhouse', {
    fetch() {
      return (async function* (): AsyncGenerator<Job> {
        throw new Error('boom');
      })();
    },
  });
  await runWith(id);
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();

  install('greenhouse', {
    fetch() {
      return (async function* () {
        yield job('1');
        throw new Error('page 2 failed');
      })();
    },
  });
  await runWith(id);
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
  expect(jobRows()).toHaveLength(1); // the partial jobs are stored, but the board stays uncached

  install('greenhouse', {
    fetch(ctx: SourceContext) {
      return (async function* () {
        yield job('2');
        await new Promise((_, reject) => ctx.abortSignal.addEventListener('abort', () => reject(new Error('aborted'))));
      })();
    },
  });
  const runId = newRun();
  await scan.runScan(runId, [sourceRow(id)], NL_OK as Criteria, { sourceDeadlineMs: 30 });
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
  expect(memDb.query('SELECT last_status FROM sources WHERE id = ?').get(id)).toEqual({ last_status: 'timeout' });

  // A failure after a good fetch keeps the earlier timestamp rather than clearing it.
  const board = fakeBoard([job('1')]);
  await runWith(id);
  const good = sourceRow(id).last_ok_fetch_at!;
  expect(good).not.toBeNull();
  makeStale(id);
  const stale = sourceRow(id).last_ok_fetch_at!;
  install('greenhouse', {
    fetch() {
      return (async function* (): AsyncGenerator<Job> {
        throw new Error('down');
      })();
    },
  });
  await runWith(id);
  expect(sourceRow(id).last_ok_fetch_at).toBe(stale);
  expect(board.fetches).toBe(1);
});

test('jobs that dropped off the board are not resurrected by cache evaluation', async () => {
  let listing = [job('1'), job('2')];
  install('greenhouse', {
    fetch() {
      return (async function* () {
        for (const j of listing) yield j;
      })();
    },
  });
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  const first = await runWith(id);

  makeStale(id);
  await Bun.sleep(5); // last_seen and the next fetch start are millisecond stamps
  listing = [job('1')]; // job 2 closed
  const second = await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/2').last_run_id).toBe(first.runId);

  const third = await runWith(id); // cached
  expect(byUrl('https://boards.test/acme/jobs/1').last_run_id).toBe(third.runId);
  expect(byUrl('https://boards.test/acme/jobs/2').last_run_id).toBe(first.runId);
  expect(runRow(third.runId).jobs_found).toBe(1);
  expect(runRow(second.runId).jobs_found).toBe(1);
});

test('cached evaluation re-applies the current criteria and leaves L2 verdicts alone', async () => {
  fakeBoard([job('1'), job('2', { title: 'Product Designer' })]);
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);
  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"score":0.9}', l2_score = 0.9, l2_fit = 1 WHERE url LIKE '%/1'`);

  const designers: Criteria = { ...NL_OK, title: { positive: ['designer'], negative: [] } } as Criteria;
  await runWith(id, designers);
  expect(byUrl('https://boards.test/acme/jobs/1').l1_pass).toBe(0);
  expect(byUrl('https://boards.test/acme/jobs/2').l1_pass).toBe(1);
  // Invalidation on a criteria change is the scan route's job and happens before runScan.
  expect(byUrl('https://boards.test/acme/jobs/1').l2_verdict_json).toBe('{"score":0.9}');

  await runWith(id); // back to engineer
  expect(byUrl('https://boards.test/acme/jobs/1').l1_pass).toBe(1);
  expect(byUrl('https://boards.test/acme/jobs/2').l1_pass).toBe(0);
});

test('aggregators are never served from cache', async () => {
  let fetches = 0;
  install('remoteok', {
    fetch() {
      fetches++;
      return (async function* () {
        yield job('r1');
      })();
    },
  });
  const id = insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });
  memDb.run('UPDATE sources SET last_ok_fetch_at = ? WHERE id = ?', [Date.now(), id]);
  const { events } = await runWith(id);
  expect(fetches).toBe(1);
  expect(events.some(e => e.msg.includes('from cache'))).toBe(false);
});

test('employment_type is persisted and follows re-sightings without wiping the verdict', async () => {
  let type: Job['employment_type'] = 'contract';
  install('greenhouse', {
    fetch() {
      return (async function* () {
        yield job('1', { employment_type: type });
      })();
    },
  });
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/1').employment_type).toBe('contract');

  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"score":0.5}', l2_score = 0.5, l2_fit = 1`);
  makeStale(id);
  type = 'full_time';
  await runWith(id);
  const row = byUrl('https://boards.test/acme/jobs/1');
  expect(row.employment_type).toBe('full_time');
  expect(row.l2_verdict_json).toBe('{"score":0.5}');

  // A board that stops reporting a type clears it, as a live L1 would see no type.
  makeStale(id);
  type = undefined;
  await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/1').employment_type).toBeNull();
});

const NOW = Date.now();
const FIXTURES: Job[] = [
  job('a', { title: 'Backend Engineer', location: 'Remote - US', remote: true, posted_at: NOW - DAY }),
  job('b', { title: 'Senior Backend Engineer', location: 'Berlin, Germany', posted_at: NOW - 30 * DAY }),
  job('c', { title: 'Software Engineer (Contract)', location: 'London, UK', employment_type: 'contract' }),
  job('d', { title: 'Platform Engineer', location: 'Bangalore, India', employment_type: 'full_time' }),
  job('e', { title: 'Data Engineer', location: 'Remote', salary_min_usd: 60000, salary_max_usd: 80000, salary_currency: 'USD' }),
  job('f', { title: 'ML Engineer', salary_min_usd: 90000, salary_max_usd: 120000, salary_currency: 'EUR' }),
  job('g', { title: 'Engineer', company: 'Crypto Exchange Inc', jd_text: 'We do not sponsor visas for this role.' }),
  job('h', { title: 'Account Executive', location: 'Remote - Europe', jd_text: 'Sell things.' }),
  job('i', { title: 'Junior Engineer', location: 'Hybrid - Paris', remote: false }),
  job('j', { title: 'Engineer Intern', location: 'Austin, TX', employment_type: 'internship' }),
  job('k', { title: 'DevOps Engineer', location: 'Anywhere', jd_text: 'Pay is $150,000 - $180,000 per year.' }),
  job('l', { title: 'Frontend Engineer', location: '', posted_at: null }),
];

const variants: [string, Partial<Criteria>][] = [
  ['baseline', {}],
  ['title negative', { title: { positive: ['engineer'], negative: ['intern', 'junior'] } }],
  ['location allowed', { location: { remote_required: false, allowed: ['india', 'germany'], block: [], always_allow: [] } }],
  ['remote required + block', { location: { remote_required: true, allowed: ['europe'], block: ['united states'], always_allow: [] } }],
  ['salary floor', { salary_min_usd: 100000, salary_currency: 'USD' }],
  ['employment types', { employment_types: ['full_time'] }],
  ['junior seniority', { seniority: { allowed: ['junior', 'mid'] } }],
  ['exclusions', { exclude_companies: ['crypto'], industries: { include: [], exclude: ['crypto'] } }],
  ['visa sponsorship', { visa_sponsorship_required: true }],
];

test('cached L1 equals live L1 for every fixture under every criteria variant', async () => {
  fakeBoard(FIXTURES);
  const id = insertSource({ type: 'greenhouse', enabled: 1 });

  for (const [name, patch] of variants) {
    const criteria = { ...NL_OK, ...patch } as Criteria;
    memDb.run('UPDATE sources SET last_ok_fetch_at = NULL WHERE id = ?', [id]);
    const live = await runWith(id, criteria);
    const snapshot = (runId: number) =>
      jobRows().map(j => ({ url: j.url, pass: j.l1_pass, reasons: j.l1_reasons, stamped: j.last_run_id === runId }));
    const liveRows = snapshot(live.runId);
    const liveCounters = runRow(live.runId);

    const cached = await runWith(id, criteria);
    const cachedRows = snapshot(cached.runId);
    const cachedCounters = runRow(cached.runId);

    expect(liveRows.every(r => r.stamped)).toBe(true);
    expect({ name, rows: cachedRows }).toEqual({ name, rows: liveRows });
    expect({ name, found: cachedCounters.jobs_found, pass: cachedCounters.jobs_l1_pass }).toEqual({
      name,
      found: liveCounters.jobs_found,
      pass: liveCounters.jobs_l1_pass,
    });
    expect(cachedCounters.jobs_new).toBe(0);
  }
  // The fixtures must actually exercise both outcomes, or the comparison proves nothing.
  const passes = jobRows().map(j => j.l1_pass);
  expect(passes).toContain(1);
  expect(passes).toContain(0);
});

test('cached survivors still missing a JD are enriched through the live pipeline, within the budget', async () => {
  const jobs = Array.from({ length: 45 }, (_, i) => job(`e${i}`));
  const enriched: string[] = [];
  const board = fakeBoard(jobs, {
    async enrich(j: Job) {
      enriched.push(j.url);
      return { jd_text: 'Backend work in Go.' };
    },
  });
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);
  expect(enriched).toHaveLength(40);
  const fetchedAt = sourceRow(id).last_ok_fetch_at;
  const lastSeen = () => memDb.query('SELECT url, last_seen FROM jobs ORDER BY url').all();
  const seenBefore = lastSeen();
  await Bun.sleep(5);

  enriched.length = 0;
  const second = await runWith(id);
  expect(board.fetches).toBe(1); // cached, but the 5 left without a JD are enriched now
  expect(enriched).toHaveLength(5);
  expect(jobRows().every(j => j.jd_text === 'Backend work in Go.')).toBe(true);
  expect(runRow(second.runId)).toMatchObject({ jobs_found: 45, jobs_l1_pass: 45, jobs_new: 0 });
  expect(jobRows().every(j => j.last_run_id === second.runId)).toBe(true);
  // The cache bookkeeping belongs to the fetch, not to enrichment.
  expect(sourceRow(id).last_ok_fetch_at).toBe(fetchedAt);
  // Nothing was fetched, so neither the enriched jobs nor the rest were re-sighted.
  expect(lastSeen()).toEqual(seenBefore);
});

test('a pass already claimed by this run is not downgraded by a cached fail', async () => {
  fakeBoard([job('1', { title: 'Account Executive' })]);
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);

  const runId = newRun();
  memDb.run(`UPDATE jobs SET last_run_id = ?, l1_pass = 1, l1_reasons = NULL`, [runId]);
  await scan.runScan(runId, [sourceRow(id)], NL_OK as Criteria);
  expect(byUrl('https://boards.test/acme/jobs/1')).toMatchObject({ l1_pass: 1, last_run_id: runId });
});

test('PATCHing a board config drops its cache', async () => {
  const id = insertSource({ type: 'workday', identifier: 'acme', config_json: JSON.stringify({ dc: 'wd5', site: 'A' }) });
  memDb.run('UPDATE sources SET last_ok_fetch_at = 5 WHERE id = ?', [id]);
  const res = await req(`/api/sources/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config_json: { dc: 'wd5', site: 'B' } }),
  });
  expect(res.status).toBe(200);
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();

  // The company name is stored on every job and feeds the exclude rule, so a rename drops it too.
  const patch = (body: unknown) =>
    req(`/api/sources/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  memDb.run('UPDATE sources SET last_ok_fetch_at = 5 WHERE id = ?', [id]);
  await patch({ display_name: 'Renamed' });
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();

  // Toggling or re-saving the same name leaves it alone.
  memDb.run('UPDATE sources SET last_ok_fetch_at = 5 WHERE id = ?', [id]);
  await patch({ display_name: 'Renamed', enabled: false });
  expect(sourceRow(id).last_ok_fetch_at).toBe(5);
});

test('a fetch that depended on the search keywords is never cached', async () => {
  let fetches = 0;
  install('greenhouse', {
    fetch(ctx: SourceContext) {
      fetches++;
      ctx.markQueryDependent?.(); // Workable's ?query= fallback for accounts too large for the default feed
      return (async function* () {
        yield job('1');
      })();
    },
  });
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);
  expect(sourceRow(id).last_ok_fetch_at).toBeNull();
  expect(memDb.query('SELECT last_status FROM sources WHERE id = ?').get(id)).toEqual({ last_status: 'ok' });

  const second = await runWith(id);
  expect(fetches).toBe(2);
  expect(second.events.some(e => e.msg.includes('from cache'))).toBe(false);
});

test('a posting another source inserted first is still evaluated for the board that lists it', async () => {
  const shared = 'https://boards.test/acme/jobs/shared';
  let aggregatorLists = true;
  install('remoteok', {
    fetch() {
      return (async function* () {
        if (aggregatorLists) yield job('shared', { url: shared });
      })();
    },
  });
  let boardLists = true;
  install('greenhouse', {
    fetch() {
      return (async function* () {
        if (boardLists) yield job('shared', { url: shared });
      })();
    },
  });
  const agg = insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });
  const board = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(agg); // the aggregator owns the row
  await runWith(board);
  expect(byUrl(shared).l1_pass).toBe(1);

  const cached = await runWith(board);
  expect(cached.events.some(e => e.msg.includes('from cache'))).toBe(true);
  expect(byUrl(shared).last_run_id).toBe(cached.runId);
  expect(runRow(cached.runId).jobs_found).toBe(1);

  // The board drops it while the aggregator still lists it: the aggregator's sighting
  // must not keep it open on the board.
  makeStale(board);
  await Bun.sleep(5);
  boardLists = false;
  await runWith(board);
  await runWith(agg);
  const afterAgg = byUrl(shared).last_run_id;
  const again = await runWith(board);
  expect(again.events.some(e => e.msg.includes('from cache'))).toBe(true);
  expect(byUrl(shared).last_run_id).toBe(afterAgg);
  expect(runRow(again.runId).jobs_found).toBe(0);
});

test('a posting folded into a row another source owns is evaluated for the board that listed it', async () => {
  install('remoteok', {
    fetch() {
      return (async function* () {
        yield job('agg', { company: 'Foo', title: 'Backend Engineer' });
      })();
    },
  });
  install('greenhouse', {
    fetch() {
      return (async function* () {
        yield job('board', { company: 'Foo', title: 'Backend Engineer' });
      })();
    },
  });
  const agg = insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });
  const board = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(agg);
  const live = await runWith(board);
  expect(jobRows()).toHaveLength(1); // folded, no second row
  expect(runRow(live.runId).jobs_found).toBe(1);

  const cached = await runWith(board);
  expect(jobRows()[0]!.last_run_id).toBe(cached.runId);
  expect(runRow(cached.runId)).toMatchObject({ jobs_found: 1, jobs_l1_pass: 1 });
});

test('the earlier of the stored and fetched posted_at drives L1 on the live and cached paths alike', async () => {
  // A relative date ("Posted 30+ Days Ago") re-derived at fetch time reads newer each scan.
  let postedAt: number | null = Date.now() - 30 * DAY;
  install('greenhouse', {
    fetch() {
      return (async function* () {
        yield job('1', { posted_at: postedAt });
      })();
    },
  });
  const id = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/1').l1_pass).toBe(0);

  makeStale(id);
  postedAt = Date.now(); // drifted newer
  const live = await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/1').l1_pass).toBe(0); // still stale: the earlier date wins
  expect(runRow(live.runId).jobs_l1_pass).toBe(0);
  const cached = await runWith(id);
  expect(byUrl('https://boards.test/acme/jobs/1').l1_pass).toBe(0);
  expect(runRow(cached.runId).jobs_l1_pass).toBe(0);

  // An earlier fetched date is adopted, and a fetch with no date keeps the stored one.
  makeStale(id);
  const earlier = Date.now() - 40 * DAY;
  postedAt = earlier;
  await runWith(id);
  const posted = () => (memDb.query('SELECT posted_at FROM jobs').get() as { posted_at: number }).posted_at;
  expect(posted()).toBe(earlier);
  makeStale(id);
  postedAt = null;
  await runWith(id);
  expect(posted()).toBe(earlier);
});

test('the board-cache TTL setting round-trips and rejects out-of-range values', async () => {
  const get = async () => (await (await req('/api/settings/board-cache')).json()).settings;
  expect(await get()).toEqual({ ttlHours: 6 });

  const put = (body: unknown) =>
    req('/api/settings/board-cache', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await put({ ttlHours: 12 })).status).toBe(200);
  expect(await get()).toEqual({ ttlHours: 12 });
  expect((await put({ ttlHours: 0 })).status).toBe(200);
  expect((await put({ ttlHours: -1 })).status).toBe(400);
  expect((await put({ ttlHours: 1000 })).status).toBe(400);
});

test('a date from another source for the same URL does not pin the job stale for the board', async () => {
  const shared = 'https://boards.test/acme/jobs/shared';
  install('remoteok', {
    fetch() {
      return (async function* () {
        yield job('shared', { url: shared, posted_at: Date.now() - 60 * DAY }); // a bogus old aggregator date
      })();
    },
  });
  install('greenhouse', {
    fetch() {
      return (async function* () {
        yield job('shared', { url: shared, posted_at: Date.now() - DAY });
      })();
    },
  });
  const agg = insertSource({ type: 'remoteok', identifier: 'remoteok', enabled: 1 });
  const board = insertSource({ type: 'greenhouse', enabled: 1 });
  await runWith(agg);
  expect(byUrl(shared).l1_pass).toBe(0); // stale under the freshness window

  await runWith(board);
  // The board's own, fresh date drives its L1 and the row keeps its owner's date.
  expect(byUrl(shared).l1_pass).toBe(1);
  expect((memDb.query('SELECT posted_at FROM jobs').get() as { posted_at: number }).posted_at).toBeLessThan(Date.now() - 59 * DAY);
});
