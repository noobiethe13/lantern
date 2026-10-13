# Data model

Lantern stores everything in one SQLite database at `data/data.db`. The schema
for a fresh database lives in [`src/db/schema.sql`](../src/db/schema.sql);
migrations for existing databases live in [`src/db/migrate.ts`](../src/db/migrate.ts).

> `data/` is user data. It is never edited by hand, and it is gitignored. All
> schema changes go through the migration path.

## Tables

```mermaid
erDiagram
    sources ||--o{ jobs : "produces"
    jobs ||--o{ attachments : "has"
    runs ||--o{ jobs : "surfaces (last_run_id)"
    jobs ||--o| jobs : "duplicate_of"

    sources {
        int id PK
        text type
        text identifier
        text display_name
        int enabled
        text config_json
        text last_status
        int last_ok_fetch_at "start of last good fetch"
        text origin "discovered or NULL"
    }
    jobs {
        int id PK
        int source_id FK
        text url UK
        text title
        text company
        text company_norm "indexed dedup key"
        int salary_min_usd "native currency"
        text salary_currency
        text salary_source "ats or jd"
        int posted_at
        text employment_type "ATS field or NULL"
        text jd_text
        int l1_pass
        text l2_verdict_json
        real l2_score
        int l2_fit
        int last_run_id
        text legitimacy
        int duplicate_of "FK jobs.id"
        blob embedding "384-d Float32"
        text status
    }
    runs {
        int id PK
        int started_at
        int finished_at
        text query
        int jobs_l1_pass
        int jobs_l2_pass
    }
    criteria {
        int id PK "always 1"
        text yaml
        text source_text
    }
    settings {
        text key PK
        text value_json
    }
    attachments {
        int id PK
        int job_id FK
        text kind
        text stored_path
    }
    scan_locks {
        text key PK "always 'scan'"
        int acquired_at
        int pid
    }
```

### `jobs`

The central table. A row is created the first time a URL is seen and updated on
every later scan. How an incoming posting lands (`upsertJob` in
`src/runner/scan.ts`):

1. **Same URL.** The row is re-stamped (`last_seen`, `last_run_id`, L1 result).
   If the posting was edited — its `content_hash` (title, location, JD) differs —
   the content columns (title, company, location, remote, salary, JD) are
   refreshed and the derived L2 verdict and embedding are cleared so the job is
   re-graded. A missing incoming JD keeps the stored one and doesn't count as an
   edit. `posted_at`, `first_seen`, and the triage fields (`status`, `notes`,
   `applied_at`) are never touched.
2. **Fuzzy duplicate.** Otherwise, a row with the same `company_norm`, the same
   role (title tokens match, with identical level words: "Senior Engineer" is not
   "Engineer"), and a compatible location (equal, or either side unknown) absorbs
   the posting: its URL is appended to `duplicate_urls` (`shouldFold` in
   `src/core/dedup.ts`).
3. **New row** otherwise.

When a row is hit twice in the same run, a passing L1 result wins over a failing
one, so a passing posting never vanishes into a failing duplicate. An L1 result
left over from an earlier run is replaced, since it was graded under that run's
criteria.

Columns worth calling out:

- **`company_norm`** is the normalized company name (see `normalizeCompany`). It is
  indexed and used as the prefilter for fuzzy deduplication, so an insert only
  compares against same-company rows instead of scanning the whole table.
- **`content_hash`** hashes title, location, and JD; a change on re-scan is what
  triggers the refresh described above.
- **`salary_min_usd` / `salary_max_usd`**. Despite the name, these hold amounts
  in the job's **native** currency, tagged by `salary_currency` (the `_usd`
  suffix is legacy). L1 only compares a salary to a floor when both currencies are
  known and equal.
- **`salary_source`** is `ats` when the figure came from the source's structured
  field and `jd` when the runner read it out of the description text
  ([`salary.ts`](../src/core/salary.ts)). NULL means no salary, or a row stored
  before the column existed (a NULL source with a salary reads as `ats`). The
  Jobs panel marks a `jd` salary with "≈". A `jd` salary appearing on a row that
  had none is a backfill and does not count as an edit, so the first re-scan after
  an upgrade keeps every L2 verdict and embedding. A `jd` salary that later
  *changes* (the JD was edited) does count, like any other edit.
- **`last_run_id`** is the run that most recently surfaced this job. Results are
  scoped to a search through this column.
