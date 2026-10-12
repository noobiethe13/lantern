import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { Job, SourceAdapter, SourceContext } from '../core/job';
import type { ScanEvent } from './progress';
import {
  REPO,
  WORK,
  memDb,
  scan,
  bus,
  setLlm,
  llmCalls,
  seedEmbeddingsOff,
  insertSource,
  resetDb,
  NL_OK,
} from '../test-harness';

const { adapterRegistry } = await import(`${REPO}/src/sources/index.ts`);
const registry = adapterRegistry as Record<string, SourceAdapter>;
const originalGreenhouse = registry.greenhouse;
const SEED_PATH = join(WORK, 'src/config/seed-sources.yml');
const originalSeed = readFileSync(SEED_PATH, 'utf-8');

const DAY = 86_400_000;

beforeEach(() => {
  resetDb();
  seedEmbeddingsOff();
});

afterEach(() => {
  registry.greenhouse = originalGreenhouse;
  writeFileSync(SEED_PATH, originalSeed);
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
};

function newRun(): number {
  return memDb
    .query<{ id: number }, []>('INSERT INTO runs (started_at, sources_total) VALUES (0, 1) RETURNING id')
    .get()!.id;
}

function sourceRow(id: number): SourceRow {
  return memDb
    .query('SELECT id, type, identifier, display_name, enabled, config_json FROM sources WHERE id = ?')
    .get(id) as SourceRow;
}

/** Installs a fake greenhouse adapter yielding `jobs` (or driven by `fetchImpl`). */
function fakeAdapter(
  jobs: Job[],
  extra: Partial<SourceAdapter> & { fetchImpl?: (ctx: SourceContext) => AsyncIterable<Job> } = {},
): { contexts: SourceContext[] } {
  const contexts: SourceContext[] = [];
  const { fetchImpl, ...rest } = extra;
  registry.greenhouse = {
    type: 'greenhouse',
    fetch(ctx: SourceContext) {
      contexts.push(ctx);
      if (fetchImpl) return fetchImpl(ctx);
      return (async function* () {
        for (const j of jobs) yield j;
      })();
    },
    ...rest,
  };
  return { contexts };
}

async function scanWith(
  jobs: Job[],
  opts: { runId?: number; sourceId?: number; adapter?: Parameters<typeof fakeAdapter>[1]; deadlineMs?: number } = {},
) {
  const sourceId = opts.sourceId ?? insertSource({ type: 'greenhouse', enabled: 1 });
  const runId = opts.runId ?? newRun();
  const { contexts } = fakeAdapter(jobs, opts.adapter);
  const events: ScanEvent[] = [];
  bus.subscribe(runId, (e: ScanEvent) => events.push(e));
  await scan.runScan(runId, [sourceRow(sourceId)], NL_OK, { sourceDeadlineMs: opts.deadlineMs });
  return { runId, sourceId, events, contexts };
}

type JobRow = {
  id: number;
  url: string;
  title: string;
  location: string | null;
  jd_text: string | null;
  l1_pass: number;
  l1_reasons: string | null;
  duplicate_urls: string | null;
  l2_verdict_json: string | null;
  l2_score: number | null;
  status: string;
  notes: string | null;
  posted_at: number | null;
  first_seen: number;
};

function jobs(): JobRow[] {
  return memDb.query('SELECT * FROM jobs ORDER BY id').all() as JobRow[];
}

const job = (over: Partial<Job> = {}): Job => ({
  url: `https://boards.example.com/${Math.random().toString(36).slice(2)}`,
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Berlin',
  ...over,
});

// W1 — fuzzy dedup identity + L1 merge

test('fuzzy dedup keeps same-role postings in different locations as separate rows', async () => {
  await scanWith([job({ location: 'Berlin' }), job({ location: 'London' })]);
  expect(jobs().length).toBe(2);
});

test('fuzzy dedup folds the same role in the same place and records the duplicate URL', async () => {
  const a = job();
  const b = job({ title: 'Backend Engineer (Platform)' });
  await scanWith([a, b]);
  const rows = jobs();
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0].duplicate_urls!)).toEqual([b.url]);
});

