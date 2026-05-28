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
}
