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
  'remoteok', 'arbeitnow', 'himalayas', 'linkedin',
];

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
          created_at      INTEGER NOT NULL,
          UNIQUE (type, identifier)
        )
      `);
      db.run('INSERT INTO sources_new SELECT * FROM sources');
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

  migrateSourceTypeCheck(db);

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
}