test('a same-run fold never lets an L1-passing posting vanish into a failing row', async () => {
  // Same role, but the first copy is stale (fails freshness) and the second passes.
  const stale = job({ posted_at: Date.now() - 60 * DAY });
  const fresh = job({ posted_at: Date.now() });
  await scanWith([stale, fresh]);
  const [row] = jobs();
  expect(jobs().length).toBe(1);
  expect(row.l1_pass).toBe(1);
  expect(row.l1_reasons).toBeNull();
});

test('a same-run fold keeps the pass when the failing copy arrives second', async () => {
  await scanWith([job({ posted_at: Date.now() }), job({ posted_at: Date.now() - 60 * DAY })]);
  expect(jobs().length).toBe(1);
  expect(jobs()[0].l1_pass).toBe(1);
  expect(jobs()[0].l1_reasons).toBeNull();
});

test('a fold replaces an L1 verdict left over from an earlier run (criteria may have changed)', async () => {
  const first = await scanWith([job({ posted_at: Date.now() })]);
  expect(jobs()[0].l1_pass).toBe(1);
  // Next run: only a stale same-role copy on another URL surfaces.
  await scanWith([job({ posted_at: Date.now() - 60 * DAY })], { sourceId: first.sourceId });
  expect(jobs()[0].l1_pass).toBe(0);
});

// W2 — refresh on re-scan

test('re-scan with changed content refreshes the row and clears only its L2 verdict', async () => {
  const posted = Date.now() - DAY;
  const original = job({ posted_at: posted, jd_text: 'old description' });
  const first = await scanWith([original]);
  const id = jobs()[0].id;
  memDb.run(
    `UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1, status = 'shortlist', notes = 'call them' WHERE id = ?`,
    [id]
  );
  const before = jobs()[0];

  await scanWith(
    [{ ...original, title: 'Senior Backend Engineer', location: 'Munich', jd_text: undefined, posted_at: Date.now() }],
    { sourceId: first.sourceId }
  );
  const row = jobs()[0];
  expect(row.title).toBe('Senior Backend Engineer');
  expect(row.location).toBe('Munich');
  expect(row.jd_text).toBe('old description'); // COALESCE(incoming, existing)
  expect(row.l2_verdict_json).toBeNull();
  expect(row.l2_score).toBeNull();
  expect(row.status).toBe('shortlist');
  expect(row.notes).toBe('call them');
  expect(row.posted_at).toBe(posted);
  expect(row.first_seen).toBe(before.first_seen);
});

test('re-scan with unchanged content (or merely a missing JD) keeps the L2 verdict', async () => {
  const original = job({ jd_text: 'the description' });
  const first = await scanWith([original]);
  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1`);

  await scanWith([original], { sourceId: first.sourceId });
  expect(jobs()[0].l2_score).toBe(0.9);

  await scanWith([{ ...original, jd_text: undefined }], { sourceId: first.sourceId });
  expect(jobs()[0].l2_score).toBe(0.9);
  expect(jobs()[0].jd_text).toBe('the description');
});

test('re-scan with only jd_text changed (same source, everything else identical) keeps the L2 verdict', async () => {
  // htmlToText output can change (entity decoding, whitespace collapsing)
  // without the underlying posting changing at all — a jd_text-only diff must
  // not wipe every verdict/embedding on the next scan.
  const original = job({ jd_text: 'Old &amp; busted   description' });
  const first = await scanWith([original]);
  const id = jobs()[0].id;
  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1 WHERE id = ?`, [id]);

  await scanWith([{ ...original, jd_text: 'New & shiny description' }], { sourceId: first.sourceId });

  const row = jobs()[0];
  expect(row.l2_score).toBe(0.9);
  // Not refreshed — a jd_text-only diff (with title/location/etc unchanged)
  // intentionally does not count as "changed" (see the why-comment in upsertJob).
  expect(row.jd_text).toBe('Old &amp; busted   description');
});

