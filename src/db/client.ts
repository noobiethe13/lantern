import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { runMigrations } from './migrate';

const DATA_DIR = join(process.cwd(), 'data');
const DB_PATH = join(DATA_DIR, 'data.db');

function createDb(): Database {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  // bun:sqlite defaults to synchronous=FULL. Under WAL, NORMAL is safe (SQLite
  // guarantees the DB itself can't corrupt) and only risks losing the most
  // recent commits on an OS crash/power loss — a good trade here since it's a
  // big win for the bulk-write passes (see runner/legitimacy.ts).
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

export const db = createDb();
