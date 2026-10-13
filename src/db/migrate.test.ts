import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from './migrate';

const columns = (db: Database, table: string) =>
  db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(r => r.name);

// A jobs table from before the migration-added columns, with every column the
// schema.sql indexes depend on.
const LEGACY_JOBS = `CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  external_id TEXT, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL, company TEXT NOT NULL,
  location TEXT, remote INTEGER, salary_min_usd INTEGER, salary_max_usd INTEGER,
  posted_at INTEGER, jd_text TEXT, content_hash TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  liveness TEXT DEFAULT 'unchecked', liveness_checked_at INTEGER,
  l1_pass INTEGER NOT NULL DEFAULT 0, l1_reasons TEXT, l2_verdict_json TEXT,
  l2_score REAL, l2_fit INTEGER, last_run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new', applied_at INTEGER, notes TEXT
)`;

test('a fresh database has the board-cache columns, and re-running is a no-op', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  runMigrations(db);
  expect(columns(db, 'sources')).toContain('last_ok_fetch_at');
  expect(columns(db, 'sources')).toEqual(expect.arrayContaining(['refresh_failures', 'refresh_retry_at']));
  expect(columns(db, 'jobs')).toContain('employment_type');
  expect(columns(db, 'board_sightings')).toEqual(['source_id', 'job_id', 'seen_at']);
});

test('an existing database gains the columns without losing rows', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, identifier TEXT NOT NULL,
    display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config_json TEXT,
    last_scan_at INTEGER, last_status TEXT, last_error TEXT, created_at INTEGER NOT NULL,
    UNIQUE (type, identifier)
  )`);
  db.run(LEGACY_JOBS);
  db.run(`INSERT INTO sources (type, identifier, display_name, created_at, last_scan_at, last_status)
          VALUES ('greenhouse', 'acme', 'Acme', 1, 99, 'ok')`);
  db.run(`INSERT INTO jobs (source_id, url, title, company, content_hash, first_seen, last_seen)
          VALUES (1, 'https://x.test/1', 'Engineer', 'Acme', 'h', 1, 1)`);

  runMigrations(db);

  expect(columns(db, 'sources')).toContain('last_ok_fetch_at');
  expect(columns(db, 'jobs')).toContain('employment_type');
  expect(columns(db, 'board_sightings')).toContain('seen_at');
  expect(db.query('SELECT id, last_scan_at, last_ok_fetch_at, refresh_failures, refresh_retry_at FROM sources').get()).toEqual({
    id: 1,
    last_scan_at: 99,
    last_ok_fetch_at: null,
    refresh_failures: 0,
    refresh_retry_at: null,
  });
  expect(db.query('SELECT source_id, employment_type FROM jobs').get()).toEqual({ source_id: 1, employment_type: null });
});

test('the source-type CHECK rebuild carries last_ok_fetch_at across', () => {
  const db = new Database(':memory:');
  // An old CHECK that predates the newer board types forces the table rebuild.
  db.run(`CREATE TABLE sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('greenhouse', 'ashby', 'lever')),
    identifier TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    config_json TEXT, last_scan_at INTEGER, last_status TEXT, last_error TEXT,
    last_ok_fetch_at INTEGER, refresh_failures INTEGER NOT NULL DEFAULT 0, refresh_retry_at INTEGER,
    created_at INTEGER NOT NULL, origin TEXT,
    UNIQUE (type, identifier)
  )`);
  db.run(LEGACY_JOBS);
  db.run(`INSERT INTO sources (type, identifier, display_name, created_at, last_ok_fetch_at, refresh_failures, refresh_retry_at)
          VALUES ('greenhouse', 'acme', 'Acme', 1, 12345, 3, 99999)`);
  db.run(`INSERT INTO jobs (source_id, url, title, company, content_hash, first_seen, last_seen)
          VALUES (1, 'https://x.test/1', 'Engineer', 'Acme', 'h', 1, 1)`);
  // A sightings table already holding a row, with real foreign keys into the tables being rebuilt.
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE board_sightings (
    source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    seen_at INTEGER NOT NULL, PRIMARY KEY (source_id, job_id)
  ) WITHOUT ROWID`);
  db.run('INSERT INTO board_sightings (source_id, job_id, seen_at) VALUES (1, 1, 77)');

  runMigrations(db);

  expect(db.query('SELECT source_id, job_id, seen_at FROM board_sightings').all()).toEqual([
    { source_id: 1, job_id: 1, seen_at: 77 },
  ]);
  expect(db.query('SELECT id, last_ok_fetch_at, refresh_failures, refresh_retry_at FROM sources').get()).toEqual({
    id: 1,
    last_ok_fetch_at: 12345,
    refresh_failures: 3,
    refresh_retry_at: 99999,
  });
  expect(db.query('SELECT source_id FROM jobs').get()).toEqual({ source_id: 1 });
  db.run(`INSERT INTO sources (type, identifier, display_name, created_at) VALUES ('teamtailor', 'x', 'X', 1)`);
});