- **`employment_type`** is the ATS's structured commitment field (Lever, Ashby) or
  NULL. It is an L1 input, refreshed on every sighting by the owning source and kept
  out of `content_hash`, so a change never clears a verdict.
- **`l2_score` / `l2_fit`** are denormalized from the verdict JSON so the Jobs API
  can sort and filter without parsing every row.
- **`duplicate_of`** is set by the semantic-dedup pass to the canonical job a
  near-duplicate folds into. Duplicates are kept, not deleted; they are hidden
  from the default list and skipped by L2.
- **`legitimacy` / `legitimacy_reasons`** hold the ghost-job signal and its reasons.
- **`embedding`** is the job's sentence embedding as a raw Float32 BLOB, or NULL
  until embedded (and again after a content refresh). There is no index; it is read by id alongside L2 survivors.
- **`status`** is the triage state (`new`, `shortlist`, `applied`, `interview`,
  `offer`, `rejected`, `hidden`).

### `sources`

One row per board. `enabled` is the user's toggle. The seed sync may turn a
retired per-company board off, but never turns one on; see
[sources.md](sources.md). Deleting a source that has saved jobs, or that is a
seeded default, turns it off instead. `origin` is `discovered` for boards seeded
from `discovered-sources.json` (disabled, hidden from the roster, bulk-toggled in
Settings) and NULL for seeded and user-added rows. `last_status` is `ok`, `timeout` (hit the
per-source deadline), or an error kind (`http-error`, `http`, `gated`, `auth`,
`extract`), with `last_error` holding the message. An `apiKey` in `config_json` is
masked in every API response. `last_scan_at` is the last attempt;
`refresh_failures` and `refresh_retry_at` are the background refresher's backoff for a
failing board (consecutive failures, earliest next attempt), reset by any successful
fetch. `last_ok_fetch_at` is the **start** of the last complete successful fetch, set only
when a source runs to the end (never by a failed, partial or timed-out fetch) and
cleared when the board's `config_json` or display name changes (the company name feeds an
L1 rule). The board cache reads it: a job is on the board iff that board's
`board_sightings.seen_at >= last_ok_fetch_at`.

### `board_sightings`

`(source_id, job_id, seen_at)`, a `WITHOUT ROWID` table written by `upsertJob` on every
sighting (insert, re-sighting, fuzzy fold). `jobs.source_id` is only the first source to
insert a posting, while a later board can list the same URL or fold into the row, so the
board cache reads this to know what each board currently lists. Rows cascade with their
source or job.

### `runs`

One row per scan. Tracks counts at each stage and the raw query. `finished_at` is
set only after L2 completes. See the two-phase progress note in
[architecture.md](architecture.md).

### `criteria`

A single row (`id = 1`) holding the structured criteria as YAML plus the original
search text. It is a **derived artifact**: the scan endpoint regenerates it from
the natural-language query on every search. There is no criteria editor and no
`/api/criteria` route.

### `settings`

A key-value store (JSON values) for feature settings: the LLM model overrides,
the résumé, the semantic-ranking toggle, and the freshness window. Each has its
own route under `/api/settings/*`.

### `scan_locks`

An advisory lock enforcing one scan at a time. `POST /api/runs/scan` inserts a
row keyed `'scan'` (with the server's pid) before it calls `nl-filter`, and
`runFull` deletes it when the run ends; a concurrent attempt hits the primary-key
conflict and gets a 409. A lock is stale when its pid is no longer alive (or, for
a row with no pid, after an hour) and is then taken over. At startup,
`recoverInterruptedScans` clears a dead process's lock and marks its unfinished
runs finished with an "interrupted" error.

## Migrations

`schema.sql` defines the full schema for a fresh database. `migrate.ts` brings an
existing database up to date with guarded, idempotent statements (`ALTER TABLE
... ADD COLUMN` behind a column check, indexes for migration-added columns).

Two rules keep migrations safe:

- **Keep `schema.sql` comments free of semicolons.** The migration splits the
  file on `;` before stripping comments, so a semicolon inside a comment breaks a
  fresh-database initialization.
- **The `sources.type` CHECK constraint needs both paths.** SQLite cannot alter a
  CHECK, so adding a board type requires editing the constraint in `schema.sql`
  (for fresh databases) *and* a table-rebuild migration (for existing ones).

Migrations are not covered by the test suite. Verify a change by running the
migrations against an in-memory database in three states: fresh, legacy (starting
from an older schema), and idempotent (running twice is a no-op).
