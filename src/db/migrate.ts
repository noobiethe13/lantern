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
}
