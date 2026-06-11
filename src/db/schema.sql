-- ── sources ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT NOT NULL CHECK (type IN (
    'greenhouse', 'ashby', 'lever',
    'recruitee', 'smartrecruiters', 'workable', 'personio',
    'remoteok', 'arbeitnow', 'himalayas'
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
);

-- ── jobs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS jobs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id            INTEGER NOT NULL REFERENCES sources(id),
  external_id          TEXT,
  url                  TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL,
  company              TEXT NOT NULL,
  -- normalized company name (see normalizeCompany) — the indexed prefilter for
  -- fuzzy dedup so we don't scan the whole jobs table per insert. Backfilled and
  -- indexed in migrate.ts. Keep this comment free of semicolons — the migrate
  -- splitter breaks on a semicolon inside a comment.
  company_norm         TEXT,
  location             TEXT,
  remote               INTEGER,
  -- salary_min_usd/max are NATIVE amounts in salary_currency, not necessarily
  -- USD (the _usd suffix is legacy). salary_currency is the ISO code tagging
  -- them, or NULL when the source did not report one. L1 only compares amounts
  -- when the job and floor currencies match (see l1Filter).
  salary_min_usd       INTEGER,
  salary_max_usd       INTEGER,
  salary_currency      TEXT,
  posted_at            INTEGER,
  jd_text              TEXT,
  content_hash         TEXT NOT NULL,
  first_seen           INTEGER NOT NULL,
  last_seen            INTEGER NOT NULL,
  liveness             TEXT DEFAULT 'unchecked'
                       CHECK (liveness IN ('active','expired','uncertain','unchecked')),
  liveness_checked_at  INTEGER,
  l1_pass              INTEGER NOT NULL DEFAULT 0,
  l1_reasons           TEXT,
  l2_verdict_json      TEXT,
  -- denormalized verdict fields for sortable/filterable presentation, written
  -- by runL2Pass alongside l2_verdict_json. l2_fit is 0 or 1.
  l2_score             REAL,
  l2_fit               INTEGER,
  -- the run that most recently surfaced this job. Jobs are scoped to the latest
  -- search via this column (see runScan upsertJob).
  last_run_id          INTEGER,
  duplicate_urls       TEXT,
  status               TEXT NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','shortlist','applied','interview',
                                          'offer','rejected','hidden')),
  applied_at           INTEGER,
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_source       ON jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status       ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_l1           ON jobs(l1_pass);
CREATE INDEX IF NOT EXISTS idx_jobs_first_seen   ON jobs(first_seen DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_last_run     ON jobs(last_run_id);
CREATE INDEX IF NOT EXISTS idx_jobs_l2_score     ON jobs(l2_score DESC);

-- ── attachments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('resume','cover_letter','other')),
  filename     TEXT NOT NULL,
  stored_path  TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  uploaded_at  INTEGER NOT NULL
);

-- ── runs ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  sources_total   INTEGER NOT NULL DEFAULT 0,
  jobs_found      INTEGER NOT NULL DEFAULT 0,
  jobs_new        INTEGER NOT NULL DEFAULT 0,
  jobs_l1_pass    INTEGER NOT NULL DEFAULT 0,
  jobs_l2_pass    INTEGER NOT NULL DEFAULT 0,
  errors_json     TEXT,
  trigger         TEXT NOT NULL DEFAULT 'manual',
  -- the raw natural-language query that drove this run (null for legacy/no-query
  -- runs). Powers the recent-searches dropdown and result scoping.
  query           TEXT
);

-- ── criteria ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS criteria (
  id           INTEGER PRIMARY KEY,
  yaml         TEXT NOT NULL,
  source_text  TEXT,
  updated_at   INTEGER NOT NULL
);

-- ── settings (KV) ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ── scan_locks ──────────────────────────────────────────────────────
-- Advisory lock used to enforce single-scanner-at-a-time. The runner
-- inserts a row keyed 'scan' and deletes it on completion. Concurrent
-- attempts hit the PRIMARY KEY conflict and fail loudly. Survives the
-- bus and module-state reloads that the previous in-memory boolean did not.
CREATE TABLE IF NOT EXISTS scan_locks (
  key         TEXT PRIMARY KEY,
  acquired_at INTEGER NOT NULL,
  pid         INTEGER
);
