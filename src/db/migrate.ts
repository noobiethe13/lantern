import { readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import { normalizeCompany } from '../core/dedup';

// Source types currently accepted by the sources.type CHECK. Keep in sync with
// the CHECK in schema.sql — a SQLite CHECK constraint can only be changed by
// rebuilding the table, so new board types added to schema.sql for fresh DBs
// also need this list updated to migrate pre-existing DBs.
const SOURCE_TYPE_CHECK = [
  'greenhouse', 'ashby', 'lever',
  'recruitee', 'smartrecruiters', 'workable', 'personio', 'bamboohr', 'workday',
  'remoteok', 'arbeitnow', 'himalayas', 'linkedin', 'google_jobs', 'jobicy',
  'themuse', 'smartrecruiters_search', 'workingnomads', 'weworkremotely', 'remotive',
  'jobtech', 'hn_hiring',
  'breezy', 'rippling', 'teamtailor',
];

const SOURCE_COLUMNS =
  'id, type, identifier, display_name, enabled, config_json, last_scan_at, last_status, last_error, last_ok_fetch_at, refresh_failures, refresh_retry_at, created_at, origin';

/**
 * Bring an existing DB's sources.type CHECK up to date. CREATE TABLE IF NOT
 * EXISTS won't touch a table that already exists, so when new board types are
 * added a pre-existing DB still carries the old CHECK and rejects inserts of the
 * new types. SQLite has no ALTER CHECK — the supported fix is the table rebuild
 * (create-new / copy / drop / rename). The rebuild preserves row ids, so
 * jobs.source_id references stay valid. No-op when every current type already
 * appears in the stored DDL.
 */
function migrateSourceTypeCheck(db: Database): void {
  const row = db
    .query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'")
    .get();
  if (!row) return; // fresh DB just created the up-to-date table
  if (SOURCE_TYPE_CHECK.every(t => row.sql.includes(`'${t}'`))) return; // already current

  const typeList = SOURCE_TYPE_CHECK.map(t => `'${t}'`).join(', ');
  // foreign_keys can't be toggled inside a transaction; do it around one.
  db.run('PRAGMA foreign_keys = OFF');
  try {
    const rebuild = db.transaction(() => {
      db.run(`
        CREATE TABLE sources_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          type            TEXT NOT NULL CHECK (type IN (${typeList})),
          identifier      TEXT NOT NULL,
          display_name    TEXT NOT NULL,
          enabled         INTEGER NOT NULL DEFAULT 1,
          config_json     TEXT,
          last_scan_at    INTEGER,
          last_status     TEXT,
          last_error      TEXT,
          last_ok_fetch_at INTEGER,
          refresh_failures INTEGER NOT NULL DEFAULT 0,
          refresh_retry_at INTEGER,
          created_at      INTEGER NOT NULL,
          origin          TEXT,
          UNIQUE (type, identifier)
        )
      `);
      // Explicit columns: the origin column is appended by ALTER on old DBs, so
      // a positional SELECT * would depend on that column order.
      db.run(`INSERT INTO sources_new (${SOURCE_COLUMNS}) SELECT ${SOURCE_COLUMNS} FROM sources`);
      db.run('DROP TABLE sources');
      db.run('ALTER TABLE sources_new RENAME TO sources');
    });
    rebuild();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }
}

export function runMigrations(db: Database): void {
  const schemaPath = join(import.meta.dir, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf-8');

  // Split on semicolons; strip comment lines from each chunk, then run non-empty ones
  const statements = sql
    .split(';')
    .map(s =>
      s
        .split('\n')
        .filter(line => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    db.run(stmt);
  }

  // Drop rows for any retired source type before the CHECK rebuild below: the
  // rebuild copies rows with SELECT *, so a row whose type is no longer listed in
  // the CHECK constraint would fail to re-insert. Extend this list if a type is retired.
  db.run("DELETE FROM sources WHERE type = 'indeed'");

  // origin: NULL for seeded and user-added rows, 'discovered' for boards seeded
  // from discovered-sources.json (bulk-toggled in Settings, hidden from the roster).
  // Added before the CHECK rebuild so the rebuilt table and its copy include it.
  const sourcesCols = db
    .query<{ name: string }, []>("PRAGMA table_info(sources)")
    .all()
    .map(r => r.name);
  if (!sourcesCols.includes('origin')) {
    db.run('ALTER TABLE sources ADD COLUMN origin TEXT');
  }
  // last_ok_fetch_at: start of the last complete successful fetch, read by the board
  // cache. NULL on existing rows, so every board is fetched live once before it can be
  // served from cache. Added before the CHECK rebuild for the same reason as origin.
  if (!sourcesCols.includes('last_ok_fetch_at')) {
    db.run('ALTER TABLE sources ADD COLUMN last_ok_fetch_at INTEGER');
  }
  // refresh_failures / refresh_retry_at: the background refresher's per-board backoff
  // (runner/board-refresher.ts). Existing rows start with no failures and no delay.
  if (!sourcesCols.includes('refresh_failures')) {
    db.run('ALTER TABLE sources ADD COLUMN refresh_failures INTEGER NOT NULL DEFAULT 0');
  }
  if (!sourcesCols.includes('refresh_retry_at')) {
    db.run('ALTER TABLE sources ADD COLUMN refresh_retry_at INTEGER');
  }

  migrateSourceTypeCheck(db);

  // token: per-acquisition owner id for scan_locks (see tryAcquireScanLock). A
  // lock row left by an older build has NULL, which no live run owns.
  const lockCols = db
    .query<{ name: string }, []>("PRAGMA table_info(scan_locks)")
    .all()
    .map(r => r.name);
  if (!lockCols.includes('token')) {
    db.run('ALTER TABLE scan_locks ADD COLUMN token TEXT');
  }
  // started_at: when the lock was first taken (acquired_at is the heartbeat). NULL on a
  // row from an older build, which then simply has no absolute ceiling.
  if (!lockCols.includes('started_at')) {
    db.run('ALTER TABLE scan_locks ADD COLUMN started_at INTEGER');
  }

  // Idempotent ADD COLUMN — schema.sql only fires for fresh DBs since
  // CREATE TABLE IF NOT EXISTS skips column changes on existing tables.
  const jobsCols = db
    .query<{ name: string }, []>("PRAGMA table_info(jobs)")
    .all()
    .map(r => r.name);
  if (!jobsCols.includes('duplicate_urls')) {
    db.run('ALTER TABLE jobs ADD COLUMN duplicate_urls TEXT');
  }

  // salary_currency: ISO code tagging the (native) salary_min_usd/max amounts.
  // Pre-existing rows get NULL, so they are not amount-filtered until re-scanned.
  if (!jobsCols.includes('salary_currency')) {
    db.run('ALTER TABLE jobs ADD COLUMN salary_currency TEXT');
  }

  // salary_source: 'ats' or 'jd' provenance of the salary. Pre-existing rows stay
  // NULL, which reads as ats (text extraction did not exist before this column).
  if (!jobsCols.includes('salary_source')) {
    db.run('ALTER TABLE jobs ADD COLUMN salary_source TEXT');
  }

  // company_norm: indexed prefilter for the fuzzy-dedup candidate lookup in
  // scan.ts. Add the column on existing DBs (CREATE TABLE covers fresh ones),
  // backfill any NULL rows with normalizeCompany(), then index it. The index
  // lives here, not in schema.sql, because schema.sql's statements run before
  // this ALTER — indexing jobs(company_norm) there would fail on a pre-column DB.
  if (!jobsCols.includes('company_norm')) {
    db.run('ALTER TABLE jobs ADD COLUMN company_norm TEXT');
  }

  // legitimacy + legitimacy_reasons: ghost-job signal written by the legitimacy
  // pass (runner/legitimacy.ts). Pre-existing rows stay NULL until a run
  // re-surfaces them.
  if (!jobsCols.includes('legitimacy')) {
    db.run('ALTER TABLE jobs ADD COLUMN legitimacy TEXT');
  }
  if (!jobsCols.includes('legitimacy_reasons')) {
    db.run('ALTER TABLE jobs ADD COLUMN legitimacy_reasons TEXT');
  }

  // embedding: raw Float32 BLOB sentence embedding for the local semantic
  // pre-ranker. Pre-existing rows stay NULL until a run re-embeds them. No index
  // (a BLOB read by id, not queried).
  if (!jobsCols.includes('embedding')) {
    db.run('ALTER TABLE jobs ADD COLUMN embedding BLOB');
  }

  // duplicate_of: canonical jobs.id a semantic near-duplicate folds into (see
  // runner/semantic-dedup.ts). Pre-existing rows stay NULL until a run re-dedups.
  // Indexed below — the jobs list filters `duplicate_of IS NULL` and the
  // duplicates endpoint queries `duplicate_of = ?`.
  if (!jobsCols.includes('duplicate_of')) {
    db.run('ALTER TABLE jobs ADD COLUMN duplicate_of INTEGER');
  }
  // l1_rescued: set by semantic rescue (runner/semantic-rescue.ts) on a job it
  // promoted past the title rule. Existing rows default to 0 (not rescued).
  if (!jobsCols.includes('l1_rescued')) {
    db.run('ALTER TABLE jobs ADD COLUMN l1_rescued INTEGER NOT NULL DEFAULT 0');
  }
  // employment_type: the ATS's structured commitment field, an L1 input the board cache
  // re-evaluates from stored rows. Existing rows stay NULL (unknown) until re-fetched.
  if (!jobsCols.includes('employment_type')) {
    db.run('ALTER TABLE jobs ADD COLUMN employment_type TEXT');
  }
  const stale = db
    .query<{ id: number; company: string }, []>(
      'SELECT id, company FROM jobs WHERE company_norm IS NULL'
    )
    .all();
  if (stale.length > 0) {
    const upd = db.prepare('UPDATE jobs SET company_norm = ? WHERE id = ?');
    const backfill = db.transaction((rows: { id: number; company: string }[]) => {
      for (const r of rows) upd.run(normalizeCompany(r.company), r.id);
    });
    backfill(stale);
  }
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_company_norm ON jobs(company_norm)');
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_duplicate_of ON jobs(duplicate_of)');

  // The Jobs list's rank order as an index, term for term with JOBS_RANK_ORDER in
  // routes/jobs.ts, so a page of the unfiltered list is an index walk instead of a
  // sort over every job (seconds at 400k+ rows).
  db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_rank ON jobs(
    (l2_score IS NULL), l2_fit DESC, l2_score DESC, l1_pass DESC, first_seen DESC, id DESC)`);
  // A run's L1 survivors (countUngraded, ?run=…&fit=1) without visiting every job the
  // run stamped. Supersedes the single-column idx_jobs_last_run.
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_last_run_l1 ON jobs(last_run_id, l1_pass)');
  db.run('DROP INDEX IF EXISTS idx_jobs_last_run');
  // The Jobs text filter's LIKE scans this instead of the wide rows (routes/jobs.ts).
  // Upserts rarely change title/company, so it costs little on the scan's write path.
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_title_company ON jobs(title, company)');
  // Applied jobs are a liked signal whatever their status (runner/preference.ts).
  db.run('CREATE INDEX IF NOT EXISTS idx_jobs_applied ON jobs(applied_at) WHERE applied_at IS NOT NULL');
}
