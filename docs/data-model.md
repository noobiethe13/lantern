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
        int posted_at
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
every later scan. Columns worth calling out:

- **`company_norm`** is the normalized company name (see `normalizeCompany`). It is
  indexed and used as the prefilter for fuzzy deduplication, so an insert only
  compares against same-company rows instead of scanning the whole table.
- **`salary_min_usd` / `salary_max_usd`**. Despite the name, these hold amounts
  in the job's **native** currency, tagged by `salary_currency` (the `_usd`
  suffix is legacy). L1 only compares a salary to a floor when both currencies are
  known and equal.
- **`last_run_id`** is the run that most recently surfaced this job. Results are
  scoped to a search through this column.
- **`l2_score` / `l2_fit`** are denormalized from the verdict JSON so the Jobs API
  can sort and filter without parsing every row.
- **`duplicate_of`** is set by the semantic-dedup pass to the canonical job a
  near-duplicate folds into. Duplicates are kept, not deleted; they are hidden
  from the default list and skipped by L2.
- **`legitimacy` / `legitimacy_reasons`** hold the ghost-job signal and its reasons.
- **`embedding`** is the job's sentence embedding as a raw Float32 BLOB, or NULL
  until embedded. There is no index; it is read by id alongside L2 survivors.
- **`status`** is the triage state (`new`, `shortlist`, `applied`, `interview`,
  `offer`, `rejected`, `hidden`).

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

An advisory lock enforcing one scan at a time. The runner inserts a row keyed
`'scan'` and deletes it on completion; a concurrent attempt hits the primary-key
conflict and is refused. A stale lock (older than an hour) is assumed to be a
crashed run and is stolen.

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