test('re-scan with a JD arriving where none existed before refreshes the row and clears the L2 verdict', async () => {
  const original = job({ jd_text: undefined });
  const first = await scanWith([original]);
  const id = jobs()[0].id;
  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1 WHERE id = ?`, [id]);

  await scanWith([{ ...original, jd_text: 'brand new description' }], { sourceId: first.sourceId });

  const row = jobs()[0];
  expect(row.l2_score).toBeNull();
  expect(row.jd_text).toBe('brand new description');
});

test('a second source reporting the same URL never refreshes content it does not own', async () => {
  const original = job({ jd_text: 'the description' });
  const first = await scanWith([original]);
  const id = jobs()[0].id;
  memDb.run(`UPDATE jobs SET l2_verdict_json = '{"fit":true}', l2_score = 0.9, l2_fit = 1 WHERE id = ?`, [id]);

  const otherSourceId = insertSource({ type: 'greenhouse', identifier: 'other', enabled: 1 });
  await scanWith([{ ...original, title: 'Totally Different Title', jd_text: 'a rewritten JD' }], {
    sourceId: otherSourceId,
  });

  const row = jobs()[0];
  expect(row.title).toBe('Backend Engineer'); // untouched — the owning source never re-reported it
  expect(row.jd_text).toBe('the description');
  expect(row.l2_score).toBe(0.9);
});

// W3 — per-source deadline + validation

test('a hung source times out on its own deadline without stalling the scan', async () => {
  let sawAbort = false;
  const { events, sourceId } = await scanWith([], {
    deadlineMs: 50,
    adapter: {
      fetchImpl: ctx =>
        (async function* () {
          yield job();
          await new Promise<void>(resolve => ctx.abortSignal.addEventListener('abort', () => {
            sawAbort = true;
            resolve();
          }));
          yield job({ title: 'Never Stored' });
        })(),
    },
  });
  expect(sawAbort).toBe(true);
  const src = memDb.query('SELECT last_status, last_error FROM sources WHERE id = ?').get(sourceId) as {
    last_status: string;
    last_error: string;
  };
  expect(src.last_status).toBe('timeout');
  expect(src.last_error).toContain('timed out');
  expect(events.some(e => e.type === 'source_error')).toBe(true);
  expect(events.some(e => e.type === 'scan_done')).toBe(true);
  expect(jobs().map(j => j.title)).toEqual(['Backend Engineer']);
});

test('jobs that fail JobShape are skipped and counted, never stored', async () => {
  const { events } = await scanWith([job(), job({ url: '' }), job({ title: '' })]);
  expect(jobs().length).toBe(1);
  const done = events.find(e => e.type === 'source_done')!;
  expect(done.msg).toContain('2 malformed skipped');
});

// W4 — keywords + freshness context

test('normalizeKeywords trims, lowercases, dedupes, drops whole-word supersets, keeps order', () => {
  expect(
    scan.normalizeKeywords([' Flutter Developer ', 'flutter', '', 'Java', 'JavaScript', 'java', 'Backend  Engineer', 'engineer'])
  ).toEqual(['flutter', 'java', 'javascript', 'engineer']);
});

test('the source context carries normalized keywords and the freshness window in days', async () => {
  const { contexts } = await scanWith([]);
  expect(contexts[0].keywords).toEqual(['engineer']);
  expect(contexts[0].maxAgeDays).toBe(7); // default freshness setting

  memDb.run(
    `INSERT OR REPLACE INTO settings (key, value_json, updated_at) VALUES ('freshness', '{"enabled":false,"maxAgeDays":30}', 0)`
  );
  const again = await scanWith([]);
  expect(again.contexts[0].maxAgeDays).toBeUndefined();
});

// W5 — enrich wiring

test('enrich runs only for L1 survivors lacking a JD, and its patch is stored', async () => {
  const enriched: string[] = [];
  const passing = job();
  const failing = job({ title: 'Sales Manager' });
  const withJd = job({ title: 'Platform Engineer', jd_text: 'already have it' });
  await scanWith([passing, failing, withJd], {
    adapter: {
      async enrich(j) {
        enriched.push(j.url);
        return { jd_text: `JD for ${j.title}` };
      },
    },
  });
  expect(enriched).toEqual([passing.url]);
  const row = jobs().find(r => r.url === passing.url)!;
  expect(row.jd_text).toBe('JD for Backend Engineer');
});

test('enrich is capped per source per run and a throwing enrich never fails the source', async () => {
  let calls = 0;
  const many = Array.from({ length: 45 }, (_, i) => job({ title: `Engineer ${i} Team${i}`, company: `Co${i}` }));
  const { events, sourceId } = await scanWith(many, {
    adapter: {
      async enrich() {
        calls++;
        if (calls === 1) throw new Error('boom');
        return null;
      },
    },
  });
  expect(calls).toBe(40);
  expect(jobs().length).toBe(45);
  expect(events.some(e => e.type === 'source_done')).toBe(true);
  const src = memDb.query('SELECT last_status FROM sources WHERE id = ?').get(sourceId) as { last_status: string };
  expect(src.last_status).toBe('ok');
});

// W6 — seed sync

test('seed sync disables a maintainer-disabled board but never enables, and leaves aggregators alone', () => {
  const dead = insertSource({ type: 'greenhouse', identifier: 'deadco', display_name: 'Dead', enabled: 1 });
  const userOff = insertSource({ type: 'greenhouse', identifier: 'liveco', display_name: 'Live', enabled: 0 });
  const linkedin = insertSource({ type: 'linkedin', identifier: 'linkedin', display_name: 'LinkedIn', enabled: 1 });
  writeFileSync(
    SEED_PATH,
    yaml.dump({
      sources: [
        { type: 'greenhouse', identifier: 'deadco', display_name: 'Dead', enabled: false },
        { type: 'greenhouse', identifier: 'liveco', display_name: 'Live', enabled: true },
        { type: 'linkedin', identifier: 'linkedin', display_name: 'LinkedIn', enabled: false },
      ],
    })
  );
  scan.createRun();
  const enabled = (id: number) =>
    (memDb.query('SELECT enabled FROM sources WHERE id = ?').get(id) as { enabled: number }).enabled;
  expect(enabled(dead)).toBe(0);
  expect(enabled(userOff)).toBe(0);
  expect(enabled(linkedin)).toBe(1);
});

// W7 — freshness visibility

test('scan_done reports jobs that only failed the freshness gate', async () => {
  const { events } = await scanWith([
    job({ title: 'Data Engineer', posted_at: Date.now() - 40 * DAY }),
    job({ title: 'ML Engineer', posted_at: Date.now() - 40 * DAY }),
    job({ title: 'Sales Manager', posted_at: Date.now() - 40 * DAY }), // also fails title — not counted
    job({ title: 'Backend Engineer', posted_at: Date.now() }),
  ]);
  const done = events.find(e => e.type === 'scan_done')!;
  expect(done.msg).toContain('2 more matched but were older than 7d (widen in Settings)');
  expect(done.data?.freshnessDropped).toBe(2);
});

// W8 — L2 gets the user's words

test("createRun snapshots the criteria's source_text and runL2Pass puts it in the verdict prompt", async () => {
  memDb.run(`INSERT INTO criteria (id, yaml, source_text, updated_at) VALUES (1, ?, ?, 0)`, [
    yaml.dump(NL_OK),
    'backend roles at climate startups',
  ]);
  const setup = scan.createRun('backend roles at climate startups');
  expect(setup.criteriaSourceText).toBe('backend roles at climate startups');

  const sourceId = insertSource({ type: 'greenhouse', enabled: 0 });
  memDb.run(
    `INSERT INTO jobs (source_id, url, title, company, company_norm, content_hash, first_seen, last_seen, last_run_id, l1_pass)
     VALUES (?, 'https://x.test/l2', 'Engineer', 'Acme', 'acme', 'h', 1, 1, ?, 1)`,
    [sourceId, setup.runId]
  );
  setLlm(async () => ({ verdicts: [] }));
  await scan.runL2Pass(setup.runId, setup.criteriaYaml, setup.criteriaSourceText);
  expect(llmCalls[0].prompt).toContain('backend roles at climate startups');
});
