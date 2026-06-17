---
paths:
  - src/runner/**
  - src/db/**
  - src/routes/runs.ts
  - src/routes/jobs.ts
---

# Scan runner, progress, and DB invariants

- **Two-phase progress.** `runScan` emits `scan_done` (NON-terminal) at the L1→L2
  handoff. The SSE stream (`routes/runs.ts`) and the `useSSE` hook only close on
  `l2_done` / `done` / `error`. Do NOT emit `done` at L1-end — it cuts the stream
  before L2 events and makes the UI look stuck.
- **`finished_at` is set only after L2** (in `runFull`, after `runL2Pass`). Setting
  it at L1-end marks the run complete while L2 is still scoring. The Search page
  treats a run with `finished_at === null` as in-progress (and reconnects to it).
- **Run scoping.** `upsertJob` stamps `last_run_id` on every job a run surfaces
  (insert + seen + fuzzy-merge). L2 and the Jobs API scope by it (`?run=latest`),
  so each search shows its own result set. `l2_score`/`l2_fit` are denormalized
  for `?fit=1` + `ORDER BY l2_score DESC`.
- **Criteria is derived.** The scan endpoint runs `nl-filter` → writes the
  `criteria` id=1 row → invalidates verdicts (`l2_verdict_json`+`l2_score`+
  `l2_fit`). There is no `/api/criteria` route; the runner reads criteria from the
  DB (`loadCriteria`, fallback `src/config/search.yml`).
- **Dedup stays linear.** `findFuzzyDuplicate` prefilters on the indexed
  `company_norm` column — never reintroduce a full-table scan (O(n²) at 300+ boards).
- **Schema/migrations.** `schema.sql` defines the full schema for fresh DBs;
  `migrate.ts` ALTERs pre-existing DBs (idempotent, guarded). Keep schema.sql
  comments **semicolon-free** — `migrate.ts` splits on `;` before stripping
  comments. Migrations aren't test-covered: verify changes with `runMigrations`
  on a `:memory:` DB. Indexes on migration-added columns go in `migrate.ts`.
- **L2 cost.** `runL2Pass` grades jobs in **batches of `L2_BATCH_SIZE` (20)** per
  `claude` call to amortize the ~15K uncacheable cold-start tokens each subprocess
  re-sends. Batches are **sequential**; each call uses `BatchVerdictShape`
  (`{verdicts:[{job_id,...}]}`) and maps results back by `job_id` (an id missing
  from a successful response is a per-job error, not an abort). Fatal-abort +
  consecutive-failure guards operate per-batch. Don't revert to per-job L2 calls.
