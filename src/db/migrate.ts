import { readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from 'bun:sqlite';
import { normalizeCompany } from '../core/dedup';

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
