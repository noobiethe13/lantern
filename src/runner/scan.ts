import { readFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { db } from '../db/client';
import { getAdapter } from '../sources/index';
import { l1Filter, type Criteria } from '../core/filter';
import { contentHash } from '../core/dedup';
import { toDbRow } from '../core/normalize';
import type { Job } from '../core/job';

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

function loadCriteria(): Criteria {
  try {
    const criteriaRow = db
      .query<{ yaml: string }, []>('SELECT yaml FROM criteria WHERE id = 1')
      .get();
    if (criteriaRow) {
      return yaml.load(criteriaRow.yaml) as Criteria;
    }
  } catch {
    // fall through to file
  }
  const searchYml = join(process.cwd(), 'src/config/search.yml');
  return yaml.load(readFileSync(searchYml, 'utf-8')) as Criteria;
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

function upsertJob(
  job: Job,
  sourceId: number,
  l1Pass: boolean,
  l1Reasons: string[]
): 'new' | 'seen' {
  const hash = contentHash(job);
  const row = toDbRow(job, sourceId, hash);
  const now = Date.now();

  // Check if exists
  const existing = db
    .query<{ id: number }, [string]>('SELECT id FROM jobs WHERE url = ?')
    .get(job.url);

  if (existing) {
    db.run('UPDATE jobs SET last_seen = ? WHERE url = ?', [now, job.url]);
    return 'seen';
  }

  db.run(
    `INSERT INTO jobs (
      source_id, external_id, url, title, company, location, remote,
      salary_min_usd, salary_max_usd, posted_at, jd_text, content_hash,
      first_seen, last_seen, l1_pass, l1_reasons
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.source_id,
      row.external_id,
      row.url,
      row.title,
      row.company,
      row.location,
      row.remote,
      row.salary_min_usd,
      row.salary_max_usd,
      row.posted_at,
      row.jd_text,
      row.content_hash,
      now,
      now,
      l1Pass ? 1 : 0,
      l1Reasons.length > 0 ? JSON.stringify(l1Reasons) : null,
    ]
  );
  return 'new';
}

const CONCURRENCY = 10;

async function runScan(): Promise<void> {
  console.log('lantern — starting scan');

  seedSources();

  const sources = db
    .query<DbSource, []>(
      'SELECT id, type, identifier, display_name, enabled, config_json FROM sources WHERE enabled = 1'
    )
    .all();

  const criteria = loadCriteria();
  console.log(`Sources enabled: ${sources.length}`);

  // Insert run record
  const runId = db
    .query<{ id: number }, [number, number]>(
      'INSERT INTO runs (started_at, sources_total) VALUES (?, ?) RETURNING id'
    )
    .get(Date.now(), sources.length)!.id;

  const runErrors: { source: string; error: string }[] = [];
  let jobsFound = 0;
  let jobsNew = 0;
  let jobsL1Pass = 0;

  const abort = new AbortController();

  // Process sources in batches of CONCURRENCY
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const batch = sources.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async source => {
        const adapter = getAdapter(source.type);
        if (!adapter) {
          console.log(`  [skip] no adapter for type: ${source.type}`);
          return;
        }

        const config: Record<string, unknown> = {
          identifier: source.identifier,
          display_name: source.display_name,
          ...(source.config_json ? JSON.parse(source.config_json) : {}),
        };

        const ctx = {
          sourceId: source.id,
          config,
          emitProgress: (msg: string, _n?: number) => console.log(`  ${msg}`),
          abortSignal: abort.signal,
        };

        let sourceJobCount = 0;
        try {
          for await (const job of adapter.fetch(ctx)) {
            if (abort.signal.aborted) break;
            const { pass, reasons } = l1Filter(job, criteria);
            const status = upsertJob(job, source.id, pass, reasons);
            jobsFound++;
            sourceJobCount++;
            if (status === 'new') jobsNew++;
            if (pass) jobsL1Pass++;
          }

          db.run(
            `UPDATE sources SET last_scan_at = ?, last_status = 'ok', last_error = NULL WHERE id = ?`,
            [Date.now(), source.id]
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [error] ${source.display_name}: ${msg}`);
          runErrors.push({ source: source.display_name, error: msg });
          db.run(
            `UPDATE sources SET last_scan_at = ?, last_status = 'http-error', last_error = ? WHERE id = ?`,
            [Date.now(), msg, source.id]
          );
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

  // Update run record
  db.run(
    `UPDATE runs SET finished_at = ?, jobs_found = ?, jobs_new = ?, jobs_l1_pass = ?, errors_json = ?
     WHERE id = ?`,
    [
      Date.now(),
      jobsFound,
      jobsNew,
      jobsL1Pass,
      runErrors.length > 0 ? JSON.stringify(runErrors) : null,
      runId,
    ]
  );

  console.log('\n── Scan complete ─────────────────────────');
  console.log(`  Jobs found:    ${jobsFound}`);
  console.log(`  Jobs new:      ${jobsNew}`);
  console.log(`  L1 passed:     ${jobsL1Pass}`);
  if (runErrors.length > 0) {
    console.log(`  Errors:        ${runErrors.length}`);
    for (const e of runErrors) {
      console.log(`    ${e.source}: ${e.error}`);
    }
  }
  console.log('─────────────────────────────────────────\n');
}

await runScan();
