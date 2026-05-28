import { readFileSync } from 'fs';
import { join } from 'path';
import type { Database } from 'bun:sqlite';

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

  // One-time: remove x-grok sources and their jobs before the CHECK constraint
  // that dropped 'x-grok' takes effect on new rows.
  db.run(`DELETE FROM jobs WHERE source_id IN (SELECT id FROM sources WHERE type = 'x-grok')`);
  db.run(`DELETE FROM sources WHERE type = 'x-grok'`);

  // Idempotent ADD COLUMN — schema.sql only fires for fresh DBs since
  // CREATE TABLE IF NOT EXISTS skips column changes on existing tables.
  const jobsCols = db
    .query<{ name: string }, []>("PRAGMA table_info(jobs)")
    .all()
    .map(r => r.name);
  if (!jobsCols.includes('duplicate_urls')) {
    db.run('ALTER TABLE jobs ADD COLUMN duplicate_urls TEXT');
  }

  // Rebuild sources table if its CHECK constraint predates the current set.
  // CREATE TABLE IF NOT EXISTS is a no-op for existing tables, so changes to
  // the CHECK constraint don't propagate to DBs created before this commit.
  // Detect by looking at the stored SQL and recreate when needed.
  const sourcesSchema = db
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'"
    )
    .get();
  if (sourcesSchema && !sourcesSchema.sql.includes("'local-parser'")) {
    db.run('BEGIN');
    try {
      db.run(`
        CREATE TABLE sources_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          type            TEXT NOT NULL CHECK (type IN (
            'greenhouse', 'ashby', 'lever',
            'hn-whos-hiring', 'generic-url', 'local-parser'
          )),
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
      db.run(`
        INSERT INTO sources_new
        (id, type, identifier, display_name, enabled, config_json,
         last_scan_at, last_status, last_error, created_at)
        SELECT id, type, identifier, display_name, enabled, config_json,
               last_scan_at, last_status, last_error, created_at
        FROM sources
      `);
      db.run('DROP TABLE sources');
      db.run('ALTER TABLE sources_new RENAME TO sources');
      db.run('COMMIT');
    } catch (err) {
      db.run('ROLLBACK');
      throw err;
    }
  }
}
